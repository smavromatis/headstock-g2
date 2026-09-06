import { AudioInputSource, type EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { BridgeQueue } from './bridge-queue'
import { MIC_CONTROL_TIMEOUT_MS } from './config'

/** Desired capture and observed host state have different lifetimes. */
export class Microphone {
  private generation = 0
  wanted = false
  state: 'off' | 'starting' | 'active' | 'error' = 'off'
  constructor(
    private bridge: EvenAppBridge,
    private queue: BridgeQueue,
  ) {}

  async start(): Promise<boolean> {
    this.wanted = true
    const generation = ++this.generation
    this.state = 'starting'
    const ok = await this.queue.run(() => {
      if (generation !== this.generation) return Promise.resolve(false)
      return this.bridge.audioControl(true, AudioInputSource.Glasses)
    }, MIC_CONTROL_TIMEOUT_MS)
    if (generation !== this.generation) return false
    // Valid PCM can arrive before audioControl's reply, and is stronger evidence.
    if (!this.isActive()) this.state = ok ? 'active' : 'error'
    return this.isActive()
  }

  private isActive(): boolean {
    return this.state === 'active'
  }

  observeAudio(): boolean {
    if (!this.wanted) return false
    this.state = 'active'
    return true
  }

  async stop(): Promise<void> {
    this.wanted = false
    const generation = ++this.generation
    this.state = 'off'
    const ok = await this.queue.run(() => this.bridge.audioControl(false), MIC_CONTROL_TIMEOUT_MS)
    if (generation === this.generation && ok !== true) this.state = 'error'
  }

  disconnected(): void {
    this.generation++
    this.wanted = false
    this.state = 'off'
  }
}
