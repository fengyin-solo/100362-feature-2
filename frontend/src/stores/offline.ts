import { defineStore } from 'pinia'

import {
  acceptAndDispatch,
  addCrossModuleReminder,
  archiveReport,
  checkReminder,
  listReminders,
  listReports,
  listTickets,
  mergeDuplicateReports,
  setOfflineFault,
  submitOfflineReport,
  type NewReportInput,
} from '@/api/offline-service'
import { resetOffline } from '@/data/offline-store'

// 离线上报页的交互状态：数据本身在 offline-store，这里只做视图状态与统一动作封装。
export const useOfflineStore = defineStore('offline', {
  state: () => ({
    reports: listReports(),
    tickets: listTickets(),
    reminders: listReminders(),
    statusFilter: '' as '' | '待复核' | '已接收' | '已归档',
    routeFilter: '',
    message: '',
    error: false,
    busyId: null as number | null,
  }),
  getters: {
    pendingCount: (state) => state.reports.filter((item) => item.status === '待复核' && item.mergedIntoId === null).length,
    uncheckedReminders: (state) => state.reminders.filter((item) => !item.checked).length,
  },
  actions: {
    refresh() {
      this.reports = listReports()
      this.tickets = listTickets()
      this.reminders = listReminders()
    },
    notify(ok: boolean, message: string) {
      this.error = !ok
      this.message = message
    },
    submit(input: NewReportInput) {
      const result = submitOfflineReport(input)
      this.notify(result.ok, result.message)
      if (result.ok) {
        this.refresh()
      }
      return result.ok
    },
    merge(masterId: number, incomingId: number) {
      const result = mergeDuplicateReports(masterId, incomingId)
      this.notify(result.ok, result.message)
      this.refresh()
      return result.ok
    },
    async accept(id: number, farm: string, operator: string) {
      this.busyId = id
      this.notify(true, `OFR-${id} 复核派单链路处理中，重复请求会被拒绝…`)
      const result = await acceptAndDispatch(id, farm, operator)
      this.busyId = null
      this.notify(result.ok, result.message)
      this.refresh()
      return result.ok
    },
    archive(id: number, farm: string) {
      const result = archiveReport(id, farm)
      this.notify(result.ok, result.message)
      this.refresh()
      return result.ok
    },
    syncReminder(input: { sourceModule: string; sourceRef: string; forestFarm: string; content: string }) {
      const result = addCrossModuleReminder(input)
      this.notify(result.ok, result.message)
      this.refresh()
      return result.ok
    },
    check(id: number) {
      const result = checkReminder(id)
      this.notify(result.ok, result.message)
      this.refresh()
    },
    toggleFault(kind: 'queueWriteFails' | 'reminderWriteFails', value: boolean) {
      setOfflineFault(kind, value)
      this.notify(true, value ? '故障注入已开启：下次接收将整体回退' : '故障注入已关闭')
    },
    resetAll() {
      resetOffline()
      this.refresh()
      this.notify(true, '离线上报数据已恢复到示例数据')
    },
  },
})
