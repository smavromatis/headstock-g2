/**
 * Robustness tests for the adaptive parts. Run with: npm run check:robustness
 *
 * The tuner adapts as it runs: the noise gate tracks the room, smoothing
 * tightens near the target, and the label resists flapping. Anything adaptive
 * can feed back on itself and get progressively worse, which is what these
 * check for over long sessions and in noise.
 *
 * One such loop already shipped: the pitch search was narrowed around the last
 * detected string, a harmonic inside that window kept the detection fresh, and
 * the window never widened. Two of ten string changes were never detected.
 */
import { Tuner } from '../src/tuner'
import { TUNINGS, midiToFreq } from '../src/tuning/notes'

const SR = 16000
const FRAME_MS = 100
const N = (SR * FRAME_MS) / 1000
let failures = 0

function check(name: string, ok: boolean, detail: string) {
  if (!ok) failures++
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name.padEnd(38)} ${detail}`)
}

function makeSource(noise: number) {
  let phase = 0
  let age = 1e9
  let freq = 0
  return {
    pluck(f: number) { freq = f; age = 0 },
    frame(): Uint8Array {
      const bytes = new Uint8Array(N * 2)
      const partials = [0.3, 0.85, 0.55, 0.4, 0.28, 0.18, 0.12]
      const step = (2 * Math.PI * freq) / SR
      for (let i = 0; i < N; i++) {
        const env = freq > 0 ? Math.exp((-0.8 * (age + i)) / SR) : 0
        let s = 0
        for (let k = 0; k < partials.length; k++) s += partials[k] * Math.sin(phase * (k + 1))
        phase += step
        const v = 0.25 * env * s + noise * (Math.random() * 2 - 1)
        const q = Math.round(Math.max(-1, Math.min(1, v)) * 32767)
        bytes[i * 2] = q & 0xff
        bytes[i * 2 + 1] = (q >> 8) & 0xff
      }
      age += N
      return bytes
    },
  }
}

function play(tuner: Tuner, src: ReturnType<typeof makeSource>, now: { t: number },
              index: number, cents: number, maxFrames = 40) {
  const s = TUNINGS[0].strings[index]
  src.pluck(midiToFreq(s.midi, 440) * Math.pow(2, cents / 1200))
  for (let f = 0; f < maxFrames; f++) {
    now.t += FRAME_MS
    tuner.ingest(src.frame())
    tuner.advance(now.t)
    const v = tuner.view()
    if (v.stringIndex === index && v.cents !== null && !v.offScale) return f + 1
  }
  return -1
}

function silence(tuner: Tuner, src: ReturnType<typeof makeSource>, now: { t: number }, frames: number) {
  src.pluck(0)
  for (let f = 0; f < frames; f++) {
    now.t += FRAME_MS
    tuner.ingest(src.frame())
    tuner.advance(now.t)
  }
}

console.log('\nswitching strings in auto mode')
{
  const tuner = new Tuner()
  const src = makeSource(0.004)
  const now = { t: 0 }
  let worst = 0
  let missed = 0
  for (const i of [0, 1, 2, 3, 4, 5, 0, 3, 1, 5, 2, 4]) {
    const f = play(tuner, src, now, i, -12)
    if (f < 0) missed++
    else worst = Math.max(worst, f)
  }
  check('every string is found', missed === 0, `${missed} never detected`)
  check('switch within 1.5s', worst > 0 && worst <= 15, `worst ${(worst * FRAME_MS) / 1000}s`)
}

console.log('\nlong session in a noisy room')
{
  const tuner = new Tuner()
  const src = makeSource(0.008)
  const now = { t: 0 }
  const lat: number[] = []
  let missed = 0
  for (let round = 0; round < 120; round++) {
    const f = play(tuner, src, now, round % 6, (Math.random() - 0.5) * 40)
    if (f < 0) missed++
    else lat.push(f)
    silence(tuner, src, now, 6)
  }
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length
  const first = mean(lat.slice(0, 15))
  const last = mean(lat.slice(-15))
  check('no strings missed', missed === 0, `${missed} of 120`)
  check('no slowdown over the session', last <= first * 1.6,
    `first ${(first * FRAME_MS / 1000).toFixed(2)}s vs last ${(last * FRAME_MS / 1000).toFixed(2)}s`)
}

console.log('\naccuracy across a session')
{
  const tuner = new Tuner()
  const src = makeSource(0.008)
  const now = { t: 0 }
  const errs: number[] = []
  for (let round = 0; round < 36; round++) {
    const i = round % 6
    const s = TUNINGS[0].strings[i]
    src.pluck(midiToFreq(s.midi, 440) * Math.pow(2, -8 / 1200))
    for (let f = 0; f < 25; f++) {
      now.t += FRAME_MS
      tuner.ingest(src.frame())
      tuner.advance(now.t)
    }
    const v = tuner.view()
    if (v.cents !== null && v.stringIndex === i) errs.push(Math.abs(v.cents + 8))
    silence(tuner, src, now, 6)
  }
  check('stays under a cent all session', Math.max(...errs) < 1,
    `worst ${Math.max(...errs).toFixed(3)} cents over ${errs.length} readings`)
}

console.log('\nnoise gate adapts to the room')
{
  for (const noise of [0.002, 0.01, 0.03, 0.05]) {
    const tuner = new Tuner()
    const src = makeSource(noise)
    const now = { t: 0 }
    silence(tuner, src, now, 200) // let the floor settle to this room
    const f = play(tuner, src, now, 0, -10)
    check(`detects with room noise ${noise}`, f > 0, f < 0 ? 'went deaf' : `${(f * FRAME_MS) / 1000}s`)
  }
}

console.log('\nlocked mode ignores other strings')
{
  const tuner = new Tuner()
  const src = makeSource(0.004)
  const now = { t: 0 }
  tuner.step(1)
  const locked = tuner.view().stringIndex ?? 0
  const other = (locked + 2) % 6
  src.pluck(midiToFreq(TUNINGS[0].strings[other].midi, 440))
  let readings = 0
  for (let f = 0; f < 30; f++) {
    now.t += FRAME_MS
    tuner.ingest(src.frame())
    tuner.advance(now.t)
    if (tuner.view().cents !== null) readings++
  }
  check('rejects a string it is not tuning', readings === 0, `${readings} of 30 frames read`)
}

console.log(failures ? `\n${failures} failure(s)\n` : '\nall robustness checks passed\n')
process.exit(failures ? 1 : 0)
