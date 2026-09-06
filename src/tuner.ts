import { ReadingVisibility } from './reading-visibility'
import { diagnostics } from './diagnostics'
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

export type TunerPhase = 'starting' | 'listening' | 'reading' | 'stale' | 'idle' | 'micError'

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
  /** Debounced presentation brightness; never confirmation evidence. */
  visualActive?: boolean
  measurement?: Readonly<Measurement> | null
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

export interface Measurement {
  freq: number
  cents: number
  target: string
  confidence: number
  sampleEnd: number
  receivedAt: number
}

/** Maximum packet gap allowed to contribute to a continuous confirmation. */
const AUDIO_GAP_MS = 250
const ANALYSIS_HOP = 1600

export function normalizeSettings(raw: unknown): TunerSettings {
  const value = raw && typeof raw === 'object' ? (raw as Partial<TunerSettings>) : {}
  const finite = (v: unknown, fallback: number, lo: number, hi: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback
  return {
    a4: finite(value.a4, 440, 415, 445),
    capo: Math.round(finite(value.capo, 0, 0, MAX_CAPO)),
    tuningId: tuningById(typeof value.tuningId === 'string' ? value.tuningId : '').id,
  }
}

export class Tuner {
  private readonly visibility = new ReadingVisibility()
  private visualActive = false
  private readonly ring = new AudioRingBuffer(WINDOW_SIZE * 2)
  private readonly smoother = new PitchSmoother()
  private readonly window = new Float32Array(WINDOW_SIZE)

  private sampleEnd = 0
  private analysedEnd = 0
  private receivedAt = -Infinity
  private evidenceEnd = 0
  private evidenceStart: number | null = null
  private measurement: Measurement | null = null
  private accepted = false
  private lastDetectionAt = 0
  private lastSoundAt = 0
  private lockedString: GuitarString | null = null
  private phase: TunerPhase = 'starting'
  private lastFreq: number | null = null
  private lastStringIndex: number | null = null
  private offScale = false

  // Attack rejection
  private prevRecentRms = 0
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

  // Adaptive noise gate, tracking the room rather than a fixed threshold.
  private noiseFloor = MIN_GATE

  // Auto-detect stickiness: a challenger must win several frames in a row.
  private candidateIndex: number | null = null
  private candidateFrames = 0

  private _settings: TunerSettings = { ...DEFAULT_SETTINGS }

  get settings(): Readonly<TunerSettings> {
    return { ...this._settings }
  }

  get currentTuning(): Tuning {
    return this.tuning
  }

  setA4(a4: number): void {
    const next = normalizeSettings({ a4 }).a4
    if (next === this._settings.a4) return
    this._settings.a4 = next
    this.clearSession()
    this.reset()
  }

  setTuning(id: string): void {
    this.applyTuning(tuningById(id), this._settings.capo)
  }

  /** Sets the capo position in semitones. */
  setCapo(semitones: number): void {
    const capo = normalizeSettings({ capo: semitones }).capo
    if (capo === this._settings.capo) return
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
    this._settings.tuningId = preset.id
    this._settings.capo = capo
    this.tuning = transposeTuning(preset, capo)

    this.tuned = this.tuning.strings.map(
      (s) => previous.find((p) => p.midi === s.midi)?.done ?? false,
    )
    this.lockedString = null
    this.reset()
  }

  /** Feeds one audio event payload. */
  ingest(rawPcm: unknown, now = Date.now()): void {
    const samples = decodePcm(rawPcm)
    if (!samples.length) return
    diagnostics.record({
      kind: 'audio',
      at: now,
      samples: samples.length,
      gapMs: Number.isFinite(this.receivedAt) ? now - this.receivedAt : null,
    })
    if (now - this.receivedAt > AUDIO_GAP_MS) this.reset()
    this.receivedAt = now
    this.sampleEnd += samples.length
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
    this.reset()
  }

  step(direction: 1 | -1): void {
    const strings = this.tuning.strings
    const current = this.lockedString
      ? strings.indexOf(this.lockedString)
      : (this.lastStringIndex ?? 0)
    const next = Math.max(0, Math.min(strings.length - 1, current + direction))
    this.lockedString = strings[next]
    this.reset()
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
    const started = performance.now()
    this.accepted = false
    const fresh = now - this.receivedAt <= AUDIO_GAP_MS
    const newSamples = this.sampleEnd - this.analysedEnd
    const canAnalyse = fresh && newSamples >= ANALYSIS_HOP
    const elapsed = (newSamples / SAMPLE_RATE) * 1000
    if (canAnalyse) this.analysedEnd = this.sampleEnd
    if (
      !fresh ||
      now - this.lastDetectionAt > AUDIO_GAP_MS ||
      newSamples > (SAMPLE_RATE * AUDIO_GAP_MS) / 1000
    )
      this.resetSettle()
    // Fixed 256ms window: doubling YIN input left phase windows unchanged.
    // The seeded benchmark found no variance benefit and added step latency.
    const window = this.ring.latest(WINDOW_SIZE, this.window)

    if (window && canAnalyse) {
      const level = rmsOf(window)
      const recent = this.ring.latest(ANALYSIS_HOP)
      const recentLevel = recent ? rmsOf(recent) : 0

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
      if (recentLevel > gate) this.lastSoundAt = this.receivedAt

      // A steeply falling level means the note is decaying hard, and its pitch
      // is moving with it rather than being mismeasured; those frames drag the
      // estimate flat.
      //
      // Compared against the previous frame, so prevRms is updated after this.
      // Assigning it above made the test `level < level * 0.6`, false for any
      // level, so the rejection never ran.
      const decaying =
        (this.prevRms > 0 && level < this.prevRms * DECAY_REJECT_RATIO) ||
        (this.prevRecentRms > 0 && recentLevel < this.prevRecentRms * DECAY_REJECT_RATIO)
      this.prevRecentRms = recentLevel
      this.prevRms = level

      if (now >= this.suppressUntil && !decaying && recentLevel > gate) {
        const result = detectPitch(window, SAMPLE_RATE, {
          minRms: gate,
          ...this.detectionBounds,
        })
        if (result) {
          // Steady near the target, quick further out, and a marginal frame
          // moves the needle less than a clean one.
          const near =
            this.currentCents !== null &&
            Math.abs(this.currentCents) <= STEADY_WITHIN_CENTS &&
            this.lastFreq !== null &&
            Math.abs(1200 * Math.log2(result.freq / this.lastFreq)) < 2
          const baseAlpha = (near ? SMOOTH_ALPHA_NEAR : SMOOTH_ALPHA_FAR) * result.confidence
          const alpha = 1 - Math.pow(1 - baseAlpha, elapsed / 100)
          this.lastFreq = this.smoother.push(result.freq, alpha)
          this.lastDetectionAt = this.receivedAt
          this.accepted = true
          const target =
            this.lockedString ??
            this.tuning.strings[matchString(result.freq, this.tuning, this._settings.a4).index]
          if (this.measurement?.target !== `${target.midi}:${this._settings.a4}`) this.resetSettle()
          this.measurement = {
            freq: result.freq,
            cents: centsForString(result.freq, target, this._settings.a4),
            target: `${target.midi}:${this._settings.a4}`,
            confidence: result.confidence,
            sampleEnd: this.sampleEnd,
            receivedAt: this.receivedAt,
          }
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

    const previousIndex = this.lastStringIndex
    if (this.accepted) this.updateMatch()
    if (previousIndex !== this.lastStringIndex) this.shownFreq = null
    if (canAnalyse && !this.accepted) this.resetSettle()

    this.updateSettle(now)
    this.advanceLock(now)
    this.updateShownFreq(now)
    this.updatePhase(now, canAnalyse)
    this.visualActive = this.visibility.update(
      now,
      this.phase === 'reading' && !this.offScale,
      this.lastFreq !== null && (this.phase === 'reading' || this.phase === 'stale'),
    )
    if (canAnalyse)
      diagnostics.record({
        kind: 'measurement',
        at: now,
        accepted: this.accepted,
        confidence: this.accepted ? (this.measurement?.confidence ?? null) : null,
        cents: this.accepted ? (this.measurement?.cents ?? null) : null,
        sampleEnd: this.sampleEnd,
        processingMs: performance.now() - started,
      })
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
  get detectionBounds(): { fMin: number; fMax: number } {
    if (!this.lockedString) {
      const frequencies = this.tuning.strings.map((s) => midiToFreq(s.midi, this._settings.a4))
      return {
        fMin: Math.min(...frequencies) * 2 ** -0.25,
        fMax: Math.max(...frequencies) * 2 ** 0.25,
      }
    }
    const centre = midiToFreq(this.lockedString.midi, this._settings.a4)
    return { fMin: centre * Math.pow(2, -0.25), fMax: centre * Math.pow(2, 0.25) }
  }

  private updateMatch(): void {
    if (this.lastFreq === null) return

    if (this.lockedString) {
      this.lastStringIndex = this.tuning.strings.indexOf(this.lockedString)
      this.currentCents = centsForString(this.lastFreq, this.lockedString, this._settings.a4)
      // A locked string is never off-scale: the user has said what they are
      // tuning, so target and direction stay on screen however far out.
      this.offScale = false
    } else {
      const m = matchString(this.lastFreq, this.tuning, this._settings.a4)

      // A challenger must win several consecutive frames before the label
      // switches, so a neighbour bleeding in cannot flip it frame to frame.
      //
      // Unconditional: an interfering string produces a pitch just as distant
      // as a real change does, so "is this plausibly still the same string"
      // cannot tell the two apart. The cost is a few frames of latency
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
      this.currentCents = centsForString(this.lastFreq, shown, this._settings.a4)

      // While a switch is pending the shown string is not the one being
      // played, so its cents are meaningless: measuring the high E against A2
      // gives 1885 cents and pins the needle to the rail under the wrong
      // name. Show nothing for those frames instead of something wrong.
      //
      // Median filtering already rejects isolated pitch outliers. Hide the
      // meter for every remaining pending switch, including its first frame.
      const settling = this.candidateFrames > 0
      this.offScale =
        !m.inRange || settling || this.measurement?.target !== `${shown.midi}:${this._settings.a4}`
    }
  }

  private currentCents: number | null = null

  private updateSettle(now: number): void {
    if (!this.accepted) return
    const c = this.measurement?.cents ?? null
    const target = this.lastStringIndex === null ? null : this.tuning.strings[this.lastStringIndex]
    const usable =
      c !== null &&
      !this.offScale &&
      target !== null &&
      this.measurement?.target === `${target.midi}:${this._settings.a4}`

    if (usable && Math.abs(c) <= IN_TUNE_CENTS) {
      if (this.inToleranceSince === null) {
        this.inToleranceSince = now
        this.evidenceStart = this.sampleEnd
      }
      // Overlapping windows do not count their old samples a second time.
      this.evidenceEnd = this.sampleEnd
      if (
        !this.confirmed &&
        now - this.inToleranceSince >= CONFIRM_HOLD_MS &&
        ((this.evidenceEnd - (this.evidenceStart ?? this.sampleEnd)) / SAMPLE_RATE) * 1000 >=
          CONFIRM_HOLD_MS
      ) {
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
        this.reset()
        return
      }
    }
  }

  private updatePhase(now: number, canAnalyse: boolean): void {
    if (this.phase === 'micError' || this.phase === 'idle') return
    const fresh = this.lastFreq !== null && now - this.lastDetectionAt <= READING_HOLD_MS
    // A render tick without a new analysis is not a rejected measurement.
    // Preserve live state between hops, but never across a rejected hop or gap.
    this.phase = fresh
      ? now - this.receivedAt <= AUDIO_GAP_MS &&
        now - this.lastDetectionAt <= AUDIO_GAP_MS &&
        (this.accepted || (!canAnalyse && this.phase === 'reading'))
        ? 'reading'
        : 'stale'
      : 'listening'
  }

  /** True when nothing has been heard for long enough to release the mic. */
  isIdle(now: number): boolean {
    return this.lastSoundAt > 0 && now - this.lastSoundAt > IDLE_TIMEOUT_MS
  }

  private resetSettle(): void {
    this.evidenceStart = null
    this.inToleranceSince = null
    this.confirmed = false
  }

  /** Current view. Pure, so it is safe to call as often as needed. */
  view(): TunerView {
    const cents = this.lastFreq === null ? null : this.currentCents
    const inTolerance =
      this.phase === 'reading' &&
      cents !== null &&
      !this.offScale &&
      Math.abs(this.measurement?.cents ?? Infinity) <= IN_TUNE_CENTS

    return {
      phase: this.phase,
      visualActive: this.visualActive,
      measurement: this.measurement ? { ...this.measurement } : null,
      stringIndex: this.lockedString
        ? this.tuning.strings.indexOf(this.lockedString)
        : this.lastStringIndex,
      locked: this.lockedString !== null,
      cents,
      freq: this.shownFreq,
      a4: this._settings.a4,
      offScale: this.offScale,
      inTolerance,
      confirmed: this.confirmed,
      tuned: [...this.tuned],
      tuning: this.tuning,
      capo: this._settings.capo,
    }
  }

  reset(): void {
    this.visibility.reset()
    this.visualActive = false
    this.sampleEnd = 0
    this.analysedEnd = 0
    this.receivedAt = -Infinity
    this.measurement = null
    this.offScale = false
    this.accepted = false
    this.candidateIndex = null
    this.candidateFrames = 0
    this.ring.clear()
    this.smoother.reset()
    this.shownFreq = null
    this.lastFreq = null
    this.lastStringIndex = null
    this.currentCents = null
    this.lastDetectionAt = 0
    this.prevRecentRms = 0
    this.prevRms = 0
    this.suppressUntil = 0
    this.resetSettle()
  }

  /** Called when the mic is (re)started, so idle timing starts fresh. */
  markActive(now: number): void {
    this.lastSoundAt = now
  }
}
