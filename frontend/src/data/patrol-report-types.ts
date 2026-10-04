/**
 * 巡护任务「离线上报」领域类型。
 *
 * 上报从离线草稿到归档的生命周期：
 *   离线草稿(outbox) ──联网合并轨迹──▶ 待复核 ──复核结束接收──▶ 已接收 ──归档──▶ 已归档
 *
 * 约束（对应业务规则）：
 * - 状态只能按 待复核 → 已接收 → 已归档 顺序推进，归档后不得切回旧状态；
 * - 接收不覆盖当班巡护记录，只新增上报记录、派单与核查提醒，三者一个事务，失败整体回退；
 * - 重复轨迹在离线队列里合并，旧巡护日期沿用当班原记录；
 * - 已接收/已归档后，跨林场人员只读。
 */

/** 上报状态：严格顺序状态机，索引即先后次序，只允许向后走一格。 */
export const REPORT_STATUSES = ['待复核', '已接收', '已归档'] as const
export type ReportStatus = (typeof REPORT_STATUSES)[number]

export type TrackPoint = {
  /** 采集时间，离线设备本地时钟，允许缺失（旧设备兼容）。 */
  at: string
  lng: number
  lat: number
}

/** 复核时联动的业务模块核查项，例如 火情报告、防火检查站。 */
export type RelatedCheckKey = 'firereport' | 'checkpoint' | 'equipment' | 'firewatch'

export const RELATED_CHECK_OPTIONS: { key: RelatedCheckKey; label: string }[] = [
  { key: 'firereport', label: '火情报告' },
  { key: 'checkpoint', label: '防火检查站' },
  { key: 'equipment', label: '消防装备' },
  { key: 'firewatch', label: '火险监测' },
]

/** 离线设备上暂存、尚未上报的巡护草稿。 */
export type OfflineDraft = {
  id: number
  /** 草稿在设备本地生成的编号，用于排查重放。 */
  draftNo: string
  forestFarm: string
  patrolNo: string
  route: string
  ranger: string
  /** 旧设备可能没带日期：留空，刷新队列时用当班原记录补齐。 */
  patrolDate: string
  timeSlot: string
  fireFound: number
  track: TrackPoint[]
  /** 复核时需要同步核查的模块。 */
  relatedChecks: RelatedCheckKey[]
  /** 设备重新联网后用于排序的本地时间戳。 */
  recordedAt: string
  /** queued=仍在离线队列；reported=已生成上报；merged=合并进了其它上报。后两者保留以便追溯。 */
  state: 'queued' | 'reported' | 'merged'
  /** 合并后指向生成的上报编号。 */
  mergedInto?: number
}

/** 合并轨迹时的依据与结果留痕，方便复核员判断。 */
export type MergeTrace = {
  keptDraftId: number
  mergedDraftIds: number[]
  /** 判定为重复轨迹时的重合度 0~1。 */
  similarity: number
  rule: string
  /** 旧巡护日期的兼容来源：当班任务编号；为空表示草稿自带日期。 */
  dateSourcePatrolNo?: string
}

export type OfflineReport = {
  id: number
  reportNo: string
  forestFarm: string
  patrolNo: string
  route: string
  ranger: string
  /** 有效巡护日期：优先沿用当班原记录的旧日期，绝不凭空改写。 */
  patrolDate: string
  dateCompatible: boolean
  timeSlot: string
  fireFound: number
  track: TrackPoint[]
  relatedChecks: RelatedCheckKey[]
  status: ReportStatus
  /** 乐观锁：每次状态推进 +1，拒绝后到的重复请求。 */
  version: number
  submittedAt: string
  receivedAt?: string
  archivedAt?: string
  /** 接收该上报的当班操作员，用于跨林场只读判定。 */
  receivedBy?: string
  mergeTrace?: MergeTrace
}

export type ReminderStatus = '待核查' | '已核查'

export type CheckRecord = {
  at: string
  by: string
  note: string
}

/** 接收上报时按联动模块同步生成的核查提醒。 */
export type CheckReminder = {
  id: number
  sourceReportId: number
  sourceReportNo: string
  moduleKey: RelatedCheckKey
  moduleName: string
  forestFarm: string
  content: string
  status: ReminderStatus
  /** 别的模块每做一次核查就追加一条，提醒不被覆盖。 */
  checks: CheckRecord[]
  createdAt: string
}

export type DispatchOrder = {
  id: number
  orderNo: string
  sourceReportId: number
  sourceReportNo: string
  forestFarm: string
  route: string
  ranger: string
  fireFound: number
  /** 派单请求的幂等键：复核结束并发派单时，同键只放行第一个。 */
  idempotencyKey: string
  createdAt: string
}

export type FailureSwitch = {
  /** 打开后，派单写入必失败，用于演示接收事务回退。 */
  dispatchFail: boolean
  /** 打开后，核查提醒写入必失败。 */
  reminderFail: boolean
}

export type PatrolReportState = {
  outbox: OfflineDraft[]
  reports: OfflineReport[]
  reminders: CheckReminder[]
  orders: DispatchOrder[]
  seq: number
}
