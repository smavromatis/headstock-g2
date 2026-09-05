/**
 * Detection regression tests. Run with: npm run check:detection
 *
 * Covers the three failures that have actually happened here: pitch error
 * beyond a cent, a reading that drifts on a constant tone, and a noise gate
 * that closes on a sustained note and makes the tuner go deaf.
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
      s += partials[k] * Math.sin(2 * Math.PI * f0 * (k + 1) * (1 + 2e-4 * k * k) * (i / SR) + phase * (k + 1))
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
    if (!r) { worst = Infinity; break }
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

console.log(failures ? `\n${failures} failure(s)\n` : '\nall detection checks passed\n')
process.exit(failures ? 1 : 0)
