/** 巡护离线上报域类型：上报单、派单队列、核查提醒三类数据各自成行，合在一次事务里落库。 */

// 离线上报状态只能沿 待复核 -> 已接收 -> 已归档 顺序推进，没有旁路、不能回退。
export type OfflineStatus = '待复核' | '已接收' | '已归档'

export type TrackPoint = {
  // 经纬度统一保留 5 位小数后参与去重，同一坐标点只留一个。
  lng: string
  lat: string
  at: string
}

export type OfflineReport = {
  id: number
  reportNo: string
  forestFarm: string
  patrolArea: string
  patrolRoute: string
  patrolMember: string
  // 巡护日期按原记录兼容：合并取最早日期，后续任何流转都不改它。
  patrolDate: string
  submittedAt: string
  deviceId: string
  fireFound: number
  track: TrackPoint[]
  status: OfflineStatus
  // 后到的重复轨迹并到主单后留痕，不删除、不另立状态。
  mergedIntoId: number | null
  mergedFromIds: number[]
  // 接收后生成的派单与核查提醒编号，回退发生时一起清空。
  ticketNo: string | null
  reminderNo: string | null
  reviewedAt: string | null
  archivedAt: string | null
  reviewer: string | null
}

export type DispatchTicket = {
  id: number
  ticketNo: string
  reportId: number
  reportNo: string
  forestFarm: string
  patrolRoute: string
  patrolMember: string
  // 复核结束时生成；返回后队列仍保留，页面上始终能查到。
  createdAt: string
  status: '待派单' | '已派单'
}

export type CheckReminder = {
  id: number
  reminderNo: string
  sourceModule: string
  sourceRef: string
  reportId: number | null
  forestFarm: string
  content: string
  createdAt: string
  // 核查提醒随上报接收同步增加，核查完成后才置为已核查。
  checked: boolean
}

export type OfflineState = {
  seq: { report: number; ticket: number; reminder: number }
  reports: OfflineReport[]
  tickets: DispatchTicket[]
  reminders: CheckReminder[]
}

export type OfflineResult<T = undefined> = {
  ok: boolean
  message: string
  data?: T
}
