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
    private extractTop3Safe(illusts: any[], shuffle: boolean = true): SafeIllust[] {
        // 打乱列表实现随机效果
        if (shuffle && illusts.length > 0) {
            const shuffled = [...illusts];
            for (let i = shuffled.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
            }
            illusts = shuffled;
        }

        const result: SafeIllust[] = [];
        for (const illust of illusts) {
            if (result.length >= 3) break;

            // R-18 过滤：如果未启用 R18，跳过限制级内容
            if (!pluginState.config.r18Enabled && (illust.xRestrict !== 0 && illust.xRestrict !== undefined)) {
                pluginState.logger.debug(`[过滤] ID: ${illust.id} 包含限制级内容，已跳过`);
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

        return result;
    }

    /**
     * 搜索关键词并返回前 3 个安全作品
     * 参照 main.py 的 search_illust + _extract_and_download_top_3
     */
    async searchTop3(keyword: string): Promise<SafeIllust[]> {
        await this.ensureLoggedIn();

        try {
            // 随机偏移量（0~150），参照 main.py
            const randomOffset = Math.floor(Math.random() * 151);
            pluginState.logger.debug(`搜索 "${keyword}"，随机偏移: ${randomOffset}`);

            const result = await this.client.searchIllust(keyword, {
                offset: randomOffset,
            });

            const illusts = result.illusts || [];
            return this.extractTop3Safe(illusts, true);
        } catch (error) {
            pluginState.logger.error('Pixiv 搜索失败:', error);
            throw error;
        }
    }

    /**
     * 获取推荐流并返回前 3 个安全作品
     * 参照 main.py 的 get_recommended + _extract_and_download_top_3
     */
    async getRandomTop3(): Promise<SafeIllust[]> {
        await this.ensureLoggedIn();

        try {
            const result = await this.client.illustRecommended();
            const illusts = result.illusts || [];
            // 推荐流本身有动态性，加上本地打乱效果更好
            return this.extractTop3Safe(illusts, true);
        } catch (error) {
            pluginState.logger.error('Pixiv 推荐获取失败:', error);
            throw error;
        }
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
