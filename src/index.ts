/**
 * NapCat 插件模板 - 主入口
 *
 * 导出 PluginModule 接口定义的生命周期函数，NapCat 加载插件时会调用这些函数。
 *
 * 生命周期：
 *   plugin_init        → 插件加载时调用（必选）
 *   plugin_onmessage   → 收到事件时调用（需通过 post_type 判断事件类型）
 *   plugin_onevent     → 收到所有 OneBot 事件时调用
 *   plugin_cleanup     → 插件卸载/重载时调用
 *
 * 配置相关：
 *   plugin_config_ui          → 导出配置 Schema，用于 WebUI 自动生成配置面板
 *   plugin_get_config         → 自定义配置读取
 *   plugin_set_config         → 自定义配置保存
 *   plugin_on_config_change   → 配置变更回调
 *
 * @author ChaceQC
 * @license MIT
 */

import type {
    PluginModule,
    PluginConfigSchema,
    PluginConfigUIController,
    NapCatPluginContext,
} from 'napcat-types/napcat-onebot/network/plugin/types';
import { EventType } from 'napcat-types/napcat-onebot/event/index';

import { buildConfigSchema } from './config';
import { pluginState } from './core/state';
import { handleMessage, clearCooldownMap } from './handlers/message-handler';
import { registerApiRoutes } from './services/api-service';
import { pixivService } from './services/pixiv.service';
import type { PluginConfig } from './types';

// ==================== 缓存清理定时器 ====================

const CACHE_TIMER_ID = 'cache-auto-clean';

/**
 * 注册/重建缓存自动清理定时器
 * 配置变更时调用此函数可实时刷新定时器间隔
 */
function registerCacheCleanTimer(): void {
    // 先清除旧定时器
    const oldTimer = pluginState.timers.get(CACHE_TIMER_ID);
    if (oldTimer) {
        clearInterval(oldTimer);
        pluginState.timers.delete(CACHE_TIMER_ID);
        pluginState.logger.debug('已清除旧的缓存清理定时器');
    }

    const minutes = pluginState.config.cacheAutoCleanMinutes ?? 30;
    if (minutes <= 0) {
        pluginState.logger.info('缓存自动清理已禁用（间隔为 0）');
        return;
    }

    const intervalMs = minutes * 60 * 1000;
    const timer = setInterval(() => {
        pluginState.logger.debug('执行自动缓存清理...');
        pixivService.smartCleanupCache();
    }, intervalMs);

    pluginState.timers.set(CACHE_TIMER_ID, timer);
    pluginState.logger.info(`缓存自动清理定时器已注册，间隔 ${minutes} 分钟`);
}

// ==================== 配置 UI Schema ====================

/** NapCat WebUI 读取此导出来展示配置面板 */
export let plugin_config_ui: PluginConfigSchema = [];

// ==================== 生命周期函数 ====================

/**
 * 插件初始化（必选）
 * 加载配置、注册 WebUI 路由和页面
 */
export const plugin_init: PluginModule['plugin_init'] = async (ctx) => {
    try {
        // 1. 初始化全局状态（加载配置）
        pluginState.init(ctx);

        ctx.logger.info('插件初始化中...');

        // 2. 生成配置 Schema（用于 NapCat WebUI 配置面板）
        plugin_config_ui = buildConfigSchema(ctx);

        // 3. 注册 WebUI 页面和静态资源
        registerWebUI(ctx);

        // 4. 注册 API 路由
        registerApiRoutes(ctx);

        // 5. Initialize Pixiv Service
        await pixivService.init();

        // 6. 注册缓存自动清理定时器
        registerCacheCleanTimer();

        ctx.logger.info('插件初始化完成');
    } catch (error) {
        ctx.logger.error('插件初始化失败:', error);
    }
};

/**
 * 消息/事件处理（可选）
 * 收到事件时调用，需通过 post_type 判断是否为消息事件
 */
export const plugin_onmessage: PluginModule['plugin_onmessage'] = async (ctx, event) => {
    // 仅处理消息事件
    if (event.post_type !== EventType.MESSAGE) return;
    // 检查插件是否启用
    if (!pluginState.config.enabled) return;
    // 委托给消息处理器
    await handleMessage(ctx, event);
};

/**
 * 插件卸载/重载（可选）
 * 必须清理定时器、关闭连接等资源
 */
export const plugin_cleanup: PluginModule['plugin_cleanup'] = async (ctx) => {
    try {
        pluginState.cleanup();
        pixivService.cleanupCacheAll();
        ctx.logger.info('插件已卸载');
    } catch (e) {
        ctx.logger.warn('插件卸载时出错:', e);
    }
};

// ==================== 配置管理钩子 ====================

/** 获取当前配置 */
export const plugin_get_config: PluginModule['plugin_get_config'] = async (ctx) => {
    return pluginState.config;
};

/** 设置配置（完整替换，由 NapCat WebUI 调用） */
export const plugin_set_config: PluginModule['plugin_set_config'] = async (ctx, config) => {
    pluginState.replaceConfig(config as PluginConfig);
    ctx.logger.info('配置已通过 WebUI 更新，正在重新初始化 Pixiv 服务...');
    await pixivService.init();
    // 重建缓存清理定时器（配置可能变更了间隔）
    registerCacheCleanTimer();
};

/**
 * 配置变更回调
 * 当 WebUI 中修改单个配置项时触发（需配置项标记 reactive: true）
 */
export const plugin_on_config_change: PluginModule['plugin_on_config_change'] = async (
    ctx, ui, key, value, currentConfig
) => {
    try {
        pluginState.updateConfig({ [key]: value });
        ctx.logger.debug(`配置项 ${key} 已更新`);
        if (['pixivRefreshToken', 'r18Enabled'].includes(key)) {
            await pixivService.init();
        }
        if (key === 'cooldownSeconds') {
            clearCooldownMap();
            ctx.logger.info(`冷却时间已更新为 ${value} 秒，已重置所有冷却`);
        }
        if (key === 'cacheAutoCleanMinutes') {
            registerCacheCleanTimer();
            ctx.logger.info(`缓存清理间隔已更新为 ${value} 分钟`);
        }
    } catch (err) {
        ctx.logger.error(`更新配置项 ${key} 失败:`, err);
    }
};

// ==================== 内部函数 ====================

/**
 * 注册 WebUI 页面和静态资源
 */
function registerWebUI(ctx: NapCatPluginContext): void {
    const router = ctx.router;

    // 托管前端静态资源（构建产物在 webui/ 目录下）
    // 访问路径: /plugin/<plugin-id>/files/static/
    router.static('/static', 'webui');

    // 注册仪表盘页面（显示在 NapCat WebUI 侧边栏）
    // 访问路径: /plugin/<plugin-id>/page/dashboard
    router.page({
        path: 'dashboard',
        title: '插件仪表盘',
        htmlFile: 'webui/index.html',
        description: '插件管理控制台',
    });

    ctx.logger.debug('WebUI 路由注册完成');
}
