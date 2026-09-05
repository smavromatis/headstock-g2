/**
 * Serialises every call this app makes over the bridge.
 *
 * The platform requires it: concurrent calls share one BLE link and can drop
 * the connection. Rendering, storage writes and microphone control all queue
 * here rather than each guarding itself.
 *
 * Every task carries a timeout, because a single flaky hop can otherwise hang
 * for ~30s and stall everything behind it.
 */
export class BridgeQueue {
  private tail: Promise<unknown> = Promise.resolve()

  /** Runs `task` after everything already queued. Returns null on failure. */
  run<T>(task: () => Promise<T>, timeoutMs = 2500): Promise<T | null> {
    const result = this.tail.then(
      () => withTimeout(task(), timeoutMs),
      () => withTimeout(task(), timeoutMs),
    )
    // The chain must not reject, or every later task inherits the rejection.
    this.tail = result.catch(() => undefined)
    return result.catch(() => null)
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('bridge timeout')), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}
