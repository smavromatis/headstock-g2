import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
const commit = 'dc08c563d792aab7cb28c71835fcf0de079c6177'
const root = mkdtempSync(join(tmpdir(), 'headstock-baseline-'))
const files = execFileSync('git', ['ls-tree', '-r', '--name-only', commit], { encoding: 'utf8' })
  .trim()
  .split('\n')
for (const file of files.filter((f) => f.startsWith('src/'))) {
  const path = join(root, file)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, execFileSync('git', ['show', `${commit}:${file}`]))
}
mkdirSync(join(root, 'scripts'))
symlinkSync(resolve('node_modules'), join(root, 'node_modules'))
const test = readFileSync('scripts/check-correctness.ts', 'utf8')
  .replace(/^import \{ Microphone \}.*\n/m, '')
  .replace(/^import \{ diagnostics \}.*\n/m, '')
  .replace('Tuner, normalizeSettings', 'Tuner')
writeFileSync(join(root, 'scripts/check-correctness.ts'), test)
execFileSync(resolve('node_modules/.bin/esbuild'), [
  join(root, 'scripts/check-correctness.ts'),
  '--bundle',
  '--platform=node',
  '--format=esm',
  `--outfile=${root}/check.mjs`,
  '--log-level=error',
])
const result = spawnSync(process.execPath, [join(root, 'check.mjs')], {
  encoding: 'utf8',
  env: { ...process.env, BASELINE: '1' },
})
process.stdout.write(result.stdout + result.stderr)
if (result.status !== 1 || (result.stderr.match(/FAIL R/g) ?? []).length !== 5)
  throw Error('Expected all five baseline regressions to fail')
console.log('Verified five regressions against', commit)
console.log('Isolated baseline sources:', root)
for (const name of ['benchmark.ts', 'seeded.ts']) {
  writeFileSync(join(root, 'scripts', name), readFileSync(join('scripts', name)))
}
execFileSync(resolve('node_modules/.bin/esbuild'), [
  join(root, 'scripts/benchmark.ts'),
  '--bundle',
  '--platform=node',
  '--format=esm',
  `--outfile=${root}/benchmark.mjs`,
  '--log-level=error',
])
const benchmark = spawnSync(process.execPath, [join(root, 'benchmark.mjs')], {
  encoding: 'utf8',
  env: { ...process.env, BASELINE: '1' },
})
process.stdout.write(benchmark.stdout)
if (benchmark.status !== 0)
  console.log(
    'Baseline benchmark missed a proposed acceptance target (expected; see measurements above).',
  )
