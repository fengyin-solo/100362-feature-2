/**
 * 验证脚本运行器：用 esbuild 的 JS API 把 verify-offline.ts 转译成 ESM 后用 Node 执行，
 * 不依赖与安装平台绑定的 .bin/esbuild 原生可执行文件，也不需要额外安装 tsx/ts-node。
 * 运行：npm run verify:offline
 */
const { build } = require('esbuild')
const { pathToFileURL } = require('node:url')
const { rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

async function main() {
  const outfile = join(tmpdir(), `verify-offline-${process.pid}.mjs`)
  await build({
    entryPoints: ['scripts/verify-offline.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    logLevel: 'warning',
  })
  try {
    await import(pathToFileURL(outfile).href)
  } finally {
    await rm(outfile, { force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
