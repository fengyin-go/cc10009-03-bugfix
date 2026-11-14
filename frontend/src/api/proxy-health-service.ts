/**
 * 代理健康领域服务（PROX-31 的唯一业务裁决处）。
 *
 * 裁决规则（与工单逐条对应）：
 * 1. 检测前先核对四要素：代理地址、代理协议、地域标签、匿名级别，任一与节点登记不符即挡下；
 * 2. 维护归属到目标站点：只有 ownerSite 匹配的负责人才可写，非负责人只读（未授权修改挡下）；
 * 3. 节点健康结果按 可用 → 不可用 → 已移除 的优先级裁决，已移除为终态，不允许跳级回退；
 * 4. 同一节点同时被检测和移除：按事件 seq 串行处理，移除先到则后续检测不再改状态；
 * 5. 重复检测只记录一次：同节点同结论同检测窗口（dedupeKey）幂等；
 * 6. 新旧健康结果冲突时，以最后一次存活检测（lastAliveSeq）为准；
 * 7. 连续失败次数达到/超过上限即判不可用，采集批次不再分配；恢复（存活）另行给出恢复结果；
 * 8. 检测/移除联动：同步采集批次台账的不可用节点数（旧失败记录仍留档），并修正路由残留旧地址。
 */
import {
  persistProxyHealth,
  proxyHealthState,
} from '@/data/proxy-health-store'
import type {
  AuditEntry,
  CheckRequest,
  CollectBatch,
  FailureRecord,
  HealthEvent,
  HealthResult,
  HealthStatus,
  ProxyHealthState,
  ProxyNode,
  RemoveRequest,
} from '@/data/proxy-health-types'

// 健康结果优先级在状态机里体现：可用 < 不可用 < 已移除；已移除是终态，不可回退。

function nowIso(): string {
  return nowProvider()
}

// 时间源：默认取系统时间；自检脚本可注入时钟以推进检测窗口（生产代码不要改它）。
let nowProvider: () => string = () => new Date().toISOString()
export function setHealthClock(provider: () => string): void {
  nowProvider = provider
}

function nextSeq(state: ProxyHealthState): number {
  state.seqCounter += 1
  return state.seqCounter
}

function findNode(state: ProxyHealthState, nodeId: number): ProxyNode | undefined {
  return state.nodes.find((node) => node.id === nodeId)
}

function appendAudit(
  state: ProxyHealthState,
  entry: Omit<AuditEntry, 'id' | 'seq' | 'occurredAt'>,
): void {
  state.audits.push({
    id: state.audits.length + 1,
    seq: state.seqCounter,
    occurredAt: nowIso(),
    ...entry,
  })
}

/** 四要素核对：检测/路由对账都以节点登记信息为基准。 */
export function matchNodeIdentity(node: ProxyNode, req: {
  address: string
  protocol: string
  region: string
  anonymity: string
}): { ok: boolean; mismatches: string[] } {
  const mismatches: string[] = []
  if (req.address !== node.address) mismatches.push(`代理地址（上报 ${req.address} / 登记 ${node.address}）`)
  if (req.protocol !== node.protocol) mismatches.push(`代理协议（上报 ${req.protocol} / 登记 ${node.protocol}）`)
  if (req.region !== node.region) mismatches.push(`地域标签（上报 ${req.region} / 登记 ${node.region}）`)
  if (req.anonymity !== node.anonymity) mismatches.push(`匿名级别（上报 ${req.anonymity} / 登记 ${node.anonymity}）`)
  return { ok: mismatches.length === 0, mismatches }
}

/** 维护归属校验：非归属站点的操作人对该节点只读，写操作一律挡下。 */
function authorize(node: ProxyNode, operator: string, ownerSite: string): { ok: boolean; reason: string } {
  if (!operator || operator.trim() === '') {
    return { ok: false, reason: '未授权：缺少操作人身份' }
  }
  if (ownerSite !== node.ownerSite) {
    return {
      ok: false,
      reason: `越权：节点 ${node.code} 归属站点 ${node.ownerSite}，${ownerSite} 负责人只读，不能修改`,
    }
  }
  return { ok: true, reason: '' }
}

function buildDedupeKey(nodeId: number, verdict: string, occurredAt: string): string {
  // 检测窗口取时间戳的「分钟」粒度：同一分钟内同节点同结论视为重复检测。
  const windowKey = occurredAt.slice(0, 16)
  return `${nodeId}:${verdict}:${windowKey}`
}

/**
 * 依据连续失败上限与最后一次存活检测，裁决单个节点的健康结果。
 * 裁决顺序：已移除终态 → 连续失败达上限判不可用 → 新旧冲突以最后一次存活检测为准。
 */
export function resolveNodeStatus(node: ProxyNode): HealthStatus {
  // 终态优先级最高：任何检测都不能把已移除节点拉回来（防止跳级回退）。
  if (node.status === '已移除') {
    return '已移除'
  }
  // 连续失败达到/超过上限：直接判不可用，采集批次不再分配该节点。
  if (node.consecutiveFailures >= node.failureLimit) {
    return '不可用'
  }
  // 新旧健康结果冲突：以最后一次存活检测（lastAliveSeq）为准。
  // 最后一次存活检测不早于最后一次检测，说明最新结论是存活 → 可用，否则不可用。
  const lastCheck = node.lastCheckSeq ?? -1
  const lastAlive = node.lastAliveSeq ?? -1
  return lastAlive >= lastCheck ? '可用' : '不可用'
}

/** 重新裁决全部节点，并把批次台账、路由对账同步到一致状态。 */
export function reconcile(state: ProxyHealthState): {
  statusChanges: { nodeCode: string; from: HealthStatus; to: HealthStatus }[]
  routeFixes: { nodeCode: string; from: string; to: string }[]
  batchSyncs: { batchNo: string; unavailable: number }[]
} {
  const statusChanges: { nodeCode: string; from: HealthStatus; to: HealthStatus }[] = []
  const routeFixes: { nodeCode: string; from: string; to: string }[] = []
  const batchSyncs: { batchNo: string; unavailable: number }[] = []

  for (const node of state.nodes) {
    const resolved = resolveNodeStatus(node)
    if (resolved !== node.status) {
      statusChanges.push({ nodeCode: node.code, from: node.status, to: resolved })
      node.status = resolved
    }
    node.updatedAt = nowIso()
  }

  // 路由对账：路由残留的旧地址以节点当前地址为准修正，使代理池列表与采集批次详情一致。
  for (const route of state.routes) {
    const node = findNode(state, route.nodeId)
    if (node && route.boundAddress !== node.currentAddress) {
      routeFixes.push({ nodeCode: node.code, from: route.boundAddress, to: node.currentAddress })
      route.boundAddress = node.currentAddress
      route.updatedAt = nowIso()
    }
  }

  // 采集批次台账同步不可用节点数（按批次实际引用的节点实时统计）。
  for (const batch of state.batches) {
    const unavailable = batch.proxyNodeIds
      .map((id) => findNode(state, id))
      .filter((node): node is ProxyNode => Boolean(node))
      .filter((node) => node.status === '不可用' || node.status === '已移除')
      .length
    if (unavailable !== batch.unavailableNodeCount) {
      batchSyncs.push({ batchNo: batch.batchNo, unavailable })
      batch.unavailableNodeCount = unavailable
      batch.updatedAt = nowIso()
    }
    // 批次详情里展示的路由地址同步为修正后的当前地址（取第一个节点的路由）。
    const firstRoute = state.routes.find((route) => route.batchId === batch.id)
    if (firstRoute) {
      batch.routeAddress = firstRoute.boundAddress
    }
  }

  return { statusChanges, routeFixes, batchSyncs }
}

/** 可分配节点：只有「可用」节点能交给抓取批次，不可用/已移除都排除。 */
export function allocatableNodes(state: ProxyHealthState, site: string): ProxyNode[] {
  return state.nodes.filter(
    (node) => node.ownerSite === site && node.status === '可用',
  )
}

function archiveFailuresForNode(state: ProxyHealthState, nodeId: number): void {
  for (const failure of state.failures) {
    if (failure.nodeId === nodeId && !failure.archived) {
      failure.archived = true
    }
  }
}

export interface CheckOutcome {
  nodeCode: string
  status: HealthStatus
  recovered: boolean
  deduped: boolean
  sync: ReturnType<typeof reconcile>
}

/**
 * 提交一次存活检测。
 * 处理顺序：身份（四要素）核对 → 授权 → 终态拦截 → 幂等去重 → 落事件 → 裁决 → 联动同步。
 */
export function submitCheck(req: CheckRequest): HealthResult<CheckOutcome> {
  const state = proxyHealthState()
  const node = findNode(state, req.nodeId)
  if (!node) {
    return { ok: false, message: `没有找到编号为 ${req.nodeId} 的代理节点` }
  }

  // 1. 四要素核对：不符直接挡下，不产生有效检测。
  const identity = matchNodeIdentity(node, req)
  if (!identity.ok) {
    const reason = `节点四要素核对失败：${identity.mismatches.join('、')}`
    state.events.push(buildRejectedEvent(state, node, req, reason))
    appendAudit(state, {
      operator: req.operator, ownerSite: req.ownerSite, action: '存活检测',
      nodeCode: node.code, allowed: false, reason,
    })
    persistProxyHealth(state)
    return { ok: false, message: reason }
  }

  // 2. 维护归属/授权校验。
  const auth = authorize(node, req.operator, req.ownerSite)
  if (!auth.ok) {
    state.events.push(buildRejectedEvent(state, node, req, auth.reason))
    appendAudit(state, {
      operator: req.operator, ownerSite: req.ownerSite, action: '存活检测',
      nodeCode: node.code, allowed: false, reason: auth.reason,
    })
    persistProxyHealth(state)
    return { ok: false, message: auth.reason }
  }

  const occurredAt = nowIso()
  const dedupeKey = buildDedupeKey(node.id, req.verdict, occurredAt)

  // 3. 终态拦截：已移除节点不再接受检测（移除与检测同时发生时，移除先到则检测无效）。
  if (node.status === '已移除') {
    const reason = `节点 ${node.code} 已移除（终态），存活检测不再改变其健康结果`
    // 仍落一条被拒事件，保证检测/移除并发时事件流完整、序号可追溯。
    state.events.push(buildRejectedEvent(state, node, req, reason))
    appendAudit(state, {
      operator: req.operator, ownerSite: req.ownerSite, action: '存活检测',
      nodeCode: node.code, allowed: false, reason,
    })
    persistProxyHealth(state)
    return { ok: false, message: reason }
  }

  // 4. 幂等：重复检测只记录一次。
  const duplicated = state.events.some(
    (event) => event.nodeId === node.id && event.dedupeKey === dedupeKey && event.accepted,
  )
  if (duplicated) {
    const reason = `节点 ${node.code} 在同一检测窗口内已有相同结论「${req.verdict}」，重复检测只记录一次`
    appendAudit(state, {
      operator: req.operator, ownerSite: req.ownerSite, action: '存活检测(重复)',
      nodeCode: node.code, allowed: false, reason,
    })
    persistProxyHealth(state)
    return {
      ok: false,
      message: reason,
      data: {
        nodeCode: node.code,
        status: node.status,
        recovered: false,
        deduped: true,
        sync: { statusChanges: [], routeFixes: [], batchSyncs: [] },
      },
    }
  }

  // 5. 落一条有效检测事件。
  const seq = nextSeq(state)
  const event: HealthEvent = {
    seq,
    nodeId: node.id,
    type: '检测',
    verdict: req.verdict,
    address: req.address,
    protocol: req.protocol,
    region: req.region,
    anonymity: req.anonymity,
    operator: req.operator,
    ownerSite: req.ownerSite,
    occurredAt,
    dedupeKey,
    accepted: true,
    reason: req.verdict === '存活' ? '检测通过：节点存活' : '检测通过：节点失败',
  }
  state.events.push(event)
  node.lastCheckSeq = seq

  const beforeStatus = node.status
  let recovered = false

  if (req.verdict === '失败') {
    node.consecutiveFailures += 1
    // 失败留档：每次失败都记录，恢复后也保留（仅在恢复时置 archived）。
    const failure: FailureRecord = {
      id: state.failures.length + 1,
      nodeId: node.id,
      nodeCode: node.code,
      eventSeq: seq,
      region: node.region,
      failureCount: node.consecutiveFailures,
      detail: `第 ${node.consecutiveFailures} 次连续存活检测失败`,
      occurredAt,
      archived: false,
    }
    state.failures.push(failure)
  } else {
    // 存活：刷新最后一次存活检测序号；新旧冲突以它为准。
    node.lastAliveSeq = seq
    // 只有从不可用恢复到可用才算「恢复」，另行给出恢复结果。
    recovered = node.status === '不可用'
    node.consecutiveFailures = 0
    if (recovered) {
      archiveFailuresForNode(state, node.id)
    }
  }

  // 6. 裁决健康结果（可用/不可用间流转；已移除终态已在上面拦截，不会跳级回退）。
  const resolved = resolveNodeStatus(node)
  node.status = resolved
  node.updatedAt = occurredAt

  // 7. 联动：批次台账 + 路由对账。
  const sync = reconcile(state)

  appendAudit(state, {
    operator: req.operator, ownerSite: req.ownerSite,
    action: req.verdict === '存活' ? (recovered ? '存活检测(恢复)' : '存活检测') : '存活检测(失败)',
    nodeCode: node.code, allowed: true,
    reason: `状态 ${beforeStatus} → ${resolved}`,
  })
  persistProxyHealth(state)

  const message = recovered
    ? `节点 ${node.code} 恢复成功，健康结果已由「不可用」恢复为「可用」，失败记录留档`
    : `节点 ${node.code} 检测「${req.verdict}」已记录，当前健康结果「${resolved}」`
  return {
    ok: true,
    message,
    data: { nodeCode: node.code, status: resolved, recovered, deduped: false, sync },
  }
}

function buildRejectedEvent(
  state: ProxyHealthState,
  node: ProxyNode,
  req: CheckRequest,
  reason: string,
): HealthEvent {
  return {
    seq: nextSeq(state),
    nodeId: node.id,
    type: '检测',
    verdict: req.verdict,
    address: req.address,
    protocol: req.protocol,
    region: req.region,
    anonymity: req.anonymity,
    operator: req.operator,
    ownerSite: req.ownerSite,
    occurredAt: nowIso(),
    dedupeKey: buildDedupeKey(node.id, req.verdict, nowIso()),
    accepted: false,
    reason,
  }
}

/** 移除节点：只有归属站点负责人可操作；已移除幂等；移除为终态，优先级高于检测。 */
export function removeNode(req: RemoveRequest): HealthResult<{ nodeCode: string; status: HealthStatus }> {
  const state = proxyHealthState()
  const node = findNode(state, req.nodeId)
  if (!node) {
    return { ok: false, message: `没有找到编号为 ${req.nodeId} 的代理节点` }
  }
  const auth = authorize(node, req.operator, req.ownerSite)
  if (!auth.ok) {
    appendAudit(state, {
      operator: req.operator, ownerSite: req.ownerSite, action: '移除节点',
      nodeCode: node.code, allowed: false, reason: auth.reason,
    })
    persistProxyHealth(state)
    return { ok: false, message: auth.reason }
  }
  if (node.status === '已移除') {
    return { ok: false, message: `节点 ${node.code} 已是已移除状态，不用重复操作` }
  }

  const seq = nextSeq(state)
  const event: HealthEvent = {
    seq,
    nodeId: node.id,
    type: '移除',
    address: node.address,
    protocol: node.protocol,
    region: node.region,
    anonymity: node.anonymity,
    operator: req.operator,
    ownerSite: req.ownerSite,
    occurredAt: nowIso(),
    dedupeKey: `${node.id}:移除:${seq}`,
    accepted: true,
    reason: req.reason ?? '负责人移除节点',
  }
  state.events.push(event)

  const before = node.status
  node.status = '已移除'
  node.updatedAt = nowIso()

  // 移除后同样联动批次台账（不可用节点数口径含已移除）与路由。
  reconcile(state)

  appendAudit(state, {
    operator: req.operator, ownerSite: req.ownerSite, action: '移除节点',
    nodeCode: node.code, allowed: true, reason: `状态 ${before} → 已移除`,
  })
  persistProxyHealth(state)
  return {
    ok: true,
    message: `节点 ${node.code} 已移除，采集批次不再分配；其历史失败记录仍保留留档`,
    data: { nodeCode: node.code, status: '已移除' },
  }
}

/** 手工触发一次全量对账（纠正路由残留旧地址、批次台账不可用数、状态不一致）。 */
export function runReconcile(): HealthResult<ReturnType<typeof reconcile>> {
  const state = proxyHealthState()
  const sync = reconcile(state)
  persistProxyHealth(state)
  return {
    ok: true,
    message: `对账完成：状态纠正 ${sync.statusChanges.length} 项，路由修正 ${sync.routeFixes.length} 条，批次台账同步 ${sync.batchSyncs.length} 个`,
    data: sync,
  }
}

export function listNodes(): ProxyNode[] {
  return proxyHealthState().nodes
}

export function listFailures(nodeId?: number): FailureRecord[] {
  const state = proxyHealthState()
  return typeof nodeId === 'number'
    ? state.failures.filter((failure) => failure.nodeId === nodeId)
    : state.failures
}

export function listBatches(): CollectBatch[] {
  return proxyHealthState().batches
}

export function listAudits(): AuditEntry[] {
  return proxyHealthState().audits
}

export function listEvents(nodeId?: number): HealthEvent[] {
  const state = proxyHealthState()
  return typeof nodeId === 'number'
    ? state.events.filter((event) => event.nodeId === nodeId)
    : state.events
}

export function getState(): ProxyHealthState {
  return proxyHealthState()
}
