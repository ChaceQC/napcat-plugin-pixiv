import axios, { type AxiosInstance } from 'axios';
import crypto from 'crypto';
import qs from 'querystring';
import decamelizeKeys from 'decamelize-keys';
import camelcaseKeys from 'camelcase-keys';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import type { Agent as HttpAgent } from 'http';
import type { Agent as HttpsAgent } from 'https';

import { pluginState } from '../core/state';

const baseURL = 'https://app-api.pixiv.net/';

// Updated headers to mimic a more recent app version
// Using headers similar to recent PixivPy or known working configs
const headers = {
    'App-OS': 'android',
    'App-OS-Version': '14.0',
    'App-Version': '5.146.0',
    'User-Agent': 'PixivAndroidApp/5.146.0 (Android 14.0; Pixel 8 Pro)',
    'Accept-Language': 'zh-CN',
};

const CLIENT_ID = 'MOBrBDS8blbauoSck0ZfDbtuzpyT';
const CLIENT_SECRET = 'lsACyCD94FhDUtGTXi3QzcFE2uU1hqtDaKeqrdwj';
const HASH_SECRET = '28c1fdd170a5204386cb1313c7077b34f83e4aaf4aa829ce78c231e05b0bae2c';

/**
 * 根据代理 URL 创建对应的 Agent
 * 支持 http://, https://, socks5://, socks4:// 协议
 */
function createProxyAgent(proxyUrl: string): HttpAgent | HttpsAgent | undefined {
    if (!proxyUrl) return undefined;

    const lower = proxyUrl.toLowerCase();
    if (lower.startsWith('socks')) {
        return new SocksProxyAgent(proxyUrl);
    }
    // http:// 和 https:// 代理均使用 HttpsProxyAgent（它同时支持两种）
    return new HttpsProxyAgent(proxyUrl);
}

export class PixivClient {
    private refreshToken: string = '';
    private auth: any = null;
    private nextUrl: string | null = null;
    private camelcaseKeys: boolean = true;
    private loginPromise: Promise<any> | null = null;
    private instance: AxiosInstance;
    private proxyAgent: HttpAgent | HttpsAgent | undefined;

    constructor(options: { camelcaseKeys?: boolean } = {}) {
        this.camelcaseKeys = options.camelcaseKeys !== false;
        this.instance = axios.create({
            baseURL,
            headers,
            timeout: 60000, // 添加 1 分钟全局超时，防止网络死锁不释放
        });
    }

    /**
     * 应用代理配置
     * @param proxyUrl 代理地址，如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080，空字符串表示不使用代理
     */
    applyProxy(proxyUrl?: string): void {
        if (proxyUrl) {
            this.proxyAgent = createProxyAgent(proxyUrl);
            this.instance.defaults.httpAgent = this.proxyAgent;
            this.instance.defaults.httpsAgent = this.proxyAgent;
            pluginState.logger.info(`[PixivClient] 已配置代理: ${proxyUrl}`);
        } else {
            this.proxyAgent = undefined;
            this.instance.defaults.httpAgent = undefined;
            this.instance.defaults.httpsAgent = undefined;
            pluginState.logger.info('[PixivClient] 未使用代理，直连模式');
        }
    }

    /**
     * 获取当前代理 Agent（供图片下载等外部模块复用）
     */
    getProxyAgent(): HttpAgent | HttpsAgent | undefined {
        return this.proxyAgent;
    }

    async login(refreshToken: string) {
        // 如果有正在进行的登录，则等待其完成，避免并发导致的大量 400 失败
        if (this.loginPromise) {
            return this.loginPromise;
        }

        this.loginPromise = (async () => {
            this.refreshToken = refreshToken;

            const now = new Date();
            const localTime = now.toISOString().replace(/\.\d{3}Z$/, '+00:00');

            const requestHeaders = {
                ...headers,
                'X-Client-Time': localTime,
                'X-Client-Hash': crypto.createHash('md5')
                    .update(Buffer.from(`${localTime}${HASH_SECRET}`, 'utf8'))
                    .digest('hex'),
            };

            const data: any = {
                clientId: CLIENT_ID,
                clientSecret: CLIENT_SECRET,
                getSecureUrl: 1,
                grantType: 'refresh_token',
                refreshToken: this.refreshToken,
            };

            try {
                const response = await axios.post(
                    'https://oauth.secure.pixiv.net/auth/token',
                    qs.stringify(decamelizeKeys(data)),
                    {
                        headers: requestHeaders,
                        httpAgent: this.proxyAgent,
                        httpsAgent: this.proxyAgent,
                    }
                );

                this.auth = response.data.response;
                this.refreshToken = response.data.response.refresh_token;

                const accessToken = response.data.response.access_token;
                this.instance.defaults.headers.common['Authorization'] = `Bearer ${accessToken}`;

                return this.camelcaseKeys ? camelcaseKeys(this.auth, { deep: true }) : this.auth;
            } catch (error: any) {
                console.error('Pixiv Login Error Details:', error.response?.data || error.message);
                throw error;
            } finally {
                this.loginPromise = null;
            }
        })();

        return this.loginPromise;
    }

    async searchIllust(word: string, params: any = {}) {
        const searchTarget = pluginState.config.searchTarget || 'partial_match_for_tags';
        const sort = pluginState.config.searchSort || 'date_desc';
        const defaultParams = {
            word,
            searchTarget,
            sort,
        };
        return this.fetch('/v1/search/illust', {
            params: { ...defaultParams, ...params }
        });
    }

    async illustRecommended(params: any = {}) {
        const defaultParams = {
            contentType: 'illust',
            includeRankingLabel: 'true',
            // filter: 'for_ios',
        };
        return this.fetch('/v1/illust/recommended', {
            params: { ...defaultParams, ...params }
        });
    }

    async fetch(url: string, options: any = {}) {
        const maxRetries = 3;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await this._request(url, options);
            } catch (error: any) {
                const status = error.response?.status;

                // access_token 过期（Pixiv OAuth 通常 1 小时过期），自动刷新并重试
                if ((status === 400 || status === 403 || status === 401) && this.refreshToken) {
                    console.log('[PixivClient] access_token 已过期，正在使用 refresh_token 重新获取...');
                    await this.login(this.refreshToken);
                    return await this._request(url, options);
                }

                // 网络级错误（超时、连接中断等），进行重试
                const isNetworkError = !error.response && (
                    error.code === 'ECONNRESET' ||
                    error.code === 'ECONNREFUSED' ||
                    error.code === 'ENOTFOUND' ||
                    error.code === 'ETIMEDOUT' ||
                    error.code === 'ECONNABORTED' ||
                    error.code === 'ERR_NETWORK' ||
                    error.message?.includes('timeout') ||
                    error.message?.includes('socket hang up')
                );

                if (isNetworkError && attempt < maxRetries) {
                    const delay = attempt * 2000; // 递增延迟：2s, 4s
                    console.log(`[PixivClient] 请求 ${url} 网络错误 (${error.code || error.message})，${delay / 1000}s 后重试 (${attempt}/${maxRetries})...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    continue;
                }

                throw error;
            }
        }
        // 不应到达此处，但 TypeScript 需要
        throw new Error(`请求 ${url} 重试 ${maxRetries} 次后仍然失败`);
    }

    private async _request(url: string, options: any = {}) {
        if (options.params) {
            options.params = decamelizeKeys(options.params);
        }

        const response = await this.instance.request({
            url,
            method: options.method || 'GET',
            params: options.params,
            data: options.data,
        });

        const data = response.data;
        this.nextUrl = data.next_url;

        return this.camelcaseKeys ? camelcaseKeys(data, { deep: true }) : data;
    }
}
