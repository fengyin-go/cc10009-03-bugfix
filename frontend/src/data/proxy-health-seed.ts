import type { ProxyHealthState } from './proxy-health-types'

/**
 * 代理健康域播种数据（PROX-31 故障现场）：
 * - PROX-31 在华东区连续失败 6 次，超过连续失败上限 5，但状态仍错误地显示「可用」；
 * - 采集批次 BATCH-009 仍把 PROX-31 分配给抓取；
 * - 代理路由里残留 PROX-31 的旧地址 203.0.113.31:8080，与代理池列表的当前地址对不上；
 * - 台账里的不可用节点数还是旧快照 0。
 * 健康服务首次加载时会基于事件流重新裁决，纠正这些不一致。
 */
export function buildProxyHealthSeed(): ProxyHealthState {
  const now = '2026-11-14T08:00:00.000Z'
  return {
    version: 1,
    seqCounter: 9,
    nodes: [
      {
        id: 31,
        code: 'PROX-31',
        address: '203.0.113.31:8100',
        protocol: 'HTTP',
        region: '华东区',
        anonymity: '高匿',
        intervalSec: 60,
        failureLimit: 5,
        ownerSite: 'east.example.com',
        // 故障现场：连续失败 6 次却仍被错误标成可用
        status: '可用',
        consecutiveFailures: 6,
        lastCheckSeq: 8,
        lastAliveSeq: 2,
        currentAddress: '203.0.113.31:8100',
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: now,
      },
      {
        id: 32,
        code: 'PROX-32',
        address: '198.51.100.7:8100',
        protocol: 'HTTPS',
        region: '华东区',
        anonymity: '匿名',
        intervalSec: 60,
        failureLimit: 5,
        ownerSite: 'east.example.com',
        status: '可用',
        consecutiveFailures: 0,
        lastCheckSeq: 7,
        lastAliveSeq: 7,
        currentAddress: '198.51.100.7:8100',
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: now,
      },
      {
        id: 41,
        code: 'PROX-41',
        address: '192.0.2.41:1080',
        protocol: 'SOCKS5',
        region: '华北区',
        anonymity: '高匿',
        intervalSec: 90,
        failureLimit: 4,
        ownerSite: 'north.example.com',
        status: '可用',
        consecutiveFailures: 1,
        lastCheckSeq: 6,
        lastAliveSeq: 5,
        currentAddress: '192.0.2.41:1080',
        createdAt: '2026-11-02T00:00:00.000Z',
        updatedAt: now,
      },
    ],
    events: [
      // PROX-31：先存活 2 次，随后连续失败 6 次（seq 3..8）
      {
        seq: 1, nodeId: 31, type: '检测', verdict: '存活',
        address: '203.0.113.31:8100', protocol: 'HTTP', region: '华东区', anonymity: '高匿',
        operator: '张站点', ownerSite: 'east.example.com',
        occurredAt: '2026-11-14T07:00:00.000Z', dedupeKey: '31:存活:07:00', accepted: true, reason: '检测通过',
      },
      {
        seq: 2, nodeId: 31, type: '检测', verdict: '存活',
        address: '203.0.113.31:8100', protocol: 'HTTP', region: '华东区', anonymity: '高匿',
        operator: '张站点', ownerSite: 'east.example.com',
        occurredAt: '2026-11-14T07:01:00.000Z', dedupeKey: '31:存活:07:01', accepted: true, reason: '检测通过',
      },
      ...[3, 4, 5, 6, 7, 8].map((seq, i) => ({
        seq, nodeId: 31, type: '检测' as const, verdict: '失败' as const,
        address: '203.0.113.31:8100', protocol: 'HTTP' as const, region: '华东区', anonymity: '高匿' as const,
        operator: '张站点', ownerSite: 'east.example.com',
        occurredAt: `2026-11-14T07:0${2 + i}:00.000Z`,
        dedupeKey: `31:失败:07:0${2 + i}`, accepted: true, reason: '检测通过',
      })),
    ],
    failures: [
      // 旧失败记录：留档，恢复后也不删
      ...[3, 4, 5, 6, 7, 8].map((seq, i) => ({
        id: i + 1,
        nodeId: 31,
        nodeCode: 'PROX-31',
        eventSeq: seq,
        region: '华东区',
        failureCount: i + 1,
        detail: `第 ${i + 1} 次连续存活检测失败（连接超时）`,
        occurredAt: `2026-11-14T07:0${2 + i}:00.000Z`,
        archived: false,
      })),
    ],
    batches: [
      {
        id: 9,
        batchNo: 'BATCH-009',
        targetSite: 'east.example.com',
        proxyNodeIds: [31, 32],
        // 故障现场：台账快照还是旧值，未同步不可用节点数
        unavailableNodeCount: 0,
        // 路由残留旧地址
        routeAddress: '203.0.113.31:8080',
        status: '待派发',
        createdAt: '2026-11-14T07:30:00.000Z',
        updatedAt: '2026-11-14T07:30:00.000Z',
      },
    ],
    routes: [
      {
        id: 1, nodeId: 31, batchId: 9,
        // 残留旧地址，与节点当前地址 203.0.113.31:8100 不一致
        boundAddress: '203.0.113.31:8080',
        updatedAt: '2026-11-10T00:00:00.000Z',
      },
      {
        id: 2, nodeId: 32, batchId: 9, boundAddress: '198.51.100.7:8100',
        updatedAt: '2026-11-14T07:30:00.000Z',
      },
    ],
    audits: [],
  }
}
