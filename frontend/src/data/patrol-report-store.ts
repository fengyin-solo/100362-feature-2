import { createPatrolReportSeed } from './patrol-report-seed'
import type { PatrolReportState } from './patrol-report-types'

// 离线上报域的本地持久化，与通用条目(entries)分库存储，互不覆盖当班记录。
const STORAGE_KEY = 'forest-fire-patrol:patrol-report'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): PatrolReportState {
  const fallback = createPatrolReportSeed()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    // 以种子为底做合并：后续新增字段时旧缓存也能正常打开。
    const parsed = JSON.parse(raw) as Partial<PatrolReportState>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: PatrolReportState | null = null

export function patrolReportState(): PatrolReportState {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

/** 整块写回：接收事务在内存里改完一次性提交，保证「队列与提醒一起回退」。 */
export function commitPatrolState(next: PatrolReportState): void {
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function mutatePatrolState(mutate: (draft: PatrolReportState) => void): PatrolReportState {
  const next = clone(patrolReportState())
  mutate(next)
  commitPatrolState(next)
  return next
}

export function resetPatrolState(): PatrolReportState {
  const next = createPatrolReportSeed()
  commitPatrolState(next)
  return next
}

export function nextId(state: PatrolReportState): number {
  state.seq += 1
  return state.seq
}
