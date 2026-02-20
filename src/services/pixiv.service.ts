import { PixivClient } from '../lib/pixiv-client';
import pixivImg from 'pixiv-img';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { pluginState } from '../core/state';

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
    private extractTop3Safe(illusts: any[], shuffle: boolean = true): ExtractResult {
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
        const result: SafeIllust[] = [];
        for (const illust of illusts) {
            if (result.length >= 3) break;

            // R-18 过滤：如果未启用 R18，跳过限制级内容
            if (!pluginState.config.r18Enabled && (illust.xRestrict !== 0 && illust.xRestrict !== undefined)) {
                r18Filtered++;
                pluginState.logger.info(`[过滤] ID: ${illust.id} 包含限制级内容，已跳过`);
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

        return { illusts: result, totalScanned: illusts.length, r18Filtered };
    }

    /**
     * 搜索关键词并返回前 3 个安全作品
     * 参照 main.py 的 search_illust + _extract_and_download_top_3
     */
    async searchTop3(keyword: string): Promise<ExtractResult> {
        await this.ensureLoggedIn();

        const maxRetries = 3;
        let lastResult: ExtractResult = { illusts: [], totalScanned: 0, r18Filtered: 0 };

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                // 随机偏移量（0~150），参照 main.py
                const randomOffset = Math.floor(Math.random() * 151);
                pluginState.logger.debug(`搜索 "${keyword}"，随机偏移: ${randomOffset}（第 ${attempt + 1} 次尝试）`);

                const result = await this.client.searchIllust(keyword, {
                    offset: randomOffset,
                });

                const illusts = result.illusts || [];
                lastResult = this.extractTop3Safe(illusts, true);

                // 累计统计
                if (lastResult.illusts.length > 0) {
                    return lastResult;
                }

                // 如果是因为 R-18 过滤导致为空，尝试重试
                if (lastResult.r18Filtered > 0) {
                    pluginState.logger.info(`搜索 "${keyword}" 第 ${attempt + 1} 次结果全被 R-18 过滤（过滤 ${lastResult.r18Filtered} 个），重试中...`);
                    continue;
                }

                // 不是因为 R-18，是真的没结果，直接返回
                return lastResult;
            } catch (error) {
                pluginState.logger.error('Pixiv 搜索失败:', error);
                throw error;
            }
        }

        pluginState.logger.warn(`搜索 "${keyword}" 重试 ${maxRetries} 次后仍无安全结果`);
        return lastResult;
    }

    /**
     * 获取推荐流并返回前 3 个安全作品
     * 参照 main.py 的 get_recommended + _extract_and_download_top_3
     */
    async getRandomTop3(): Promise<ExtractResult> {
        await this.ensureLoggedIn();

        const maxRetries = 3;
        let lastResult: ExtractResult = { illusts: [], totalScanned: 0, r18Filtered: 0 };

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                const result = await this.client.illustRecommended();
                const illusts = result.illusts || [];
                // 推荐流本身有动态性，加上本地打乱效果更好
                lastResult = this.extractTop3Safe(illusts, true);

                if (lastResult.illusts.length > 0) {
                    return lastResult;
                }

                // 如果是因为 R-18 过滤导致为空，尝试重试
                if (lastResult.r18Filtered > 0) {
                    pluginState.logger.info(`推荐第 ${attempt + 1} 次结果全被 R-18 过滤（过滤 ${lastResult.r18Filtered} 个），重试中...`);
                    continue;
                }

                // 不是因为 R-18，是真的没结果
                return lastResult;
            } catch (error) {
                pluginState.logger.error('Pixiv 推荐获取失败:', error);
                throw error;
            }
        }

        pluginState.logger.warn(`推荐重试 ${maxRetries} 次后仍无安全结果`);
        return lastResult;
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
}

export const pixivService = new PixivService();
