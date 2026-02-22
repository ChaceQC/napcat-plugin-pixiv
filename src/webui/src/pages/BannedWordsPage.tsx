import { useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { noAuthFetch } from '../utils/api'
import { showToast } from '../hooks/useToast'
import type { BannedWord, BannedWordMatchType } from '../types'
import { IconBan, IconPlus, IconTrash, IconX } from '../components/icons'

const matchTypeLabels: Record<BannedWordMatchType, string> = {
    regex: '正则',
    exact: '精确',
    fuzzy: '模糊',
}

const matchTypeColors: Record<BannedWordMatchType, string> = {
    regex: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300',
    exact: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
    fuzzy: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
}

const matchTypeDescriptions: Record<BannedWordMatchType, string> = {
    fuzzy: '包含即命中：只要搜索词或标题中包含此内容就会被过滤',
    exact: '完整等于：搜索词需与此内容完全一致才会被过滤',
    regex: '正则表达式：使用正则表达式进行高级匹配',
}

/** 编辑图标 */
function IconEdit({ size = 16, className = '' }: { size?: number; className?: string }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
        </svg>
    )
}

export default function BannedWordsPage() {
    const [words, setWords] = useState<BannedWord[]>([])
    const [loading, setLoading] = useState(true)
    const [modalMode, setModalMode] = useState<'add' | 'edit' | null>(null)
    const [editingWord, setEditingWord] = useState<BannedWord | null>(null)

    const fetchWords = useCallback(async () => {
        try {
            const res = await noAuthFetch<BannedWord[]>('/banned-words')
            if (res.code === 0 && res.data) setWords(res.data)
        } catch { showToast('获取违禁词失败', 'error') }
        finally { setLoading(false) }
    }, [])

    useEffect(() => { fetchWords() }, [fetchWords])

    const toggleEnabled = async (word: BannedWord) => {
        try {
            await noAuthFetch(`/banned-words/${word.id}/update`, {
                method: 'POST',
                body: JSON.stringify({ enabled: !word.enabled }),
            })
            setWords(prev => prev.map(w => w.id === word.id ? { ...w, enabled: !w.enabled } : w))
        } catch { showToast('更新失败', 'error') }
    }

    const deleteWord = async (word: BannedWord) => {
        try {
            await noAuthFetch(`/banned-words/${word.id}/delete`, { method: 'POST' })
            setWords(prev => prev.filter(w => w.id !== word.id))
            showToast('已删除', 'success')
        } catch { showToast('删除失败', 'error') }
    }

    const handleAdded = (word: BannedWord) => {
        setWords(prev => [...prev, word])
        setModalMode(null)
    }

    const handleUpdated = (updated: BannedWord) => {
        setWords(prev => prev.map(w => w.id === updated.id ? updated : w))
        setModalMode(null)
        setEditingWord(null)
    }

    const openEdit = (word: BannedWord) => {
        setEditingWord(word)
        setModalMode('edit')
    }

    const closeModal = () => {
        setModalMode(null)
        setEditingWord(null)
    }

    if (loading) {
        return (
            <div className="flex items-center justify-center h-64 empty-state">
                <div className="flex flex-col items-center gap-3">
                    <div className="loading-spinner text-primary" />
                    <div className="text-gray-400 text-sm">加载中...</div>
                </div>
            </div>
        )
    }

    return (
        <div className="space-y-6 stagger-children">
            {/* 操作栏 */}
            <div className="flex items-center justify-between">
                <div className="text-sm text-gray-500 dark:text-gray-400">
                    共 <span className="font-semibold text-gray-800 dark:text-gray-200">{words.length}</span> 条违禁词，
                    已启用 <span className="font-semibold text-green-600 dark:text-green-400">{words.filter(w => w.enabled).length}</span> 条
                </div>
                <button
                    className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white rounded-lg transition-all duration-200 hover:shadow-lg active:scale-95"
                    style={{ background: 'linear-gradient(135deg, #FB7299, #e85580)' }}
                    onClick={() => { setEditingWord(null); setModalMode('add') }}
                >
                    <IconPlus size={16} />
                    添加违禁词
                </button>
            </div>

            {/* 列表 */}
            {words.length === 0 ? (
                <div className="card p-12 text-center">
                    <div className="flex flex-col items-center gap-3">
                        <IconBan size={48} className="text-gray-300 dark:text-gray-600" />
                        <div className="text-gray-400 text-sm">暂无违禁词</div>
                        <div className="text-gray-300 dark:text-gray-600 text-xs">点击上方按钮添加你的第一条违禁词</div>
                    </div>
                </div>
            ) : (
                <div className="card overflow-hidden hover-lift">
                    {words.map((word, idx) => (
                        <div
                            key={word.id}
                            className={`group px-5 py-4 transition-colors hover:bg-gray-50/80 dark:hover:bg-gray-800/30 ${idx > 0 ? 'border-t border-gray-100 dark:border-gray-800/60' : ''
                                }`}
                        >
                            {/* 第一行：类型标签 + 操作 */}
                            <div className="flex items-center justify-between mb-2">
                                <div className="flex items-center gap-2">
                                    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold ${matchTypeColors[word.matchType]}`}>
                                        {matchTypeLabels[word.matchType]}匹配
                                    </span>
                                    <span className="text-[11px] text-gray-300 dark:text-gray-600">
                                        {new Date(word.createdAt).toLocaleString('zh-CN')}
                                    </span>
                                </div>
                                <div className="flex items-center gap-1.5">
                                    <label className="toggle" style={{ transform: 'scale(0.75)' }}>
                                        <input type="checkbox" checked={word.enabled} onChange={() => toggleEnabled(word)} />
                                        <div className="slider" />
                                    </label>
                                    <button
                                        className="p-1.5 rounded-lg text-gray-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors opacity-0 group-hover:opacity-100"
                                        onClick={() => openEdit(word)}
                                        title="编辑"
                                    >
                                        <IconEdit size={14} />
                                    </button>
                                    <button
                                        className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors opacity-0 group-hover:opacity-100"
                                        onClick={() => deleteWord(word)}
                                        title="删除"
                                    >
                                        <IconTrash size={14} />
                                    </button>
                                </div>
                            </div>
                            {/* 第二行：完整模式内容 */}
                            <code className="text-[13px] bg-gray-50 dark:bg-gray-800/80 px-3 py-1.5 rounded-lg font-mono text-gray-700 dark:text-gray-300 block break-all leading-relaxed">
                                {word.pattern}
                            </code>
                        </div>
                    ))}
                </div>
            )}

            {/* 添加/编辑弹窗 - 通过 Portal 渲染到 body，防止被父级裁剪 */}
            {modalMode && createPortal(
                <WordModal
                    mode={modalMode}
                    word={editingWord}
                    onClose={closeModal}
                    onAdded={handleAdded}
                    onUpdated={handleUpdated}
                />,
                document.body
            )}
        </div>
    )
}

/* ---- 添加/编辑违禁词弹窗 ---- */

function WordModal({ mode, word, onClose, onAdded, onUpdated }: {
    mode: 'add' | 'edit'
    word: BannedWord | null
    onClose: () => void
    onAdded: (w: BannedWord) => void
    onUpdated: (w: BannedWord) => void
}) {
    const [pattern, setPattern] = useState(word?.pattern || '')
    const [matchType, setMatchType] = useState<BannedWordMatchType>(word?.matchType || 'fuzzy')
    const [saving, setSaving] = useState(false)
    const [regexError, setRegexError] = useState('')

    const isEdit = mode === 'edit'

    // 正则实时校验
    useEffect(() => {
        if (matchType !== 'regex' || !pattern) {
            setRegexError('')
            return
        }
        try {
            new RegExp(pattern)
            setRegexError('')
        } catch (e) {
            setRegexError(e instanceof Error ? e.message : '语法错误')
        }
    }, [pattern, matchType])

    const handleSubmit = async () => {
        if (!pattern.trim()) { showToast('请输入模式内容', 'error'); return }
        if (regexError) { showToast('正则表达式语法错误', 'error'); return }
        setSaving(true)
        try {
            if (isEdit && word) {
                const res = await noAuthFetch<BannedWord>(`/banned-words/${word.id}/update`, {
                    method: 'POST',
                    body: JSON.stringify({ pattern: pattern.trim(), matchType }),
                })
                if (res.code === 0 && res.data) {
                    showToast('修改成功', 'success')
                    onUpdated(res.data)
                } else {
                    showToast(res.message || '修改失败', 'error')
                }
            } else {
                const res = await noAuthFetch<BannedWord>('/banned-words', {
                    method: 'POST',
                    body: JSON.stringify({ pattern: pattern.trim(), matchType }),
                })
                if (res.code === 0 && res.data) {
                    showToast('添加成功', 'success')
                    onAdded(res.data)
                } else {
                    showToast(res.message || '添加失败', 'error')
                }
            }
        } catch { showToast(isEdit ? '修改失败' : '添加失败', 'error') }
        finally { setSaving(false) }
    }

    return (
        <div className="fixed inset-0 flex items-center justify-center p-4" style={{ zIndex: 9999 }}>
            {/* 遮罩 */}
            <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />

            {/* 弹窗 */}
            <div className="relative bg-white dark:bg-[#1e1f22] rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden page-enter">
                {/* 头部 */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-gray-800">
                    <h3 className="text-base font-semibold text-gray-900 dark:text-white flex items-center gap-2">
                        {isEdit ? <IconEdit size={18} className="text-gray-400" /> : <IconBan size={18} className="text-gray-400" />}
                        {isEdit ? '编辑违禁词' : '添加违禁词'}
                    </h3>
                    <button className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors" onClick={onClose}>
                        <IconX size={18} />
                    </button>
                </div>

                {/* 内容 */}
                <div className="px-6 py-5 space-y-5">
                    {/* 模式内容 */}
                    <div>
                        <div className="text-sm font-medium text-gray-800 dark:text-gray-200 mb-1.5">模式内容</div>
                        <textarea
                            className={`input-field font-mono text-[15px] resize-none ${regexError ? '!border-red-400 !ring-red-400/20' : ''}`}
                            placeholder={matchType === 'regex' ? '例如: 血腥|暴力' : '例如: 敏感词'}
                            value={pattern}
                            onChange={e => setPattern(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleSubmit() }}
                            rows={3}
                            autoFocus
                        />
                        {regexError && (
                            <div className="text-xs text-red-500 mt-1.5 flex items-center gap-1">
                                <IconX size={12} />
                                {regexError}
                            </div>
                        )}
                    </div>

                    {/* 匹配类型 */}
                    <div>
                        <div className="text-sm font-medium text-gray-800 dark:text-gray-200 mb-2">匹配类型</div>
                        <div className="grid grid-cols-3 gap-2">
                            {(['fuzzy', 'exact', 'regex'] as BannedWordMatchType[]).map(type => (
                                <button
                                    key={type}
                                    className={`py-2.5 px-3 rounded-xl text-sm font-medium transition-all duration-200 border-2 ${matchType === type
                                        ? 'border-brand-500 bg-brand-500/10 text-brand-600 dark:text-brand-400 shadow-sm'
                                        : 'border-transparent bg-gray-50 dark:bg-gray-800/60 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700/60'
                                        }`}
                                    onClick={() => setMatchType(type)}
                                >
                                    <div className="flex items-center justify-center gap-1.5">
                                        <span className={`inline-block w-2 h-2 rounded-full ${matchType === type ? 'bg-brand-500' : 'bg-gray-300 dark:bg-gray-600'}`} />
                                        {matchTypeLabels[type]}匹配
                                    </div>
                                </button>
                            ))}
                        </div>
                        <div className="text-xs text-gray-400 mt-2 leading-relaxed">
                            {matchTypeDescriptions[matchType]}
                        </div>
                    </div>
                </div>

                {/* 底部 */}
                <div className="px-6 py-4 border-t border-gray-100 dark:border-gray-800 flex justify-end gap-3">
                    <button
                        className="px-4 py-2 text-sm font-medium text-gray-600 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                        onClick={onClose}
                    >
                        取消
                    </button>
                    <button
                        className="px-5 py-2 text-sm font-medium text-white rounded-lg transition-all duration-200 hover:shadow-lg active:scale-95 disabled:opacity-50 disabled:pointer-events-none"
                        style={{ background: 'linear-gradient(135deg, #FB7299, #e85580)' }}
                        onClick={handleSubmit}
                        disabled={saving || !pattern.trim() || !!regexError}
                    >
                        {saving ? (isEdit ? '保存中...' : '添加中...') : (isEdit ? '保存' : '添加')}
                    </button>
                </div>
            </div>
        </div>
    )
}
