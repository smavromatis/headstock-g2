/**
 * Note maths and tuning presets. Frequencies derive from the A4 reference at
 * run time, so 442 ensemble pitch and 415 baroque pitch stay exact.
 */

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']

export interface GuitarString {
  /** Display label, e.g. "E2" or "Eb2". */
  readonly label: string
  /** Letter alone, for the block font. */
  readonly letter: string
  /** '#', 'b' or '' for the block font's middle cell. */
  readonly accidental: string
  readonly octave: number
  readonly midi: number
}

export interface Tuning {
  readonly id: string
  /** Shown on the glasses header and in the menu; kept short. */
  readonly name: string
  readonly strings: readonly GuitarString[]
}

/**
 * Classical, acoustic and electric guitars all tune to the same pitches, so
 * the presets differ by tuning, not by instrument.
 *
 * Spelling follows how players name each tuning: half step down is written
 * with flats, open D with a sharp.
 */
const PRESETS: ReadonlyArray<{
  id: string
  name: string
  midi: readonly number[]
  spelling: 'sharp' | 'flat'
}> = [
  { id: 'standard', name: 'STANDARD', midi: [40, 45, 50, 55, 59, 64], spelling: 'sharp' },
  { id: 'dropd', name: 'DROP D', midi: [38, 45, 50, 55, 59, 64], spelling: 'sharp' },
  { id: 'dadgad', name: 'DADGAD', midi: [38, 45, 50, 55, 57, 62], spelling: 'sharp' },
  { id: 'openg', name: 'OPEN G', midi: [38, 43, 50, 55, 59, 62], spelling: 'sharp' },
  { id: 'opend', name: 'OPEN D', midi: [38, 45, 50, 54, 57, 62], spelling: 'sharp' },
  { id: 'halfstep', name: 'HALF STEP', midi: [39, 44, 49, 54, 58, 63], spelling: 'flat' },
]

function stringFromMidi(midi: number, spelling: 'sharp' | 'flat'): GuitarString {
  const name = (spelling === 'flat' ? FLAT_NAMES : SHARP_NAMES)[((midi % 12) + 12) % 12]
  const octave = Math.floor(midi / 12) - 1
  return {
    label: `${name}${octave}`,
    letter: name[0],
    accidental: name.length > 1 ? name[1] : '',
    octave,
    midi,
  }
}

export const TUNINGS: readonly Tuning[] = PRESETS.map((p) => ({
  id: p.id,
  name: p.name,
  strings: p.midi.map((m) => stringFromMidi(m, p.spelling)),
}))

export const DEFAULT_TUNING = TUNINGS[0]

export function tuningById(id: string): Tuning {
  return TUNINGS.find((t) => t.id === id) ?? DEFAULT_TUNING
}

/** Equal-tempered frequency of a MIDI note for a given A4 reference. */
export function midiToFreq(midi: number, a4: number): number {
  return a4 * Math.pow(2, (midi - 69) / 12)
}

/** Signed interval in cents from `reference` to `freq`. */
export function centsBetween(freq: number, reference: number): number {
  return 1200 * Math.log2(freq / reference)
}

export interface StringMatch {
  readonly index: number
  readonly cents: number
  /** True when the pitch is close enough to name this string. */
  readonly inRange: boolean
}

/**
 * Nearest string in the given tuning, in log-frequency so the choice is
 * octave-symmetric.
 *
 * The range depends on the tuning. Standard keeps its strings 400 cents apart,
 * but DADGAD puts G3 and A3 a whole tone apart, so a fixed 150-cent window
 * would claim a match that could belong to either string.
 */
export function matchString(freq: number, tuning: Tuning, a4: number): StringMatch {
  let index = 0
  let best = Infinity
  tuning.strings.forEach((s, i) => {
    const c = centsBetween(freq, midiToFreq(s.midi, a4))
    if (Math.abs(c) < Math.abs(best)) {
      best = c
      index = i
    }
  })
  const limit = Math.min(150, minStringSpacingCents(tuning) / 2)
  return { index, cents: best, inRange: Math.abs(best) <= limit }
}

/** Cents relative to one specific string, for locked mode. */
export function centsForString(freq: number, s: GuitarString, a4: number): number {
  return centsBetween(freq, midiToFreq(s.midi, a4))
}

/**
 * Closest spacing between adjacent strings in a tuning, in cents.
 * Auto-detect is only unambiguous within half of this.
 */
export function minStringSpacingCents(tuning: Tuning): number {
  const sorted = [...tuning.strings].map((s) => s.midi).sort((a, b) => a - b)
  let min = Infinity
  for (let i = 1; i < sorted.length; i++) min = Math.min(min, (sorted[i] - sorted[i - 1]) * 100)
  return min
}
