declare module 'pixiv-img' {
    export default function pixivImg(url: string, dest?: string): Promise<string>;
}
