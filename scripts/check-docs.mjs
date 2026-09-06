/**
 * Keeps the README for its reader. Run with: npm run check:docs
 *
 * Technical rationale has drifted back into the README three times: it grew
 * from 124 to 216 lines that way, because every fix arrived with a paragraph
 * explaining itself. Rationale belongs in a code comment at the site of the
 * fix, or in AGENTS.md. This fails the build when it reappears.
 */
import { readFileSync } from 'node:fs'

const MAX_README_LINES = 90

/** Words that mean the text is aimed at someone changing the code. */
const TECHNICAL = [
  'YIN',
  'phase-vocoder',
  'autocorrelation',
  'FFT',
  'Goertzel',
  'kerning',
  'glyph',
  'pixel',
  'px',
  'dot-matrix',
  'LVGL',
  'protobuf',
  'sysEvent',
  'textEvent',
  'textContainerUpgrade',
  'createStartUpPageContainer',
  'rebuildPageContainer',
  'BLE',
  'bridge',
  'hysteresis',
  'ring buffer',
  'EMA',
  'smoothing',
  'noise gate',
  'RMS',
  'localStorage',
  'WebView',
  'setBackgroundState',
  'package_id',
  'esbuild',
]

const readme = readFileSync('README.md', 'utf8')
const lines = readme.split('\n')
let failures = 0

function check(name, ok, detail) {
  if (!ok) failures++
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name.padEnd(38)} ${detail}`)
}

const hits = []
for (const [i, line] of lines.entries()) {
  // Skip the one link that is allowed to name the other document.
  if (line.includes('AGENTS.md')) continue
  for (const word of TECHNICAL) {
    const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
    if (re.test(line)) hits.push(`line ${i + 1}: "${word}"`)
  }
}

check(
  'README stays non-technical',
  hits.length === 0,
  hits.length ? hits.slice(0, 4).join(', ') : 'no implementation vocabulary',
)
check(
  'README stays short',
  lines.length <= MAX_README_LINES,
  `${lines.length} lines, cap ${MAX_README_LINES}`,
)
check('README points at AGENTS.md', readme.includes('AGENTS.md'), 'linked')

console.log(failures ? `\n${failures} failure(s)\n` : '\ndocs check passed\n')
process.exit(failures ? 1 : 0)
