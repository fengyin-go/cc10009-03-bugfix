<template>
  <section class="page" data-module="proxy-health">
    <header class="page-head">
      <div>
        <h2>代理池管理 · 健康链路</h2>        <p class="page-desc">
          沿「四要素核对 → 授权 → 健康裁决（可用→不可用→已移除）→ 批次/路由联动」链路管理代理节点。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="reconcileNow">重新对账</button>
        <button class="btn ghost" type="button" @click="toggleRole">
          切换为{{ session.isReadOnly ? '负责人（可写）' : '只读访客' }}
        </button>
      </div>
    </header>

    <!-- 会话与维护归属 -->
    <div class="session-bar">
      <span class="legend-item">操作人：{{ session.operator }}</span>
      <span class="legend-item">维护归属站点：{{ session.ownerSite }}</span>
      <span class="legend-item" :class="session.isReadOnly ? 'badge-danger' : 'badge-ok'">
        权限：{{ session.isReadOnly ? '只读（非负责人）' : '可读可写（站点负责人）' }}
      </span>
    </div>

    <!-- 指标卡 -->
    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <!-- 代理池列表 -->
    <h3 class="section-title">代理池列表（健康结果按 可用 → 不可用 → 已移除 优先级裁决）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>节点编号</th><th>代理地址</th><th>代理协议</th><th>地域标签</th><th>匿名级别</th>
          <th>归属站点</th><th>连续失败/上限</th><th>最后存活检测</th><th>健康结果</th><th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="node in nodes" :key="node.id">
          <td>{{ node.code }}</td>
          <td>{{ node.address }}</td>
          <td>{{ node.protocol }}</td>
          <td>{{ node.region }}</td>
          <td>{{ node.anonymity }}</td>
          <td>{{ node.ownerSite }}</td>
          <td>
            <span :class="node.consecutiveFailures >= node.failureLimit ? 'error-text' : ''">
              {{ node.consecutiveFailures }} / {{ node.failureLimit }}
            </span>
          </td>
          <td>{{ node.lastAliveSeq ?? '—' }}</td>
          <td><span class="badge" :class="badgeClass(node.status)">{{ node.status }}</span></td>
          <td class="row-actions">
            <button class="link" type="button" :disabled="session.isReadOnly"
              :title="session.isReadOnly ? '非负责人只读' : ''" @click="reportCheck(node, '存活')">上报存活</button>
            <button class="link" type="button" :disabled="session.isReadOnly"
              :title="session.isReadOnly ? '非负责人只读' : ''" @click="reportCheck(node, '失败')">上报失败</button>
            <button class="link danger" type="button" :disabled="session.isReadOnly"
              :title="session.isReadOnly ? '非负责人只读' : ''" @click="reportRemove(node)">移除节点</button>
          </td>
        </tr>
      </tbody>
    </table>

    <!-- 采集批次台账 -->
    <h3 class="section-title">采集批次台账（其它入口，同步不可用节点数）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>批次号</th><th>目标站点</th><th>引用节点</th><th>不可用节点数</th>
          <th>批次路由地址</th><th>可分配节点</th><th>状态</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="batch in batches" :key="batch.id">
          <td>{{ batch.batchNo }}</td>
          <td>{{ batch.targetSite }}</td>
          <td>{{ nodeCodes(batch.proxyNodeIds).join('、') }}</td>
          <td>
            <span :class="batch.unavailableNodeCount > 0 ? 'error-text' : 'badge-ok'">
              {{ batch.unavailableNodeCount }}
            </span>
          </td>
          <td>{{ batch.routeAddress }}</td>
          <td>{{ allocatableFor(batch.targetSite).map((n) => n.code).join('、') || '无可用节点' }}</td>
          <td>{{ batch.status }}</td>
        </tr>
      </tbody>
    </table>

    <!-- 路由对账 -->
    <h3 class="section-title">代理路由对账（残留旧地址以代理池当前地址为准修正）</h3>
    <table class="data-table">
      <thead>
        <tr><th>节点</th><th>路由绑定地址</th><th>代理池当前地址</th><th>对账结果</th></tr>
      </thead>
      <tbody>
        <tr v-for="route in routes" :key="route.id">
          <td>{{ codeOf(route.nodeId) }}</td>
          <td>{{ route.boundAddress }}</td>
          <td>{{ addressOf(route.nodeId) }}</td>
          <td>
            <span :class="route.boundAddress === addressOf(route.nodeId) ? 'badge-ok' : 'error-text'">
              {{ route.boundAddress === addressOf(route.nodeId) ? '一致' : '残留旧地址（已修正）' }}
            </span>
          </td>
        </tr>
      </tbody>
    </table>

    <!-- 失败留档 -->
    <h3 class="section-title">失败留档（旧失败记录长期保留，恢复后仅标记归档不删除）</h3>
    <table class="data-table">
      <thead>
        <tr><th>节点</th><th>事件序号</th><th>地域</th><th>连续失败次数</th><th>详情</th><th>时间</th><th>归档状态</th></tr>
      </thead>
      <tbody>
        <tr v-for="failure in failures" :key="failure.id">
          <td>{{ failure.nodeCode }}</td>
          <td>{{ failure.eventSeq }}</td>
          <td>{{ failure.region }}</td>
          <td>{{ failure.failureCount }}</td>
          <td>{{ failure.detail }}</td>
          <td>{{ failure.occurredAt }}</td>
          <td>{{ failure.archived ? '已归档（恢复）' : '未归档' }}</td>
        </tr>
        <tr v-if="!failures.length">
          <td colspan="7" class="empty-state">暂无失败记录</td>
        </tr>
      </tbody>
    </table>

    <!-- 审计 -->
    <h3 class="section-title">操作审计（跳级、越权、未授权修改全部挡下并留痕）</h3>
    <table class="data-table">
      <thead>
        <tr><th>序号</th><th>操作人</th><th>归属站点</th><th>动作</th><th>节点</th><th>结果</th><th>原因</th></tr>
      </thead>
      <tbody>
        <tr v-for="audit in audits" :key="audit.id">
          <td>{{ audit.seq }}</td>
          <td>{{ audit.operator }}</td>
          <td>{{ audit.ownerSite }}</td>
          <td>{{ audit.action }}</td>
          <td>{{ audit.nodeCode }}</td>
          <td>
            <span :class="audit.allowed ? 'badge-ok' : 'badge-danger'">
              {{ audit.allowed ? '放行' : '挡下' }}
            </span>
          </td>
          <td>{{ audit.reason }}</td>
        </tr>
        <tr v-if="!audits.length">
          <td colspan="7" class="empty-state">暂无审计记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>数据保存在本机浏览器（{{ storageKey }}），刷新不丢</span>
      <span v-if="message" :class="messageOk ? 'badge-ok' : 'error-text'">{{ message }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  allocatableNodes,
  getState,
  listAudits,
  listBatches,
  listFailures,
  listNodes,
  removeNode,
  runReconcile,
  submitCheck,
} from '@/api/proxy-health-service'
import { proxyHealthStorageKey } from '@/data/proxy-health-store'
import type {
  CheckVerdict,
  HealthStatus,
  ProxyNode,
} from '@/data/proxy-health-types'
import { useSessionStore } from '@/stores/session'

const session = useSessionStore()
const storageKey = proxyHealthStorageKey()

const nodes = ref<ProxyNode[]>([])
const message = ref('')
const messageOk = ref(true)
// 刷新计数：服务侧数据是普通对象（非响应式），用它驱动所有 computed 在每次操作后重算。
const refreshTick = ref(0)

function refresh() {
  refreshTick.value += 1
  nodes.value = listNodes()
}

onMounted(() => {
  // 进入页面先全量对账：纠正 PROX-31 类状态不一致、路由残留旧地址、批次台账旧快照。
  const result = runReconcile()
  refresh()
  message.value = result.message
  messageOk.value = true
})

const batches = computed(() => {
  void refreshTick.value
  return listBatches()
})
const routes = computed(() => {
  void refreshTick.value
  return getState().routes
})
const failures = computed(() => {
  void refreshTick.value
  return listFailures()
})
const audits = computed(() => {
  void refreshTick.value
  return listAudits()
})

const stats = computed(() => [
  { label: '代理节点总数', value: nodes.value.length },
  { label: '可用节点数', value: nodes.value.filter((n) => n.status === '可用').length },
  { label: '不可用节点数', value: nodes.value.filter((n) => n.status === '不可用').length },
  { label: '已移除节点数', value: nodes.value.filter((n) => n.status === '已移除').length },
])

const statusSummary = computed(() =>
  (['可用', '不可用', '已移除'] as HealthStatus[]).map((status) => ({
    status,
    count: nodes.value.filter((n) => n.status === status).length,
  })),
)

function badgeClass(status: HealthStatus): string {
  if (status === '可用') return 'badge-ok'
  if (status === '不可用') return 'badge-warn'
  return 'badge-danger'
}

function nodeCodes(ids: number[]): string[] {
  return ids.map((id) => nodes.value.find((n) => n.id === id)?.code ?? `#${id}`)
}
function codeOf(id: number): string {
  return nodes.value.find((n) => n.id === id)?.code ?? `#${id}`
}
function addressOf(id: number): string {
  return nodes.value.find((n) => n.id === id)?.currentAddress ?? '—'
}
function allocatableFor(site: string): ProxyNode[] {
  return allocatableNodes(getState(), site)
}

function notify(ok: boolean, text: string) {
  messageOk.value = ok
  message.value = text
}

// 上报检测：页面只采集四要素与身份，业务裁决全部在服务里。
function reportCheck(node: ProxyNode, verdict: CheckVerdict) {
  const result = submitCheck({
    nodeId: node.id,
    verdict,
    address: node.address,
    protocol: node.protocol,
    region: node.region,
    anonymity: node.anonymity,
    operator: session.operator,
    ownerSite: session.ownerSite,
  })
  notify(result.ok, result.message)
  refresh()
}

function reportRemove(node: ProxyNode) {
  const result = removeNode({
    nodeId: node.id,
    operator: session.operator,
    ownerSite: session.ownerSite,
    reason: '页面移除节点',
  })
  notify(result.ok, result.message)
  refresh()
}

function reconcileNow() {
  const result = runReconcile()
  notify(true, result.message)
  refresh()
}

function toggleRole() {
  session.setRole(session.isReadOnly ? 'owner' : 'reader')
  notify(true, session.isReadOnly ? '已切换为只读访客，写操作将被挡下' : '已切换为站点负责人')
}
</script>

<style scoped>
.section-title { font-size: 15px; margin: 20px 0 8px; }
.session-bar { display: flex; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
.badge { border-radius: 999px; padding: 2px 10px; font-size: 12px; }
.badge-ok { color: #067647; background: #e7f6ec; }
.badge-warn { color: #b54708; background: #fdf3e3; }
.badge-danger { color: #b42318; background: #fee4e2; }
.link.danger { color: #b42318; }
.link:disabled { color: #9aa6b2; cursor: not-allowed; }
</style>
