/**
 * 代理健康域类型（PROX-31）。
 *
 * 与通用 EntryRow 不同，这里是带业务约束的强类型模型：节点、检测事件、失败留档、
 * 采集批次台账与代理路由都落在同一份本地持久化数据里，由 proxy-health 服务统一裁决。
 */

// 节点健康结果：裁决时严格按 可用 < 不可用 < 已移除 的优先级，已移除为终态优先级最高。
export type HealthStatus = '可用' | '不可用' | '已移除'

export type ProxyProtocol = 'HTTP' | 'HTTPS' | 'SOCKS5'

export type AnonymityLevel = '透明' | '匿名' | '高匿'

// 一次存活检测的结论。健康结果由检测事件按规则裁决，不允许页面直接改状态。
export type CheckVerdict = '存活' | '失败'

export type HealthEventType = '检测' | '移除'

/** 代理节点：四要素（地址/协议/地域/匿名级别）是检测与路由对账的核对基准。 */
export interface ProxyNode {
  id: number
  code: string // 节点编号，如 PROX-31
  address: string // 代理地址
  protocol: ProxyProtocol // 代理协议
  region: string // 地域标签，如 华东区
  anonymity: AnonymityLevel // 匿名级别
  intervalSec: number // 存活检测间隔（秒）
  failureLimit: number // 连续失败上限
  ownerSite: string // 维护归属：目标站点，只有该站点负责人可写
  // 运行期字段
  status: HealthStatus
  consecutiveFailures: number // 当前连续失败次数
  lastCheckSeq: number | null // 最后一次存活检测的事件序号（新旧冲突以它为准）
  lastAliveSeq: number | null // 最后一次「存活」检测的事件序号
  currentAddress: string // 当前生效地址（路由对账基准；修正后与 address 一致）
  createdAt: string
  updatedAt: string
}

/**
 * 健康事件流：检测与移除都追加为不可变事件。
 * 同一节点同时被检测和移除时，由 seq 大小决定先后，服务按到达顺序串行裁决。
 */
export interface HealthEvent {
  seq: number // 全局单调递增，冲突时序号大的（最后一次）为准
  nodeId: number
  type: HealthEventType
  verdict?: CheckVerdict // type=检测 时存在
  // 检测请求携带的四要素，必须与节点登记信息逐字一致，否则判为越权/无效检测
  address: string
  protocol: ProxyProtocol
  region: string
  anonymity: AnonymityLevel
  operator: string
  ownerSite: string // 操作时声明的维护归属，用于越权校验
  occurredAt: string
  // 幂等键：同一节点同一检测结论在同一检测窗口内只记一次（重复检测只记录一次）
  dedupeKey: string
  accepted: boolean // 是否被采纳（被挡下的事件也留痕，便于审计）
  reason: string // 采纳或拒绝原因
}

/** 失败留档：旧失败记录长期保留，节点恢复后也不删除。 */
export interface FailureRecord {
  id: number
  nodeId: number
  nodeCode: string
  eventSeq: number
  region: string
  failureCount: number // 发生时的连续失败次数
  detail: string
  occurredAt: string
  archived: boolean // 恢复后标记为已归档，记录本身仍在
}

/** 采集批次台账：记录批次引用的代理及当时的不可用节点数。 */
export interface CollectBatch {
  id: number
  batchNo: string // 批次号
  targetSite: string // 目标站点（其它入口）
  proxyNodeIds: number[] // 批次分配到的代理节点
  unavailableNodeCount: number // 台账同步的不可用节点数（快照）
  routeAddress: string // 批次代理路由里记录的地址（可能残留旧地址）
  status: '待派发' | '采集中' | '已完成'
  createdAt: string
  updatedAt: string
}

/** 代理路由：节点地址变更后这里可能残留旧地址，需要与代理池列表对账修正。 */
export interface ProxyRoute {
  id: number
  nodeId: number
  batchId: number
  boundAddress: string // 路由当前绑定的地址
  updatedAt: string
}

/** 操作审计：跳级、越权、未授权修改全部留痕并被挡下。 */
export interface AuditEntry {
  id: number
  seq: number
  operator: string
  ownerSite: string
  action: string
  nodeCode: string
  allowed: boolean
  reason: string
  occurredAt: string
}

export interface ProxyHealthState {
  version: number
  nodes: ProxyNode[]
  events: HealthEvent[]
  failures: FailureRecord[]
  batches: CollectBatch[]
  routes: ProxyRoute[]
  audits: AuditEntry[]
  seqCounter: number
}

/** 服务统一返回结果，被挡下时 ok=false 且带原因。 */
export interface HealthResult<T = unknown> {
  ok: boolean
  message: string
  data?: T
}

// 检测请求入参：四要素 + 维护归属 + 操作人。
export interface CheckRequest {
  nodeId: number
  verdict: CheckVerdict
  address: string
  protocol: ProxyProtocol
  region: string
  anonymity: AnonymityLevel
  operator: string
  ownerSite: string
}

export interface RemoveRequest {
  nodeId: number
  operator: string
  ownerSite: string
  reason?: string
}
