import type { FailureSwitch } from './patrol-report-types'

/**
 * 故障注入开关放在运行时内存，不进 localStorage、不参与接收事务：
 * 事务提交/回退改的是 PatrolReportState 副本，绝不会把开关回滚掉或误提交。
 */
const runtimeSwitch: FailureSwitch = { dispatchFail: false, reminderFail: false }

export function getFailureSwitch(): FailureSwitch {
  return runtimeSwitch
}

export function patchFailureSwitch(patch: Partial<FailureSwitch>): FailureSwitch {
  Object.assign(runtimeSwitch, patch)
  return runtimeSwitch
}
