/**
 * 违禁词管理服务
 *
 * 提供违禁词的 CRUD 操作以及关键词/搜索结果匹配检查。
 * 数据独立存储在 banned-words.json 文件中。
 */

import { pluginState } from '../core/state';
import type { BannedWord, BannedWordMatchType } from '../types';
import { randomUUID } from 'crypto';

const DATA_FILE = 'banned-words.json';

class BannedWordsService {
    private words: BannedWord[] = [];
    private loaded = false;

    /** 确保数据已加载 */
    private ensureLoaded(): void {
        if (!this.loaded) {
            this.words = pluginState.loadDataFile<BannedWord[]>(DATA_FILE, []);
            this.loaded = true;
        }
    }

    /** 保存到磁盘 */
    private save(): void {
        pluginState.saveDataFile(DATA_FILE, this.words);
    }

    /** 重新加载（插件重载时调用） */
    reload(): void {
        this.loaded = false;
        this.ensureLoaded();
    }

    // ==================== CRUD ====================

    /** 获取所有违禁词 */
    getAll(): BannedWord[] {
        this.ensureLoaded();
        return [...this.words];
    }

    /** 添加违禁词 */
    add(pattern: string, matchType: BannedWordMatchType): BannedWord {
        this.ensureLoaded();

        // 正则表达式语法校验
        if (matchType === 'regex') {
            try {
                new RegExp(pattern);
            } catch {
                throw new Error(`正则表达式语法错误: ${pattern}`);
            }
        }

        const word: BannedWord = {
            id: randomUUID(),
            pattern,
            matchType,
            enabled: true,
            createdAt: Date.now(),
        };
        this.words.push(word);
        this.save();
        pluginState.logger.info(`[违禁词] 添加: "${pattern}" (${matchType})`);
        return word;
    }

    /** 更新违禁词 */
    update(id: string, updates: Partial<Pick<BannedWord, 'pattern' | 'matchType' | 'enabled'>>): BannedWord | null {
        this.ensureLoaded();
        const word = this.words.find(w => w.id === id);
        if (!word) return null;

        // 如果更新了正则模式，校验语法
        const newMatchType = updates.matchType ?? word.matchType;
        const newPattern = updates.pattern ?? word.pattern;
        if (newMatchType === 'regex') {
            try {
                new RegExp(newPattern);
            } catch {
                throw new Error(`正则表达式语法错误: ${newPattern}`);
            }
        }

        if (updates.pattern !== undefined) word.pattern = updates.pattern;
        if (updates.matchType !== undefined) word.matchType = updates.matchType;
        if (updates.enabled !== undefined) word.enabled = updates.enabled;

        this.save();
        return word;
    }

    /** 删除违禁词 */
    remove(id: string): boolean {
        this.ensureLoaded();
        const idx = this.words.findIndex(w => w.id === id);
        if (idx === -1) return false;

        const removed = this.words.splice(idx, 1)[0];
        this.save();
        pluginState.logger.info(`[违禁词] 删除: "${removed.pattern}"`);
        return true;
    }

    // ==================== 匹配检查 ====================

    /** 获取所有已启用的违禁词 */
    private getEnabled(): BannedWord[] {
        this.ensureLoaded();
        return this.words.filter(w => w.enabled);
    }

    /**
     * 检查文本是否命中违禁词
     * @returns 命中的违禁词，未命中返回 null
     */
    private matchText(text: string): BannedWord | null {
        const lowerText = text.toLowerCase();
        for (const word of this.getEnabled()) {
            try {
                switch (word.matchType) {
                    case 'exact':
                        if (lowerText === word.pattern.toLowerCase()) return word;
                        break;
                    case 'fuzzy':
                        if (lowerText.includes(word.pattern.toLowerCase())) return word;
                        break;
                    case 'regex': {
                        const regex = new RegExp(word.pattern, 'i');
                        if (regex.test(text)) return word;
                        break;
                    }
                }
            } catch (e) {
                pluginState.logger.warn(`[违禁词] 匹配失败 (${word.pattern}):`, e);
            }
        }
        return null;
    }

    /**
     * 检查搜索关键词是否命中违禁词
     * @returns 命中的违禁词，未命中返回 null
     */
    checkKeyword(keyword: string): BannedWord | null {
        return this.matchText(keyword);
    }

    /**
     * 检查插画标题/标签是否命中违禁词
     * @returns 命中的违禁词，未命中返回 null
     */
    checkIllust(illust: { title?: string; tags?: Array<{ name?: string }> }): BannedWord | null {
        // 检查标题
        if (illust.title) {
            const hit = this.matchText(illust.title);
            if (hit) return hit;
        }
        // 检查标签
        if (illust.tags) {
            for (const tag of illust.tags) {
                if (tag.name) {
                    const hit = this.matchText(tag.name);
                    if (hit) return hit;
                }
            }
        }
        return null;
    }
}

export const bannedWordsService = new BannedWordsService();
