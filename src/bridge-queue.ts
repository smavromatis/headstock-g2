import { diagnostics } from './diagnostics'
/** One physical operation at a time, including after a caller's deadline. */
export class BridgeQueue {
  private tail: Promise<unknown> = Promise.resolve()
  private pending = 0
  state: 'ready' | 'degraded' = 'ready'

  /**
   * Timeout releases the caller, never the physical lane. While degraded new
   * work is dropped. A late settlement recovers the lane; a permanently hung
   * host requires closing and reopening the app (there is no cancellation API).
   */
  run<T>(task: () => Promise<T>, timeoutMs = 2500): Promise<T | null> {
    if (this.state === 'degraded' || this.pending >= 16) return Promise.resolve(null)
    this.pending++
    const queuedAt = Date.now()
    let finish!: (value: T | null) => void
    const result = new Promise<T | null>((resolve) => {
      finish = resolve
    })
    let started = false
    let expired = false
    const timer = setTimeout(() => {
      expired = true
      if (started) this.state = 'degraded'
      diagnostics.record({ kind: 'bridge', at: Date.now(), result: 'timeout' })
      finish(null)
    }, timeoutMs)
    this.tail = this.tail
      .then(async () => {
        if (expired || this.state === 'degraded') {
          finish(null)
          return
        }
        started = true
        diagnostics.record({
          kind: 'bridge',
          at: Date.now(),
          result: 'started',
          queueMs: Date.now() - queuedAt,
        })
        try {
          const value = await task()
          diagnostics.record({ kind: 'bridge', at: Date.now(), result: String(value) })
          finish(value)
        } catch {
          diagnostics.record({ kind: 'bridge', at: Date.now(), result: 'rejected' })
          finish(null)
        } finally {
          this.state = 'ready'
        }
      })
      .finally(() => {
        clearTimeout(timer)
        this.pending--
      })
    return result
  }
}
