/**
 * Detection regression tests. Run with: npm run check:detection
 *
 * Covers the failures that have actually happened here: pitch error beyond a
 * cent, a reading that drifts on a constant tone, a noise gate that closes on
 * a sustained note and makes the tuner go deaf, and a decay rejection that was
 * comparing the level against itself instead of the previous frame.
 */
import { Tuner } from '../src/tuner'
import { detectPitch } from '../src/audio/pitch'
import { TUNINGS, midiToFreq } from '../src/tuning/notes'

const SR = 16000
const WINDOW = 4096
let failures = 0

function report(name: string, ok: boolean, detail: string) {
  if (!ok) failures++
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name.padEnd(34)} ${detail}`)
}

/** Plucked string: harmonic stack, weak fundamental, decay, slight inharmonicity. */
function pluck(f0: number, n: number, phase = 0.3, weak = true): Float32Array {
  const buf = new Float32Array(n)
  const partials = [weak ? 0.25 : 1, 0.85, 0.55, 0.4, 0.28, 0.18, 0.12, 0.08, 0.05]
  for (let i = 0; i < n; i++) {
    let s = 0
    for (let k = 0; k < partials.length; k++) {
      s +=
        partials[k] *
        Math.sin(2 * Math.PI * f0 * (k + 1) * (1 + 2e-4 * k * k) * (i / SR) + phase * (k + 1))
    }
    buf[i] = 0.22 * Math.exp(-2.2 * (i / SR)) * s + 0.004 * (Math.random() * 2 - 1)
  }
  return buf
}

const cents = (a: number, b: number) => 1200 * Math.log2(a / b)

console.log('\naccuracy, worst of 12 trials per string')
for (const s of TUNINGS[0].strings) {
  const target = midiToFreq(s.midi, 440)
  let worst = 0
  for (let t = 0; t < 12; t++) {
    const r = detectPitch(pluck(target, WINDOW, t * 0.37), SR)
    if (!r) {
      worst = Infinity
      break
    }
    worst = Math.max(worst, Math.abs(cents(r.freq, target)))
  }
  report(`${s.label} within 1 cent`, worst < 1, `${worst.toFixed(3)} cents`)
}

/** Feeds a phase-continuous tone through a Tuner, as the app would. */
function runSustained(freq: number, seconds: number) {
  const tuner = new Tuner()
  let phase = 0
  const chunk = (n: number) => {
    const bytes = new Uint8Array(n * 2)
    const partials = [0.3, 0.85, 0.55, 0.4, 0.28, 0.18, 0.12]
    const step = (2 * Math.PI * freq) / SR
    for (let i = 0; i < n; i++) {
      let s = 0
      for (let k = 0; k < partials.length; k++) s += partials[k] * Math.sin(phase * (k + 1))
      phase += step
      const q = Math.round(Math.max(-1, Math.min(1, 0.25 * s)) * 32767)
      bytes[i * 2] = q & 0xff
      bytes[i * 2 + 1] = (q >> 8) & 0xff
    }
    return bytes
  }
  const readings: Array<number | null> = []
  let now = 0
  for (let step = 0; step < seconds * 10; step++) {
    now += 100
    tuner.ingest(chunk(1600))
    tuner.advance(now)
    if (now > 1500) readings.push(tuner.view().freq)
  }
  return readings
}

console.log('\nsustained tone, 60 seconds')
const target = midiToFreq(TUNINGS[0].strings[0].midi, 440) * Math.pow(2, -18 / 1200)
const readings = runSustained(target, 60)
const lost = readings.filter((r) => r === null).length
report('never goes deaf', lost === 0, `${lost} of ${readings.length} frames lost`)

const errs = readings.filter((r): r is number => r !== null).map((r) => Math.abs(cents(r, target)))
const worstDrift = Math.max(...errs)
report('no drift over 60s', worstDrift < 1, `worst ${worstDrift.toFixed(3)} cents`)

/**
 * A note damped hard while its pitch slides flat.
 *
 * A string goes flat as it dies, so those frames must not reach the estimator:
 * the reading should hold where the note was rather than follow it down.
 * `advance()` drops them by comparing the level against the previous frame.
 *
 * Guards an ordering bug. `prevRms` was assigned before the comparison read
 * it, making the test `level < level * 0.6`, false for every level, so the
 * rejection never ran. Put that assignment back above the comparison and this
 * reports ~17 cents against a limit of 10.
 */
function runDamped(f0: number, dampRate: number, slideCents: number) {
  const tuner = new Tuner()
  // Deterministic noise, so the margin cannot vary between runs.
  let seed = 12345
  const noise = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1

  let phase = 0
  let t = 0
  const worst: number[] = []
  for (let step = 0; step < 45; step++) {
    const n = 1600
    const bytes = new Uint8Array(n * 2)
    const partials = [0.3, 0.85, 0.55, 0.4, 0.28, 0.18, 0.12]
    for (let i = 0; i < n; i++) {
      // Sustained long enough to be locked on, then damped.
      const dying = Math.max(0, t - 1.8)
      const envelope = Math.exp(-dampRate * dying)
      const slide = slideCents * (1 - envelope)
      let s = 0
      for (let k = 0; k < partials.length; k++) s += partials[k] * Math.sin(phase * (k + 1))
      phase += (2 * Math.PI * (f0 * Math.pow(2, slide / 1200))) / SR
      const v = 0.25 * envelope * s + 0.002 * noise()
      const q = Math.round(Math.max(-1, Math.min(1, v)) * 32767)
      bytes[i * 2] = q & 0xff
      bytes[i * 2 + 1] = (q >> 8) & 0xff
      t += 1 / SR
    }
    tuner.ingest(bytes)
    tuner.advance(step * 100 + 100)
    // Only frames after the damping starts matter.
    if (t > 2.2) {
      const c = tuner.view().cents
      if (c !== null) worst.push(Math.abs(c))
    }
  }
  return worst.length ? Math.max(...worst) : Infinity
}

console.log('\na damped string sliding 30 cents flat')
for (const rate of [6, 9, 14]) {
  const worst = runDamped(midiToFreq(TUNINGS[0].strings[2].midi, 440), rate, -30)
  report(`holds through damping at ${rate}/s`, worst < 10, `drifted ${worst.toFixed(2)} cents`)
}

console.log(failures ? `\n${failures} failure(s)\n` : '\nall detection checks passed\n')
process.exit(failures ? 1 : 0)
