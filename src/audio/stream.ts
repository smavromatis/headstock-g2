/**
 * Rolling analysis window over the host's audio events.
 *
 * PCM arrives at 16 kHz, signed 16-bit little-endian, mono, but the container
 * varies: Uint8Array, number[] after a JSON hop, or base64.
 */

export const SAMPLE_RATE = 16000

/**
 * Measures how many samples actually arrive per second of wall clock.
 *
 * The host reports no sample rate, and the two microphone paths need not use
 * the same one. Assuming 16 kHz for a path running at a different rate shifts
 * every reading by a fixed ratio. Measuring it is device-independent, where a
 * per-phone constant would be guesswork that goes stale.
 *
 * Ignores the first second, since the first buffers arrive in a burst.
 */
export class SampleRateMeter {
  private startedAt = 0
  private samples = 0

  reset(now: number): void {
    this.startedAt = now
    this.samples = 0
  }

  add(count: number, now: number): void {
    if (this.startedAt === 0) this.startedAt = now
    if (now - this.startedAt < 1000) return
    this.samples += count
  }

  /** Measured rate, or null until there is enough data to be meaningful. */
  rate(now: number): number | null {
    const elapsed = now - this.startedAt - 1000
    if (elapsed < 4000 || this.samples === 0) return null
    return (this.samples * 1000) / elapsed
  }
}

export class AudioRingBuffer {
  private readonly buf: Float32Array
  private write = 0
  private filled = 0

  constructor(private readonly capacity: number) {
    this.buf = new Float32Array(capacity)
  }

  push(samples: Float32Array): void {
    for (let i = 0; i < samples.length; i++) {
      this.buf[this.write] = samples[i]
      this.write = (this.write + 1) % this.capacity
    }
    this.filled = Math.min(this.capacity, this.filled + samples.length)
  }

  /** Copies the most recent `n` samples in chronological order. */
  latest(n: number, out?: Float32Array): Float32Array | null {
    if (this.filled < n) return null
    const dst = out && out.length === n ? out : new Float32Array(n)
    let idx = (this.write - n + this.capacity) % this.capacity
    for (let i = 0; i < n; i++) {
      dst[i] = this.buf[idx]
      idx = idx + 1 === this.capacity ? 0 : idx + 1
    }
    return dst
  }

  clear(): void {
    this.buf.fill(0)
    this.write = 0
    this.filled = 0
  }
}

/** Decodes a host payload into normalised float samples. */
export function decodePcm(raw: unknown): Float32Array {
  if (raw == null) return new Float32Array(0)

  if (typeof raw === 'string') return int16BytesToFloat(base64ToBytes(raw))
  if (raw instanceof Uint8Array) return int16BytesToFloat(raw)
  if (raw instanceof ArrayBuffer) return int16BytesToFloat(new Uint8Array(raw))
  if (ArrayBuffer.isView(raw)) {
    const v = raw as ArrayBufferView
    return int16BytesToFloat(new Uint8Array(v.buffer, v.byteOffset, v.byteLength))
  }

  if (Array.isArray(raw)) return decodeNumberArray(raw as number[])

  return new Float32Array(0)
}

/**
 * A number[] may be bytes or 16-bit samples. Deciding per call would flip
 * interpretation mid-note, since a quiet passage of samples stays under 255.
 * Decided once, on the first payload that proves it, then held.
 */
type ArrayPcmFormat = 'unknown' | 'bytes' | 'samples'
let arrayFormat: ArrayPcmFormat = 'unknown'

/**
 * Forgets the latched format. Must be called when the microphone source
 * changes: the two sources are separate host paths and need not agree, and a
 * latch made for one would silently mis-decode the other.
 */
export function resetPcmFormat(): void {
  arrayFormat = 'unknown'
}

function decodeNumberArray(raw: number[]): Float32Array {
  if (arrayFormat === 'unknown') {
    for (let i = 0; i < raw.length; i++) {
      if (Math.abs(raw[i]) > 255) {
        arrayFormat = 'samples'
        break
      }
    }
  }

  // Default to bytes: that is what the host documents and sends.
  if (arrayFormat === 'samples') {
    const out = new Float32Array(raw.length)
    for (let i = 0; i < raw.length; i++) out[i] = raw[i] / 32768
    return out
  }
  return int16BytesToFloat(Uint8Array.from(raw))
}

function int16BytesToFloat(bytes: Uint8Array): Float32Array {
  const n = bytes.length >> 1
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const lo = bytes[i * 2]
    const hi = bytes[i * 2 + 1]
    let v = (hi << 8) | lo
    if (v >= 0x8000) v -= 0x10000 // sign-extend
    out[i] = v / 32768
  }
  return out
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * Median-then-EMA smoothing. The median drops outlier frames, the EMA stops
 * the last digit flickering without lagging a turning peg.
 */
export class PitchSmoother {
  private readonly history: number[] = []
  private ema: number | null = null

  constructor(
    private readonly medianLength = 5,
    private readonly alpha = 0.4,
  ) {}

  /** `alpha` may vary per call, so smoothing can tighten near the target. */
  push(freq: number, alpha = this.alpha): number {
    this.history.push(freq)
    if (this.history.length > this.medianLength) this.history.shift()

    const sorted = [...this.history].sort((a, b) => a - b)
    const median = sorted[sorted.length >> 1]

    // Over a semitone means a different string: snap, don't glide.
    if (this.ema === null || Math.abs(1200 * Math.log2(median / this.ema)) > 100) {
      this.ema = median
    } else {
      this.ema = this.ema + alpha * (median - this.ema)
    }
    return this.ema
  }

  reset(): void {
    this.history.length = 0
    this.ema = null
  }
}
