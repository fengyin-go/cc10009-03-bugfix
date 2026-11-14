// 自检运行器：用 esbuild 把 @/ 别名解析后在 Node 里跑代理健康链路测试。
// 纯本地、无浏览器、无第三方测试框架；退出码非零即表示有用例失败。
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const entry = resolve(here, 'proxy-health.check.ts')
const outfile = resolve(here, '.proxy-health.check.bundle.mjs')

await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile,
  alias: {
    '@': resolve(root, 'src'),
  },
  logLevel: 'warning',
})

try {
  execFileSync(process.execPath, [outfile], { stdio: 'inherit' })
} catch (error) {
  rmSync(outfile, { force: true })
  process.exit(1)
}
rmSync(outfile, { force: true })
