/**
 * Fails if the glasses code references a character the firmware font does not
 * have. Missing glyphs render as nothing, silently, so this is the only cheap
 * way to catch one before it reaches the display.
 */
import { getAdvW } from '@evenrealities/pretext'
import { readFileSync } from 'node:fs'

const sources = ['src/glasses/display.ts', 'src/glasses/blockfont.ts']
const used = new Set()
for (const f of sources) {
  for (const ch of readFileSync(f, 'utf8')) {
    if (ch.codePointAt(0) > 0x2000) used.add(ch)
  }
}

const missing = [...used].filter((ch) => getAdvW(ch.codePointAt(0)) === 0)
console.log(`glyphs referenced: ${[...used].join(' ')}`)
if (missing.length) {
  console.error(`MISSING FROM FIRMWARE FONT: ${missing.join(' ')}`)
  process.exit(1)
}
console.log('all present in firmware font')
