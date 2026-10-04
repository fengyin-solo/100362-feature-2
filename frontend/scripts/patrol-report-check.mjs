/* 规则自检：用内存 localStorage 桩跑离线上报服务，不依赖浏览器。
 * 覆盖：状态机顺序、重复轨迹合并、旧日期兼容、不覆盖当班、并发拒绝、事务回退、跨林场只读、核查同步。 */

function makeStorage() {
  const map = new Map()
  globalThis.window = {
    localStorage: {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => void map.set(k, v),
    },
    setTimeout,
  }
}
makeStorage()

const {
  advanceStatus,
  flushOfflineQueue,
  receiveReport,
  archiveReport,
  checkReminder,
  patrolReportStateExport,
  setFailureSwitch,
} = await import(process.env.PATROL_CHECK_BUNDLE ?? './service-bundle.mjs')

let passed = 0
let failed = 0
function assert(condition, label) {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${label}`)
  } else {
    failed += 1
    console.error(`  ✗ ${label}`)
  }
}

// 1. 顺序状态机
console.log('状态机：')
assert(advanceStatus('待复核', '已接收').ok, '待复核→已接收 允许')
assert(advanceStatus('已接收', '已归档').ok, '已接收→已归档 允许')
assert(!advanceStatus('已归档', '已接收').ok, '已归档→已接收 拒绝')
assert(!advanceStatus('已归档', '待复核').ok, '已归档→待复核 拒绝')
assert(!advanceStatus('待复核', '已归档').ok, '待复核→已归档 越级拒绝')

// 2. 队列刷新 + 重复轨迹合并 + 旧日期兼容
console.log('离线队列合并：')
const before = patrolReportStateExport()
const queuedBefore = before.outbox.filter((d) => d.state === 'queued').length
assert(queuedBefore === 3, `初始 3 条待上报草稿（实际 ${queuedBefore}）`)

const flush = flushOfflineQueue()
assert(flush.ok, '联网刷新队列成功')
const after = patrolReportStateExport()
const created = after.reports.filter((r) => r.status === '待复核')
assert(created.length === 2, `合并后生成 2 条待复核上报（实际 ${created.length}）`)

const qs = [...after.reports].find((r) => r.patrolNo === 'PATR-0001')
assert(!!qs, 'PATR-0001 上报存在')
assert(qs?.mergeTrace?.mergedDraftIds.length === 1, `含 1 条被合并草稿（实际 ${qs?.mergeTrace?.mergedDraftIds.length}）`)
assert(qs?.patrolDate === '2026-09-01', `旧设备缺日期沿用当班 2026-09-01（实际 ${qs?.patrolDate}）`)
assert(qs?.dateCompatible === true, '标记为沿用旧日期')
assert(qs?.fireFound === 1, '火情数取最大值 1')
assert(qs?.relatedChecks.includes('firereport') && qs.relatedChecks.includes('checkpoint'), '联动核查取并集')
assert(qs?.track.length >= 4, `轨迹点并集去重（实际 ${qs?.track.length} 点）`)

// 3. 不覆盖当班记录
const patrolJson = JSON.parse(globalThis.window.localStorage.getItem('forest-fire-patrol:entries'))
assert(patrolJson.patrol[0]['巡护日期'] === '2026-09-01', '当班巡护记录未被修改')

// 4. 原队列保留可追溯
const draft102 = after.outbox.find((d) => d.id === 102)
assert(draft102?.state === 'merged' && draft102.mergedInto === qs.id, '被合并草稿留在原队列并指向新上报')

// 5. 并发派单：只放行一个
console.log('并发与事务：')
const qsFresh = patrolReportStateExport().reports.find((r) => r.patrolNo === 'PATR-0001')
const results = await Promise.all([
  receiveReport(qsFresh.id, qsFresh.version, '值班管理员'),
  receiveReport(qsFresh.id, qsFresh.version, '值班管理员'),
])
assert(results.filter((r) => r.ok).length === 1, '并发两个派单仅一个成功')
assert(results.some((r) => !r.ok && r.message.includes('重复请求')), '后到重复请求被明确拒绝')

const afterReceive = patrolReportStateExport()
const received = afterReceive.reports.find((r) => r.id === qsFresh.id)
assert(received.status === '已接收' && received.version === 1, '成功后状态推进、版本号 +1')
assert(afterReceive.orders.filter((o) => o.sourceReportId === qsFresh.id).length === 1, '派单只入队一次（幂等）')
assert(afterReceive.reminders.filter((m) => m.sourceReportId === qsFresh.id).length === 2, '两条联动核查提醒同步生成')

// 版本过期的重复请求（记录已是「已接收」，状态机/版本任一拦截即算拒绝）
const stale = await receiveReport(qsFresh.id, 99, '值班管理员')
assert(!stale.ok, `旧版本重复派单被拒绝：${stale.message}`)

// 6. 事务回退：提醒失败，派单一并撤销，队列与上报不动
const yunling = afterReceive.reports.find((r) => r.patrolNo === 'PATR-0002')
const ordersBefore = afterReceive.orders.length
setFailureSwitch({ reminderFail: true })
const failRes = await receiveReport(yunling.id, yunling.version, '值班管理员')
assert(!failRes.ok && failRes.message.includes('回退'), `提醒失败触发整体回退：${failRes.message}`)
const afterFail = patrolReportStateExport()
assert(afterFail.orders.length === ordersBefore, '回退后派单未残留')
assert(afterFail.reminders.filter((m) => m.sourceReportId === yunling.id).length === 0, '回退后无提醒残留')
assert(afterFail.reports.find((r) => r.id === yunling.id).status === '待复核', '上报状态回到待复核')
assert(afterFail.outbox.some((d) => d.id === 103), '离线队列原样保留')
setFailureSwitch({ reminderFail: false })

// 派单失败也回退
setFailureSwitch({ dispatchFail: true })
const failRes2 = await receiveReport(yunling.id, yunling.version, '值班管理员')
assert(!failRes2.ok && failRes2.message.includes('回退'), '派单失败同样回退')
setFailureSwitch({ dispatchFail: false })

// 正常接收云岭（用最新版本，避免过期版本）
const yunlingFresh = patrolReportStateExport().reports.find((r) => r.id === yunling.id)
const ok2 = await receiveReport(yunling.id, yunlingFresh.version, '值班管理员')
assert(ok2.ok, '关闭故障开关后可正常接收')

// 7. 跨林场只读：当前模拟青山林场
console.log('跨林场权限：')
const yunlingReceived = patrolReportStateExport().reports.find((r) => r.id === yunling.id)
assert(yunlingReceived.forestFarm === '云岭林场', '云岭上报归属云岭林场')
const archiveForeign = archiveReport(yunling.id, '青山林场')
assert(!archiveForeign.ok && archiveForeign.message.includes('只能查看'), '青山林场不能归档云岭记录（跨林场只读）')
const archiveOwn = archiveReport(received.id, '青山林场')
assert(archiveOwn.ok, '青山林场可归档本林场记录')
const archived = patrolReportStateExport().reports.find((r) => r.id === received.id)
assert(archived.status === '已归档', '归档成功')
assert(!advanceStatus(archived.status, '已接收').ok, '归档后不可切回旧状态')

// 8. 核查提醒：别的模块核查同步追加，并写模块核查行
console.log('核查提醒数据流：')
const reminder = patrolReportStateExport().reminders.find(
  (m) => m.sourceReportId === received.id && m.moduleKey === 'firereport',
)
const checkRes = checkReminder(reminder.id, '火情已核实', '值班管理员')
assert(checkRes.ok, '在火情报告模块同步核查成功')
const checked = patrolReportStateExport().reminders.find((m) => m.id === reminder.id)
assert(checked.status === '已核查' && checked.checks.length === 1, '提醒追加一条核查留痕')
const firereportRows = JSON.parse(globalThis.window.localStorage.getItem('forest-fire-patrol:entries')).firereport
assert(firereportRows.some((r) => r['报告编号'] === `CHK-${String(reminder.id).padStart(4, '0')}`), '火情报告模块新增核查行')
// 再次核查是追加而非覆盖
checkReminder(reminder.id, '二次复核', '值班管理员')
assert(patrolReportStateExport().reminders.find((m) => m.id === reminder.id).checks.length === 2, '多次核查累加不覆盖')

console.log(`\n结果：${passed} 通过，${failed} 失败`)
if (failed > 0) process.exit(1)
