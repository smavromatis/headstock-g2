import assert from 'node:assert/strict'
import { diagnostics } from '../src/diagnostics'
import { Microphone } from '../src/microphone'
import { Tuner, normalizeSettings } from '../src/tuner'
import { detectPitch } from '../src/audio/pitch'
import { decodePcm, PitchSmoother } from '../src/audio/stream'
import { TUNINGS, midiToFreq } from '../src/tuning/notes'
import { BridgeQueue } from '../src/bridge-queue'
import { GlassesRenderer } from '../src/glasses/display'

let failures = 0
async function test(name: string, run: () => unknown) {
  try {
    await run()
    console.log('pass', name)
  } catch (error) {
    failures++
    console.error('FAIL', name, String(error))
  }
}
function source() {
  let phase = 0
  return (freq = 110, count = 1600) => {
    const bytes = new Uint8Array(count * 2)
    const view = new DataView(bytes.buffer)
    for (let i = 0; i < count; i++) {
      view.setInt16(i * 2, Math.round(10000 * Math.sin(phase)), true)
      phase += (2 * Math.PI * freq) / 16000
    }
    return bytes
  }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
await test('R1 stale buffer cannot refresh reading or idle activity', () => {
  const t = new Tuner()
  t.markActive(1)
  t.ingest(source()(110, 8192), 100)
  for (let now = 100; now <= 5000; now += 100) t.advance(now)
  assert.equal(t.view().cents, null)
  assert.equal(t.view().confirmed, false)
  assert(t.isIdle(181000))
})
await test('R2 silence cannot finish confirmation', () => {
  const t = new Tuner()
  const tone = source()
  for (let now = 100; now <= 2500; now += 100) {
    t.ingest(now <= 600 ? tone() : new Uint8Array(3200), now)
    t.advance(now)
    assert.equal(t.view().confirmed, false)
    assert(!t.view().tuned.some(Boolean))
  }
})
await test('R3 high capo notes retain their octave', () => {
  for (const freq of [440, 659.255]) {
    const r = detectPitch(decodePcm(source()(freq, 4096)), 16000)
    assert(r)
    assert(Math.abs(1200 * Math.log2(r.freq / freq)) <= 0.5)
  }
})
await test('R4 false display response stays dirty', async () => {
  let calls = 0
  const bridge = {
    textContainerUpgrade: async () => {
      calls++
      return false
    },
  }
  const renderer = new GlassesRenderer(bridge as never, new BridgeQueue())
  const view = new Tuner().view()
  renderer.render(view)
  await sleep(20)
  const before = calls
  await sleep(220)
  renderer.render(view)
  await sleep(20)
  assert(calls > before)
})
await test('R5 timeout retains physical lane through late completion', async () => {
  const q = new BridgeQueue()
  let release!: (v: boolean) => void
  let calls = 0
  const first = q.run(() => {
    calls++
    return new Promise<boolean>((r) => {
      release = r
    })
  }, 10)
  assert.equal(await first, null)
  const second = q.run(async () => {
    calls++
    return true
  }, 10)
  await sleep(20)
  assert.equal(calls, 1)
  release(true)
  await second
  await sleep(0)
  assert.equal(await q.run(async () => true), true)
})
if (!process.env.BASELINE) {
  await test('R2 smoothed pointer cannot confirm out-of-tolerance measurement', () => {
    const t = new Tuner()
    const tone = source()
    for (let now = 100; now <= 1800; now += 100) {
      t.ingest(tone(now <= 1000 ? 110 : 110 * 2 ** (1.8 / 1200)), now)
      t.advance(now)
      assert(!t.view().confirmed)
      assert(!t.view().tuned.some(Boolean))
    }
  })
  await test('R11 diagnostics are opt-in, bounded and contain no audio', () => {
    diagnostics.clear()
    diagnostics.enabled = false
    diagnostics.record({ kind: 'audio', at: 0, samples: 1 })
    assert.equal(diagnostics.snapshot().length, 0)
    diagnostics.enabled = true
    for (let i = 0; i < 1100; i++) diagnostics.record({ kind: 'audio', at: i, samples: 1600 })
    assert.equal(diagnostics.snapshot().length, 1000)
    assert.equal(diagnostics.snapshot()[0].at, 100)
    diagnostics.enabled = false
    diagnostics.clear()
  })
  await test('R5 queued callers expire behind a hung operation', async () => {
    const q = new BridgeQueue()
    let release!: (v: boolean) => void
    let called = false
    const first = q.run(
      () =>
        new Promise<boolean>((r) => {
          release = r
        }),
      10,
    )
    const waiting = q.run(async () => {
      called = true
      return true
    }, 20)
    assert.equal(await first, null)
    assert.equal(await waiting, null)
    assert(!called)
    release(true)
    await sleep(0)
    assert(!called)
  })
  await test('R10 late microphone replies, denial, disconnect and repeated stop', async () => {
    let release!: (v: boolean) => void
    const calls: boolean[] = []
    const bridge = {
      audioControl: (enabled: boolean) => {
        calls.push(enabled)
        return enabled
          ? new Promise<boolean>((resolve) => {
              release = resolve
            })
          : Promise.resolve(true)
      },
    }
    const mic = new Microphone(bridge as never, new BridgeQueue())
    const start = mic.start()
    await sleep(0)
    const stop = mic.stop()
    release(true)
    assert.equal(await start, false)
    await stop
    assert.equal(mic.state, 'off')
    assert(!mic.observeAudio())
    assert.deepEqual(calls, [true, false])
    const next = mic.start()
    await sleep(0)
    mic.observeAudio()
    release(false)
    assert(await next)
    assert.equal(mic.state, 'active')
    mic.disconnected()
    assert.equal(mic.state, 'off')
    const denied = mic.start()
    await sleep(0)
    release(false)
    assert.equal(await denied, false)
    assert.equal(mic.state, 'error')
    assert(mic.observeAudio())
    assert.equal(mic.state, 'active')
    await mic.stop()
    await mic.stop()
    assert.equal(mic.state, 'off')
    const failedStop = new Microphone(
      { audioControl: async () => false } as never,
      new BridgeQueue(),
    )
    await failedStop.stop()
    assert.equal(failedStop.state, 'error')
  })
  await test('R9 settings reject nonfinite and malformed values', () => {
    assert.deepEqual(normalizeSettings({ a4: '440', capo: NaN, tuningId: {} }), {
      a4: 440,
      capo: 0,
      tuningId: 'standard',
    })
    assert.equal(normalizeSettings({ capo: 2.6 }).capo, 3)
    const t = new Tuner()
    const tone = source()
    for (let now = 100; now <= 2400; now += 100) {
      t.ingest(tone(), now)
      t.advance(now)
    }
    assert(t.view().confirmed)
    t.setA4(442)
    assert(!t.view().confirmed)
    assert(!t.view().tuned.some(Boolean))
    assert.equal(t.view().cents, null)
    t.step(1)
    assert.equal(t.view().stringIndex, 1)
    assert.equal(t.view().freq, null)
  })
  await test('R2 missing packets, target changes and out-of-band evidence reset hold', () => {
    for (const change of ['gap', 'a4', 'step', 'outside']) {
      const t = new Tuner()
      const tone = source()
      for (let now = 100; now <= 1000; now += 100) {
        t.ingest(tone(), now)
        t.advance(now)
      }
      if (change === 'a4') t.setA4(441)
      if (change === 'step') t.step(1)
      for (let now = 1100; now <= 1600; now += 100) {
        if (change !== 'gap') t.ingest(change === 'outside' ? tone(113) : new Uint8Array(3200), now)
        t.advance(now)
        assert(!t.view().confirmed)
        assert(!t.view().tuned.some(Boolean))
      }
    }
  })
  await test('R10 malformed PCM is rejected without persistent format state', () => {
    for (const value of ['%%%', [NaN, 0], [-1, 0], [256, 0], [1.5, 0], new Uint8Array(3), {}])
      assert.equal(decodePcm(value).length, 0)
    assert.deepEqual([...decodePcm([0, 128, 255, 127])], [-1, 32767 / 32768])
  })
  await test('R4/R5 rejection and old generation cannot poison cache', async () => {
    const q = new BridgeQueue()
    assert.equal(
      await q.run(async () => {
        throw Error('no')
      }),
      null,
    )
    let release!: (v: boolean) => void
    let calls = 0
    const bridge = {
      textContainerUpgrade: () => {
        calls++
        return calls === 1
          ? new Promise<boolean>((r) => {
              release = r
            })
          : Promise.resolve(true)
      },
    }
    const r = new GlassesRenderer(bridge as never, q)
    const view = new Tuner().view()
    r.render(view)
    await sleep(0)
    r.invalidate()
    r.render(view)
    release(true)
    await sleep(20)
    assert.equal(calls, 7)
  })
  await test('R10 queued display rows expire before reaching the host', async () => {
    const q = new BridgeQueue()
    let release!: (value: boolean) => void
    let calls = 0
    const blocked = q.run(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve
        }),
      1000,
    )
    const renderer = new GlassesRenderer(
      {
        textContainerUpgrade: async () => {
          calls++
          return true
        },
      } as never,
      q,
    )
    renderer.render(new Tuner().view())
    await sleep(520)
    release(true)
    await blocked
    await sleep(20)
    assert.equal(calls, 0)
    await sleep(220)
    renderer.render(new Tuner().view())
    await sleep(20)
    assert.equal(calls, 6)
  })
  await test('R10 obsolete rebuild completion preserves newer settings', async () => {
    let release!: (v: boolean) => void
    const rows: string[] = []
    const bridge = {
      rebuildPageContainer: () =>
        new Promise<boolean>((resolve) => {
          release = resolve
        }),
      textContainerUpgrade: async (row: { containerName: string; content: string }) => {
        if (row.containerName === 'hdr') rows.push(row.content)
        return true
      },
    }
    const renderer = new GlassesRenderer(bridge as never, new BridgeQueue())
    const t = new Tuner()
    const rebuilding = renderer.rebuild(t.view())
    await sleep(0)
    t.setA4(442)
    renderer.render(t.view())
    release(true)
    await rebuilding
    await sleep(20)
    assert(rows.length > 0)
    assert(rows.at(-1)!.includes('442'))
    assert(!rows.at(-1)!.includes('440'))
  })
  await test('R6 repeated ticks, packet bursts, and slow peg turns', () => {
    const t = new Tuner()
    const tone = source()
    for (let now = 100; now <= 3000; now += 100) {
      t.ingest(tone(), now)
      t.advance(now)
    }
    const sample = t.view().measurement?.sampleEnd
    for (let now = 3001; now < 3100; now++) t.advance(now)
    assert.equal(t.view().measurement?.sampleEnd, sample)
    for (let now = 3100; now <= 4000; now += 100) t.advance(now)
    assert.equal(t.view().phase, 'stale')
    assert(!t.view().confirmed)
    t.advance(5000)
    assert.equal(t.view().cents, null)
    for (let now = 6000; now < 10000; now += 400) {
      t.ingest(tone(110, 6400), now)
      t.advance(now)
      assert(!t.view().confirmed)
    }
    t.reset()
    let last = -Infinity
    for (let step = 0; step < 100; step++) {
      const now = 11000 + step * 100
      const c = -20 + step * 0.4
      t.ingest(tone(110 * 2 ** (c / 1200)), now)
      t.advance(now)
      if (step > 15 && t.view().cents !== null) {
        assert(t.view().cents! >= last - 0.1)
        last = t.view().cents!
      }
    }
    assert(last > 15)
  })
  await test('R8 clipping, missing fundamentals, noise and isolated outliers', () => {
    for (const clipped of [false, true]) {
      const signal = Float32Array.from({ length: 4096 }, (_, i) => {
        const x = (2 * Math.PI * 110 * i) / 16000
        const v = 0.3 * (Math.sin(x) + 0.8 * Math.sin(2 * x) + 0.5 * Math.sin(3 * x))
        return clipped ? Math.max(-0.15, Math.min(0.15, v)) : v
      })
      const r = detectPitch(signal, 16000)
      assert(r)
      assert(Math.abs(1200 * Math.log2(r.freq / 110)) < 0.5)
    }
    const absent = Float32Array.from(
      { length: 4096 },
      (_, i) =>
        0.3 * Math.sin((2 * Math.PI * 220 * i) / 16000) +
        0.2 * Math.sin((2 * Math.PI * 330 * i) / 16000),
    )
    assert.equal(detectPitch(absent, 16000), null)
    const filter = new PitchSmoother()
    for (let i = 0; i < 10; i++) filter.push(110)
    assert(Math.abs(filter.push(220) - 110) < 1e-10)
    assert(Math.abs(filter.push(110) - 110) < 1e-10)
  })
  if (!process.env.QUICK)
    await test('R3 full preset/capo/A4/detuning matrix, auto and locked bounds', () => {
      let count = 0
      let worst = 0
      let rejected = 0
      let octaves = 0
      for (const preset of TUNINGS)
        for (let capo = 0; capo <= 12; capo++)
          for (let a4 = 415; a4 <= 445; a4++) {
            const tuner = new Tuner()
            tuner.setTuning(preset.id)
            tuner.setCapo(capo)
            tuner.setA4(a4)
            const autoBounds = tuner.detectionBounds
            const frequencies = preset.strings.map((s) => midiToFreq(s.midi + capo, a4))
            tuner.toggleLock()
            for (const [index, target] of frequencies.entries()) {
              if (index) tuner.step(1)
              const lockedBounds = tuner.detectionBounds
              for (const detune of [-299, -50, 0, 50, 299]) {
                const freq = target * 2 ** (detune / 1200)
                const samples = decodePcm(source()(freq, 4096))
                for (const locked of [false, true]) {
                  count++
                  const r = detectPitch(samples, 16000, locked ? lockedBounds : autoBounds)
                  if (!r) {
                    rejected++
                    continue
                  }
                  const error = Math.abs(1200 * Math.log2(r.freq / freq))
                  worst = Math.max(worst, error)
                  if (error > 600) octaves++
                }
              }
            }
          }
      console.log(JSON.stringify({ count, worst, rejected, octaves }))
      assert.equal(rejected, 0)
      assert.equal(octaves, 0)
      assert(worst <= 0.5)
    })
}
process.exitCode = failures ? 1 : 0
