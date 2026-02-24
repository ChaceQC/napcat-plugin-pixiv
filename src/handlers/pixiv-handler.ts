/**
 * Pixiv 命令处理器
 *
 * 命令：
 *   #p站         → 随机推荐 3 张图片（合并转发）
 *   #p站 关键词  → 搜索并返回 3 张图片（合并转发）
 */

import { OB11Message } from 'napcat-types/napcat-onebot';
import { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';
import { pixivService, SafeIllust, ExtractResult } from '../services/pixiv.service';
import { sendReply, sendForwardMsg, ForwardNode } from './message-handler';
import { pluginState } from '../core/state';
import { bannedWordsService } from '../services/banned-words.service';

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

    if (content.length === 0) {
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

async function handleRandomRecommend(ctx: NapCatPluginContext, event: OB11Message) {
    try {
        await sendReply(ctx, event, '🌟 正在获取随机推荐...');

        const now = new Date();
        const cmdTime = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

        const result = await pixivService.getRandomTop3();

        if (result.illusts.length === 0) {
            const totalFiltered = result.r18Filtered + result.sensitiveFiltered + result.bannedFiltered + result.duplicateFiltered;
            if (totalFiltered > 0) {
                const parts: string[] = [];
                if (result.r18Filtered > 0) parts.push(`R-18: ${result.r18Filtered}`);
                if (result.sensitiveFiltered > 0) parts.push(`敏感: ${result.sensitiveFiltered}`);
                if (result.bannedFiltered > 0) parts.push(`违禁词: ${result.bannedFiltered}`);
                if (result.duplicateFiltered > 0) parts.push(`近期重复: ${result.duplicateFiltered}`);
                await sendReply(ctx, event, `🔞 推荐内容均为限制级内容或近期已发送过（已过滤 ${parts.join('、')}），换个时间再试试吧~`);
            } else {
                await sendReply(ctx, event, '未找到推荐内容。');
            }
            return;
        }

        const senderName = event.sender?.card || event.sender?.nickname || '未知用户';
        const userId = event.sender?.user_id || event.user_id || '未知QQ号';
        const nodes = await buildForwardNodes(result.illusts, `🌟 随机推荐 | 来自 ${senderName} (${userId})\n${cmdTime}\n\n`);
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
        pluginState.logger.error('Pixiv 随机推荐错误:', error);
        await sendReply(ctx, event, `获取推荐失败: ${error instanceof Error ? error.message : '未知错误'}`);
    }
}

async function handleSearch(ctx: NapCatPluginContext, event: OB11Message, keyword: string) {
    try {
        // 违禁词关键词拦截
        const bannedHit = bannedWordsService.checkKeyword(keyword);
        if (bannedHit) {
            pluginState.logger.info(`[违禁词] 搜索关键词 "${keyword}" 命中违禁词: "${bannedHit.pattern}" (${bannedHit.matchType})`);
            await sendReply(ctx, event, `🚫 搜索关键词包含违禁内容，已拒绝搜索。`);
            return;
        }

        await sendReply(ctx, event, `🔍 正在搜索: ${keyword}...`);

        const result = await pixivService.searchTop3(keyword);

        const now = new Date();
        const cmdTime = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

        if (result.illusts.length === 0) {
            const totalFiltered = result.r18Filtered + result.sensitiveFiltered + result.bannedFiltered + result.duplicateFiltered;
            if (totalFiltered > 0) {
                const parts: string[] = [];
                if (result.r18Filtered > 0) parts.push(`R-18: ${result.r18Filtered}`);
                if (result.sensitiveFiltered > 0) parts.push(`敏感: ${result.sensitiveFiltered}`);
                if (result.bannedFiltered > 0) parts.push(`违禁词: ${result.bannedFiltered}`);
                if (result.duplicateFiltered > 0) parts.push(`近期重复: ${result.duplicateFiltered}`);
                await sendReply(ctx, event, `🔞 「${keyword}」的搜索结果均为限制级内容或近期已发送过（已过滤 ${parts.join('、')}），请尝试其他关键词~`);
            } else {
                await sendReply(ctx, event, '未找到相关内容。');
            }
            return;
        }

        const senderName = event.sender?.card || event.sender?.nickname || '未知用户';
        const userId = event.sender?.user_id || event.user_id || '未知QQ号';
        const nodes = await buildForwardNodes(result.illusts, `🔍 搜索: ${keyword} | 来自 ${senderName} (${userId})\n${cmdTime}\n\n`);
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
        pluginState.logger.error('Pixiv 搜索错误:', error);
        await sendReply(ctx, event, `搜索失败: ${error instanceof Error ? error.message : '未知错误'}`);
    }
}
