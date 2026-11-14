import { buildProxyHealthSeed } from './proxy-health-seed'
import type { ProxyHealthState } from './proxy-health-types'

// 代理健康域独立持久化：与通用条目存储（scraper-config-studio:entries）分开，互不影响。
const STORAGE_KEY = 'scraper-config-studio:proxy-health:v1'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): ProxyHealthState {
  const fallback = buildProxyHealthSeed()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as ProxyHealthState
    if (!parsed || parsed.version !== fallback.version || !Array.isArray(parsed.nodes)) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
      return fallback
    }
    return parsed
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: ProxyHealthState | null = null

export function proxyHealthState(): ProxyHealthState {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function persistProxyHealth(state: ProxyHealthState): void {
  cache = state
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }
}

export function resetProxyHealth(): ProxyHealthState {
  const fresh = buildProxyHealthSeed()
  persistProxyHealth(fresh)
  return fresh
}

// 供无浏览器环境（自检脚本/单测）注入初始状态，绕过 localStorage。
export function loadProxyHealthFrom(initial: ProxyHealthState): ProxyHealthState {
  cache = clone(initial)
  return cache
}

export function proxyHealthStorageKey(): string {
  return STORAGE_KEY
}
