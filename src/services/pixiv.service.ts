import { PixivClient } from '../lib/pixiv-client';
import pixivImg from 'pixiv-img';
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
}

export class PixivService {
    private client: PixivClient;
    private isLoggedIn: boolean = false;

    constructor() {
        this.client = new PixivClient();
    }

    /**
     * 初始化并登录 Pixiv
     */
    async init(): Promise<void> {
        const { pixivRefreshToken } = pluginState.config;

        if (!pixivRefreshToken) {
            pluginState.logger.warn('Pixiv Refresh Token 未配置，请在 WebUI 设置中配置。');
            return;
        }

        try {
            this.client = new PixivClient({ camelcaseKeys: true });

            pluginState.logger.info('正在通过 Refresh Token 登录 Pixiv...');
            await this.client.login(pixivRefreshToken);
            pluginState.logger.info('Pixiv 登录成功');

            this.isLoggedIn = true;
        } catch (error) {
            pluginState.logger.error('Pixiv 登录失败:', error);
            this.isLoggedIn = false;
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

        let r18Filtered = 0;
        let sensitiveFiltered = 0;
        let bannedFiltered = 0;
        const result: SafeIllust[] = [];
        for (const illust of illusts) {
            if (result.length >= count) break;

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

        return { illusts: result, totalScanned: illusts.length, r18Filtered, sensitiveFiltered, bannedFiltered };
    }

    /**
     * 搜索关键词并返回前 3 个安全作品
     * 参照 main.py 的 search_illust + _extract_and_download_top_3
     */
    async searchTop3(keyword: string): Promise<ExtractResult> {
        await this.ensureLoggedIn();

        const maxRetries = 5;
        const requiredCount = pluginState.config.resultCount ?? 3;
        // 累积池：按 ID 去重叠加
        const collectedMap = new Map<number, SafeIllust>();
        let totalScanned = 0;
        let totalR18Filtered = 0;
        let totalSensitiveFiltered = 0;
        let totalBannedFiltered = 0;

        // offset 上限仅在 API 真的返回空结果时递减，过滤导致的不足不缩小范围
        const offsetLimits = [300, 200, 100, 50, 0];
        let offsetLevel = 0;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                const maxOffset = offsetLimits[Math.min(offsetLevel, offsetLimits.length - 1)];
                const randomOffset = maxOffset > 0 ? Math.floor(Math.random() * (maxOffset + 1)) : 0;
                pluginState.logger.debug(`搜索 "${keyword}"，随机偏移: ${randomOffset}（第 ${attempt + 1} 次尝试，偏移上限: ${maxOffset}）`);

                const result = await this.client.searchIllust(keyword, {
                    offset: randomOffset,
                });

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

                // 已满足数量要求，直接返回
                if (collectedMap.size >= requiredCount) {
                    const collected = Array.from(collectedMap.values()).slice(0, requiredCount);
                    return { illusts: collected, totalScanned, r18Filtered: totalR18Filtered, sensitiveFiltered: totalSensitiveFiltered, bannedFiltered: totalBannedFiltered };
                }

                // API 返回空结果（非过滤导致）→ 缩小偏移范围
                if (illusts.length === 0) {
                    offsetLevel++;
                    // 已用最小偏移仍为空，真的没结果
                    if (maxOffset === 0) break;
                }

                const filterParts: string[] = [];
                if (currentResult.r18Filtered > 0) filterParts.push(`R-18: ${currentResult.r18Filtered}`);
                if (currentResult.sensitiveFiltered > 0) filterParts.push(`敏感: ${currentResult.sensitiveFiltered}`);
                if (currentResult.bannedFiltered > 0) filterParts.push(`违禁词: ${currentResult.bannedFiltered}`);
                const filterInfo = filterParts.length > 0 ? `（本次过滤 ${filterParts.join('、')}）` : '';
                pluginState.logger.info(`搜索 "${keyword}" 第 ${attempt + 1} 次累计获取 ${collectedMap.size}/${requiredCount} 张${filterInfo}，重试中...`);
            } catch (error) {
                pluginState.logger.error('Pixiv 搜索失败:', error);
                throw error;
            }
        }

        const finalIllusts = Array.from(collectedMap.values()).slice(0, requiredCount);
        if (finalIllusts.length > 0 && finalIllusts.length < requiredCount) {
            pluginState.logger.info(`搜索 "${keyword}" 重试 ${maxRetries} 次后累计获取 ${finalIllusts.length}/${requiredCount} 张，将发送已有结果`);
        } else if (finalIllusts.length === 0) {
            pluginState.logger.info(`搜索 "${keyword}" 重试 ${maxRetries} 次后仍无安全结果`);
        }
        return { illusts: finalIllusts, totalScanned, r18Filtered: totalR18Filtered, sensitiveFiltered: totalSensitiveFiltered, bannedFiltered: totalBannedFiltered };
    }

    /**
     * 获取推荐流并返回前 3 个安全作品
     * 参照 main.py 的 get_recommended + _extract_and_download_top_3
     */
    async getRandomTop3(): Promise<ExtractResult> {
        await this.ensureLoggedIn();

        const maxRetries = 3;
        const requiredCount = pluginState.config.resultCount ?? 3;
        // 累积池：按 ID 去重叠加
        const collectedMap = new Map<number, SafeIllust>();
        let totalScanned = 0;
        let totalR18Filtered = 0;
        let totalSensitiveFiltered = 0;
        let totalBannedFiltered = 0;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                const result = await this.client.illustRecommended();
                const illusts = result.illusts || [];
                // 推荐流本身有动态性，加上本地打乱效果更好
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

                // 已满足数量要求，直接返回
                if (collectedMap.size >= requiredCount) {
                    const collected = Array.from(collectedMap.values()).slice(0, requiredCount);
                    return { illusts: collected, totalScanned, r18Filtered: totalR18Filtered, sensitiveFiltered: totalSensitiveFiltered, bannedFiltered: totalBannedFiltered };
                }

                // 没有任何结果且不是过滤导致的，说明真的没结果
                const totalFiltered = currentResult.r18Filtered + currentResult.sensitiveFiltered + currentResult.bannedFiltered;
                if (currentResult.illusts.length === 0 && totalFiltered === 0) {
                    break;
                }

                const filterParts: string[] = [];
                if (currentResult.r18Filtered > 0) filterParts.push(`R-18: ${currentResult.r18Filtered}`);
                if (currentResult.sensitiveFiltered > 0) filterParts.push(`敏感: ${currentResult.sensitiveFiltered}`);
                if (currentResult.bannedFiltered > 0) filterParts.push(`违禁词: ${currentResult.bannedFiltered}`);
                const filterInfo = filterParts.length > 0 ? `（本次过滤 ${filterParts.join('、')}）` : '';
                pluginState.logger.info(`推荐第 ${attempt + 1} 次累计获取 ${collectedMap.size}/${requiredCount} 张${filterInfo}，重试中...`);
            } catch (error) {
                pluginState.logger.error('Pixiv 推荐获取失败:', error);
                throw error;
            }
        }

        const finalIllusts = Array.from(collectedMap.values()).slice(0, requiredCount);
        if (finalIllusts.length > 0 && finalIllusts.length < requiredCount) {
            pluginState.logger.info(`推荐重试 ${maxRetries} 次后累计获取 ${finalIllusts.length}/${requiredCount} 张，将发送已有结果`);
        } else if (finalIllusts.length === 0) {
            pluginState.logger.info(`推荐重试 ${maxRetries} 次后仍无安全结果`);
        }
        return { illusts: finalIllusts, totalScanned, r18Filtered: totalR18Filtered, sensitiveFiltered: totalSensitiveFiltered, bannedFiltered: totalBannedFiltered };
    }

    /**
     * 下载图片到临时目录
     * @returns 本地绝对路径
     */
    async downloadImage(imageUrl: string): Promise<string> {
        const tempDir = path.join(os.tmpdir(), 'napcat-pixiv-plugin');
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }

        const fileName = path.basename(imageUrl);
        const filePath = path.join(tempDir, fileName);

        // 简单缓存：已存在则跳过
        if (fs.existsSync(filePath)) {
            return filePath;
        }

        try {
            await pixivImg(imageUrl, filePath);
            return filePath;
        } catch (error) {
            pluginState.logger.error(`下载图片失败 ${imageUrl}:`, error);
            throw error;
        }
    }
    /**
     * 清理临时图片缓存目录
     */
    cleanupCache(): void {
        const tempDir = path.join(os.tmpdir(), 'napcat-pixiv-plugin');
        try {
            if (fs.existsSync(tempDir)) {
                fs.rmSync(tempDir, { recursive: true, force: true });
                pluginState.logger.info('已清理临时图片缓存目录');
            }
        } catch (error) {
            pluginState.logger.warn('清理临时缓存失败:', error);
        }
    }
}

export const pixivService = new PixivService();
