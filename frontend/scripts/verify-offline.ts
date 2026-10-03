/* 规则验证脚本（非生产代码）：用 esbuild 转译后在 Node 里跑，localStorage 用内存桩替代。 */
import { strict as assert } from 'node:assert'

// localStorage 内存桩：与浏览器同名同形。
const memory = new Map<string, string>()
;(globalThis as any).window = {
  localStorage: {
    getItem: (k: string) => (memory.has(k) ? memory.get(k)! : null),
    setItem: (k: string, v: string) => void memory.set(k, v),
    removeItem: (k: string) => void memory.delete(k),
  },
}
;(globalThis as any).localStorage = (globalThis as any).window.localStorage

const { resetOffline } = await import('../src/data/offline-store')
const svc = await import('../src/api/offline-service')
const { listRows } = await import('../src/data/local-store')

// 首次读取会用种子初始化当班记录；之后整个离线流程都不应改动它。
const shiftSnapshot = JSON.stringify(listRows('patrol'))

resetOffline()
const farmA = '青松岭林场'
const farmB = '白桦坪林场'
let passed = 0
const ok = (name: string) => {
  passed += 1
  console.log(`  ✓ ${name}`)
}

// 1. 提交不覆盖当班记录
const submitted = svc.submitOfflineReport({
  forestFarm: farmA, patrolArea: '北坡', patrolRoute: '测试环线', patrolMember: '测试员',
  patrolDate: '2026-10-01', deviceId: 'PDA-TEST', fireFound: 0, trackText: '118.1,41.1 08:00',
})
assert.equal(submitted.ok, true)
assert.equal(JSON.stringify(listRows('patrol')), shiftSnapshot, '当班巡护记录被改动')
ok('离线上报不覆盖当班巡护记录')

const newId = submitted.data!.id
assert.equal(submitted.data!.status, '待复核')
ok('新上报初始为待复核')

// 2. 状态顺序推进：待复核不能直接归档
const jump = svc.archiveReport(newId, farmA)
assert.equal(jump.ok, false)
assert.match(jump.message, /跨级|顺序/)
ok('待复核不能跨级直接归档')

// 3. 合并规则：同场次后到重复单
const dup = svc.submitOfflineReport({
  forestFarm: farmA, patrolArea: '北坡', patrolRoute: '测试环线', patrolMember: '测试员',
  patrolDate: '2026-09-28', deviceId: 'PDA-TEST', fireFound: 2,
  trackText: '118.100001,41.100001 08:00\n118.2,41.2 09:30',
})
const dupId = dup.data!.id
const merge = svc.mergeDuplicateReports(newId, dupId)
assert.equal(merge.ok, true)
const master = svc.getReport(newId)!
const merged = svc.getReport(dupId)!
assert.equal(master.patrolDate, '2026-09-28', '应保留更早的巡护日期')
assert.equal(master.fireFound, 2, '火情数取最大')
assert.equal(master.track.length, 2, '轨迹点按5位小数去重')
assert.equal(merged.mergedIntoId, newId, '后到单应指向主单')
assert.deepEqual(merged.track.length, 2, '被并入单原始轨迹保留')
ok('重复轨迹合并：坐标去重、火情取大、日期保留最早原记录')

// 4. 非同场次不可合并
const other = svc.submitOfflineReport({
  forestFarm: farmA, patrolArea: '南坡', patrolRoute: '别的路线', patrolMember: '测试员',
  patrolDate: '2026-09-28', deviceId: 'P', fireFound: 0, trackText: '',
})
assert.equal(svc.mergeDuplicateReports(newId, other.data!.id).ok, false)
ok('不同场次拒绝合并')

// 5. 并发派单：inflight 期间后到请求被拒，只有第一笔成功
const [r1, r2] = await Promise.all([
  svc.acceptAndDispatch(newId, farmA, '值班管理员'),
  svc.acceptAndDispatch(newId, farmA, '值班管理员'),
])
assert.equal(r1.ok, true)
assert.equal(r2.ok, false)
assert.match(r2.message, /重复请求/)
const after1 = svc.getReport(newId)!
assert.equal(after1.status, '已接收')
assert.ok(after1.ticketNo && after1.reminderNo)
ok('并发派单：后到重复请求被拒绝，先到请求成功且队列+提醒同生')

// 6. 重复接收（状态已变）被拒
const again = await svc.acceptAndDispatch(newId, farmA, '值班管理员')
assert.equal(again.ok, false)
assert.match(again.message, /顺序|旧状态/)
ok('已接收不能重复接收（不可回退/重复）')

// 7. 跨林场：接收后可见但只读；归档操作拒绝
assert.equal(svc.canViewReport(after1, farmB), true)
assert.equal(svc.canOperateReport(after1, farmB), false)
assert.equal(svc.archiveReport(newId, farmB).ok, false)
ok('接收后跨林场人员只能查看，不能操作')
// 待复核跨林场不可见
const pending = svc.listReports().find((r) => r.status === '待复核' && r.mergedIntoId === null)!
assert.equal(svc.canViewReport(pending, farmB), false)
ok('待复核单跨林场不可见')

// 8. 归档顺序推进，归档后封档
const arch = svc.archiveReport(newId, farmA)
assert.equal(arch.ok, true)
assert.equal(svc.getReport(newId)!.status, '已归档')
assert.equal(svc.archiveReport(newId, farmA).ok, false)
ok('已接收 → 已归档，归档后不可再切换状态')

// 9. 队列返回后保留：归档不删派单与提醒
const ticketKept = svc.listTickets().some((t) => t.reportId === newId)
const reminderKept = svc.listReminders().some((r) => r.sourceRef === `OFR-${newId}`)
assert.ok(ticketKept && reminderKept)
ok('归档后派单队列与提醒仍然保留')

// 10. 故障注入：队列失败整体回退
const q = svc.submitOfflineReport({
  forestFarm: farmA, patrolArea: '北坡', patrolRoute: '回退路线A', patrolMember: '甲',
  patrolDate: '2026-10-02', deviceId: 'P', fireFound: 0, trackText: '',
})
const qId = q.data!.id
const ticketsBefore = svc.listTickets().length
svc.setOfflineFault('queueWriteFails', true)
const qr = await svc.acceptAndDispatch(qId, farmA, 'x')
svc.setOfflineFault('queueWriteFails', false)
assert.equal(qr.ok, false)
assert.match(qr.message, /回退/)
assert.equal(svc.getReport(qId)!.status, '待复核', '队列失败后状态必须回退')
assert.equal(svc.listTickets().length, ticketsBefore, '队列失败不得留下派单')
ok('派单队列失败：状态与数据整体回退')

// 11. 故障注入：提醒失败，连队列一起回退
const r = svc.submitOfflineReport({
  forestFarm: farmA, patrolArea: '北坡', patrolRoute: '回退路线B', patrolMember: '乙',
  patrolDate: '2026-10-02', deviceId: 'P', fireFound: 0, trackText: '',
})
const rId = r.data!.id
const ticketsBefore2 = svc.listTickets().length
const remindersBefore2 = svc.listReminders().length
svc.setOfflineFault('reminderWriteFails', true)
const rr = await svc.acceptAndDispatch(rId, farmA, 'x')
svc.setOfflineFault('reminderWriteFails', false)
assert.equal(rr.ok, false)
assert.match(rr.message, /回退/)
assert.equal(svc.getReport(rId)!.status, '待复核')
assert.equal(svc.listTickets().length, ticketsBefore2, '提醒失败时队列也要回退')
assert.equal(svc.listReminders().length, remindersBefore2, '提醒失败不得留下提醒')
ok('核查提醒失败：队列连同提醒一起回退')

// 12. 别的模块同步增加核查提醒
const cr = svc.addCrossModuleReminder({
  sourceModule: 'firereport', sourceRef: 'FIRE-0009', forestFarm: farmB, content: '火情核查',
})
assert.equal(cr.ok, true)
assert.equal(svc.listReminders()[0].sourceModule, 'firereport')
ok('其他模块可同步增加核查提醒到同一提醒中心')

// 13. 旧巡护日期全链路兼容（种子里 2026-07-30 的归档单）
const old = svc.getReport(2404)!
assert.equal(old.patrolDate, '2026-07-30')
assert.equal(old.status, '已归档')
assert.equal(await svc.acceptAndDispatch(2404, farmA, 'x').then((x) => x.ok), false)
ok('旧日期归档单保持原日期，且归档后不能回退到接收')

assert.equal(JSON.stringify(listRows('patrol')), shiftSnapshot, '全流程结束当班记录仍被改动过')
ok('全流程结束当班巡护记录逐字节不变')

console.log(`\n全部 ${passed} 条规则验证通过`)
