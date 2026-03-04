import { PixivClient } from '../lib/pixiv-client';
import axios from 'axios';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { pluginState } from '../core/state';
import { bannedWordsService } from './banned-words.service';

/** 安全插画信息（过滤后） */
export interface SafeIllust {
    id: number;
    title: string;
    userName: string;
    imageUrl: string;
}

/** 提取结果（含过滤统计） */
export interface ExtractResult {
    illusts: SafeIllust[];
    /** 总共扫描的作品数 */
    totalScanned: number;
    /** 因 R-18 被过滤的数量 */
    r18Filtered: number;
    /** 因敏感内容被过滤的数量 */
    sensitiveFiltered: number;
    /** 因违禁词被过滤的数量 */
    bannedFiltered: number;
    /** 因近期重复发送被过滤的数量 */
    duplicateFiltered: number;
}

export class PixivService {
    private client: PixivClient;
    private isLoggedIn: boolean = false;
    private sentCache = new Map<number, number>(); // <illustId, expireTimeMs>
    private readonly cacheTtl = 5 * 60 * 1000; // 5分钟
    private readonly sentCacheMaxSize = 1000;
    private initPromise: Promise<void> | null = null;
    private downloadingImages = new Map<string, Promise<string>>();
    private lastLoginFailTime = 0;
    private readonly loginCooldown = 60 * 1000; // 登录失败后冷却 60 秒
    private readonly cacheDir = path.join(os.tmpdir(), 'napcat-pixiv-plugin');

    constructor() {
        this.client = new PixivClient();
    }

    /**
     * 初始化并登录 Pixiv
     */
    async init(): Promise<void> {
        if (this.initPromise) {
            return this.initPromise;
        }

        // 登录失败冷却期内不再重试，避免频繁无效请求
        if (this.lastLoginFailTime > 0 && Date.now() - this.lastLoginFailTime < this.loginCooldown) {
            throw new Error(`Pixiv 登录失败冷却中，请 ${Math.ceil((this.loginCooldown - (Date.now() - this.lastLoginFailTime)) / 1000)} 秒后重试`);
        }

        this.initPromise = (async () => {
            const { pixivRefreshToken } = pluginState.config;

            if (!pixivRefreshToken) {
                pluginState.logger.warn('Pixiv Refresh Token 未配置，请在 WebUI 设置中配置。');
                return;
            }

            try {
                this.client = new PixivClient({ camelcaseKeys: true });

                // 应用代理配置
                const { proxyUrl } = pluginState.config;
                this.client.applyProxy(proxyUrl);

                pluginState.logger.info('正在通过 Refresh Token 登录 Pixiv...');
                await this.client.login(pixivRefreshToken);
                pluginState.logger.info('Pixiv 登录成功');

                this.isLoggedIn = true;
                this.lastLoginFailTime = 0;
            } catch (error) {
                pluginState.logger.error('Pixiv 登录失败:', error);
                this.isLoggedIn = false;
                this.lastLoginFailTime = Date.now();
            }
        })();

        try {
            await this.initPromise;
        } finally {
            this.initPromise = null;
        }
    }

    /**
     * 确保已登录
     */
    private async ensureLoggedIn(): Promise<void> {
        if (!this.isLoggedIn) {
            await this.init();
            if (!this.isLoggedIn) throw new Error('Pixiv 登录失败，请检查凭据配置。');
        }
    }

    /**
     * 重新应用代理配置（配置变更时调用）
     */
    reapplyProxy(): void {
        const { proxyUrl } = pluginState.config;
        this.client.applyProxy(proxyUrl);
    }

    /**
     * 从插画列表中提取前 3 个安全作品
     * 参照 main.py 的 _extract_and_download_top_3 逻辑
     */
    private extractTopSafe(illusts: any[], shuffle: boolean = true): ExtractResult {
        const count = pluginState.config.resultCount ?? 3;
        // 打乱列表实现随机效果
        if (shuffle && illusts.length > 0) {
            const shuffled = [...illusts];
            for (let i = shuffled.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
            }
            illusts = shuffled;
        }

        const now = Date.now();
        // 清理过期的缓存
        for (const [id, expireTime] of this.sentCache.entries()) {
            if (now > expireTime) {
                this.sentCache.delete(id);
            }
        }
        // 防止 sentCache 无限增长
        if (this.sentCache.size > this.sentCacheMaxSize) {
            const excess = this.sentCache.size - this.sentCacheMaxSize;
            const iter = this.sentCache.keys();
            for (let i = 0; i < excess; i++) {
                this.sentCache.delete(iter.next().value!);
            }
        }

        let r18Filtered = 0;
        let sensitiveFiltered = 0;
        let bannedFiltered = 0;
        let duplicateFiltered = 0;
        const result: SafeIllust[] = [];

        for (const illust of illusts) {
            if (result.length >= count) break;

            // 重复过滤：如果近期已发送过，跳过
            if (this.sentCache.has(illust.id)) {
                duplicateFiltered++;
                pluginState.logger.info(`[过滤] ID: ${illust.id} 包含近期已发送的内容，已跳过`);
                continue;
            }

            // R-18 过滤：如果未启用 R18，跳过限制级内容
            if (!pluginState.config.r18Enabled && (illust.xRestrict !== 0 && illust.xRestrict !== undefined)) {
                r18Filtered++;
                pluginState.logger.info(`[过滤] ID: ${illust.id} 包含限制级内容，已跳过`);
                continue;
            }

            // 敏感内容过滤：如果未启用敏感内容，跳过 sanity_level >= 4 的作品
            const sanityLevel = illust.sanityLevel ?? illust.sanity_level ?? 0;
            if (!pluginState.config.sensitiveEnabled && sanityLevel >= 4) {
                sensitiveFiltered++;
                pluginState.logger.info(`[过滤] ID: ${illust.id} 含敏感内容 (sanity_level=${sanityLevel})，已跳过`);
                continue;
            }

            // 违禁词过滤：检查标题和标签
            const bannedHit = bannedWordsService.checkIllust(illust);
            if (bannedHit) {
                bannedFiltered++;
                pluginState.logger.info(`[违禁词] ID: ${illust.id} 标题/标签命中违禁词 "${bannedHit.pattern}"，已跳过`);
                continue;
            }

            // 提取最高画质图片链接
            let imageUrl: string;
            if (illust.metaSinglePage?.originalImageUrl) {
                imageUrl = illust.metaSinglePage.originalImageUrl;
            } else {
                imageUrl = illust.imageUrls?.large || illust.imageUrls?.medium;
            }

            if (!imageUrl) continue;

            result.push({
                id: illust.id,
                title: illust.title,
                userName: illust.user?.name || '未知',
                imageUrl,
            });
        }

        return { illusts: result, totalScanned: illusts.length, r18Filtered, sensitiveFiltered, bannedFiltered, duplicateFiltered };
    }

    /**
     * 通用的带重试的数据获取方法
     * 将 searchTop3 和 getRandomTop3 中的公共逻辑抽取出来
     */
    private async fetchWithRetry(
        fetcher: (attempt: number) => Promise<{ illusts: any[] }>,
        options: {
            maxRetries: number;
            label: string;
            shouldBreakOnEmpty?: (illusts: any[], currentResult: ExtractResult) => boolean;
        },
    ): Promise<ExtractResult> {
        await this.ensureLoggedIn();

        const { maxRetries, label } = options;
        const requiredCount = pluginState.config.resultCount ?? 3;
        const collectedMap = new Map<number, SafeIllust>();
        let totalScanned = 0;
        let totalR18Filtered = 0;
        let totalSensitiveFiltered = 0;
        let totalBannedFiltered = 0;
        let totalDuplicateFiltered = 0;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                const result = await fetcher(attempt);
                const illusts = result.illusts || [];
                const currentResult = this.extractTopSafe(illusts, true);

                // 去重叠加到累积池
                for (const illust of currentResult.illusts) {
                    if (!collectedMap.has(illust.id)) {
                        collectedMap.set(illust.id, illust);
                    }
                }
                totalScanned += currentResult.totalScanned;
                totalR18Filtered += currentResult.r18Filtered;
                totalSensitiveFiltered += currentResult.sensitiveFiltered;
                totalBannedFiltered += currentResult.bannedFiltered;
                totalDuplicateFiltered += currentResult.duplicateFiltered;

                // 已满足数量要求，直接返回
                if (collectedMap.size >= requiredCount) {
                    const collected = Array.from(collectedMap.values()).slice(0, requiredCount);
                    this.recordSentCache(collected);
                    return { illusts: collected, totalScanned, r18Filtered: totalR18Filtered, sensitiveFiltered: totalSensitiveFiltered, bannedFiltered: totalBannedFiltered, duplicateFiltered: totalDuplicateFiltered };
                }

                // 检查是否应提前终止
                if (options.shouldBreakOnEmpty?.(illusts, currentResult)) {
                    break;
                }

                const filterParts: string[] = [];
                if (currentResult.r18Filtered > 0) filterParts.push(`R-18: ${currentResult.r18Filtered}`);
                if (currentResult.sensitiveFiltered > 0) filterParts.push(`敏感: ${currentResult.sensitiveFiltered}`);
                if (currentResult.bannedFiltered > 0) filterParts.push(`违禁词: ${currentResult.bannedFiltered}`);
                if (currentResult.duplicateFiltered > 0) filterParts.push(`近期重复: ${currentResult.duplicateFiltered}`);
                const filterInfo = filterParts.length > 0 ? `（本次过滤 ${filterParts.join('、')}）` : '';
                pluginState.logger.info(`${label}第 ${attempt + 1} 次累计获取 ${collectedMap.size}/${requiredCount} 张${filterInfo}，重试中...`);
            } catch (error: any) {
                pluginState.logger.error(`Pixiv ${label}失败:`, error);
                if (error?.response?.status === 400 || error?.response?.status === 401 || error?.response?.status === 403) {
                    this.isLoggedIn = false;
                }
                throw error;
            }
        }

        const finalIllusts = Array.from(collectedMap.values()).slice(0, requiredCount);
        if (finalIllusts.length > 0 && finalIllusts.length < requiredCount) {
            pluginState.logger.info(`${label}重试 ${maxRetries} 次后累计获取 ${finalIllusts.length}/${requiredCount} 张，将发送已有结果`);
        } else if (finalIllusts.length === 0) {
            pluginState.logger.info(`${label}重试 ${maxRetries} 次后仍无安全结果`);
        }
        this.recordSentCache(finalIllusts);
        return { illusts: finalIllusts, totalScanned, r18Filtered: totalR18Filtered, sensitiveFiltered: totalSensitiveFiltered, bannedFiltered: totalBannedFiltered, duplicateFiltered: totalDuplicateFiltered };
    }

    /** 记录已发送图片到近期缓存 */
    private recordSentCache(illusts: SafeIllust[]): void {
        const now = Date.now();
        for (const illust of illusts) {
            this.sentCache.set(illust.id, now + this.cacheTtl);
        }
    }

    /**
     * 搜索关键词并返回前 N 个安全作品
     * 参照 main.py 的 search_illust + _extract_and_download_top_3
     */
    async searchTop3(keyword: string): Promise<ExtractResult> {
        // offset 上限仅在 API 真的返回空结果时递减，过滤导致的不足不缩小范围
        const offsetLimits = [300, 200, 100, 50, 0];
        let offsetLevel = 0;

        return this.fetchWithRetry(
            async (attempt) => {
                const maxOffset = offsetLimits[Math.min(offsetLevel, offsetLimits.length - 1)];
                const randomOffset = maxOffset > 0 ? Math.floor(Math.random() * (maxOffset + 1)) : 0;
                pluginState.logger.debug(`搜索 "${keyword}"，随机偏移: ${randomOffset}（第 ${attempt + 1} 次尝试，偏移上限: ${maxOffset}）`);
                return this.client.searchIllust(keyword, { offset: randomOffset });
            },
            {
                maxRetries: 5,
                label: `搜索 "${keyword}" `,
                shouldBreakOnEmpty: (illusts) => {
                    if (illusts.length === 0) {
                        const maxOffset = offsetLimits[Math.min(offsetLevel, offsetLimits.length - 1)];
                        offsetLevel++;
                        if (maxOffset === 0) return true; // 已用最小偏移仍为空
                    }
                    return false;
                },
            },
        );
    }

    /**
     * 获取推荐流并返回前 N 个安全作品
     * 参照 main.py 的 get_recommended + _extract_and_download_top_3
     */
    async getRandomTop3(): Promise<ExtractResult> {
        return this.fetchWithRetry(
            async () => this.client.illustRecommended(),
            {
                maxRetries: 3,
                label: '推荐',
                shouldBreakOnEmpty: (illusts, currentResult) => {
                    const totalFiltered = currentResult.r18Filtered + currentResult.sensitiveFiltered + currentResult.bannedFiltered + currentResult.duplicateFiltered;
                    return currentResult.illusts.length === 0 && totalFiltered === 0;
                },
            },
        );
    }

    /**
     * 下载图片到临时目录
     * @returns 本地绝对路径
     */
    async downloadImage(imageUrl: string): Promise<string> {
        if (!fs.existsSync(this.cacheDir)) {
            fs.mkdirSync(this.cacheDir, { recursive: true });
        }

        const fileName = path.basename(imageUrl);
        const filePath = path.join(this.cacheDir, fileName);
        const tmpPath = filePath + '.tmp';

        // 简单缓存：已存在则跳过
        if (fs.existsSync(filePath)) {
            return filePath;
        }

        // 如果该图片正在下载，则等待它完成，避免重复写同一个文件报错 EBUSY
        if (this.downloadingImages.has(imageUrl)) {
            pluginState.logger.debug(`图片 ${imageUrl} 正在下载，等待完成...`);
            return this.downloadingImages.get(imageUrl)!;
        }

        const downloadPromise = (async () => {
            const maxRetries = 3;
            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    // 使用 axios 流式下载，支持代理
                    const proxyAgent = this.client.getProxyAgent();
                    const response = await axios({
                        url: imageUrl,
                        method: 'GET',
                        responseType: 'stream',
                        timeout: 90000,
                        headers: { Referer: 'http://www.pixiv.net/' },
                        httpAgent: proxyAgent,
                        httpsAgent: proxyAgent,
                    });
                    const writer = fs.createWriteStream(tmpPath);
                    response.data.pipe(writer);
                    await new Promise<void>((resolve, reject) => {
                        response.data.on('error', reject); // 监听 readable stream 错误
                        writer.on('error', reject);
                        writer.on('close', resolve);
                    });
                    // 下载完成后重命名，避免残留不完整文件
                    fs.renameSync(tmpPath, filePath);
                    return filePath;
                } catch (error) {
                    // 清理可能残留的临时文件
                    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* ignore */ }
                    if (attempt < maxRetries) {
                        pluginState.logger.info(`下载图片失败 ${imageUrl} (第 ${attempt}/${maxRetries} 次尝试)，正在重试...`);
                    } else {
                        pluginState.logger.error(`下载图片彻底失败 ${imageUrl}:`, error);
                        throw error;
                    }
                }
            }
            throw new Error(`下载图片彻底失败 ${imageUrl}`);
        })();

        this.downloadingImages.set(imageUrl, downloadPromise);
        try {
            return await downloadPromise;
        } finally {
            this.downloadingImages.delete(imageUrl);
        }
    }
    /**
     * 获取缓存目录信息（文件数量和总大小）
     */
    getCacheInfo(): { fileCount: number; totalSizeBytes: number; totalSizeFormatted: string } {
        let fileCount = 0;
        let totalSizeBytes = 0;

        try {
            if (fs.existsSync(this.cacheDir)) {
                const files = fs.readdirSync(this.cacheDir);
                for (const file of files) {
                    try {
                        const stat = fs.statSync(path.join(this.cacheDir, file));
                        if (stat.isFile()) {
                            fileCount++;
                            totalSizeBytes += stat.size;
                        }
                    } catch { /* ignore */ }
                }
            }
        } catch { /* ignore */ }

        return { fileCount, totalSizeBytes, totalSizeFormatted: this.formatBytes(totalSizeBytes) };
    }

    /**
     * 智能清理缓存（保护最近 5 分钟内创建的文件，避免清理正在上传的图片）
     * @returns 清理的文件数量
     */
    smartCleanupCache(): number {
        const protectMs = 5 * 60 * 1000; // 5 分钟保护期
        const now = Date.now();
        let cleaned = 0;

        try {
            if (!fs.existsSync(this.cacheDir)) return 0;

            const files = fs.readdirSync(this.cacheDir);
            for (const file of files) {
                const filePath = path.join(this.cacheDir, file);
                try {
                    const stat = fs.statSync(filePath);
                    if (!stat.isFile()) continue;

                    // 保护期内的文件跳过
                    if (now - stat.mtimeMs < protectMs) {
                        pluginState.logger.info(`[缓存] 跳过新文件: ${file}（${Math.round((now - stat.mtimeMs) / 1000)}秒前下载）`);
                        continue;
                    }

                    fs.unlinkSync(filePath);
                    cleaned++;
                } catch { /* ignore single file error */ }
            }

            if (cleaned > 0) {
                pluginState.logger.info(`已智能清理 ${cleaned} 个缓存文件`);
            }
        } catch (error) {
            pluginState.logger.warn('智能清理缓存失败:', error);
        }

        return cleaned;
    }

    /**
     * 全量清理缓存目录（插件卸载时使用）
     */
    cleanupCacheAll(): void {
        try {
            if (fs.existsSync(this.cacheDir)) {
                fs.rmSync(this.cacheDir, { recursive: true, force: true });
                pluginState.logger.info('已全量清理临时图片缓存目录');
            }
        } catch (error) {
            pluginState.logger.warn('全量清理临时缓存失败:', error);
        }
    }

    /** 格式化字节为可读大小 */
    private formatBytes(bytes: number): string {
        if (bytes === 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB'];
        const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
        return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
    }
}

export const pixivService = new PixivService();
