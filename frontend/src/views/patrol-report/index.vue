<template>
  <section class="page" data-module="patrol-report">
    <header class="page-head">
      <div>
        <h2>巡护任务离线上报</h2>
        <p class="page-desc">
          离线轨迹先入队，联网后按「同林场+同路线+同日期+轨迹重合」合并为待复核上报；
          状态只能 待复核 → 已接收 → 已归档 顺序推进，接收不覆盖当班巡护记录。
        </p>
      </div>
      <div class="page-actions">
        <label class="farm-switch">
          当前林场
          <select :value="store.forestFarm" @change="switchFarm(($event.target as HTMLSelectElement).value)">
            <option v-for="farm in farms" :key="farm" :value="farm">{{ farm }}</option>
          </select>
        </label>
        <button class="btn" type="button" @click="resetDomain">重置演示数据</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in statusCards" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span class="legend-item">状态顺序：待复核 → 已接收 → 已归档（归档锁定，不可回切）</span>
      <span class="legend-item">接收后跨林场记录只读</span>
    </p>

    <h3 class="block-title">① 离线队列（设备无网时暂存，刷新后保留原队列可追溯）</h3>
    <div class="page-actions queue-bar">
      <button class="btn primary" type="button" @click="flushQueue">联网刷新队列（合并重复轨迹）</button>
      <button class="btn" type="button" @click="showDraftForm = !showDraftForm">
        {{ showDraftForm ? '收起登记' : '离线登记一条巡护' }}
      </button>
      <span class="queue-hint">
        待上报 {{ queuedCount }} 条 · 已合并 {{ mergedCount }} 条 · 已上报 {{ reportedCount }} 条
      </span>
    </div>

    <form v-if="showDraftForm" class="filter-bar draft-form" @submit.prevent="submitDraft">
      <label class="filter-item">
        <span>所属林场</span>
        <select v-model="draftForm.forestFarm">
          <option v-for="farm in farms" :key="farm" :value="farm">{{ farm }}</option>
        </select>
      </label>
      <label class="filter-item">
        <span>任务编号</span>
        <input v-model="draftForm.patrolNo" placeholder="如 PATR-0001" required />
      </label>
      <label class="filter-item">
        <span>巡护路线</span>
        <input v-model="draftForm.route" required />
      </label>
      <label class="filter-item">
        <span>巡护员</span>
        <input v-model="draftForm.ranger" required />
      </label>
      <label class="filter-item">
        <span>巡护日期（留空=旧设备）</span>
        <input v-model="draftForm.patrolDate" placeholder="留空则沿用当班日期" />
      </label>
      <label class="filter-item">
        <span>发现火情数</span>
        <input v-model.number="draftForm.fireFound" type="number" min="0" />
      </label>
      <label class="filter-item">
        <span>联动核查</span>
        <span class="check-toggle" v-for="opt in relatedOptions" :key="opt.key">
          <input v-model="draftForm.relatedChecks" type="checkbox" :value="opt.key" />{{ opt.label }}
        </span>
      </label>
      <button class="btn primary" type="submit">入离线队列</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th>草稿号</th><th>林场</th><th>任务编号</th><th>路线</th><th>巡护员</th>
          <th>巡护日期</th><th>火情</th><th>轨迹点</th><th>队列状态</th><th>去向</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="draft in outbox" :key="draft.id">
          <td>{{ draft.draftNo }}</td>
          <td>{{ draft.forestFarm }}</td>
          <td>{{ draft.patrolNo }}</td>
          <td>{{ draft.route }}</td>
          <td>{{ draft.ranger }}</td>
          <td>{{ draft.patrolDate || '（旧设备缺日期，沿用当班）' }}</td>
          <td>{{ draft.fireFound }}</td>
          <td>{{ draft.track.length }}</td>
          <td>{{ queueStateLabel(draft.state) }}</td>
          <td>{{ draft.mergedInto ? `REP-${draft.mergedInto}` : '—' }}</td>
        </tr>
        <tr v-if="!outbox.length">
          <td colspan="10" class="empty-state">离线队列为空，所有草稿均已上报</td>
        </tr>
      </tbody>
    </table>

    <h3 class="block-title">② 复核与接收（接收事务：派单 + 核查提醒同成同败）</h3>
    <div class="page-actions queue-bar">
      <label class="check-toggle">
        <input type="checkbox" :checked="failure.dispatchFail" @change="toggleFailure('dispatchFail')" />
        模拟派单队列失败
      </label>
      <label class="check-toggle">
        <input type="checkbox" :checked="failure.reminderFail" @change="toggleFailure('reminderFail')" />
        模拟核查提醒失败
      </label>
      <span class="queue-hint">任一失败：派单与提醒一起回退，离线队列与上报保持原样</span>
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th>上报号</th><th>林场</th><th>任务编号</th><th>路线</th><th>巡护日期</th>
          <th>合并/兼容</th><th>联动核查</th><th>状态</th><th>版本</th><th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="report in reports" :key="report.id">
          <td>{{ report.reportNo }}</td>
          <td>{{ report.forestFarm }}</td>
          <td>{{ report.patrolNo }}</td>
          <td>{{ report.route }}</td>
          <td>
            {{ report.patrolDate || '（日期待确认）' }}
            <span v-if="report.dateCompatible" class="tag">沿用旧日期</span>
          </td>
          <td>
            <span v-if="report.mergeTrace" class="tag">
              {{ report.mergeTrace.mergedDraftIds.length ? `合并${report.mergeTrace.mergedDraftIds.length}条·重合${report.mergeTrace.similarity}` : '单条兼容' }}
            </span>
            <span v-else>—</span>
          </td>
          <td>{{ report.relatedChecks.map((key) => moduleLabel(key)).join('、') || '无' }}</td>
          <td><strong>{{ report.status }}</strong></td>
          <td>v{{ report.version }}</td>
          <td class="row-actions">
            <template v-if="report.status === '待复核'">
              <button class="link" type="button" @click="receive(report)">复核结束·接收派单</button>
              <button class="link" type="button" @click="receiveConcurrent(report)">并发派单×2</button>
            </template>
            <template v-else-if="report.status === '已接收'">
              <button
                v-if="canOperate(report, store.forestFarm)"
                class="link"
                type="button"
                @click="archive(report)"
              >归档</button>
              <span v-else class="readonly-hint">跨林场只读</span>
            </template>
            <template v-else>
              <button class="link danger" type="button" @click="tryRollback(report)">
                尝试切回旧状态
              </button>
            </template>
          </td>
        </tr>
        <tr v-if="!reports.length">
          <td colspan="10" class="empty-state">暂无上报，先刷新离线队列</td>
        </tr>
      </tbody>
    </table>

    <h3 class="block-title">③ 核查提醒（别的模块核查时同步追加核查，不覆盖巡护记录）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>来源上报</th><th>林场</th><th>联动模块</th><th>提醒内容</th><th>状态</th><th>核查留痕</th><th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="reminder in reminders" :key="reminder.id">
          <td>{{ reminder.sourceReportNo }}</td>
          <td>{{ reminder.forestFarm }}</td>
          <td>{{ reminder.moduleName }}</td>
          <td>{{ reminder.content }}</td>
          <td>{{ reminder.status }}</td>
          <td>
            <div v-for="(check, index) in reminder.checks" :key="index" class="check-line">
              {{ check.at.slice(0, 16).replace('T', ' ') }} · {{ check.by }} · {{ check.note }}
            </div>
            <span v-if="!reminder.checks.length" class="readonly-hint">待核查</span>
          </td>
          <td>
            <button
              v-if="reminder.status === '待核查'"
              class="link"
              type="button"
              @click="doCheck(reminder)"
            >同步核查</button>
            <span v-else class="readonly-hint">已核查</span>
          </td>
        </tr>
        <tr v-if="!reminders.length">
          <td colspan="7" class="empty-state">还没有核查提醒</td>
        </tr>
      </tbody>
    </table>

    <h3 class="block-title">④ 派单队列（回退时不入队）</h3>
    <table class="data-table">
      <thead>
        <tr><th>派单号</th><th>来源上报</th><th>林场</th><th>路线</th><th>巡护员</th><th>火情</th><th>幂等键</th></tr>
      </thead>
      <tbody>
        <tr v-for="order in orders" :key="order.id">
          <td>{{ order.orderNo }}</td>
          <td>{{ order.sourceReportNo }}</td>
          <td>{{ order.forestFarm }}</td>
          <td>{{ order.route }}</td>
          <td>{{ order.ranger }}</td>
          <td>{{ order.fireFound }}</td>
          <td>{{ order.idempotencyKey }}</td>
        </tr>
        <tr v-if="!orders.length">
          <td colspan="7" class="empty-state">派单队列为空</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>数据保存在本机浏览器；接收动作只增不改当班巡护记录</span>
      <span v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  advanceStatus,
  archiveReport,
  canOperate,
  checkReminder,
  enqueueDraft,
  failureSwitch,
  flushOfflineQueue,
  listOrders,
  listOutbox,
  listReminders,
  listReports,
  receiveReport,
  resetPatrolReportDomain,
  setFailureSwitch,
} from '@/api/patrol-report-service'
import type {
  CheckReminder,
  DispatchOrder,
  OfflineDraft,
  OfflineReport,
  RelatedCheckKey,
} from '@/data/patrol-report-types'
import { RELATED_CHECK_OPTIONS } from '@/data/patrol-report-types'
import { FOREST_FARMS, useSessionStore } from '@/stores/session'

const store = useSessionStore()
const farms = FOREST_FARMS
const relatedOptions = RELATED_CHECK_OPTIONS

const outbox = ref<OfflineDraft[]>([])
const reports = ref<OfflineReport[]>([])
const reminders = ref<CheckReminder[]>([])
const orders = ref<DispatchOrder[]>([])
const failure = ref(failureSwitch())
const message = ref('')
const messageOk = ref(true)
const showDraftForm = ref(false)

const draftForm = reactive({
  forestFarm: store.forestFarm,
  patrolNo: '',
  route: '',
  ranger: '',
  patrolDate: '',
  fireFound: 0,
  relatedChecks: ['firereport'] as RelatedCheckKey[],
})

const queuedCount = computed(() => outbox.value.filter((item) => item.state === 'queued').length)
const mergedCount = computed(() => outbox.value.filter((item) => item.state === 'merged').length)
const reportedCount = computed(() => outbox.value.filter((item) => item.state === 'reported').length)

const statusCards = computed(() =>
  (['待复核', '已接收', '已归档'] as const).map((status) => ({
    label: status,
    value: reports.value.filter((report) => report.status === status).length,
  })),
)

function moduleLabel(key: RelatedCheckKey): string {
  return RELATED_CHECK_OPTIONS.find((item) => item.key === key)?.label ?? key
}

function queueStateLabel(state: OfflineDraft['state']): string {
  return state === 'queued' ? '待上报' : state === 'merged' ? '已合并' : '已上报'
}

function notify(ok: boolean, text: string) {
  messageOk.value = ok
  message.value = text
}

function reload() {
  outbox.value = listOutbox()
  reports.value = listReports()
  reminders.value = listReminders()
  orders.value = listOrders()
  failure.value = failureSwitch()
}

function switchFarm(farm: string) {
  store.setForestFarm(farm)
  notify(true, `已切换到 ${farm}，接收/归档后的跨林场记录变为只读`)
}

function flushQueue() {
  const result = flushOfflineQueue()
  notify(result.ok, result.message)
  reload()
}

function submitDraft() {
  enqueueDraft({
    forestFarm: draftForm.forestFarm,
    patrolNo: draftForm.patrolNo,
    route: draftForm.route,
    ranger: draftForm.ranger,
    patrolDate: draftForm.patrolDate,
    timeSlot: '全天',
    fireFound: Number(draftForm.fireFound) || 0,
    track: [{ at: '', lng: Number((118 + Math.random()).toFixed(3)), lat: Number((27 + Math.random() / 10).toFixed(3)) }],
    relatedChecks: [...draftForm.relatedChecks],
  })
  notify(true, '已写入离线队列，设备联网后刷新即可合并上报')
  draftForm.patrolNo = ''
  draftForm.route = ''
  draftForm.ranger = ''
  draftForm.patrolDate = ''
  draftForm.fireFound = 0
  showDraftForm.value = false
  reload()
}

async function receive(report: OfflineReport) {
  const result = await receiveReport(report.id, report.version, store.operator)
  notify(result.ok, result.message)
  reload()
}

// 复核结束时几乎同时发出两个派单：只应第一个成功，后到的重复请求被拒绝。
async function receiveConcurrent(report: OfflineReport) {
  const [first, second] = await Promise.all([
    receiveReport(report.id, report.version, store.operator),
    receiveReport(report.id, report.version, store.operator),
  ])
  const accepted = first.ok ? first.message : second.message
  const rejected = first.ok ? second.message : first.message
  notify(
    first.ok !== second.ok,
    `并发派单：先到者「${accepted}」；后到重复请求「${rejected}」`,
  )
  reload()
}

function archive(report: OfflineReport) {
  const result = archiveReport(report.id, store.forestFarm)
  notify(result.ok, result.message)
  reload()
}

function tryRollback(report: OfflineReport) {
  // 归档后尝试改回「已接收」：顺序状态机必须拒绝。
  const result = advanceStatus(report.status, '已接收')
  notify(false, result.ok ? '不应出现' : result.message)
}

function doCheck(reminder: CheckReminder) {
  const note = `${reminder.moduleName}已现场核查，无新增异常`
  const result = checkReminder(reminder.id, note, store.operator)
  notify(result.ok, result.message)
  reload()
}

function toggleFailure(key: 'dispatchFail' | 'reminderFail') {
  setFailureSwitch({ [key]: !failure.value[key] })
  reload()
}

function resetDomain() {
  resetPatrolReportDomain()
  notify(true, '离线上报演示数据已重置')
  reload()
}

onMounted(reload)
</script>

<style scoped>
.block-title { font-size: 14px; margin: 18px 0 8px; }
.farm-switch { font-size: 12px; color: var(--muted); display: flex; flex-direction: column; gap: 2px; }
.queue-bar { align-items: center; margin-bottom: 10px; }
.queue-hint { font-size: 12px; color: var(--muted); }
.draft-form { background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 10px; }
.check-toggle { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; margin-right: 8px; }
.tag { background: #e8f1ff; color: #1d4ed8; border-radius: 999px; padding: 1px 8px; font-size: 11px; margin-left: 4px; }
.readonly-hint { color: var(--muted); font-size: 12px; }
.check-line { font-size: 12px; color: #334155; }
.link.danger { color: #b42318; }
.ok-text { color: #15803d; }
</style>
