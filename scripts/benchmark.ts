import assert from 'node:assert/strict'
import { Tuner } from '../src/tuner'
import { PitchSmoother } from '../src/audio/stream'
import { detectPitch } from '../src/audio/pitch'
import { GlassesRenderer, needleDot } from '../src/glasses/display'
import { BridgeQueue } from '../src/bridge-queue'
import { random } from './seeded'

const cents = (f: number, target: number) => 1200 * Math.log2(f / target)
const quantile = (values: number[], q: number) =>
  [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * q)]
function stats(values: number[]) {
  const steps = values.slice(1).map((v, i) => v - values[i])
  let reversals = 0
  let direction = 0
  for (const step of steps)
    if (step) {
      if (direction && Math.sign(step) !== direction) reversals++
      direction = Math.sign(step)
    }
  return {
    span95: quantile(values, 0.975) - quantile(values, 0.025),
    range: Math.max(...values) - Math.min(...values),
    maxStep: Math.max(0, ...steps.map(Math.abs)),
    reversals,
  }
}
// Original-author One Euro equations; frequencies are converted to cents first.
class OneEuro {
  private value: number | null = null
  private raw = 0
  private derivative = 0
  push(x: number, dt: number) {
    if (this.value === null) {
      this.value = this.raw = x
      return x
    }
    const alpha = (cutoff: number) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt))
    this.derivative += alpha(1) * ((x - this.raw) / dt - this.derivative)
    this.raw = x
    this.value += alpha(0.8 + 0.05 * Math.abs(this.derivative)) * (x - this.value)
    return this.value
  }
}
const ema = new PitchSmoother()
const euro = new OneEuro()
const traces: Record<string, number[]> = { ema: [], oneEuro: [] }
for (let i = 0; i < 100; i++) {
  const x = (i >= 70 ? 10 : 0) + (random() - 0.5) * 0.4
  const base = i >= 70 ? 0.5 : 0.15
  traces.ema.push(cents(ema.push(110 * 2 ** (x / 1200), base), 110))
  traces.oneEuro.push(euro.push(x, 0.1))
}
for (const [filter, trace] of Object.entries(traces))
  console.log(
    'filter',
    filter,
    JSON.stringify({
      jitterCents: stats(trace.slice(20, 70)),
      step90Ms: trace.slice(70).findIndex((v) => v >= 9) * 100,
    }),
  )

// Actual renderer output, captured after successful fake-bridge writes.
let simulatedAt = 0
const updates: number[] = []
const t = new Tuner()
let dot: number | null = null
let phase = 0
const bridge = {
  textContainerUpgrade: async (row: { containerName: string; content: string }) => {
    if (row.containerName === 'needle') {
      updates.push(simulatedAt)
      const index = [...row.content].findIndex((c) => ['▲', '◆', '█'].includes(c))
      dot = index < 0 ? null : index * 5
    }
    return true
  },
}
const renderer = new GlassesRenderer(bridge as never, new BridgeQueue())
const positions: number[] = []
const timings: number[] = []
let lag = -1
let switchLag = -1
let downLag = -1
const motion: number[] = []
for (let frame = 1; frame <= 160; frame++) {
  const offset = frame > 80 && frame <= 105 ? 10 : frame > 105 && frame <= 130 ? -10 : 0
  const target = frame > 130 ? 146.832384 : 110
  const freq = target * 2 ** (offset / 1200)
  const bytes = new Uint8Array(3200)
  const data = new DataView(bytes.buffer)
  for (let i = 0; i < 1600; i++) {
    data.setInt16(i * 2, Math.round(10000 * Math.sin(phase) + 5 * (random() - 0.5)), true)
    phase += (2 * Math.PI * freq) / 16000
  }
  const start = performance.now()
  t.ingest(bytes, frame * 100)
  t.advance(frame * 100)
  timings.push(performance.now() - start)
  simulatedAt = frame * 100
  renderer.render(t.view())
  await new Promise((resolve) => setImmediate(resolve))
  if (!process.env.BASELINE && t.view().offScale)
    assert.equal(dot, null, 'pending target must not rail the old meter')
  if (frame > 25 && frame <= 75 && dot !== null) positions.push(dot)
  if (frame > 80 && frame <= 105 && dot !== null && dot >= needleDot(9) * 5 && lag < 0)
    lag = (frame - 81) * 100
  if (process.env.TRACE && frame > 75)
    console.log('frame', frame, dot, t.view().cents, t.view().measurement?.cents, t.view().offScale)
  if (dot !== null) motion.push(dot)
  if (frame > 105 && frame <= 130 && dot !== null && dot <= needleDot(-9) * 5 && downLag < 0)
    downLag = (frame - 106) * 100
  if (frame > 130 && t.view().stringIndex === 2 && !t.view().offScale && switchLag < 0)
    switchLag = (frame - 131) * 100
}
console.log(
  'pipeline',
  JSON.stringify({
    pointer: stats(positions),
    step90Ms: lag,
    reverse90Ms: downLag,
    motion: stats(motion),
    switchMs: switchLag,
    processingP95Ms: quantile(timings, 0.95),
    tickMs: 100,
    needleWrites: updates.length,
    updateIntervalsMs: {
      min: Math.min(...updates.slice(1).map((v, i) => v - updates[i])),
      max: Math.max(...updates.slice(1).map((v, i) => v - updates[i])),
    },
  }),
)
assert(stats(positions).span95 <= 5)
// Report proposed latency misses explicitly; do not substitute weaker pass thresholds.
assert(lag >= 0 && lag <= 500, `step90 ${lag}ms exceeds 500ms`)
assert(downLag >= 0 && downLag <= 500, `reverse90 ${downLag}ms exceeds 500ms`)
assert(switchLag >= 0 && switchLag <= 800, `switch ${switchLag}ms exceeds 800ms`)

for (const length of [4096, 8192]) {
  for (const fundamental of [1, 0.03, 0]) {
    const errors: number[] = []
    let rejected = 0
    let wrongOctave = 0
    for (let trial = 0; trial < 30; trial++) {
      const buf = new Float32Array(length)
      for (let i = 0; i < length; i++) {
        const x = (2 * Math.PI * 82.406889 * i) / 16000 + trial
        buf[i] =
          0.15 * (fundamental * Math.sin(x) + 0.8 * Math.sin(2 * x) + 0.5 * Math.sin(3 * x)) +
          0.001 * (random() - 0.5)
      }
      const r = detectPitch(buf, 16000)
      if (!r) rejected++
      else {
        const error = cents(r.freq, 82.406889)
        errors.push(error)
        if (Math.abs(error) > 600) wrongOctave++
      }
    }
    console.log(
      'phase-window',
      JSON.stringify({
        length,
        fundamental,
        rejected,
        wrongOctave,
        maxError: errors.length ? Math.max(...errors.map(Math.abs)) : null,
        variance: errors.length
          ? errors.reduce(
              (a, x) => a + (x - errors.reduce((a, b) => a + b, 0) / errors.length) ** 2,
              0,
            ) / errors.length
          : null,
      }),
    )
  }
}
