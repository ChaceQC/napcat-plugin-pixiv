import axios from 'axios';
import crypto from 'crypto';
import qs from 'querystring';
import decamelizeKeys from 'decamelize-keys';
import camelcaseKeys from 'camelcase-keys';

const baseURL = 'https://app-api.pixiv.net/';

// Updated headers to mimic a more recent app version
// Using headers similar to recent PixivPy or known working configs
const headers = {
    'App-OS': 'ios',
    'App-OS-Version': '14.6',
    'App-Version': '7.13.3',
    'User-Agent': 'PixivIOSApp/7.13.3 (iOS 14.6; iPhone13,2)',
};

const instance = axios.create({
    baseURL,
    headers,
});

const CLIENT_ID = 'MOBrBDS8blbauoSck0ZfDbtuzpyT';
const CLIENT_SECRET = 'lsACyCD94FhDUtGTXi3QzcFE2uU1hqtDaKeqrdwj';
const HASH_SECRET = '28c1fdd170a5204386cb1313c7077b34f83e4aaf4aa829ce78c231e05b0bae2c';

export class PixivClient {
    private refreshToken: string = '';
    private auth: any = null;
    private nextUrl: string | null = null;
    private camelcaseKeys: boolean = true;

    constructor(options: { camelcaseKeys?: boolean } = {}) {
        this.camelcaseKeys = options.camelcaseKeys !== false;
    }

    async login(refreshToken: string) {
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
                { headers: requestHeaders }
            );

            this.auth = response.data.response;
            this.refreshToken = response.data.response.refresh_token;

            const accessToken = response.data.response.access_token;
            instance.defaults.headers.common['Authorization'] = `Bearer ${accessToken}`;

            return this.camelcaseKeys ? camelcaseKeys(this.auth, { deep: true }) : this.auth;
        } catch (error: any) {
            console.error('Pixiv Login Error Details:', error.response?.data || error.message);
            throw error;
        }
    }

    async searchIllust(word: string, params: any = {}) {
        const defaultParams = {
            word,
            searchTarget: 'partial_match_for_tags',
            sort: 'popular_desc',
            filter: 'for_ios',
        };
        return this.fetch('/v1/search/illust', {
            params: { ...defaultParams, ...params }
        });
    }

    async illustRecommended(params: any = {}) {
        const defaultParams = {
            contentType: 'illust',
            includeRankingLabel: 'true',
            filter: 'for_ios',
        };
        return this.fetch('/v1/illust/recommended', {
            params: { ...defaultParams, ...params }
        });
    }

    async fetch(url: string, options: any = {}) {
        try {
            return await this._request(url, options);
        } catch (error) {
            // Attempt to refresh token if 401? 
            // Pixiv OAuth usually expires in 1 hour.
            // Simplified: Just retry login once if error looks like auth error
            // checks omitted for brevity, assuming caller handles re-login or init calls login
            throw error;
        }
    }

    private async _request(url: string, options: any = {}) {
        if (options.params) {
            options.params = decamelizeKeys(options.params);
        }

        const response = await instance.request({
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
