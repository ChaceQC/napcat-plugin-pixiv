/**
 * 类型定义文件
 * 定义插件内部使用的接口和类型
 *
 * 注意：OneBot 相关类型（OB11Message, OB11PostSendMsg 等）
 * 以及插件框架类型（NapCatPluginContext, PluginModule 等）
 * 均来自 napcat-types 包，无需在此重复定义。
 */

// ==================== 插件配置 ====================

/**
 * 插件主配置接口
 * 在此定义你的插件所需的所有配置项
 */
export interface PluginConfig {
    /** 全局开关：是否启用插件功能 */
    enabled: boolean;
    /** 调试模式：启用后输出详细日志 */
    debug: boolean;
    /** 触发命令前缀，默认为 #cmd */
    commandPrefix: string;
    /** 同一命令请求冷却时间（秒），0 表示不限制 */
    cooldownSeconds?: number;
    pixivRefreshToken?: string;
    /** 是否允许含敏感内容的作品 (sanity_level >= 4) */
    sensitiveEnabled?: boolean;
    r18Enabled?: boolean;
    /** 全局每分钟频次限制（所有群共享），0 表示不限制，默认 60 */
    rateLimitPerMinute?: number;
    /** 搜索匹配模式 */
    searchTarget?: 'partial_match_for_tags' | 'exact_match_for_tags' | 'title_and_caption';
    /** 搜索排序方式 */
    searchSort?: 'date_desc' | 'date_asc' | 'popular_desc';
    /** 每次返回的图片数量，默认 3 */
    resultCount?: number;
    /** 按群的单独配置 */
    groupConfigs: Record<string, GroupConfig>;
}

/**
 * 群配置
 */
export interface GroupConfig {
    /** 是否启用此群的功能 */
    enabled?: boolean;
}

// ==================== API 响应 ====================

/**
 * 统一 API 响应格式
 */
export interface ApiResponse<T = unknown> {
    /** 状态码，0 表示成功，-1 表示失败 */
    code: number;
    /** 错误信息（仅错误时返回） */
    message?: string;
    /** 响应数据（仅成功时返回） */
    data?: T;
}

// ==================== 违禁词 ====================

/** 违禁词匹配类型 */
export type BannedWordMatchType = 'regex' | 'exact' | 'fuzzy';

/**
 * 违禁词条目
 */
export interface BannedWord {
    /** 唯一标识符 */
    id: string;
    /** 匹配模式内容（正则表达式/精确词/模糊词） */
    pattern: string;
    /** 匹配类型 */
    matchType: BannedWordMatchType;
    /** 是否启用 */
    enabled: boolean;
    /** 创建时间戳 */
    createdAt: number;
}
