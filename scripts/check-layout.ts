/**
 * Layout regression tests. Run with: npm run check:layout
 *
 * Text that exactly fills a container wraps to an invisible second line, so a
 * row that is one pixel too wide silently loses its tail. That has happened
 * twice here. This walks every row through every tuning, capo and needle
 * position and asserts each one fits.
 */
import {
  buildHeaderRow,
  buildNeedleRow,
  buildNoteBlock,
  buildReadoutRow,
  buildScaleRow,
  buildStringsRow,
} from '../src/glasses/display'
import { textWidth } from '../src/glasses/metrics'
import { TUNINGS, transposeTuning } from '../src/tuning/notes'
import { MAX_CAPO } from '../src/config'

const ROW_W = 540
const NOTE_W = 220
const NEEDLE_W = 540
let failures = 0
const seen = { rows: 0, needles: 0, notes: 0 }

function check(name: string, ok: boolean, detail: string) {
  if (ok) return
  failures++
  console.log(`  FAIL  ${name}  ${detail}`)
}

for (const preset of TUNINGS) {
  for (let capo = 0; capo <= MAX_CAPO; capo++) {
    const tuning = transposeTuning(preset, capo)
    for (const phase of ['reading', 'listening', 'idle', 'micError'] as const) {
      for (const locked of [false, true]) {
        for (let cents = -60; cents <= 60; cents += 0.5) {
          for (const fine of [false, true]) {
            const view = {
              phase, locked, cents,
              stringIndex: 2,
              freq: 196.0,
              a4: 442,
              offScale: false,
              inTolerance: Math.abs(cents) <= 1.5,
              confirmed: Math.abs(cents) <= 1.5,
              fine,
              meterRange: fine ? 10 : 50,
              tuned: tuning.strings.map((_, i) => i % 2 === 0),
              tuning,
              capo,
            }

            for (const [row, text] of [
              ['header', buildHeaderRow(view)],
              ['readout', buildReadoutRow(view)],
              ['strings', buildStringsRow(view)],
              ['scale', buildScaleRow(fine)],
            ] as const) {
              seen.rows++
              const w = textWidth(text)
              check(`${row} fits`, w <= ROW_W, `${preset.name} capo ${capo} ${cents}c -> ${w}px > ${ROW_W}`)
            }

            seen.needles++
            const needle = textWidth(buildNeedleRow(view))
            check('needle width constant', needle === NEEDLE_W,
              `${preset.name} ${cents}c fine=${fine} -> ${needle}px, expected ${NEEDLE_W}`)

            seen.notes++
            const lines = buildNoteBlock(view).split('\n')
            check('note block is 5 lines', lines.length === 5, `got ${lines.length}`)
            for (const line of lines) {
              check('note block width constant', textWidth(line) === NOTE_W,
                `${tuning.strings[2].label} -> ${textWidth(line)}px, expected ${NOTE_W}`)
            }
          }
        }
      }
    }
  }
}

console.log(`  checked ${seen.rows} rows, ${seen.needles} needle positions, ${seen.notes} note blocks`)
console.log(failures ? `\n${failures} failure(s)\n` : '\nall layout checks passed\n')
process.exit(failures ? 1 : 0)
