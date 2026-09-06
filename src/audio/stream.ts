/**
 * Rolling analysis window over the host's audio events.
 *
 * PCM arrives at 16 kHz, signed 16-bit little-endian, mono, but the container
 * varies: Uint8Array, number[] after a JSON hop, or base64.
 */

export const SAMPLE_RATE = 16000

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

  if (typeof raw === 'string') {
    try {
      return int16BytesToFloat(base64ToBytes(raw))
    } catch {
      return new Float32Array(0)
    }
  }
  if (raw instanceof Uint8Array) return int16BytesToFloat(raw)
  if (raw instanceof ArrayBuffer) return int16BytesToFloat(new Uint8Array(raw))

  if (Array.isArray(raw)) return decodeNumberArray(raw as number[])

  return new Float32Array(0)
}

/** JSON arrays are bytes, exactly as documented; never infer a format from amplitude. */
function decodeNumberArray(raw: number[]): Float32Array {
  if (!raw.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) return new Float32Array(0)
  return int16BytesToFloat(Uint8Array.from(raw))
}

function int16BytesToFloat(bytes: Uint8Array): Float32Array {
  if (bytes.length % 2) return new Float32Array(0)
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
    private readonly medianLength = 3,
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
      this.ema = Math.exp(Math.log(this.ema) + alpha * Math.log(median / this.ema))
    }
    return this.ema
  }

  reset(): void {
    this.history.length = 0
    this.ema = null
  }
}
