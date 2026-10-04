#!/usr/bin/env node
/* 自检运行器：用 esbuild 把 TS 服务层打成临时 ESM，再执行规则自检。
 * 用法：node scripts/run-check.mjs（不依赖浏览器，localStorage 用内存桩替代）。 */
import { build } from 'esbuild'
import { rm } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const entry = path.join(here, '.check-entry.ts')
const outfile = path.join(here, 'service-bundle.generated.mjs')
const checker = path.join(here, 'patrol-report-check.mjs')

const entrySource = `
export * from ${JSON.stringify(path.join(root, 'src/api/patrol-report-service.ts'))}
import { patrolReportState } from ${JSON.stringify(path.join(root, 'src/data/patrol-report-store.ts'))}
export function patrolReportStateExport() { return patrolReportState() }
`

const { writeFile } = await import('node:fs/promises')
await writeFile(entry, entrySource, 'utf8')

try {
  await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'warning' })
  process.env.PATROL_CHECK_BUNDLE = pathToFileURL(outfile).href
  await import(pathToFileURL(checker).href)
} finally {
  await rm(entry, { force: true })
}
