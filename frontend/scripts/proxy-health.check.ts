/**
 * PROX-31 代理健康链路自检测试。
 * 用 esbuild 把 @/ 别名打包后在 Node 里跑（见 scripts/run-check.sh），不依赖浏览器与第三方测试框架。
 * 每条用例对应工单里的一条规则；任一断言失败即进程非零退出。
 */
import { buildProxyHealthSeed } from '@/data/proxy-health-seed'
import { loadProxyHealthFrom, resetProxyHealth } from '@/data/proxy-health-store'
import type { ProxyHealthState, ProxyNode } from '@/data/proxy-health-types'
import {
  allocatableNodes,
  getState,
  listFailures,
  matchNodeIdentity,
  removeNode,
  resolveNodeStatus,
  runReconcile,
  setHealthClock,
  submitCheck,
} from '@/api/proxy-health-service'

let passed = 0
let failed = 0
const failures: string[] = []

function assert(condition: boolean, label: string): void {
  if (condition) {
    passed += 1
    console.log(`  ✅ ${label}`)
  } else {
    failed += 1
    failures.push(label)
    console.error(`  ❌ ${label}`)
  }
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 每个场景给一份全新的播种状态，并把时钟固定住，避免真实时间干扰幂等窗口。
let clockIso = '2026-11-14T09:00:00.000Z'
function useFreshState(): ProxyHealthState {
  clockIso = '2026-11-14T09:00:00.000Z'
  setHealthClock(() => clockIso)
  return loadProxyHealthFrom(buildProxyHealthSeed())
}
function advanceMinutes(minutes: number): void {
  const t = new Date(clockIso)
  t.setUTCMinutes(t.getUTCMinutes() + minutes)
  clockIso = t.toISOString()
}
function node31(state: ProxyHealthState): ProxyNode {
  const node = state.nodes.find((n) => n.id === 31)
  if (!node) throw new Error('PROX-31 缺失')
  return node
}
const ownerReq = {
  address: '203.0.113.31:8100',
  protocol: 'HTTP' as const,
  region: '华东区',
  anonymity: '高匿' as const,
  operator: '张站点',
  ownerSite: 'east.example.com',
}

console.log('\n场景 1：PROX-31 连续失败 6 次后，对账必须把它从「可用」纠正为「不可用」，并停止分配')
{
  const state = useFreshState()
  assert(node31(state).status === '可用', '播种现场：PROX-31 被错误显示为可用')
  assert(node31(state).consecutiveFailures === 6, '播种现场：连续失败次数为 6（超过上限 5）')
  const result = runReconcile()
  assert(result.ok, '全量对账执行成功')
  assert(node31(getState()).status === '不可用', '规则：达到失败上限后健康结果裁决为不可用')
  const change = result.data.statusChanges.find((c) => c.nodeCode === 'PROX-31')
  assert(Boolean(change) && change?.from === '可用' && change?.to === '不可用', '对账记录了 可用 → 不可用 的纠正')
  const allocatable = allocatableNodes(getState(), 'east.example.com').map((n) => n.code)
  assert(!allocatable.includes('PROX-31'), '规则：不可用节点不再出现在可分配列表，采集批次不会再拿到它')
  assert(allocatable.includes('PROX-32'), '同站点健康节点 PROX-32 仍可分配')
}

console.log('\n场景 2：四要素（地址/协议/地域/匿名级别）核对，任一不符即挡下检测')
{
  useFreshState()
  const base = { nodeId: 31, verdict: '失败' as const, ...ownerReq }
  const wrongAddress = submitCheck({ ...base, address: '10.0.0.99:9999' })
  assert(!wrongAddress.ok && wrongAddress.message.includes('代理地址'), '代理地址不符被挡下')
  const wrongProtocol = submitCheck({ ...base, protocol: 'SOCKS5' })
  assert(!wrongProtocol.ok && wrongProtocol.message.includes('代理协议'), '代理协议不符被挡下')
  const wrongRegion = submitCheck({ ...base, region: '华南区' })
  assert(!wrongRegion.ok && wrongRegion.message.includes('地域标签'), '地域标签不符被挡下')
  const wrongAnon = submitCheck({ ...base, anonymity: '透明' })
  assert(!wrongAnon.ok && wrongAnon.message.includes('匿名级别'), '匿名级别不符被挡下')
  const rejected = getState().events.filter((e) => e.nodeId === 31 && !e.accepted)
  assert(rejected.length === 4, '被挡下的检测事件全部留痕（accepted=false）')
  const before = node31(getState()).consecutiveFailures
  assert(before === 6, '无效检测不改变连续失败计数与健康结果')
  // 纯函数核对器本身
  const node = node31(getState())
  assert(matchNodeIdentity(node, ownerReq).ok, '四要素完全一致时核对通过')
}

console.log('\n场景 3：健康结果按 可用 → 不可用 → 已移除 优先级裁决，已移除为终态，跳级/回退被挡下')
{
  useFreshState()
  assert(resolveNodeStatus({ ...node31(getState()), status: '已移除' }) === '已移除', '已移除终态裁决保持已移除')
  const removed = removeNode({ nodeId: 31, operator: '张站点', ownerSite: 'east.example.com' })
  assert(removed.ok && node31(getState()).status === '已移除', '负责人可把节点移除，结果为已移除')
  // 移除后再检测：不能把已移除节点拉回可用/不可用（跳级回退挡下）
  advanceMinutes(1)
  const checkAfterRemove = submitCheck({ nodeId: 31, verdict: '存活', ...ownerReq })
  assert(!checkAfterRemove.ok && node31(getState()).status === '已移除', '已移除节点的存活检测被挡下，终态不回退')
  const again = removeNode({ nodeId: 31, operator: '张站点', ownerSite: 'east.example.com' })
  assert(!again.ok, '重复移除被幂等挡下')
}

console.log('\n场景 4：维护归属到目标站点，非负责人只读（越权/未授权修改挡下）')
{
  useFreshState()
  // 越权：华北站点负责人改华东节点
  const crossSite = submitCheck({
    nodeId: 31, verdict: '失败', ...ownerReq, operator: '李华北', ownerSite: 'north.example.com',
  })
  assert(!crossSite.ok && crossSite.message.includes('越权'), '跨站点（越权）检测被挡下')
  const crossRemove = removeNode({ nodeId: 31, operator: '李华北', ownerSite: 'north.example.com' })
  assert(!crossRemove.ok && crossRemove.message.includes('越权'), '跨站点移除被挡下')
  // 未授权：缺少操作人
  const noOperator = submitCheck({
    nodeId: 31, verdict: '失败', ...ownerReq, operator: '  ', ownerSite: 'east.example.com',
  })
  assert(!noOperator.ok && noOperator.message.includes('未授权'), '未授权（无操作人）修改被挡下')
  assert(node31(getState()).status === '可用', '被挡下的写操作不改变节点状态（只读生效）')
  const blocked = getState().audits.filter((a) => !a.allowed)
  assert(blocked.length >= 3, '越权与未授权操作全部写入审计并标记挡下')
}

console.log('\n场景 5：同一节点同时被检测和移除 —— 按事件序号串行，移除先到则检测无效')
{
  useFreshState()
  // 先移除（seq 增加），随后在同一窗口检测，检测必须因终态被挡下
  removeNode({ nodeId: 31, operator: '张站点', ownerSite: 'east.example.com' })
  const check = submitCheck({ nodeId: 31, verdict: '失败', ...ownerReq })
  assert(!check.ok, '移除先到达时，并发到达的检测不生效')
  const nodeEvents = getState().events.filter((e) => e.nodeId === 31)
  const removeSeq = nodeEvents.filter((e) => e.type === '移除').at(-1)?.seq
  const lastCheck = nodeEvents.filter((e) => e.type === '检测').at(-1)
  assert(
    typeof removeSeq === 'number' && typeof lastCheck?.seq === 'number' && (lastCheck?.seq ?? 0) > (removeSeq ?? 0),
    '事件按全局序号排序，检测序号晚于移除但仍不改变终态',
  )
}

console.log('\n场景 6：重复检测只记录一次（同节点同结论同检测窗口幂等）')
{
  useFreshState()
  // 先恢复成健康起点，避免被失败上限干扰
  const node = node31(getState())
  node.status = '可用'; node.consecutiveFailures = 0
  const seedSeq = getState().seqCounter
  const first = submitCheck({ nodeId: 31, verdict: '失败', ...ownerReq })
  assert(first.ok, '第一次失败检测被采纳')
  const dup = submitCheck({ nodeId: 31, verdict: '失败', ...ownerReq })
  assert(!dup.ok && dup.data?.deduped === true, '同一分钟内相同结论的重复检测只记录一次')
  advanceMinutes(1)
  const nextWindow = submitCheck({ nodeId: 31, verdict: '失败', ...ownerReq })
  assert(nextWindow.ok, '进入下一检测窗口后相同结论可再次记录')
  const newAcceptedFailures = getState().events.filter(
    (e) => e.nodeId === 31 && e.type === '检测' && e.accepted && e.verdict === '失败' && e.seq > seedSeq,
  )
  assert(newAcceptedFailures.length === 2, '本场景采纳的失败事件恰好 2 条（重复的那条未入账）')
}

console.log('\n场景 7：节点恢复 —— 成功后另行给出恢复结果，旧失败记录留档并归档')
{
  useFreshState()
  runReconcile() // 先把 PROX-31 纠正为不可用
  const archivedBefore = listFailures(31).filter((f) => !f.archived).length
  assert(archivedBefore === 6, '恢复前 6 条失败记录均未归档且完整留档')
  advanceMinutes(1)
  const recovered = submitCheck({ nodeId: 31, verdict: '存活', ...ownerReq })
  assert(recovered.ok && recovered.data?.recovered === true, '存活检测触发恢复，结果显式标记 recovered')
  assert(node31(getState()).status === '可用', '恢复后健康结果回到可用')
  assert(recovered.message.includes('恢复'), '返回信息另行提示恢复结果')
  const allFailures = listFailures(31)
  assert(allFailures.length === 6, '旧失败记录一条不删，仍留档')
  assert(allFailures.every((f) => f.archived), '恢复后历史失败记录统一标记为已归档')
  assert(node31(getState()).consecutiveFailures === 0, '恢复后连续失败计数清零')
}

console.log('\n场景 8：采集批次台账同步不可用节点数，且新旧冲突以最后一次存活检测为准')
{
  useFreshState()
  const batch = getState().batches.find((b) => b.batchNo === 'BATCH-009')!
  assert(batch.unavailableNodeCount === 0, '播种现场：台账不可用节点数是旧快照 0')
  runReconcile()
  assert(batch.unavailableNodeCount === 1, '对账后台账同步为 1（PROX-31 不可用，PROX-32 可用）')
  // 再来一次失败推进到最后检测仍是失败，台账维持 1
  advanceMinutes(2)
  submitCheck({ nodeId: 31, verdict: '失败', ...ownerReq })
  assert(batch.unavailableNodeCount === 1, '持续失败时台账不可用数保持同步')
  // 最后一次存活检测：恢复后以它为准，台账回到 0
  advanceMinutes(1)
  const recovered = submitCheck({ nodeId: 31, verdict: '存活', ...ownerReq })
  assert(recovered.ok, '最后一次检测为存活，恢复成功')
  assert(batch.unavailableNodeCount === 0, '以最后一次存活检测为准，台账不可用数回到 0')
  assert(allocatableNodes(getState(), 'east.example.com').some((n) => n.id === 31), '恢复后 PROX-31 重新可分配给采集批次')
}

console.log('\n场景 9：代理路由残留旧地址 —— 沿健康链路对账修正，列表与批次详情一致')
{
  useFreshState()
  const route = getState().routes.find((r) => r.nodeId === 31)!
  const batch = getState().batches.find((b) => b.batchNo === 'BATCH-009')!
  assert(route.boundAddress === '203.0.113.31:8080', '播种现场：路由残留旧地址 8080')
  assert(route.boundAddress !== node31(getState()).currentAddress, '残留地址与代理池当前地址 8100 对不上')
  const sync = runReconcile()
  const fix = sync.data.routeFixes.find((r) => r.nodeCode === 'PROX-31')
  assert(Boolean(fix) && fix?.from === '203.0.113.31:8080' && fix?.to === '203.0.113.31:8100', '路由旧地址被修正为当前地址')
  assert(route.boundAddress === '203.0.113.31:8100', '修正后路由绑定地址等于代理池当前地址')
  assert(batch.routeAddress === route.boundAddress, '采集批次详情的路由地址与代理池列表完全一致')
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
if (failed > 0) {
  console.error('失败用例：\n - ' + failures.join('\n - '))
  process.exit(1)
}
// 自检结束复位存储，避免污染浏览器缓存键（Node 下无 localStorage，此调用主要走内存缓存）。
resetProxyHealth()
