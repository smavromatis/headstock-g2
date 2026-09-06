/** Check that selected safety regressions detect their deliberately restored bugs. */
import { cpSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
const root = mkdtempSync(join(tmpdir(), 'headstock-mutations-'))
cpSync('src', join(root, 'src'), { recursive: true })
cpSync('scripts', join(root, 'scripts'), { recursive: true })
symlinkSync(resolve('node_modules'), join(root, 'node_modules'))
const mutations = [
  [
    'src/tuner.ts',
    'const c = this.measurement?.cents ?? null',
    'const c = this.currentCents',
    'R2 smoothed pointer',
  ],
  ['src/tuner.ts', '    this.clearSession()\n    this.reset()', '    this.reset()', 'R9 settings'],
  [
    'src/audio/stream.ts',
    'private readonly medianLength = 3',
    'private readonly medianLength = 1',
    'R8 clipping',
  ],
  [
    'src/audio/stream.ts',
    'if (bytes.length % 2) return new Float32Array(0)',
    '/* accept odd data */',
    'R10 malformed',
  ],
  [
    'src/glasses/display.ts',
    '    this.generation++',
    '    /* no generation invalidation */',
    'R4/R5 rejection',
  ],
  [
    'src/microphone.ts',
    'if (generation !== this.generation) return false',
    '/* accept obsolete control result */',
    'R10 late microphone',
  ],
  [
    'src/diagnostics.ts',
    'if (this.events.length >= 1000) this.events.shift()',
    '/* unbounded trace */',
    'R11 diagnostics',
  ],
]
for (const [file, before, after, expected] of mutations) {
  const path = join(root, file)
  const original = readFileSync(path, 'utf8')
  if (!original.includes(before)) throw Error(`Mutation no longer matches ${file}`)
  writeFileSync(path, original.replace(before, after))
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
    env: { ...process.env, QUICK: '1' },
  })
  writeFileSync(path, original)
  if (result.status !== 1 || !result.stderr.includes(`FAIL ${expected}`)) {
    process.stdout.write(result.stdout + result.stderr)
    throw Error(`Regression did not detect mutation: ${file}: ${expected}`)
  }
  console.log('pass mutation detected:', expected)
}

const displayPath = join(root, 'src/glasses/display.ts')
const display = readFileSync(displayPath, 'utf8')
writeFileSync(
  displayPath,
  display.replace(
    'view.cents === null || view.stringIndex === null || view.offScale',
    'view.cents === null || view.stringIndex === null',
  ),
)
execFileSync(resolve('node_modules/.bin/esbuild'), [
  join(root, 'scripts/benchmark.ts'),
  '--bundle',
  '--platform=node',
  '--format=esm',
  `--outfile=${root}/benchmark.mjs`,
  '--log-level=error',
])
const rendered = spawnSync(process.execPath, [join(root, 'benchmark.mjs')], { encoding: 'utf8' })
if (
  rendered.status !== 1 ||
  !rendered.stderr.includes('pending target must not rail the old meter')
)
  throw Error('Renderer regression did not detect restored pending-target needle')
console.log('pass mutation detected: R7 pending-target meter')
