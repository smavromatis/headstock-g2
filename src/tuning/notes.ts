/**
 * Note maths for classical guitar. Frequencies derive from the A4 reference at
 * run time, so 442 ensemble pitch and 415 baroque pitch stay exact.
 */

export interface GuitarString {
  /** Display label, e.g. "E2" */
  readonly label: string
  /** Letter part only, e.g. "E" */
  readonly letter: string
  /** Octave number in scientific pitch notation */
  readonly octave: number
  /** MIDI note number */
  readonly midi: number
  /** String number as guitarists count them (1 = high E) */
  readonly stringNo: number
}

/**
 * Standard tuning, low to high. At A4 = 440 these are
 * 82.407 / 110.000 / 146.832 / 195.998 / 246.942 / 329.628 Hz.
 */
export const STANDARD_TUNING: readonly GuitarString[] = [
  { label: 'E2', letter: 'E', octave: 2, midi: 40, stringNo: 6 },
  { label: 'A2', letter: 'A', octave: 2, midi: 45, stringNo: 5 },
  { label: 'D3', letter: 'D', octave: 3, midi: 50, stringNo: 4 },
  { label: 'G3', letter: 'G', octave: 3, midi: 55, stringNo: 3 },
  { label: 'B3', letter: 'B', octave: 3, midi: 59, stringNo: 2 },
  { label: 'E4', letter: 'E', octave: 4, midi: 64, stringNo: 1 },
]

/** Equal-tempered frequency of a MIDI note for a given A4 reference. */
export function midiToFreq(midi: number, a4: number): number {
  return a4 * Math.pow(2, (midi - 69) / 12)
}

/** Signed interval in cents from `reference` to `freq`. */
export function centsBetween(freq: number, reference: number): number {
  return 1200 * Math.log2(freq / reference)
}

export interface StringMatch {
  readonly string: GuitarString
  readonly target: number
  readonly cents: number
  /** True when the pitch is closer than a semitone-and-a-half to the target. */
  readonly inRange: boolean
}

/**
 * Nearest open string, in log-frequency so the choice is octave-symmetric.
 * The strings are >=400 cents apart, so this is unambiguous within ~200 cents.
 */
export function matchString(
  freq: number,
  a4: number,
  tuning: readonly GuitarString[] = STANDARD_TUNING,
): StringMatch {
  let best = tuning[0]
  let bestCents = Infinity
  for (const s of tuning) {
    const c = centsBetween(freq, midiToFreq(s.midi, a4))
    if (Math.abs(c) < Math.abs(bestCents)) {
      best = s
      bestCents = c
    }
  }
  const target = midiToFreq(best.midi, a4)
  return { string: best, target, cents: bestCents, inRange: Math.abs(bestCents) <= 150 }
}

/** Cents relative to one specific string, for locked (manual) mode. */
export function centsForString(freq: number, s: GuitarString, a4: number): StringMatch {
  const target = midiToFreq(s.midi, a4)
  const cents = centsBetween(freq, target)
  return { string: s, target, cents, inRange: Math.abs(cents) <= 150 }
}
