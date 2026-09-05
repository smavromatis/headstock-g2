/**
 * 3x5 dot-matrix font built from the firmware's block glyphs.
 *
 * The firmware has one font at one size, so large text has to be drawn from
 * cells. A block is 20px and a space is 5px, so four spaces are exactly one
 * cell and every row stays the same width whichever cells are lit.
 * One character: 60px wide, 5 lines (135px) tall.
 */

/** Lit cell. */
const ON = '█'
/** Unlit cell: four spaces, exactly one block wide. */
const OFF = '    '

export const CELL_PX = 20
export const GLYPH_COLS = 3
export const GLYPH_ROWS = 5
export const GLYPH_WIDTH_PX = GLYPH_COLS * CELL_PX // 60

/**
 * What the tuning presets can produce: note letters, both accidentals, the
 * octaves a guitar reaches, a dash for "no reading", and a blank.
 */
const GLYPHS: Record<string, string[]> = {
  A: ['111', '101', '111', '101', '101'],
  B: ['110', '101', '110', '101', '110'],
  C: ['111', '100', '100', '100', '111'],
  D: ['110', '101', '101', '101', '110'],
  E: ['111', '100', '111', '100', '111'],
  F: ['111', '100', '111', '100', '100'],
  G: ['111', '100', '101', '101', '111'],
  '#': ['101', '111', '101', '111', '101'],
  b: ['100', '100', '110', '101', '110'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '-': ['000', '000', '111', '000', '000'],
  ' ': ['000', '000', '000', '000', '000'],
}

/** Width in pixels of a string rendered through this font, including gaps. */
export function blockTextWidth(text: string, gapCells = 1): number {
  const n = [...text].length
  if (n === 0) return 0
  return n * GLYPH_WIDTH_PX + (n - 1) * gapCells * CELL_PX
}

/** Renders `text` as 5 lines. Unknown characters render blank, not throw. */
export function renderBlockText(text: string, gapCells = 1): string {
  const chars = [...text].map((c) => GLYPHS[c] ?? GLYPHS[c.toUpperCase()] ?? GLYPHS[' '])
  const gap = OFF.repeat(gapCells)

  const lines: string[] = []
  for (let row = 0; row < GLYPH_ROWS; row++) {
    let line = ''
    for (let i = 0; i < chars.length; i++) {
      if (i > 0) line += gap
      const pattern = chars[i][row]
      for (const bit of pattern) line += bit === '1' ? ON : OFF
    }
    lines.push(line)
  }
  return lines.join('\n')
}
