/**
 * Pixiv 命令处理器
 *
 * 命令：
 *   #p站           → 随机推荐图片（合并转发）
 *   #p站 关键词    → 搜索并返回图片（合并转发）
 *   #pid 123 456   → 按 PID 获取指定作品（合并转发，支持空格/逗号分隔）
 */

import { OB11Message } from 'napcat-types/napcat-onebot';
import { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';
import { pixivService, SafeIllust, ExtractResult, PidFetchResult } from '../services/pixiv.service';
import { sendReply, sendForwardMsg, ForwardNode } from './message-handler';
import { pluginState } from '../core/state';
import { bannedWordsService } from '../services/banned-words.service';

/** 格式化当前时间为 yyyy-MM-dd HH:mm:ss */
function formatDateTime(): string {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

export async function handlePixivCommand(
    ctx: NapCatPluginContext,
    event: OB11Message,
    args: string[]
): Promise<void> {
    const subCommand = args[0] || '';

    if (!subCommand) {
        await handleRandomRecommend(ctx, event);
        return;
    }

    const keyword = args.join(' ');
    await handleSearch(ctx, event, keyword);
}

/** PID 分隔符：空格、英文逗号、中文逗号及其任意组合 */
const PID_SEPARATOR = /[\s,，]+/;

/** 解析 pid 命令参数，无效输入返回 null */
function parsePidList(args: string[]): number[] | null {
    const raw = args.join(' ').trim();
    if (!raw) return [];

    const tokens = raw.split(PID_SEPARATOR).filter(Boolean);
    if (tokens.length === 0) return [];

    const ids: number[] = [];
    const seen = new Set<number>();

    for (const token of tokens) {
        if (!/^\d+$/.test(token)) return null;

        const pid = Number(token);
        if (!Number.isSafeInteger(pid) || pid <= 0) return null;

        if (!seen.has(pid)) {
            seen.add(pid);
            ids.push(pid);
        }
    }

    return ids;
}

export async function handlePidCommand(
    ctx: NapCatPluginContext,
    event: OB11Message,
    args: string[]
): Promise<void> {
    const prefix = pluginState.config.commandPrefix || '#';
    const usage = `用法: ${prefix}pid 12345678 87654321 或 12345678,87654321`;

    const ids = parsePidList(args);
    if (ids === null || ids.length === 0) {
        await sendReply(ctx, event, usage);
        return;
    }

    try {
        await sendReply(ctx, event, `🔢 正在获取 ${ids.length} 个 PID 对应的作品...`);
        const result = await pixivService.getIllustsByIds(ids);
        const summaryLines = buildPidSummaryLines(result);

        if (result.illusts.length === 0) {
            const summary = summaryLines.length > 0 ? `\n${summaryLines.join('\n')}` : '';
            await sendReply(ctx, event, `未找到可发送的作品。${summary}`);
            return;
        }

        const cmdTime = formatDateTime();
        const senderName = event.sender?.card || event.sender?.nickname || '未知用户';
        const userId = event.sender?.user_id || event.user_id || '未知QQ号';
        const nodes = await buildForwardNodes(result.illusts, `🔢 PID 获取 | 来自 ${senderName} (${userId})\n${cmdTime}\n\n`);
        if (nodes.length === 0) {
            await sendReply(ctx, event, '图片下载失败，请稍后重试。');
            return;
        }

        const isGroup = event.message_type === 'group';
        const target = isGroup ? event.group_id! : event.user_id;
        const ok = await sendForwardMsg(ctx, target, isGroup, nodes);
        if (!ok) {
            await sendReply(ctx, event, '⚠️ 合并转发消息发送失败，请稍后重试。');
            return;
        }

        if (summaryLines.length > 0) {
            await sendReply(ctx, event, summaryLines.join('\n'));
        }
    } catch (error) {
        pluginState.logger.error('Pixiv PID 获取错误:', error);
        await sendReply(ctx, event, `PID 获取失败: ${error instanceof Error ? error.message : '未知错误'}`);
    }
}

function buildFilterParts(result: Pick<ExtractResult, 'r18Filtered' | 'sensitiveFiltered' | 'bannedFiltered' | 'duplicateFiltered'>): string[] {
    const parts: string[] = [];
    if (result.r18Filtered > 0) parts.push(`R-18: ${result.r18Filtered}`);
    if (result.sensitiveFiltered > 0) parts.push(`敏感: ${result.sensitiveFiltered}`);
    if (result.bannedFiltered > 0) parts.push(`违禁词: ${result.bannedFiltered}`);
    if (result.duplicateFiltered > 0) parts.push(`近期重复: ${result.duplicateFiltered}`);
    return parts;
}

function buildPidSummaryLines(result: PidFetchResult): string[] {
    const lines: string[] = [];

    if (result.truncatedIds.length > 0) {
        lines.push(`⚠️ 超过上限，已忽略 PID: ${result.truncatedIds.join('、')}`);
    }
    if (result.invalidIds.length > 0) {
        lines.push(`❓ 不存在或无效的 PID: ${result.invalidIds.join('、')}`);
    }
    if (result.filteredIds.length > 0) {
        const filterParts = buildFilterParts(result);
        const suffix = filterParts.length > 0 ? `（${filterParts.join('、')}）` : '';
        lines.push(`🚫 因过滤跳过的 PID: ${result.filteredIds.join('、')}${suffix}`);
    }
    if (result.failedIds.length > 0) {
        lines.push(`⚠️ 请求失败的 PID: ${result.failedIds.join('、')}`);
    }

    return lines;
}

/**
 * 构建包含 3 张图片的合并转发节点
 * 一个节点内放入 3 张图 + 对应信息
 */
async function buildForwardNodes(illusts: SafeIllust[], title: string): Promise<ForwardNode[]> {
    // 并行下载所有图片
    const downloadResults = await Promise.allSettled(
        illusts.map(illust => pixivService.downloadImage(illust.imageUrl))
    );

    // 构建单个节点的 content：每张图片 + 文字信息交替排列
    const content: Array<{ type: string; data: Record<string, unknown> }> = [];

    // 在开头添加摘要信息
    content.push({
        type: 'text',
        data: { text: title },
    });

    for (let i = 0; i < illusts.length; i++) {
        const result = downloadResults[i];
        if (result.status !== 'fulfilled') {
            pluginState.logger.warn(`第 ${i + 1} 张图片下载失败，跳过`);
            continue;
        }

        const localPath = result.value;
        const illust = illusts[i];

        // 添加图片
        content.push({
            type: 'image',
            data: { file: `file://${localPath}` },
        });

        // 添加文字信息
        content.push({
            type: 'text',
            data: { text: `\n📌 ${illust.title}\n🎨 ${illust.userName}\n🔗 ID: ${illust.id}\n` },
        });
    }

    if (content.length <= 1) {
        // 只有标题文本节点，没有图片被成功加入
        return [];
    }

    // 一个合并转发节点包含所有图片
    const node: ForwardNode = {
        type: 'node',
        data: {
            nickname: 'Pixiv Bot',
            user_id: pluginState.selfId || '10000',
            content,
        },
    };

    return [node];
}

/**
 * 通用 Pixiv 获取并发送处理
 */
async function handlePixivFetch(
    ctx: NapCatPluginContext,
    event: OB11Message,
    options: {
        fetchFn: () => Promise<ExtractResult>;
        loadingMsg: string;
        titlePrefix: string;
        errorLabel: string;
    },
): Promise<void> {
    try {
        await sendReply(ctx, event, options.loadingMsg);
        const result = await options.fetchFn();

        if (result.illusts.length === 0) {
            const totalFiltered = result.r18Filtered + result.sensitiveFiltered + result.bannedFiltered + result.duplicateFiltered;
            if (totalFiltered > 0) {
                const parts = buildFilterParts(result);
                await sendReply(ctx, event, `🔞 结果均为限制级内容或近期已发送过（已过滤 ${parts.join('、')}），换个时间再试试吧~`);
            } else {
                await sendReply(ctx, event, '未找到相关内容。');
            }
            return;
        }

        const cmdTime = formatDateTime();
        const senderName = event.sender?.card || event.sender?.nickname || '未知用户';
        const userId = event.sender?.user_id || event.user_id || '未知QQ号';
        const nodes = await buildForwardNodes(result.illusts, `${options.titlePrefix} | 来自 ${senderName} (${userId})\n${cmdTime}\n\n`);
        if (nodes.length === 0) {
            await sendReply(ctx, event, '图片下载失败，请稍后重试。');
            return;
        }

        const isGroup = event.message_type === 'group';
        const target = isGroup ? event.group_id! : event.user_id;
        const ok = await sendForwardMsg(ctx, target, isGroup, nodes);
        if (!ok) {
            await sendReply(ctx, event, '⚠️ 合并转发消息发送失败，请稍后重试。');
        }
    } catch (error) {
        pluginState.logger.error(`Pixiv ${options.errorLabel}错误:`, error);
        await sendReply(ctx, event, `${options.errorLabel}失败: ${error instanceof Error ? error.message : '未知错误'}`);
    }
}

async function handleRandomRecommend(ctx: NapCatPluginContext, event: OB11Message) {
    await handlePixivFetch(ctx, event, {
        fetchFn: () => pixivService.getRandomTop3(),
        loadingMsg: '🌟 正在获取随机推荐...',
        titlePrefix: '🌟 随机推荐',
        errorLabel: '获取推荐',
    });
}

async function handleSearch(ctx: NapCatPluginContext, event: OB11Message, keyword: string) {
    // 违禁词关键词拦截
    const bannedHit = bannedWordsService.checkKeyword(keyword);
    if (bannedHit) {
        pluginState.logger.info(`[违禁词] 搜索关键词 "${keyword}" 命中违禁词: "${bannedHit.pattern}" (${bannedHit.matchType})`);
        await sendReply(ctx, event, `🚫 搜索关键词包含违禁内容，已拒绝搜索。`);
        return;
    }

    await handlePixivFetch(ctx, event, {
        fetchFn: () => pixivService.searchTop3(keyword),
        loadingMsg: `🔍 正在搜索: ${keyword}...`,
        titlePrefix: `🔍 搜索: ${keyword}`,
        errorLabel: '搜索',
    });
}
