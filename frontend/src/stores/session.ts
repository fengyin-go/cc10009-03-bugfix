import { defineStore } from 'pinia'

// 值班会话：operator 是当前操作人，ownerSite 是其负责的目标站点（维护归属）。
// role 为 owner（站点负责人，可写）或 reader（非负责人，只读）。
export type SessionRole = 'owner' | 'reader'

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    shiftLabel: '白班 08:00-20:00',
    scope: '网页采集配置管理工具',
    // 维护归属：当前操作人负责的目标站点；只有归属站点内的代理节点才能被其修改。
    ownerSite: 'east.example.com',
    role: 'owner' as SessionRole,
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
    // 非负责人对维护范围只读。
    isReadOnly: (state) => state.role !== 'owner' || state.operator.length === 0,
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setRole(role: SessionRole) {
      this.role = role
    },
    setOwnerSite(site: string) {
      this.ownerSite = site
    },
  },
})
