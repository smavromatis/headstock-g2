/**
 * Tuner state machine: audio in, view model out. No bridge calls, so it runs
 * without a device.
 *
 * `advance()` mutates, `view()` is a pure read. Keeping them separate stops a
 * gesture or settings change from running a second detection pass and pushing
 * a duplicate reading into the smoother.
 */

import { detectPitch, rmsOf, WINDOW_SIZE } from './audio/pitch'
import { AudioRingBuffer, PitchSmoother, SAMPLE_RATE, decodePcm } from './audio/stream'
import {
  DEFAULT_TUNING,
  centsForString,
  matchString,
  TUNINGS,
  tuningById,
  type GuitarString,
  type Tuning,
} from './tuning/notes'
import {
  ATTACK_SKIP_MS,
  CONFIRM_HOLD_MS,
  FINE_ENTER_CENTS,
  FINE_EXIT_CENTS,
  IDLE_TIMEOUT_MS,
  GATE_MARGIN,
  IN_TUNE_CENTS,
  METER_COARSE_CENTS,
  MIN_GATE,
  NOISE_FALL,
  NOISE_RISE,
  METER_FINE_CENTS,
  READING_HOLD_MS,
} from './config'

export type TunerPhase = 'starting' | 'listening' | 'reading' | 'idle' | 'micError'

/** Where the tuner is currently being driven from. */
export type Surface = 'glasses' | 'phone'

export interface TunerSettings {
  a4: number
  tuningId: string
}

export const DEFAULT_SETTINGS: TunerSettings = { a4: 440, tuningId: DEFAULT_TUNING.id }

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
  /** Meter is on the fine scale. */
  fine: boolean
  /** Half-range of the meter in cents (coarse or fine). */
  meterRange: number
  /** Which strings have been confirmed in tune this session. */
  tuned: readonly boolean[]
  tuning: Tuning
}

export class Tuner {
  private readonly ring = new AudioRingBuffer(WINDOW_SIZE * 3)
  private readonly smoother = new PitchSmoother()
  private readonly window = new Float32Array(WINDOW_SIZE)

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

  // Meter scale
  private fine = false

  private tuning: Tuning = DEFAULT_TUNING
  private tuned: boolean[] = this.tuning.strings.map(() => false)

  // Adaptive noise gate, tracking the room rather than a fixed threshold.
  private noiseFloor = MIN_GATE

  settings: TunerSettings = { ...DEFAULT_SETTINGS }

  get currentTuning(): Tuning {
    return this.tuning
  }

  /** Switches tuning and clears anything measured against the old one. */
  setTuning(id: string): void {
    if (id === this.tuning.id) return
    this.tuning = tuningById(id)
    this.settings.tuningId = this.tuning.id
    this.lockedString = null
    this.clearSession()
    this.reset()
  }

  /** Next preset, for the long-press fallback when no menu is available. */
  cycleTuning(): void {
    const order = TUNINGS.map((t) => t.id)
    const next = order[(order.indexOf(this.tuning.id) + 1) % order.length]
    this.setTuning(next)
  }

  /** Feeds one audio event payload. */
  ingest(rawPcm: unknown): void {
    const samples = decodePcm(rawPcm)
    if (samples.length) this.ring.push(samples)
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
    const window = this.ring.latest(WINDOW_SIZE, this.window)

    if (window) {
      const level = rmsOf(window)

      // Track the room: fall quickly toward a quieter floor, rise slowly, so a
      // sustained note cannot drag the floor up and gate itself out.
      const rate = level < this.noiseFloor ? NOISE_FALL : NOISE_RISE
      this.noiseFloor += rate * (level - this.noiseFloor)
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

      if (now >= this.suppressUntil) {
        const result = detectPitch(window, SAMPLE_RATE, { minRms: gate })
        if (result) {
          const smoothed = this.smoother.push(result.freq)
          this.lastFreq = smoothed
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
      this.fine = false
    }

    this.updateMatch()
    this.updateSettle(now)
    this.updatePhase(now)
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
      this.lastStringIndex = m.index
      this.currentCents = m.cents
      this.offScale = !m.inRange
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
        if (this.lastStringIndex !== null) this.tuned[this.lastStringIndex] = true
      }
    } else {
      this.resetSettle()
    }

    // Hysteresis, so the scale cannot flap on the boundary.
    if (usable) {
      const abs = Math.abs(c)
      if (!this.fine && abs <= FINE_ENTER_CENTS) this.fine = true
      else if (this.fine && abs > FINE_EXIT_CENTS) this.fine = false
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
    const inTolerance =
      cents !== null && !this.offScale && Math.abs(cents) <= IN_TUNE_CENTS

    return {
      phase: this.phase,
      stringIndex: this.lastStringIndex,
      locked: this.lockedString !== null,
      cents,
      freq: this.lastFreq,
      a4: this.settings.a4,
      offScale: this.offScale,
      inTolerance,
      confirmed: this.confirmed,
      fine: this.fine,
      meterRange: this.fine ? METER_FINE_CENTS : METER_COARSE_CENTS,
      tuned: this.tuned,
      tuning: this.tuning,
    }
  }

  reset(): void {
    this.ring.clear()
    this.smoother.reset()
    this.lastFreq = null
    this.lastStringIndex = null
    this.currentCents = null
    this.lastDetectionAt = 0
    this.prevRms = 0
    this.suppressUntil = 0
    this.resetSettle()
    this.fine = false
  }

  /** Called when the mic is (re)started, so idle timing starts fresh. */
  markActive(now: number): void {
    this.lastSoundAt = now
  }
}
