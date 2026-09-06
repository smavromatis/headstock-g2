/** Explicit local replay of a user-supplied signed 16-bit LE mono 16kHz file. */
import { readFileSync } from 'node:fs'
import { Tuner } from '../src/tuner'
import { needleDot } from '../src/glasses/display'
const [file, tuning = 'standard', capo = '0', a4 = '440'] = process.argv.slice(2)
if (!file) throw Error('Usage: npm run replay -- capture.pcm [tuningId] [capo] [a4]')
const bytes = readFileSync(file)
if (bytes.length % 2) throw Error('Odd PCM byte count')
const tuner = new Tuner()
tuner.setTuning(tuning)
tuner.setCapo(Number(capo))
tuner.setA4(Number(a4))
for (let offset = 0; offset < bytes.length; offset += 3200) {
  const end = Math.min(bytes.length, offset + 3200)
  const now = end / 32
  tuner.ingest(bytes.subarray(offset, end), now)
  tuner.advance(now)
  const v = tuner.view()
  console.log(
    JSON.stringify({
      at: now,
      ...v.measurement,
      phase: v.phase,
      index: v.stringIndex,
      cents: v.cents,
      confirmed: v.confirmed,
      pointerPx: v.cents === null ? null : needleDot(v.cents) * 5,
    }),
  )
}
