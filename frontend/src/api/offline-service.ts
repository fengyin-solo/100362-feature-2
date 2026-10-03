import { commitOffline, offlineState } from '@/data/offline-store'
import { listRows } from '@/data/local-store'
import type {
  CheckReminder,
  DispatchTicket,
  OfflineReport,
  OfflineResult,
  OfflineState,
  OfflineStatus,
  TrackPoint,
} from '@/data/offline-types'

// 状态机：只能按下标顺序向前推进一格。归档在最后，归档后任何旧状态都进不来。
const STATUS_ORDER: OfflineStatus[] = ['待复核', '已接收', '已归档']
const SHIFT_RECORDS_KEY = 'patrol'

// 故障注入开关：演示「队列失败」「提醒失败」时的整体回退，正常使用保持 false。
export const offlineFaults = {
  queueWriteFails: false,
  reminderWriteFails: false,
}

export function setOfflineFault(kind: keyof typeof offlineFaults, value: boolean): void {
  offlineFaults[kind] = value
}

function nowStamp(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// 复核结束（接收 + 派单）进行中的上报单：并发的后到请求按这个集合判重拒绝。
const inflight = new Set<number>()

function fail<T>(message: string): OfflineResult<T> {
  return { ok: false, message }
}

function findReport(state: OfflineState, id: number): OfflineReport | undefined {
  return state.reports.find((item) => item.id === id)
}

function assertForward(current: OfflineStatus, next: OfflineStatus): string | null {
  const from = STATUS_ORDER.indexOf(current)
  const to = STATUS_ORDER.indexOf(next)
  if (to <= from) {
    return `状态只能顺序推进：「${current}」不能切换到${to === from ? '相同的' : '旧'}状态「${next}」`
  }
  if (to !== from + 1) {
    return `状态不能跨级推进：「${current}」必须先到「${STATUS_ORDER[from + 1]}」`
  }
  return null
}

/**
 * 重复轨迹合并规则（固定在此处，页面不做判断）：
 * 1. 同一场次 = 同林场 + 同巡护路线 + 同巡护员，且两次巡护日期相差不超过 7 天
 *    （离线终端重发常跨午夜或时钟漂移，日期不同也可能是同一次巡护）；
 * 2. 轨迹点按 经纬度保留 5 位小数 去重后拼接，时间先后排序；
 * 3. 发现火情数取各单最大值；
 * 4. 巡护日期保留最早的原记录，旧日期不因合并或后续流转改变；
 * 5. 后到单据标记 mergedIntoId 指向主单（最早一单），不删除、不覆盖。
 */
const SESSION_DATE_WINDOW_DAYS = 7

function sameTrackSession(a: OfflineReport, b: OfflineReport): boolean {
  if (
    a.forestFarm !== b.forestFarm ||
    a.patrolRoute !== b.patrolRoute ||
    a.patrolMember !== b.patrolMember
  ) {
    return false
  }
  const ta = Date.parse(a.patrolDate)
  const tb = Date.parse(b.patrolDate)
  if (Number.isNaN(ta) || Number.isNaN(tb)) {
    return false
  }
  const gapDays = Math.abs(ta - tb) / 86_400_000
  return gapDays <= SESSION_DATE_WINDOW_DAYS
}

function round5(value: string): string {
  const num = Number(value)
  if (Number.isNaN(num)) {
    return value.trim()
  }
  return num.toFixed(5)
}

function mergeTrack(primary: OfflineReport, incoming: OfflineReport): TrackPoint[] {
  const map = new Map<string, TrackPoint>()
  for (const point of [...primary.track, ...incoming.track]) {
    const key = `${round5(point.lng)}|${round5(point.lat)}`
    const existed = map.get(key)
    if (!existed || (existed.at > point.at)) {
      map.set(key, { ...point, lng: round5(point.lng), lat: round5(point.lat) })
    }
  }
  return [...map.values()].sort((a, b) => a.at.localeCompare(b.at))
}

export function listReports(): OfflineReport[] {
  return offlineState().reports
}

export function listTickets(): DispatchTicket[] {
  return offlineState().tickets
}

export function listReminders(): CheckReminder[] {
  return offlineState().reminders
}

export function getReport(id: number): OfflineReport | undefined {
  return offlineState().reports.find((item) => item.id === id)
}

/**
 * 跨林场权限：接收以后（含已归档）跨林场人员只能查看；
 * 待复核单属于发送林场内部复核材料，跨林场人员既不可见也不可操作。
 */
export function canViewReport(report: OfflineReport, currentFarm: string): boolean {
  if (report.status === '待复核') {
    return report.forestFarm === currentFarm
  }
  return true
}

export function canOperateReport(report: OfflineReport, currentFarm: string): boolean {
  return canViewReport(report, currentFarm) && report.forestFarm === currentFarm
}

export type NewReportInput = {
  forestFarm: string
  patrolArea: string
  patrolRoute: string
  patrolMember: string
  patrolDate: string
  deviceId: string
  fireFound: number
  trackText: string
}

function parseTrack(text: string): TrackPoint[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [lng = '', lat = '', at = ''] = line.split(/[,，\s]+/).map((part) => part.trim())
      return { lng, lat, at }
    })
    .filter((point) => point.lng && point.lat)
}

/** 离线提交：只进离线上报库，不触碰当班巡护记录（patrol 集合保持原样）。 */
export function submitOfflineReport(input: NewReportInput): OfflineResult<OfflineReport> {
  if (!input.forestFarm || !input.patrolRoute || !input.patrolMember || !input.patrolDate) {
    return fail('林场、巡护路线、巡护员、巡护日期为必填项')
  }
  let created: OfflineReport | undefined
  const shiftBefore = JSON.stringify(listRows(SHIFT_RECORDS_KEY))
  commitOffline((draft) => {
    draft.seq.report += 1
    const id = draft.seq.report
    created = {
      id,
      reportNo: `OFR-${id}`,
      forestFarm: input.forestFarm.trim(),
      patrolArea: input.patrolArea.trim(),
      patrolRoute: input.patrolRoute.trim(),
      patrolMember: input.patrolMember.trim(),
      patrolDate: input.patrolDate.trim(),
      submittedAt: nowStamp(),
      deviceId: input.deviceId.trim() || '离线终端',
      fireFound: Math.max(0, Math.trunc(input.fireFound) || 0),
      track: parseTrack(input.trackText),
      status: '待复核',
      mergedIntoId: null,
      mergedFromIds: [],
      ticketNo: null,
      reminderNo: null,
      reviewedAt: null,
      archivedAt: null,
      reviewer: null,
    }
    draft.reports.unshift(created)
  })
  // 双保险：提交完成后当班巡护记录必须与提交前逐字节一致。
  if (JSON.stringify(listRows(SHIFT_RECORDS_KEY)) !== shiftBefore) {
    return fail('离线上报不得覆盖当班巡护记录，操作已中止')
  }
  return { ok: true, message: `离线上报 ${created!.reportNo} 已进入待复核`, data: created }
}

/**
 * 复核去重：把同场次的后到重复上报并入主单（最早一单）。
 * 只允许在待复核阶段做；已接收 / 已归档的单据不参与合并。
 */
export function mergeDuplicateReports(masterId: number, incomingId: number): OfflineResult {
  if (masterId === incomingId) {
    return fail('不能将上报单并入自身')
  }
  try {
    commitOffline((draft) => {
      const master = findReport(draft, masterId)
      const incoming = findReport(draft, incomingId)
      if (!master || !incoming) {
        throw new Error('未找到要合并的上报单')
      }
      if (master.status !== '待复核' || incoming.status !== '待复核') {
        throw new Error('只有待复核的上报单可以合并')
      }
      if (incoming.mergedIntoId !== null) {
        throw new Error(`上报单 ${incoming.reportNo} 已并入别的主单`)
      }
      if (!sameTrackSession(master, incoming)) {
        throw new Error('林场、路线、日期、巡护员不一致，不属于同一场次的重复轨迹')
      }
      master.track = mergeTrack(master, incoming)
      master.fireFound = Math.max(master.fireFound, incoming.fireFound)
      // 旧巡护日期按原记录兼容：保留最早日期。
      if (incoming.patrolDate < master.patrolDate) {
        master.patrolDate = incoming.patrolDate
      }
      incoming.mergedIntoId = master.id
      master.mergedFromIds = [...new Set([...master.mergedFromIds, incoming.id])]
    })
  } catch (error) {
    return fail(error instanceof Error ? error.message : '合并失败')
  }
  return { ok: true, message: `重复轨迹已并入 OFR-${masterId}，巡护日期保留最早原记录` }
}

export function duplicatesOf(masterId: number): OfflineReport[] {
  const state = offlineState()
  const master = state.reports.find((item) => item.id === masterId)
  if (!master || master.mergedIntoId !== null) {
    return []
  }
  return state.reports.filter(
    (item) =>
      item.id !== masterId &&
      item.mergedIntoId === null &&
      item.status === '待复核' &&
      sameTrackSession(master, item),
  )
}

function delay(ms: number): Promise<void> {
  const timer: (cb: () => void, wait: number) => unknown =
    typeof globalThis.setTimeout === 'function' ? globalThis.setTimeout : (cb) => cb()
  return new Promise((resolve) => timer(resolve, ms))
}

/**
 * 复核结束：接收上报并并发派单（模拟与服务端往返，存在真实并发窗口）。
 * - 状态校验由状态机统一负责（顺序推进，归档后不可回退）；
 * - 同一张单在链路中再次请求（并发后到）按 inflight + 事务内版本双重判重，直接拒绝；
 * - 派单队列与核查提醒在同一事务写入，任一失败整体回退。
 */
export async function acceptAndDispatch(
  id: number,
  currentFarm: string,
  reviewer: string,
): Promise<OfflineResult<{ report: OfflineReport; ticket: DispatchTicket; reminder: CheckReminder }>> {
  if (inflight.has(id)) {
    return fail(`上报单 OFR-${id} 正在复核派单，后到的重复请求已拒绝`)
  }
  const current = getReport(id)
  if (!current) {
    return fail(`没有找到编号为 ${id} 的离线上报单`)
  }
  if (current.mergedIntoId !== null) {
    return fail(`该上报单已并入 OFR-${current.mergedIntoId}，请对主单复核`)
  }
  if (current.forestFarm !== currentFarm) {
    return fail('跨林场人员只能查看，不能执行复核接收')
  }
  const orderError = assertForward(current.status, '已接收')
  if (orderError) {
    return fail(orderError)
  }

  inflight.add(id)
  try {
    // 模拟服务端复核 + 派单链路耗时：这段窗口内的第二次点击就是「后到的重复请求」。
    await delay(200)
    let report: OfflineReport | undefined
    let ticket: DispatchTicket | undefined
    let reminder: CheckReminder | undefined
    commitOffline((draft) => {
      const target = findReport(draft, id)!
      // 进入事务后再读一次状态：拦住「读到旧状态」的并发后到请求。
      if (target.status !== '待复核') {
        throw new Error('上报单状态已变更，重复派单请求已拒绝')
      }
      const stamp = nowStamp()

      draft.seq.ticket += 1
      ticket = {
        id: draft.seq.ticket,
        ticketNo: `DSP-${draft.seq.ticket}`,
        reportId: target.id,
        reportNo: target.reportNo,
        forestFarm: target.forestFarm,
        patrolRoute: target.patrolRoute,
        patrolMember: target.patrolMember,
        createdAt: stamp,
        status: '待派单',
      }
      draft.tickets.unshift(ticket)
      if (offlineFaults.queueWriteFails) {
        throw new Error('派单队列写入失败，本次接收连同核查提醒一起回退')
      }

      draft.seq.reminder += 1
      reminder = {
        id: draft.seq.reminder,
        reminderNo: `CHK-${draft.seq.reminder}`,
        sourceModule: 'patrol-offline',
        sourceRef: target.reportNo,
        reportId: target.id,
        forestFarm: target.forestFarm,
        content: `离线上报 ${target.reportNo} 已接收，请核查巡护轨迹与现场情况`,
        createdAt: stamp,
        checked: false,
      }
      draft.reminders.unshift(reminder)
      if (offlineFaults.reminderWriteFails) {
        throw new Error('核查提醒写入失败，本次接收连同派单队列一起回退')
      }

      // 两侧副作用都成功后，才推进上报单状态。
      target.status = '已接收'
      target.ticketNo = ticket!.ticketNo
      target.reminderNo = reminder!.reminderNo
      target.reviewedAt = stamp
      target.reviewer = reviewer
      report = target
    })
    return {
      ok: true,
      message: `已接收 ${report!.reportNo}，派单 ${ticket!.ticketNo} 已入队，核查提醒 ${reminder!.reminderNo} 已同步`,
      data: { report: report!, ticket: ticket!, reminder: reminder! },
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : '复核接收失败，已整体回退')
  } finally {
    inflight.delete(id)
  }
}

export function archiveReport(id: number, currentFarm: string): OfflineResult {
  const current = getReport(id)
  if (!current) {
    return fail(`没有找到编号为 ${id} 的离线上报单`)
  }
  if (current.forestFarm !== currentFarm) {
    return fail('跨林场人员只能查看，不能归档')
  }
  const orderError = assertForward(current.status, '已归档')
  if (orderError) {
    return fail(orderError)
  }
  commitOffline((draft) => {
    const target = findReport(draft, id)!
    if (target.status !== '已接收') {
      throw new Error('状态已被变更，归档中止')
    }
    target.status = '已归档'
    target.archivedAt = nowStamp()
  })
  return { ok: true, message: `上报单 OFR-${id} 已归档，归档后不可再切换状态` }
}

/**
 * 别的模块核查提醒同步：其他业务模块（如火情报告）发起核查时，
 * 同一条核查提醒进同一个提醒中心，核查口径与巡护一致。
 * 同样走事务，失败不留半截提醒。
 */
export function addCrossModuleReminder(input: {
  sourceModule: string
  sourceRef: string
  forestFarm: string
  content: string
}): OfflineResult<CheckReminder> {
  if (!input.sourceRef || !input.forestFarm) {
    return fail('来源单号与林场为必填项')
  }
  let created: CheckReminder | undefined
  try {
    commitOffline((draft) => {
      draft.seq.reminder += 1
      created = {
        id: draft.seq.reminder,
        reminderNo: `CHK-${draft.seq.reminder}`,
        sourceModule: input.sourceModule,
        sourceRef: input.sourceRef,
        reportId: null,
        forestFarm: input.forestFarm,
        content: input.content || `${input.sourceModule} ${input.sourceRef} 提请核查`,
        createdAt: nowStamp(),
        checked: false,
      }
      draft.reminders.unshift(created)
    })
  } catch (error) {
    return fail(error instanceof Error ? error.message : '核查提醒同步失败')
  }
  return { ok: true, message: `核查提醒 ${created!.reminderNo} 已同步到提醒中心`, data: created }
}

export function checkReminder(id: number): OfflineResult {
  const state = offlineState()
  if (!state.reminders.some((item) => item.id === id)) {
    return fail(`没有找到编号为 ${id} 的核查提醒`)
  }
  commitOffline((draft) => {
    const target = draft.reminders.find((item) => item.id === id)
    if (target) {
      target.checked = true
    }
  })
  return { ok: true, message: `提醒 CHK-${id} 已核查` }
}
