/**
 * Pitch detection for nylon-string guitar at the G2 mic's 16 kHz.
 *
 * YIN gives an octave-safe period; a phase-vocoder step then refines it.
 * YIN alone reads +4.2 cents sharp on a nylon low E, because the string's
 * upper partials sit above exact harmonics and drag the period estimate.
 */

/** Guitar search range, a few semitones either side of E2..E4. */
export const F_MIN = 65 // Hz, ~C2 - comfortably below a flat low E
export const F_MAX = 420 // Hz, ~G#4 - comfortably above a sharp high E

/**
 * Analysis window in samples (256 ms at 16 kHz).
 * At 2048 the phase step had ~5 cycles of a low E and drifted 1.7 cents;
 * 4096 holds E2 under 0.4.
 */
export const WINDOW_SIZE = 4096

/** Separation between the two phase windows. */
const PHASE_HOP = 1024
/** Length of each phase window. */
const PHASE_WIN = 2048

export interface PitchResult {
  /** Refined fundamental in Hz. */
  readonly freq: number
  /** 0..1, derived from the YIN aperiodicity at the chosen lag. */
  readonly confidence: number
  /** RMS level of the analysed window, 0..1. */
  readonly rms: number
}

const YIN_THRESHOLD = 0.15

export function rmsOf(buf: Float32Array): number {
  let sum = 0
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
  return Math.sqrt(sum / buf.length)
}

/**
 * Returns the estimated pitch of `buf`, or null when the window is too quiet or
 * too aperiodic to trust.
 */
export function detectPitch(
  buf: Float32Array,
  sampleRate: number,
  opts: { minRms?: number; minConfidence?: number } = {},
): PitchResult | null {
  const minRms = opts.minRms ?? 0.004
  const minConfidence = opts.minConfidence ?? 0.55

  const rms = rmsOf(buf)
  if (rms < minRms) return null

  const tauMin = Math.max(2, Math.floor(sampleRate / F_MAX))
  const tauMax = Math.min(Math.ceil(sampleRate / F_MIN), (buf.length / 2) | 0)
  if (tauMax <= tauMin + 2) return null

  // --- Stage 1: YIN ------------------------------------------------------
  const W = buf.length - tauMax // integration window length
  const diff = new Float32Array(tauMax + 1)

  for (let tau = 1; tau <= tauMax; tau++) {
    let sum = 0
    for (let j = 0; j < W; j++) {
      const d = buf[j] - buf[j + tau]
      sum += d * d
    }
    diff[tau] = sum
  }

  // The running sum must span every lag from 1, not just the searched range.
  const cmnd = new Float32Array(tauMax + 1)
  cmnd[0] = 1
  let running = 0
  for (let tau = 1; tau <= tauMax; tau++) {
    running += diff[tau]
    cmnd[tau] = running > 0 ? (diff[tau] * tau) / running : 1
  }

  // First local minimum below the threshold wins; fall through to the global
  // minimum so quiet plucks still read.
  let tau = -1
  for (let t = tauMin; t <= tauMax; t++) {
    if (cmnd[t] < YIN_THRESHOLD) {
      while (t + 1 <= tauMax && cmnd[t + 1] < cmnd[t]) t++
      tau = t
      break
    }
  }
  if (tau === -1) {
    let bestVal = Infinity
    for (let t = tauMin; t <= tauMax; t++) {
      if (cmnd[t] < bestVal) {
        bestVal = cmnd[t]
        tau = t
      }
    }
  }
  if (tau <= 0) return null

  const confidence = Math.max(0, Math.min(1, 1 - cmnd[tau]))
  if (confidence < minConfidence) return null

  // Parabolic interpolation around the chosen lag.
  let tauRefined = tau
  if (tau > 1 && tau < tauMax) {
    const a = cmnd[tau - 1]
    const b = cmnd[tau]
    const c = cmnd[tau + 1]
    const denom = 2 * (2 * b - a - c)
    if (denom !== 0) tauRefined = tau + (c - a) / denom
  }
  if (tauRefined <= 0) return null

  const coarse = sampleRate / tauRefined
  if (coarse < F_MIN || coarse > F_MAX) return null

  // Two passes: the first moves the analysis bin onto the fundamental, the
  // second removes the residual bias from the bin having been offset.
  let freq = coarse
  for (let pass = 0; pass < 2; pass++) {
    const refined = refineByPhase(buf, sampleRate, freq)
    if (refined === null) break
    freq = refined
  }

  return { freq, confidence, rms }
}

/**
 * Refines `f0` from the phase advance between two windows `hop` apart.
 * Unambiguous range is +/- sampleRate / (2 * hop) = +/- 7.8 Hz, wider than
 * YIN's error, so the phase cannot wrap onto the wrong branch.
 */
function refineByPhase(buf: Float32Array, sampleRate: number, f0: number): number | null {
  const hop = PHASE_HOP
  const win = Math.min(PHASE_WIN, buf.length - hop)
  if (win < 256) return null

  const start2 = buf.length - win
  const start1 = start2 - hop
  if (start1 < 0) return null

  const p1 = goertzelPhase(buf, start1, win, f0, sampleRate)
  const p2 = goertzelPhase(buf, start2, win, f0, sampleRate)
  if (p1 === null || p2 === null) return null

  const expected = (2 * Math.PI * f0 * hop) / sampleRate
  let delta = p2 - p1 - expected
  // Wrap into (-pi, pi]
  delta -= 2 * Math.PI * Math.round(delta / (2 * Math.PI))

  const corrected = f0 + (delta * sampleRate) / (2 * Math.PI * hop)
  if (!Number.isFinite(corrected) || corrected < F_MIN || corrected > F_MAX) return null
  // The phase step should only nudge.
  if (Math.abs(corrected - f0) > f0 * 0.05) return null
  return corrected
}

/** Phase of the Hann-windowed DFT bin at `freq`. One bin, so no FFT needed. */
function goertzelPhase(
  buf: Float32Array,
  start: number,
  len: number,
  freq: number,
  sampleRate: number,
): number | null {
  const w = (2 * Math.PI * freq) / sampleRate
  let re = 0
  let im = 0
  for (let n = 0; n < len; n++) {
    // Hann keeps neighbouring partials off the phase.
    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (len - 1))
    const s = buf[start + n] * hann
    const angle = w * n
    re += s * Math.cos(angle)
    im -= s * Math.sin(angle)
  }
  if (re === 0 && im === 0) return null
  // Phase referenced to the window start.
  return Math.atan2(im, re)
}
