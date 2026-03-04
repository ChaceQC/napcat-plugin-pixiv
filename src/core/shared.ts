/**
 * 共享状态模块
 *
 * 提取出被多个模块交叉依赖的函数引用，
 * 避免 api-service.ts → index.ts 和 message-handler.ts 的循环依赖。
 *
 * 各模块在初始化时注册实际实现，使用时通过此模块调用。
 */

/**
 * 注册/重建缓存自动清理定时器的函数引用
 * 由 index.ts 注册，api-service.ts 调用
 */
export let registerCacheCleanTimerFn: (() => void) | null = null;

/**
 * 清空冷却记录的函数引用
 * 由 message-handler.ts 注册，api-service.ts 调用
 */
export let clearCooldownMapFn: (() => void) | null = null;

/** 注册缓存清理定时器函数 */
export function setRegisterCacheCleanTimer(fn: () => void): void {
    registerCacheCleanTimerFn = fn;
}

/** 注册清空冷却函数 */
export function setClearCooldownMap(fn: () => void): void {
    clearCooldownMapFn = fn;
}
