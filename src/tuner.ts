/**
 * Tuner state machine: audio in, view model out. No bridge calls, so it runs
 * without a device.
 *
 * `advance()` mutates, `view()` is a pure read. Keeping them separate stops a
 * gesture or settings change from running a second detection pass and pushing
 * a duplicate reading into the smoother.
 */

import { detectPitch, rmsOf, WINDOW_SIZE } from './audio/pitch'
import { midiToFreq } from './tuning/notes'
import { AudioRingBuffer, PitchSmoother, SAMPLE_RATE, decodePcm } from './audio/stream'
import {
  DEFAULT_TUNING,
  centsForString,
  matchString,
  transposeTuning,
  tuningById,
  type GuitarString,
  type Tuning,
} from './tuning/notes'
import {
  ADVANCE_DELAY_MS,
  ATTACK_SKIP_MS,
  CONFIRM_HOLD_MS,
  DECAY_REJECT_RATIO,
  GATE_MARGIN,
  HZ_UPDATE_MS,
  IDLE_TIMEOUT_MS,
  IN_TUNE_CENTS,
  LONG_WINDOW_ENTER_CENTS,
  LONG_WINDOW_EXIT_CENTS,
  MAX_CAPO,
  MIN_GATE,
  NOISE_CREEP,
  NOISE_FALL,
  READING_HOLD_MS,
  SMOOTH_ALPHA_FAR,
  STRING_SWITCH_FRAMES,
  SMOOTH_ALPHA_NEAR,
  STEADY_WITHIN_CENTS,
} from './config'

/** Long window used when close to the target, for lower estimate variance. */
const LONG_WINDOW_SIZE = WINDOW_SIZE * 2

export type TunerPhase = 'starting' | 'listening' | 'reading' | 'idle' | 'micError'

export interface TunerSettings {
  a4: number
  tuningId: string
  /** Capo position in semitones; 0 is no capo. */
  capo: number
}

export const DEFAULT_SETTINGS: TunerSettings = {
  a4: 440,
  tuningId: DEFAULT_TUNING.id,
  capo: 0,
}

export interface TunerView {
  phase: TunerPhase
  /** Index into STANDARD_TUNING, or null when nothing is detected. */
  stringIndex: number | null
  locked: boolean
  cents: number | null
  freq: number | null
  a4: number
  /** Pitch too far from any open string to name it (auto mode only). */
  offScale: boolean
  /** Inside the in-tune band right now, but not yet held long enough. */
  inTolerance: boolean
  /** Held inside the band for CONFIRM_HOLD_MS - this is the real "in tune". */
  confirmed: boolean
  /** Which strings have been confirmed in tune this session. */
  tuned: readonly boolean[]
  /** The tuning as it sounds, with any capo already applied. */
  tuning: Tuning
  capo: number
}

export class Tuner {
  private readonly ring = new AudioRingBuffer(LONG_WINDOW_SIZE * 2)
  private readonly smoother = new PitchSmoother()
  private readonly window = new Float32Array(WINDOW_SIZE)
  private readonly longWindow = new Float32Array(LONG_WINDOW_SIZE)

  private lastDetectionAt = 0
  private lastSoundAt = 0
  private lockedString: GuitarString | null = null
  private phase: TunerPhase = 'starting'
  private lastFreq: number | null = null
  private lastStringIndex: number | null = null
  private offScale = false

  // Attack rejection
  private prevRms = 0
  private suppressUntil = 0

  // Settle
  private inToleranceSince: number | null = null
  private confirmed = false

  /** The preset as chosen; `tuning` is this with the capo applied. */
  private basePreset: Tuning = DEFAULT_TUNING
  private tuning: Tuning = DEFAULT_TUNING
  private tuned: boolean[] = this.tuning.strings.map(() => false)

  // Displayed frequency, updated on its own slower clock.
  private shownFreq: number | null = null
  private shownFreqAt = 0

  private confirmedAt = 0
  private longWindowActive = false

  // Adaptive noise gate, tracking the room rather than a fixed threshold.
  private noiseFloor = MIN_GATE

  // Auto-detect stickiness: a challenger must win several frames in a row.
  private candidateIndex: number | null = null
  private candidateFrames = 0

  settings: TunerSettings = { ...DEFAULT_SETTINGS }

  get currentTuning(): Tuning {
    return this.tuning
  }

  setTuning(id: string): void {
    this.applyTuning(tuningById(id), this.settings.capo)
  }

  /** Sets the capo position in semitones. */
  setCapo(semitones: number): void {
    const capo = Math.max(0, Math.min(MAX_CAPO, Math.round(semitones)))
    if (capo === this.settings.capo) return
    this.applyTuning(this.basePreset, capo)
  }

  /**
   * Rebuilds the sounding tuning from a preset and capo.
   *
   * Confirmed strings survive if the new tuning still contains the same note:
   * switching standard to drop D keeps five of six, and adding a capo keeps
   * none, which is correct in both cases.
   */
  private applyTuning(preset: Tuning, capo: number): void {
    const previous = this.tuning.strings.map((s, i) => ({ midi: s.midi, done: this.tuned[i] }))

    this.basePreset = preset
    this.settings.tuningId = preset.id
    this.settings.capo = capo
    this.tuning = transposeTuning(preset, capo)

    this.tuned = this.tuning.strings.map(
      (s) => previous.find((p) => p.midi === s.midi)?.done ?? false,
    )
    this.lockedString = null
    this.reset()
  }

  /** Feeds one audio event payload. */
  ingest(rawPcm: unknown): void {
    const samples = decodePcm(rawPcm)
    if (!samples.length) return
    this.ring.push(samples)
  }

  setPhase(phase: TunerPhase): void {
    this.phase = phase
  }

  get currentPhase(): TunerPhase {
    return this.phase
  }

  toggleLock(): void {
    if (this.lockedString) this.lockedString = null
    else if (this.lastStringIndex !== null)
      this.lockedString = this.tuning.strings[this.lastStringIndex]
    else this.lockedString = this.tuning.strings[0]
    this.resetSettle()
  }

  step(direction: 1 | -1): void {
    const strings = this.tuning.strings
    const current = this.lockedString
      ? strings.indexOf(this.lockedString)
      : (this.lastStringIndex ?? 0)
    const next = Math.max(0, Math.min(strings.length - 1, current + direction))
    this.lockedString = strings[next]
    this.resetSettle()
    this.smoother.reset()
  }

  /** Clears the six-string session progress. */
  clearSession(): void {
    this.tuned = this.tuning.strings.map(() => false)
  }

  /**
   * Advances detection one frame. Driven by a timer, not by audio events:
   * events arrive in small chunks that mostly re-read the same window.
   */
  advance(now: number): void {
    // A longer window halves estimate variance. Only affordable when close,
    // where adjustments are small and slow; further out the shorter window
    // keeps the needle responsive.
    const dist = this.currentCents === null ? Infinity : Math.abs(this.currentCents)
    if (!this.longWindowActive && dist <= LONG_WINDOW_ENTER_CENTS) this.longWindowActive = true
    else if (this.longWindowActive && dist > LONG_WINDOW_EXIT_CENTS) this.longWindowActive = false

    const window = this.longWindowActive
      ? (this.ring.latest(LONG_WINDOW_SIZE, this.longWindow) ??
        this.ring.latest(WINDOW_SIZE, this.window))
      : this.ring.latest(WINDOW_SIZE, this.window)

    if (window) {
      const level = rmsOf(window)

      // The floor tracks the quiet moments: it follows the level down, but may
      // only creep up, and never past the current level. A note therefore
      // cannot raise the floor and gate itself out.
      if (level < this.noiseFloor) {
        this.noiseFloor += NOISE_FALL * (level - this.noiseFloor)
      } else {
        this.noiseFloor = Math.min(level, this.noiseFloor * NOISE_CREEP)
      }
      const gate = Math.max(MIN_GATE, this.noiseFloor * GATE_MARGIN)

      // A pluck is a sharp jump in level. The transient after it is
      // inharmonic and sharp, so pause until it leaves the window.
      if (level > gate * 2 && level > this.prevRms * 2.5) {
        this.suppressUntil = now + ATTACK_SKIP_MS
        this.resetSettle()
        this.smoother.reset()
      }
      this.prevRms = level
      if (level > gate) this.lastSoundAt = now

      // A steeply falling level means the note is decaying hard, where its
      // pitch is genuinely moving; those frames drag the estimate flat.
      const decaying = this.prevRms > 0 && level < this.prevRms * DECAY_REJECT_RATIO

      if (now >= this.suppressUntil && !decaying) {
        const result = detectPitch(window, SAMPLE_RATE, {
          minRms: gate,
          ...this.searchRange(),
        })
        if (result) {
          // Steady near the target, quick further out, and a marginal frame
          // moves the needle less than a clean one.
          const near =
            this.currentCents !== null && Math.abs(this.currentCents) <= STEADY_WITHIN_CENTS
          const alpha = (near ? SMOOTH_ALPHA_NEAR : SMOOTH_ALPHA_FAR) * result.confidence
          this.lastFreq = this.smoother.push(result.freq, alpha)
          this.lastDetectionAt = now
        }
      }
    }

    if (now - this.lastDetectionAt > READING_HOLD_MS) {
      this.smoother.reset()
      this.lastFreq = null
      this.lastStringIndex = null
      this.offScale = false
      this.resetSettle()
    }

    this.updateMatch()

    this.updateSettle(now)
    this.advanceLock(now)
    this.updateShownFreq(now)
    this.updatePhase(now)
  }

  /**
   * Frequency window to search, but only when the user has locked a string.
   *
   * Never derived from the last detection. Doing that fed back on itself: a
   * stale index narrowed the search around the wrong string, a harmonic inside
   * that window scored a detection, the detection refreshed the staleness
   * timer, and the window never widened again. Measured as a permanent
   * failure to detect two of ten string changes, and 1.6s on the rest.
   */
  private searchRange(): { fMin?: number; fMax?: number } {
    if (!this.lockedString) return {}
    const centre = midiToFreq(this.lockedString.midi, this.settings.a4)
    return { fMin: centre * Math.pow(2, -0.25), fMax: centre * Math.pow(2, 0.25) }
  }

  private updateMatch(): void {
    if (this.lastFreq === null) return

    if (this.lockedString) {
      this.lastStringIndex = this.tuning.strings.indexOf(this.lockedString)
      this.currentCents = centsForString(this.lastFreq, this.lockedString, this.settings.a4)
      // A locked string is never off-scale: the user has said what they are
      // tuning, so target and direction stay on screen however far out.
      this.offScale = false
    } else {
      const m = matchString(this.lastFreq, this.tuning, this.settings.a4)

      // A challenger must win several consecutive frames before the label
      // switches, so a neighbour bleeding in cannot flip it frame to frame.
      //
      // Unconditional: an interfering string produces a genuinely distant
      // pitch, so "is this plausibly still the same string" cannot tell
      // interference from a real change. The cost is a few frames of latency
      // on every switch. Detection is never restricted, and the counter always
      // completes, so this cannot lock in.
      const current = this.lastStringIndex
      if (current === null || m.index === current) {
        this.candidateIndex = null
        this.candidateFrames = 0
        this.lastStringIndex = m.index
      } else {
        this.candidateFrames = m.index === this.candidateIndex ? this.candidateFrames + 1 : 1
        this.candidateIndex = m.index
        if (this.candidateFrames >= STRING_SWITCH_FRAMES) {
          this.lastStringIndex = m.index
          this.candidateIndex = null
          this.candidateFrames = 0
        }
      }

      // Cents always measured against the string actually shown.
      const shown = this.tuning.strings[this.lastStringIndex ?? m.index]
      this.currentCents = centsForString(this.lastFreq, shown, this.settings.a4)

      // While a switch is pending the shown string is not the one being
      // played, so its cents are meaningless: measuring the high E against A2
      // gives 1885 cents and pins the needle to the rail under the wrong
      // name. Show nothing for those frames instead of something wrong.
      //
      // One stray frame does not count. A single bad reading used to blank the
      // display for a frame, which flickered between the note and NO STRING
      // MATCH; holding the last good reading through it is correct.
      const settling = this.candidateFrames > 1
      this.offScale = !m.inRange || settling
    }
  }

  private currentCents: number | null = null

  private updateSettle(now: number): void {
    const c = this.currentCents
    const usable = c !== null && this.lastFreq !== null && !this.offScale

    if (usable && Math.abs(c) <= IN_TUNE_CENTS) {
      if (this.inToleranceSince === null) this.inToleranceSince = now
      if (!this.confirmed && now - this.inToleranceSince >= CONFIRM_HOLD_MS) {
        this.confirmed = true
        this.confirmedAt = now
        if (this.lastStringIndex !== null) this.tuned[this.lastStringIndex] = true
      }
    } else {
      this.resetSettle()
    }
  }

  /**
   * The displayed frequency, on a slower clock than the needle.
   *
   * A stale reading clears immediately, so the display never holds a frequency
   * for a string that has stopped sounding.
   */
  private updateShownFreq(now: number): void {
    if (this.lastFreq === null) {
      this.shownFreq = null
      return
    }
    if (this.shownFreq === null || now - this.shownFreqAt >= HZ_UPDATE_MS) {
      this.shownFreq = this.lastFreq
      this.shownFreqAt = now
    }
  }

  /**
   * Moves the lock to the next unconfirmed string once one is done, so a whole
   * guitar can be tuned without touching the glasses between strings.
   *
   * Only in locked mode: auto-detect already follows whatever is played. The
   * delay leaves the confirmation on screen long enough to be read.
   */
  private advanceLock(now: number): void {
    if (!this.lockedString || !this.confirmed) return
    if (now - this.confirmedAt < ADVANCE_DELAY_MS) return

    const strings = this.tuning.strings
    const from = strings.indexOf(this.lockedString)
    for (let step = 1; step <= strings.length; step++) {
      const i = (from + step) % strings.length
      if (!this.tuned[i]) {
        this.lockedString = strings[i]
        this.resetSettle()
        this.smoother.reset()
        return
      }
    }
  }

  private updatePhase(now: number): void {
    if (this.phase === 'micError' || this.phase === 'idle') return
    const fresh = this.lastFreq !== null && now - this.lastDetectionAt <= READING_HOLD_MS
    this.phase = fresh ? 'reading' : 'listening'
  }

  /** True when nothing has been heard for long enough to release the mic. */
  isIdle(now: number): boolean {
    return this.lastSoundAt > 0 && now - this.lastSoundAt > IDLE_TIMEOUT_MS
  }

  private resetSettle(): void {
    this.inToleranceSince = null
    this.confirmed = false
  }

  /** Current view. Pure, so it is safe to call as often as needed. */
  view(): TunerView {
    const cents = this.lastFreq === null ? null : this.currentCents
    const inTolerance = cents !== null && !this.offScale && Math.abs(cents) <= IN_TUNE_CENTS

    return {
      phase: this.phase,
      stringIndex: this.lastStringIndex,
      locked: this.lockedString !== null,
      cents,
      freq: this.shownFreq,
      a4: this.settings.a4,
      offScale: this.offScale,
      inTolerance,
      confirmed: this.confirmed,
      tuned: this.tuned,
      tuning: this.tuning,
      capo: this.settings.capo,
    }
  }

  reset(): void {
    this.candidateIndex = null
    this.candidateFrames = 0
    this.longWindowActive = false
    this.ring.clear()
    this.smoother.reset()
    this.shownFreq = null
    this.lastFreq = null
    this.lastStringIndex = null
    this.currentCents = null
    this.lastDetectionAt = 0
    this.prevRms = 0
    this.suppressUntil = 0
    this.resetSettle()
  }

  /** Called when the mic is (re)started, so idle timing starts fresh. */
  markActive(now: number): void {
    this.lastSoundAt = now
  }
}
