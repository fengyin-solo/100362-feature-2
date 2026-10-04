import { listRows, saveRows } from '@/data/local-store'
import { getFailureSwitch, patchFailureSwitch } from '@/data/patrol-report-failure'
import { MODULE_BY_KEY } from '@/data/modules'
import {
  commitPatrolState,
  mutatePatrolState,
  nextId,
  patrolReportState,
  resetPatrolState,
} from '@/data/patrol-report-store'
import type {
  CheckRecord,
  CheckReminder,
  DispatchOrder,
  MergeTrace,
  OfflineDraft,
  OfflineReport,
  PatrolReportState,
  RelatedCheckKey,
  ReportStatus,
  TrackPoint,
} from '@/data/patrol-report-types'
import { RELATED_CHECK_OPTIONS, REPORT_STATUSES } from '@/data/patrol-report-types'
import type { EntryRow } from '@/data/types'

export type ServiceResult<T = undefined> = {
  ok: boolean
  message: string
  data?: T
}

/** 上报状态机：只允许沿 待复核→已接收→已归档 向后推进一格。 */
export function advanceStatus(current: ReportStatus, target: ReportStatus): ServiceResult<ReportStatus> {
  const from = REPORT_STATUSES.indexOf(current)
  const to = REPORT_STATUSES.indexOf(target)
  if (to < 0) {
    return { ok: false, message: `「${target}」不是合法的上报状态` }
  }
  if (to <= from) {
    return {
      ok: false,
      message: `状态只能顺序推进：已在「${current}」，不能切换回旧状态「${target}」`,
    }
  }
  if (to !== from + 1) {
    return { ok: false, message: `状态需逐步推进：不能从「${current}」越级到「${target}」` }
  }
  return { ok: true, message: '', data: REPORT_STATUSES[to] }
}

/** 跨林场只读：接收/归档后的记录，非本林场人员只能查看。待复核记录各林场都要能核。 */
export function canOperate(report: OfflineReport, forestFarm: string): boolean {
  if (report.status === '待复核') {
    return true
  }
  return report.forestFarm === forestFarm
}

// ── 重复轨迹合并 ────────────────────────────────────────────────────────────

/** 轨迹点落到约 2km 的网格，用网格重合度衡量两条轨迹是否重复。 */
function trackCells(track: TrackPoint[]): Set<string> {
  return new Set(track.map((point) => `${Math.round(point.lng * 50)}|${Math.round(point.lat * 50)}`))
}

/** Jaccard 重合度：共同网格 / 并集网格。 */
export function trackSimilarity(a: TrackPoint[], b: TrackPoint[]): number {
  const cellsA = trackCells(a)
  const cellsB = trackCells(b)
  if (cellsA.size === 0 || cellsB.size === 0) {
    return 0
  }
  let common = 0
  for (const cell of cellsA) {
    if (cellsB.has(cell)) {
      common += 1
    }
  }
  return common / (cellsA.size + cellsB.size - common)
}

/** 判重阈值：同林场、同路线、同（补齐后的）巡护日期且轨迹网格重合度达到 50% 视为重复上报。 */
const DUPLICATE_SIMILARITY = 0.5

/**
 * 旧巡护日期兼容：草稿没带日期时，按任务编号回当班巡护记录里取原日期。
 * 当班记录只读取、不修改；查不到就保持空串并标记待确认，绝不臆造日期。
 */
export function resolvePatrolDate(draft: OfflineDraft): { date: string; fromDuty: boolean } {
  if (draft.patrolDate.trim()) {
    return { date: draft.patrolDate.trim(), fromDuty: false }
  }
  const duty = listRows('patrol').find((row) => String(row['任务编号']) === draft.patrolNo)
  const date = duty ? String(duty['巡护日期'] ?? '') : ''
  return { date, fromDuty: date !== '' }
}

/** 合并后的轨迹按采集时间去重排序；时间缺失的旧点排到最前，点位不丢弃。 */
function mergeTrack(tracks: TrackPoint[][]): TrackPoint[] {
  const byCell = new Map<string, TrackPoint>()
  for (const point of tracks.flat()) {
    const cell = `${Math.round(point.lng * 50)}|${Math.round(point.lat * 50)}`
    const existing = byCell.get(cell)
    if (!existing || (!existing.at && point.at)) {
      byCell.set(cell, point)
    }
  }
  return [...byCell.values()].sort((a, b) => (a.at || '').localeCompare(b.at || ''))
}

function unionChecks(drafts: OfflineDraft[]): RelatedCheckKey[] {
  const keys: RelatedCheckKey[] = []
  for (const draft of drafts) {
    for (const key of draft.relatedChecks) {
      if (!keys.includes(key)) {
        keys.push(key)
      }
    }
  }
  return keys
}

function buildReport(
  state: PatrolReportState,
  members: { draft: OfflineDraft; resolvedDate: string; fromDuty: boolean }[],
): OfflineReport {
  // 以最早入队的草稿为主记录，保证巡护日期与归属沿用原记录。
  const ordered = [...members].sort((a, b) => a.draft.recordedAt.localeCompare(b.draft.recordedAt))
  const anchor = ordered[0]
  // 锚点原草稿没带日期、靠当班记录补齐时才算「沿用旧日期」。
  const date = anchor.resolvedDate
  const fromDuty = anchor.fromDuty
  const drafts = ordered.map((member) => ({
    ...member.draft,
    patrolDate: member.resolvedDate,
  }))
  const merged = drafts.length > 1
  const similarity = merged
    ? Math.max(
        ...ordered.slice(1).map((member) => trackSimilarity(anchor.draft.track, member.draft.track)),
      )
    : 1

  const trace: MergeTrace | undefined =
    merged || fromDuty
      ? {
          keptDraftId: anchor.draft.id,
          mergedDraftIds: merged ? ordered.slice(1).map((member) => member.draft.id) : [],
          similarity: Number(similarity.toFixed(2)),
          rule: merged
            ? '同林场+同路线+同巡护日期，轨迹网格重合度≥0.5 判为重复；保留最早草稿，轨迹点并集去重，火情数取最大值'
            : '单条上报，旧设备未带巡护日期，按任务编号沿用当班原记录日期',
          dateSourcePatrolNo: fromDuty ? anchor.draft.patrolNo : undefined,
        }
      : undefined

  return {
    id: nextId(state),
    reportNo: `REP-${state.seq}`,
    forestFarm: anchor.draft.forestFarm,
    patrolNo: anchor.draft.patrolNo,
    route: anchor.draft.route,
    ranger: anchor.draft.ranger,
    patrolDate: date,
    dateCompatible: fromDuty,
    timeSlot: anchor.draft.timeSlot,
    fireFound: Math.max(...drafts.map((draft) => draft.fireFound)),
    track: mergeTrack(drafts.map((draft) => draft.track)),
    relatedChecks: unionChecks(drafts),
    status: '待复核',
    version: 0,
    submittedAt: new Date().toISOString(),
    mergeTrace: trace,
  }
}

// ── 离线队列：保留原队列，只改状态，不物理删除 ──────────────────────────────

export type FlushResult = {
  created: OfflineReport[]
  mergedDraftCount: number
}

/**
 * 设备联网后把离线队列刷新成「待复核」上报：
 * 重复轨迹在队列内先合并；草稿标记 merged/reported 后保留在原队列里可追溯。
 */
export function flushOfflineQueue(): ServiceResult<FlushResult> {
  const state = patrolReportState()
  // 用当班日期补齐旧草稿后再分组，保证缺日期的重复轨迹也能合到一起。
  const queued = state.outbox
    .filter((draft) => draft.state === 'queued')
    .map((draft) => ({ draft, resolved: resolvePatrolDate(draft) }))
  if (queued.length === 0) {
    return { ok: false, message: '离线队列里没有待上报的巡护记录' }
  }

  const next: PatrolReportState = JSON.parse(JSON.stringify(state)) as PatrolReportState
  type Member = { draft: OfflineDraft; resolvedDate: string; fromDuty: boolean }
  const groups: Member[][] = []
  for (const item of queued) {
    const member: Member = { draft: item.draft, resolvedDate: item.resolved.date, fromDuty: item.resolved.fromDuty }
    const group = groups.find((candidate) =>
      candidate.some(
        (other) =>
          other.draft.forestFarm === member.draft.forestFarm &&
          other.draft.route === member.draft.route &&
          other.resolvedDate !== '' &&
          other.resolvedDate === member.resolvedDate &&
          trackSimilarity(other.draft.track, member.draft.track) >= DUPLICATE_SIMILARITY,
      ),
    )
    if (group) {
      group.push(member)
    } else {
      groups.push([member])
    }
  }

  const created: OfflineReport[] = []
  let mergedDraftCount = 0
  for (const members of groups) {
    const report = buildReport(next, members)
    next.reports.push(report)
    created.push(report)
    for (const draft of next.outbox) {
      if (members.some((member) => member.draft.id === draft.id)) {
        if (members.length > 1 && draft.id !== report.mergeTrace?.keptDraftId) {
          draft.state = 'merged'
          draft.mergedInto = report.id
          mergedDraftCount += 1
        } else {
          draft.state = 'reported'
          draft.mergedInto = report.id
        }
      }
    }
  }
  commitPatrolState(next)
  return {
    ok: true,
    message: `队列刷新完成：新增 ${created.length} 条待复核上报，合并重复轨迹 ${mergedDraftCount} 条`,
    data: { created, mergedDraftCount },
  }
}

/** 设备离线期间登记一条草稿，进入待上报队列。 */
export function enqueueDraft(input: Omit<OfflineDraft, 'id' | 'draftNo' | 'state' | 'recordedAt'>): OfflineDraft {
  let created: OfflineDraft | undefined
  mutatePatrolState((draft) => {
    const id = nextId(draft)
    created = {
      ...input,
      id,
      draftNo: `DRAFT-${id}`,
      recordedAt: new Date().toISOString(),
      state: 'queued',
    }
    draft.outbox.push(created)
  })
  return created as OfflineDraft
}

// ── 接收事务：状态推进 + 派单 + 核查提醒，整体提交/整体回退 ──────────────────

// 同一上报的接收动作进行中：并发派单只放行第一个，后到的重复请求直接拒绝。
const inflightReceive = new Set<number>()

function buildReminder(
  state: PatrolReportState,
  report: OfflineReport,
  key: RelatedCheckKey,
  now: string,
): CheckReminder {
  const moduleName = RELATED_CHECK_OPTIONS.find((item) => item.key === key)?.label ?? key
  return {
    id: nextId(state),
    sourceReportId: report.id,
    sourceReportNo: report.reportNo,
    moduleKey: key,
    moduleName,
    forestFarm: report.forestFarm,
    content:
      key === 'firereport' && report.fireFound > 0
        ? `${report.route}发现火情 ${report.fireFound} 处，核查${moduleName}是否已登记处置`
        : `${report.route}巡护上报联动${moduleName}核查`,
    status: '待核查',
    checks: [],
    createdAt: now,
  }
}

/**
 * 复核结束 → 接收：
 * 1. 状态机校验（待复核→已接收）；
 * 2. 乐观锁版本校验，拒绝后到的重复派单；
 * 3. 同事务写入派单队列与各联动模块核查提醒，任一失败整体回退，离线队列原样保留。
 */
export async function receiveReport(
  id: number,
  expectedVersion: number,
  operator: string,
): Promise<ServiceResult<OfflineReport>> {
  if (inflightReceive.has(id)) {
    return { ok: false, message: '该上报正在接收派单，已拒绝后到的重复请求' }
  }
  const current = patrolReportState().reports.find((row) => row.id === id)
  if (!current) {
    return { ok: false, message: `没有找到编号为 ${id} 的离线上报` }
  }
  const guard = advanceStatus(current.status, '已接收')
  if (!guard.ok) {
    return { ok: false, message: guard.message }
  }
  if (current.version !== expectedVersion) {
    return {
      ok: false,
      message: `上报已被其他复核操作更新（版本 ${current.version}），本次派单请求已拒绝`,
    }
  }

  inflightReceive.add(id)
  try {
    // 让出事件循环，制造与「并发派单×2」第二个请求交错的窗口。
    await new Promise((resolve) => window.setTimeout(resolve, 60))

    // 在副本上完成全部写操作：异常即丢弃副本，已提交存储不受影响。
    const next: PatrolReportState = JSON.parse(JSON.stringify(patrolReportState())) as PatrolReportState
    const report = next.reports.find((row) => row.id === id)
    if (!report || report.status !== '待复核') {
      return { ok: false, message: '上报状态已变化，本次派单请求已拒绝' }
    }

    const now = new Date().toISOString()
    const idempotencyKey = `${report.reportNo}:dispatch`
    if (next.orders.some((order) => order.idempotencyKey === idempotencyKey)) {
      return { ok: false, message: '派单已存在，重复派单请求已拒绝' }
    }

    // 第一步：进派单队列（可由故障开关强制失败以演示回退）。
    let order: DispatchOrder | undefined
    try {
      if (getFailureSwitch().dispatchFail) {
        throw new Error('派单队列暂不可用')
      }
      order = {
        id: nextId(next),
        orderNo: `DISP-${String(next.orders.length + 1).padStart(3, '0')}`,
        sourceReportId: report.id,
        sourceReportNo: report.reportNo,
        forestFarm: report.forestFarm,
        route: report.route,
        ranger: report.ranger,
        fireFound: report.fireFound,
        idempotencyKey,
        createdAt: now,
      }
      next.orders.push(order)
    } catch (error) {
      return {
        ok: false,
        message: `派单失败已整体回退：${error instanceof Error ? error.message : '未知错误'}；离线队列与上报保持原样`,
      }
    }

    // 第二步：同步生成核查提醒（可由故障开关强制失败：回退时派单一并撤销）。
    try {
      if (getFailureSwitch().reminderFail) {
        throw new Error('核查提醒服务暂不可用')
      }
      for (const key of report.relatedChecks) {
        next.reminders.push(buildReminder(next, report, key, now))
      }
    } catch (error) {
      return {
        ok: false,
        message: `核查提醒失败，已连同派单一起回退：${error instanceof Error ? error.message : '未知错误'}；离线队列保持原样`,
      }
    }

    // 第三步：全部成功才推进状态并整体提交（不触碰 patrol 当班记录）。
    report.status = '已接收'
    report.version += 1
    report.receivedAt = now
    report.receivedBy = operator
    const placedOrder = order
    commitPatrolState(next)
    return {
      ok: true,
      message: `已接收 ${report.reportNo}：派单 ${placedOrder.orderNo} 已入队，${report.relatedChecks.length} 条核查提醒已同步`,
      data: report,
    }
  } finally {
    inflightReceive.delete(id)
  }
}

/** 归档：只允许 已接收→已归档；归档后状态机拒绝任何回切；跨林场记录只读。 */
export function archiveReport(id: number, operatorForestFarm: string): ServiceResult<OfflineReport> {
  const state = patrolReportState()
  const current = state.reports.find((row) => row.id === id)
  if (!current) {
    return { ok: false, message: `没有找到编号为 ${id} 的离线上报` }
  }
  // 权限先于状态：跨林场人员无论对方处在什么状态都只能查看。
  if (!canOperate(current, operatorForestFarm)) {
    return { ok: false, message: '跨林场人员只能查看该林场记录，不能归档' }
  }
  const guard = advanceStatus(current.status, '已归档')
  if (!guard.ok) {
    return { ok: false, message: guard.message }
  }
  let result: ServiceResult<OfflineReport> = { ok: false, message: '' }
  mutatePatrolState((next) => {
    const report = next.reports.find((row) => row.id === id)
    if (!report) {
      result = { ok: false, message: '上报已不存在' }
      return
    }
    report.status = '已归档'
    report.version += 1
    report.archivedAt = new Date().toISOString()
    result = { ok: true, message: `${report.reportNo} 已归档，状态锁定不可回退`, data: { ...report } }
  })
  return result
}

// ── 核查提醒：别的模块核查时同步追加，不改巡护上报本身 ──────────────────────

/**
 * 别的模块完成核查：提醒上追加一条核查记录并置为已核查，
 * 同时在对应业务模块写一条同内容核查行，形成「提醒↔模块」双向数据流。
 */
export function checkReminder(
  reminderId: number,
  note: string,
  operator: string,
): ServiceResult<CheckReminder> {
  const state = patrolReportState()
  const reminder = state.reminders.find((row) => row.id === reminderId)
  if (!reminder) {
    return { ok: false, message: `没有找到编号为 ${reminderId} 的核查提醒` }
  }
  const record: CheckRecord = { at: new Date().toISOString(), by: operator, note }

  const next: PatrolReportState = JSON.parse(JSON.stringify(state)) as PatrolReportState
  const target = next.reminders.find((row) => row.id === reminderId)
  if (!target) {
    return { ok: false, message: '核查提醒已不存在' }
  }
  target.checks.push(record)
  target.status = '已核查'

  // 同步到对应业务模块：追加核查行而非覆盖既有记录。
  const meta = MODULE_BY_KEY.get(target.moduleKey)
  if (meta) {
    const rows = listRows(target.moduleKey)
    const seq = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
    const stamp = record.at.slice(0, 16).replace('T', ' ')
    const row: EntryRow = {
      id: seq,
      status: '已核查',
      pending: false,
      abnormal: false,
      [meta.fields[0]]: `CHK-${String(reminderId).padStart(4, '0')}`,
      [meta.fields[meta.fields.length - 1]]: `联动核查：${target.content}（${stamp} ${operator}）`,
    }
    saveRows(target.moduleKey, [...rows, row])
  }

  commitPatrolState(next)
  return {
    ok: true,
    message: `已在「${target.moduleName}」同步核查：${note}`,
    data: target,
  }
}

// ── 查询与故障开关 ──────────────────────────────────────────────────────────

export function listReports(): OfflineReport[] {
  return patrolReportState().reports
}

export function listOutbox(): OfflineDraft[] {
  return patrolReportState().outbox
}

export function listReminders(): CheckReminder[] {
  return patrolReportState().reminders
}

export function listOrders(): DispatchOrder[] {
  return patrolReportState().orders
}

/** 顺着「上报 → 派单/提醒 → 模块核查」追踪一条上报的完整数据流。 */
export function traceReport(reportId: number) {
  const state = patrolReportState()
  const report = state.reports.find((row) => row.id === reportId)
  if (!report) {
    return undefined
  }
  return {
    report,
    drafts: state.outbox.filter((draft) => draft.mergedInto === report.id),
    orders: state.orders.filter((order) => order.sourceReportId === report.id),
    reminders: state.reminders.filter((reminder) => reminder.sourceReportId === report.id),
  }
}

export function setFailureSwitch(patch: Partial<import('@/data/patrol-report-types').FailureSwitch>): void {
  patchFailureSwitch(patch)
}

export function failureSwitch(): import('@/data/patrol-report-types').FailureSwitch {
  return getFailureSwitch()
}

export function resetPatrolReportDomain(): PatrolReportState {
  return resetPatrolState()
}
