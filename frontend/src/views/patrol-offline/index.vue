<template>
  <section class="page" data-module="patrol-offline">
    <header class="page-head">
      <div>
        <h2>巡护任务离线上报</h2>
        <p class="page-desc">
          离线终端的巡护记录先进待复核，不覆盖当班巡护记录；复核接收后入派单队列并同步核查提醒，
          最后归档。状态只能 待复核 → 已接收 → 已归档 顺序推进。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="showForm = !showForm">
          {{ showForm ? '收起上报表单' : '模拟离线提交' }}
        </button>
        <button class="btn ghost" type="button" @click="store.resetAll">恢复示例数据</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">待复核（主单）</span>
        <strong class="stat-value">{{ store.pendingCount }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">派单队列（返回后保留）</span>
        <strong class="stat-value">{{ store.tickets.length }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">待核查提醒</span>
        <strong class="stat-value">{{ store.uncheckedReminders }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">当前身份林场</span>
        <strong class="stat-value farm-value">{{ session.forestFarm }}</strong>
      </article>
    </div>

    <div class="session-bar">
      <label class="filter-item">
        <span>切换登录林场（验证跨林场只读）</span>
        <select :value="session.forestFarm" @change="onFarmChange">
          <option v-for="farm in farms" :key="farm" :value="farm">{{ farm }}</option>
        </select>
      </label>
      <label class="fault-item">
        <input type="checkbox" :checked="faultQueue" @change="onFault('queueWriteFails', ($event.target as HTMLInputElement).checked)" />
        注入：派单队列写入失败（整体回退）
      </label>
      <label class="fault-item">
        <input type="checkbox" :checked="faultReminder" @change="onFault('reminderWriteFails', ($event.target as HTMLInputElement).checked)" />
        注入：核查提醒写入失败（整体回退）
      </label>
    </div>

    <form v-if="showForm" class="offline-form" @submit.prevent="onSubmit">
      <label class="filter-item">
        <span>林场</span>
        <input v-model="form.forestFarm" placeholder="如 青松岭林场" />
      </label>
      <label class="filter-item">
        <span>巡护区域</span>
        <input v-model="form.patrolArea" placeholder="如 北坡管护区" />
      </label>
      <label class="filter-item">
        <span>巡护路线</span>
        <input v-model="form.patrolRoute" placeholder="如 三号沟环线" />
      </label>
      <label class="filter-item">
        <span>巡护员</span>
        <input v-model="form.patrolMember" placeholder="如 周海" />
      </label>
      <label class="filter-item">
        <span>巡护日期</span>
        <input v-model="form.patrolDate" type="date" />
      </label>
      <label class="filter-item">
        <span>发现火情数</span>
        <input v-model.number="form.fireFound" type="number" min="0" />
      </label>
      <label class="filter-item track-input">
        <span>轨迹点（每行：经度,纬度 时间，可多行）</span>
        <textarea v-model="form.trackText" rows="3" placeholder="118.71234,41.09123 08:12"></textarea>
      </label>
      <label class="filter-item">
        <span>离线设备</span>
        <input v-model="form.deviceId" placeholder="如 PDA-071" />
      </label>
      <button class="btn primary" type="submit">提交到待复核</button>
    </form>

    <form class="filter-bar" @submit.prevent>
      <label class="filter-item">
        <span>状态筛选（切换页面后保留）</span>
        <select v-model="store.statusFilter">
          <option value="">全部</option>
          <option value="待复核">待复核</option>
          <option value="已接收">已接收</option>
          <option value="已归档">已归档</option>
        </select>
      </label>
      <label class="filter-item">
        <span>按路线检索</span>
        <input v-model="store.routeFilter" placeholder="巡护路线关键字" />
      </label>
    </form>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <table class="data-table">
      <thead>
        <tr>
          <th>上报编号</th>
          <th>林场</th>
          <th>巡护路线 / 区域</th>
          <th>巡护员</th>
          <th>巡护日期</th>
          <th>上报时间</th>
          <th>火情数</th>
          <th>轨迹点</th>
          <th>当前状态</th>
          <th>派单 / 提醒</th>
          <th>复核操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in visibleReports" :key="row.id" :class="{ merged: row.mergedIntoId !== null, readonly: !canOperate(row) }">
          <td>{{ row.reportNo }}</td>
          <td>{{ row.forestFarm }}</td>
          <td>{{ row.patrolRoute }}<br /><span class="muted-text">{{ row.patrolArea }}</span></td>
          <td>{{ row.patrolMember }}</td>
          <td>{{ row.patrolDate }}</td>
          <td>{{ row.submittedAt }}</td>
          <td>{{ row.fireFound }}</td>
          <td>
            {{ row.track.length }} 个
            <span v-if="row.mergedFromIds.length" class="merge-badge">并入 {{ row.mergedFromIds.length }} 单</span>
          </td>
          <td>
            {{ row.status }}
            <div v-if="row.mergedIntoId !== null" class="muted-text">已并入 OFR-{{ row.mergedIntoId }}</div>
            <div v-if="row.archivedAt" class="muted-text">归档于 {{ row.archivedAt }}</div>
          </td>
          <td class="muted-text">
            <div v-if="row.ticketNo">{{ row.ticketNo }}</div>
            <div v-if="row.reminderNo">{{ row.reminderNo }}</div>
            <div v-if="!row.ticketNo">—</div>
          </td>
          <td class="row-actions">
            <template v-if="row.mergedIntoId === null && canOperate(row)">
              <template v-if="row.status === '待复核'">
                <button
                  class="link"
                  type="button"
                  :disabled="store.busyId === row.id"
                  @click="onAccept(row)"
                >
                  {{ store.busyId === row.id ? '派单中…' : '复核接收并派单' }}
                </button>
                <button class="link" type="button" @click="onConcurrent(row)">
                  并发再派一次
                </button>
                <button
                  v-for="dup in duplicates(row.id)"
                  :key="dup.id"
                  class="link warn"
                  type="button"
                  @click="onMerge(row.id, dup.id)"
                >
                  合并重复单 {{ dup.reportNo }}
                </button>
              </template>
              <button
                v-else-if="row.status === '已接收'"
                class="link"
                type="button"
                @click="onArchive(row)"
              >
                归档
              </button>
              <span v-else class="muted-text">已封档，禁止回退</span>
            </template>
            <span v-else-if="!canOperate(row)" class="muted-text">跨林场只读</span>
            <span v-else class="muted-text">随主单处理</span>
          </td>
        </tr>
        <tr v-if="!visibleReports.length">
          <td colspan="11" class="empty-state">当前筛选下没有可见上报单（待复核单跨林场不可见）</td>
        </tr>
      </tbody>
    </table>

    <div class="offline-bottom">
      <section class="offline-panel">
        <h3>派单队列（接收即入队，返回后仍保留）</h3>
        <table class="data-table">
          <thead>
            <tr><th>派单号</th><th>来源上报</th><th>林场</th><th>路线 / 巡护员</th><th>生成时间</th><th>状态</th></tr>
          </thead>
          <tbody>
            <tr v-for="ticket in store.tickets" :key="ticket.id">
              <td>{{ ticket.ticketNo }}</td>
              <td>{{ ticket.reportNo }}</td>
              <td>{{ ticket.forestFarm }}</td>
              <td>{{ ticket.patrolRoute }} / {{ ticket.patrolMember }}</td>
              <td>{{ ticket.createdAt }}</td>
              <td>{{ ticket.status }}</td>
            </tr>
            <tr v-if="!store.tickets.length"><td colspan="6" class="empty-state">队列暂无派单</td></tr>
          </tbody>
        </table>
      </section>

      <section class="offline-panel">
        <h3>核查提醒（巡护与其他模块共用一个提醒中心）</h3>
        <table class="data-table">
          <thead>
            <tr><th>提醒号</th><th>来源模块</th><th>来源单号</th><th>林场</th><th>内容</th><th>状态</th><th>操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="reminder in store.reminders" :key="reminder.id">
              <td>{{ reminder.reminderNo }}</td>
              <td>{{ reminder.sourceModule }}</td>
              <td>{{ reminder.sourceRef }}</td>
              <td>{{ reminder.forestFarm }}</td>
              <td>{{ reminder.content }}</td>
              <td>{{ reminder.checked ? '已核查' : '待核查' }}</td>
              <td>
                <button v-if="!reminder.checked" class="link" type="button" @click="store.check(reminder.id)">
                  完成核查
                </button>
              </td>
            </tr>
            <tr v-if="!store.reminders.length"><td colspan="7" class="empty-state">暂无核查提醒</td></tr>
          </tbody>
        </table>
      </section>
    </div>

    <footer class="page-foot">
      <span>
        规则：离线上报不覆盖当班巡护记录；状态顺序推进，归档后不可回退；接收与派单、提醒同事务，失败一起回退。
      </span>
      <span v-if="store.message" :class="store.error ? 'error-text' : 'ok-text'">{{ store.message }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue'

import { useSessionStore, FOREST_FARMS } from '@/stores/session'
import { useOfflineStore } from '@/stores/offline'
import { canViewReport, canOperateReport, duplicatesOf, type NewReportInput } from '@/api/offline-service'
import type { OfflineReport } from '@/data/offline-types'

const session = useSessionStore()
const store = useOfflineStore()
const farms = FOREST_FARMS

const showForm = ref(false)
const faultQueue = ref(false)
const faultReminder = ref(false)

const emptyForm = (): NewReportInput => ({
  forestFarm: session.forestFarm,
  patrolArea: '',
  patrolRoute: '',
  patrolMember: '',
  patrolDate: '2026-10-03',
  deviceId: '',
  fireFound: 0,
  trackText: '',
})
const form = reactive<NewReportInput>(emptyForm())

const visibleReports = computed(() =>
  store.reports.filter((row) => {
    if (!canViewReport(row, session.forestFarm)) {
      return false
    }
    if (store.statusFilter && row.status !== store.statusFilter) {
      return false
    }
    if (store.routeFilter && !row.patrolRoute.includes(store.routeFilter.trim())) {
      return false
    }
    return true
  }),
)
const statusSummary = computed(() =>
  (['待复核', '已接收', '已归档'] as const).map((status) => ({
    status,
    count: store.reports.filter(
      (row) =>
        row.status === status &&
        // 待复核只数主单，已并入的后到单据挂在主单上，不重复计数。
        (status !== '待复核' || row.mergedIntoId === null) &&
        canViewReport(row, session.forestFarm),
    ).length,
  })),
)

function canOperate(row: OfflineReport): boolean {
  return canOperateReport(row, session.forestFarm)
}

function duplicates(id: number): OfflineReport[] {
  return duplicatesOf(id)
}

function onFarmChange(event: Event) {
  session.setForestFarm((event.target as HTMLSelectElement).value)
  store.refresh()
}

function onFault(kind: 'queueWriteFails' | 'reminderWriteFails', value: boolean) {
  if (kind === 'queueWriteFails') {
    faultQueue.value = value
  } else {
    faultReminder.value = value
  }
  store.toggleFault(kind, value)
}

function onSubmit() {
  if (store.submit({ ...form })) {
    Object.assign(form, emptyForm())
    showForm.value = false
  }
}

function onAccept(row: OfflineReport) {
  void store.accept(row.id, session.forestFarm, session.operator)
}

// 不等第一笔返回立刻再点一次：验证「后到的重复请求」被拒绝。
function onConcurrent(row: OfflineReport) {
  void store.accept(row.id, session.forestFarm, session.operator)
}

function onMerge(masterId: number, incomingId: number) {
  store.merge(masterId, incomingId)
}

function onArchive(row: OfflineReport) {
  store.archive(row.id, session.forestFarm)
}
</script>

<style scoped>
.session-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  align-items: flex-end;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 12px;
}
.fault-item {
  font-size: 13px;
  display: flex;
  gap: 6px;
  align-items: center;
}
.offline-form {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: flex-end;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 12px;
}
.track-input {
  flex-basis: 320px;
}
.track-input textarea {
  width: 100%;
}
.farm-value {
  font-size: 15px;
}
.merged {
  background: #f8fafc;
}
.readonly {
  background: #fefefe;
}
.merge-badge {
  display: inline-block;
  margin-left: 6px;
  background: #e0e7ff;
  color: #3730a3;
  border-radius: 999px;
  padding: 0 8px;
  font-size: 12px;
}
.muted-text {
  color: var(--muted);
  font-size: 12px;
}
.link:disabled {
  color: #94a3b8;
  cursor: not-allowed;
}
.link.warn {
  color: #b45309;
}
.offline-bottom {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-top: 16px;
}
.offline-panel h3 {
  margin: 0 0 8px;
  font-size: 14px;
}
.ok-text {
  color: #047857;
}
@media (max-width: 1100px) {
  .offline-bottom {
    grid-template-columns: 1fr;
  }
}
</style>
