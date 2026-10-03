import { OFFLINE_SEED } from './offline-seed'
import type { OfflineState } from './offline-types'

// 离线上报与当班巡护记录分开存：任何离线上报流程都不允许写 forest-fire-patrol:entries。
const STORAGE_KEY = 'forest-fire-patrol:offline'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): OfflineState {
  const fallback = clone(OFFLINE_SEED)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as OfflineState
    // 新增字段时保证老缓存仍能读：缺的集合回退到种子。
    return {
      seq: { ...fallback.seq, ...(parsed.seq ?? {}) },
      reports: parsed.reports ?? fallback.reports,
      tickets: parsed.tickets ?? fallback.tickets,
      reminders: parsed.reminders ?? fallback.reminders,
    }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: OfflineState | null = null

export function offlineState(): OfflineState {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

function persist(): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(offlineState()))
  }
}

/**
 * 事务式改写：先基于深拷贝草稿执行 mutate，任一步抛错都整体回退，不碰已落库数据；
 * 全部成功才提交（替换缓存 + 持久化）。派单队列与核查提醒必须同生共死。
 */
export function commitOffline(mutate: (draft: OfflineState) => void): void {
  const draft = clone(offlineState())
  mutate(draft)
  cache = draft
  persist()
}

export function resetOffline(): OfflineState {
  cache = clone(OFFLINE_SEED)
  persist()
  return cache
}

export function offlineStorageKey(): string {
  return STORAGE_KEY
}
