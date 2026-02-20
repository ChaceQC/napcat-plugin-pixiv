/**
 * 消息处理器
 *
 * 处理接收到的 QQ 消息事件，包含：
 * - 命令解析与分发
 * - CD 冷却管理
 * - 消息发送工具函数
 *
 * 最佳实践：将不同类型的业务逻辑拆分到不同的 handler 文件中，
 * 保持每个文件职责单一。
 */

import type { OB11Message, OB11PostSendMsg } from 'napcat-types/napcat-onebot';
import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';
import { pluginState } from '../core/state';
import { handlePixivCommand } from './pixiv-handler';

// ==================== 全局频次限制（滑动窗口） ====================

const requestTimestamps: number[] = [];

/**
 * 全局频次限制检查
 * 使用滑动窗口算法，限制每分钟内所有来源（群+私聊）的总请求数
 * @returns true 表示已达到频次限制
 */
function isRateLimited(): boolean {
    const limit = pluginState.config.rateLimitPerMinute ?? 60;
    if (limit <= 0) return false; // 0 表示不限制

    const now = Date.now();
    const windowMs = 60_000; // 1 分钟

    // 清理超过窗口的旧记录
    while (requestTimestamps.length > 0 && requestTimestamps[0] <= now - windowMs) {
        requestTimestamps.shift();
    }

    if (requestTimestamps.length >= limit) {
        pluginState.logger.debug(`全局频次限制触发: ${requestTimestamps.length}/${limit} 次/分钟`);
        return true;
    }

    requestTimestamps.push(now);
    return false;
}

// ==================== CD 冷却管理 ====================

/** CD 冷却记录 key: groupId, value: 过期时间戳 */
const cooldownMap = new Map<string, number>();

/**
 * 检查是否在 CD 中（同群共享冷却）
 * @returns 剩余秒数，0 表示可用
 */
function getCooldownRemaining(groupId: number | string): number {
    const cdSeconds = Number(pluginState.config.cooldownSeconds) || 0;
    if (cdSeconds <= 0) return 0;

    const key = String(groupId);
    const expireTime = cooldownMap.get(key);
    if (!expireTime) return 0;

    const remaining = Math.ceil((expireTime - Date.now()) / 1000);
    if (remaining <= 0) {
        cooldownMap.delete(key);
        return 0;
    }
    pluginState.logger.debug(`群 ${groupId} CD 剩余 ${remaining} 秒`);
    return remaining;
}

/** 设置 CD 冷却（同群共享） */
function setCooldown(groupId: number | string): void {
    const cdSeconds = Number(pluginState.config.cooldownSeconds) || 0;
    if (cdSeconds <= 0) return;
    cooldownMap.set(String(groupId), Date.now() + cdSeconds * 1000);
    pluginState.logger.debug(`群 ${groupId} 设置 CD ${cdSeconds} 秒`);
}

/** 清空所有冷却记录（配置变更时调用） */
export function clearCooldownMap(): void {
    cooldownMap.clear();
}

// ==================== 消息发送工具 ====================

/**
 * 发送消息（通用）
 * 根据消息类型自动发送到群或私聊
 *
 * @param ctx 插件上下文
 * @param event 原始消息事件（用于推断回复目标）
 * @param message 消息内容（支持字符串或消息段数组）
 */
export async function sendReply(
    ctx: NapCatPluginContext,
    event: OB11Message,
    message: OB11PostSendMsg['message']
): Promise<boolean> {
    try {
        const params: OB11PostSendMsg = {
            message,
            message_type: event.message_type,
            ...(event.message_type === 'group' && event.group_id
                ? { group_id: String(event.group_id) }
                : {}),
            ...(event.message_type === 'private' && event.user_id
                ? { user_id: String(event.user_id) }
                : {}),
        };
        await ctx.actions.call('send_msg', params, ctx.adapterName, ctx.pluginManager.config);
        return true;
    } catch (error) {
        pluginState.logger.error('发送消息失败:', error);
        return false;
    }
}

/**
 * 发送群消息
 */
export async function sendGroupMessage(
    ctx: NapCatPluginContext,
    groupId: number | string,
    message: OB11PostSendMsg['message']
): Promise<boolean> {
    try {
        const params: OB11PostSendMsg = {
            message,
            message_type: 'group',
            group_id: String(groupId),
        };
        await ctx.actions.call('send_msg', params, ctx.adapterName, ctx.pluginManager.config);
        return true;
    } catch (error) {
        pluginState.logger.error('发送群消息失败:', error);
        return false;
    }
}

/**
 * 发送私聊消息
 */
export async function sendPrivateMessage(
    ctx: NapCatPluginContext,
    userId: number | string,
    message: OB11PostSendMsg['message']
): Promise<boolean> {
    try {
        const params: OB11PostSendMsg = {
            message,
            message_type: 'private',
            user_id: String(userId),
        };
        await ctx.actions.call('send_msg', params, ctx.adapterName, ctx.pluginManager.config);
        return true;
    } catch (error) {
        pluginState.logger.error('发送私聊消息失败:', error);
        return false;
    }
}

// ==================== 合并转发消息 ====================

/** 合并转发消息节点 */
export interface ForwardNode {
    type: 'node';
    data: {
        nickname: string;
        user_id?: string;
        content: Array<{ type: string; data: Record<string, unknown> }>;
    };
}

/**
 * 发送合并转发消息
 * @param ctx 插件上下文
 * @param target 群号或用户 ID
 * @param isGroup 是否为群消息
 * @param nodes 合并转发节点列表
 */
export async function sendForwardMsg(
    ctx: NapCatPluginContext,
    target: number | string,
    isGroup: boolean,
    nodes: ForwardNode[],
): Promise<boolean> {
    try {
        const actionName = isGroup ? 'send_group_forward_msg' : 'send_private_forward_msg';
        const params: Record<string, unknown> = { message: nodes };
        if (isGroup) {
            params.group_id = String(target);
        } else {
            params.user_id = String(target);
        }
        await ctx.actions.call(
            actionName as 'send_group_forward_msg',
            params as never,
            ctx.adapterName,
            ctx.pluginManager.config,
        );
        return true;
    } catch (error) {
        pluginState.logger.error('发送合并转发消息失败:', error);
        return false;
    }
}

// ==================== 权限检查 ====================

/**
 * 检查群聊中是否有管理员权限
 * 私聊消息默认返回 true
 */
export function isAdmin(event: OB11Message): boolean {
    if (event.message_type !== 'group') return true;
    const role = (event.sender as Record<string, unknown>)?.role;
    return role === 'admin' || role === 'owner';
}

// ==================== 消息处理主函数 ====================

/**
 * 消息处理主函数
 * 在这里实现你的命令处理逻辑
 */
export async function handleMessage(ctx: NapCatPluginContext, event: OB11Message): Promise<void> {
    try {
        const rawMessage = event.raw_message || '';
        const messageType = event.message_type;
        const groupId = event.group_id;
        const userId = event.user_id;

        pluginState.ctx.logger.debug(`收到消息: ${rawMessage} | 类型: ${messageType}`);

        // 群消息：检查该群是否启用
        if (messageType === 'group' && groupId) {
            if (!pluginState.isGroupEnabled(String(groupId))) return;
        }

        // 检查命令前缀
        const prefix = pluginState.config.commandPrefix || '#cmd';
        if (!rawMessage.startsWith(prefix)) return;

        // 解析命令参数
        const args = rawMessage.slice(prefix.length).trim().split(/\s+/);
        const subCommand = args[0]?.toLowerCase() || '';

        // 全局频次限制检查（所有命令共享，群+私聊）
        if (isRateLimited()) {
            await sendReply(ctx, event, '⚠️ 请求过于频繁，请稍后再试。');
            return;
        }

        switch (subCommand) {
            case 'help': {
                const helpText = [
                    `[= 插件帮助 =]`,
                    `${prefix} help - 显示帮助信息`,
                    `${prefix} ping - 测试连通性`,
                    `${prefix} status - 查看运行状态`,
                ].join('\n');
                await sendReply(ctx, event, helpText);
                break;
            }

            case 'ping': {
                // 群消息检查 CD
                if (messageType === 'group' && groupId) {
                    const remaining = getCooldownRemaining(groupId);
                    if (remaining > 0) {
                        await sendReply(ctx, event, `请等待 ${remaining} 秒后再试`);
                        return;
                    }
                    setCooldown(groupId);
                }

                await sendReply(ctx, event, 'pong!');
                pluginState.incrementProcessed();
                break;
            }

            case 'p站': {
                // 群消息检查 CD
                if (messageType === 'group' && groupId) {
                    const remaining = getCooldownRemaining(groupId);
                    if (remaining > 0) {
                        await sendReply(ctx, event, `请等待 ${remaining} 秒后再试`);
                        return;
                    }
                    setCooldown(groupId);
                }

                await handlePixivCommand(ctx, event, args.slice(1));
                pluginState.incrementProcessed();
                break;
            }

            case 'status': {
                const statusText = [
                    `[= 插件状态 =]`,
                    `运行时长: ${pluginState.getUptimeFormatted()}`,
                    `今日处理: ${pluginState.stats.todayProcessed}`,
                    `总计处理: ${pluginState.stats.processed}`,
                ].join('\n');
                await sendReply(ctx, event, statusText);
                break;
            }

            default: {
                // TODO: 在这里处理你的主要命令逻辑
                break;
            }
        }
    } catch (error) {
        pluginState.logger.error('处理消息时出错:', error);
    }
}
