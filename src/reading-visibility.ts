/** Presentation only: never supplies evidence to pitch confirmation. */
export class ReadingVisibility {
  private active = false
  private reliableSince: number | null = null
  private uncertainSince: number | null = null

  update(now: number, reliable: boolean, hasReading: boolean): boolean {
    if (!hasReading) {
      this.reset()
      return false
    }
    if (reliable) {
      this.uncertainSince = null
      this.reliableSince ??= now
      // Recovery needs sustained evidence, so isolated late detections cannot
      // repeatedly brighten a fading pluck.
      if (now - this.reliableSince >= 300) this.active = true
    } else {
      this.reliableSince = null
      this.uncertainSince ??= now
      if (now - this.uncertainSince >= 500) this.active = false
    }
    return this.active
  }

  reset(): void {
    this.active = false
    this.reliableSince = null
    this.uncertainSince = null
  }
}
