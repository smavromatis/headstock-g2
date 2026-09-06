/** Opt-in bounded numeric traces. Never stores PCM or transmits data. */
export interface DiagnosticEvent {
  kind: 'audio' | 'measurement' | 'pointer' | 'bridge'
  at: number
  [key: string]: string | number | boolean | null
}
class Diagnostics {
  enabled = false
  private events: DiagnosticEvent[] = []
  record(event: DiagnosticEvent): void {
    if (!this.enabled) return
    if (this.events.length >= 1000) this.events.shift()
    this.events.push(event)
  }
  snapshot(): DiagnosticEvent[] {
    return this.events.map((event) => ({ ...event }))
  }
  clear(): void {
    this.events = []
  }
}
export const diagnostics = new Diagnostics()
