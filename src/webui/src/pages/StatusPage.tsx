import { useState, useEffect, useCallback } from 'react'
import type { PluginStatus, CacheInfo, CacheClearResult } from '../types'
import { noAuthFetch } from '../utils/api'
import { IconPower, IconClock, IconActivity, IconDownload, IconRefresh, IconTerminal, IconTrash, IconFolder } from '../components/icons'

interface StatusPageProps {
    status: PluginStatus | null
    onRefresh: () => void
}

/** 将毫秒格式化为可读时长 */
function formatUptime(uptimeMs: number): string {
    const seconds = Math.floor(uptimeMs / 1000)
    const days = Math.floor(seconds / 86400)
    const hours = Math.floor((seconds % 86400) / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    const secs = seconds % 60

    if (days > 0) return `${days}天 ${hours}小时 ${minutes}分 ${secs}秒`
    if (hours > 0) return `${hours}小时 ${minutes}分 ${secs}秒`
    if (minutes > 0) return `${minutes}分 ${secs}秒`
    return `${secs}秒`
}

export default function StatusPage({ status, onRefresh }: StatusPageProps) {
    const [displayUptime, setDisplayUptime] = useState<string>('-')
    const [syncInfo, setSyncInfo] = useState<{ baseUptime: number; syncTime: number } | null>(null)
    const [cacheInfo, setCacheInfo] = useState<CacheInfo | null>(null)
    const [clearing, setClearing] = useState(false)
    const [clearResult, setClearResult] = useState<string | null>(null)

    useEffect(() => {
        if (status?.uptime !== undefined && status.uptime > 0) {
            setSyncInfo({ baseUptime: status.uptime, syncTime: Date.now() })
        }
    }, [status?.uptime])

    useEffect(() => {
        if (!syncInfo) { setDisplayUptime('-'); return }
        const updateUptime = () => {
            const elapsed = Date.now() - syncInfo.syncTime
            setDisplayUptime(formatUptime(syncInfo.baseUptime + elapsed))
        }
        updateUptime()
        const interval = setInterval(updateUptime, 1000)
        return () => clearInterval(interval)
    }, [syncInfo])

    const fetchCacheInfo = useCallback(async () => {
        try {
            const res = await noAuthFetch<CacheInfo>('/cache/status')
            if (res.code === 0 && res.data) setCacheInfo(res.data)
        } catch { /* ignore */ }
    }, [])

    useEffect(() => {
        fetchCacheInfo()
        const interval = setInterval(fetchCacheInfo, 10000)
        return () => clearInterval(interval)
    }, [fetchCacheInfo])

    const handleClearCache = async () => {
        setClearing(true)
        setClearResult(null)
        try {
            const res = await noAuthFetch<CacheClearResult>('/cache/clear', { method: 'POST' })
            if (res.code === 0 && res.data) {
                setClearResult(`已清理 ${res.data.cleaned} 个文件`)
                setCacheInfo(res.data.remaining)
            } else {
                setClearResult('清理失败')
            }
        } catch {
            setClearResult('清理请求失败')
        } finally {
            setClearing(false)
            setTimeout(() => setClearResult(null), 3000)
        }
    }

    if (!status) {
        return (
            <div className="flex items-center justify-center h-64 empty-state">
                <div className="flex flex-col items-center gap-3">
                    <div className="loading-spinner text-primary" />
                    <div className="text-gray-400 text-sm">正在获取插件状态...</div>
                </div>
            </div>
        )
    }

    const { config, stats } = status

    const statCards = [
        {
            label: '插件状态',
            value: config.enabled ? '运行中' : '已停用',
            icon: <IconPower size={18} />,
            color: config.enabled ? 'text-emerald-500' : 'text-red-400',
            bg: config.enabled ? 'bg-emerald-500/10' : 'bg-red-500/10',
        },
        {
            label: '运行时长',
            value: displayUptime,
            icon: <IconClock size={18} />,
            color: 'text-primary',
            bg: 'bg-primary/10',
        },
        {
            label: '今日处理',
            value: String(stats.todayProcessed),
            icon: <IconActivity size={18} />,
            color: 'text-amber-500',
            bg: 'bg-amber-500/10',
        },
        {
            label: '累计处理',
            value: String(stats.processed),
            icon: <IconDownload size={18} />,
            color: 'text-violet-500',
            bg: 'bg-violet-500/10',
        },
    ]

    return (
        <div className="space-y-6">
            {/* 统计卡片 */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 stagger-children">
                {statCards.map((card) => (
                    <div key={card.label} className="card p-4 hover-lift">
                        <div className="flex items-center justify-between mb-3">
                            <span className="text-xs text-gray-400 font-medium">{card.label}</span>
                            <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${card.bg} ${card.color} transition-transform duration-300 hover:scale-110`}>
                                {card.icon}
                            </div>
                        </div>
                        <div className="text-xl font-bold text-gray-900 dark:text-white">{card.value}</div>
                    </div>
                ))}
            </div>

            {/* 缓存管理 */}
            <div className="card p-5 hover-lift animate-fade-in-up">
                <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-semibold text-gray-900 dark:text-white flex items-center gap-2">
                        <IconFolder size={16} className="text-gray-400" />
                        缓存管理
                    </h3>
                    <div className="flex items-center gap-2">
                        {clearResult && (
                            <span className="text-xs text-emerald-500 animate-fade-in">{clearResult}</span>
                        )}
                        <button
                            onClick={handleClearCache}
                            disabled={clearing}
                            className="btn-ghost btn text-xs px-2.5 py-1.5 text-red-500 hover:bg-red-500/10 disabled:opacity-50"
                        >
                            <IconTrash size={13} />
                            {clearing ? '清理中...' : '手动清理'}
                        </button>
                        <button onClick={fetchCacheInfo} className="btn-ghost btn text-xs px-2.5 py-1.5">
                            <IconRefresh size={13} />
                            刷新
                        </button>
                    </div>
                </div>
                <div className="space-y-3">
                    <InfoRow label="缓存文件数" value={cacheInfo ? `${cacheInfo.fileCount} 个` : '-'} />
                    <InfoRow label="占用空间" value={cacheInfo?.totalSizeFormatted ?? '-'} />
                    <InfoRow label="自动清理间隔" value={config.cacheAutoCleanMinutes ? `${config.cacheAutoCleanMinutes} 分钟` : '已禁用'} />
                    <div className="pt-1">
                        <span className="text-[10px] text-gray-400">💡 智能清理会保护最近 5 分钟内下载的图片，正在上传的图片不会受影响</span>
                    </div>
                </div>
            </div>

            {/* 配置概览 */}
            <div className="card p-5 hover-lift animate-fade-in-up">
                <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-semibold text-gray-900 dark:text-white flex items-center gap-2">
                        <IconTerminal size={16} className="text-gray-400" />
                        基础信息
                    </h3>
                    <button onClick={onRefresh} className="btn-ghost btn text-xs px-2.5 py-1.5">
                        <IconRefresh size={13} />
                        刷新
                    </button>
                </div>
                <div className="space-y-3">
                    <InfoRow label="命令前缀" value={config.commandPrefix} />
                    <InfoRow label="冷却时间" value={`${config.cooldownSeconds} 秒`} />
                    <InfoRow label="调试模式" value={config.debug ? '开启' : '关闭'} />
                </div>
            </div>
        </div>
    )
}

function InfoRow({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex items-center justify-between py-1">
            <span className="text-xs text-gray-400">{label}</span>
            <span className="text-xs font-medium text-gray-700 dark:text-gray-300">{value}</span>
        </div>
    )
}
