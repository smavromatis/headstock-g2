/**
 * Tuneful - a classical guitar tuner for Even Realities G2.
 *
 * Once running the app needs no phone interaction; the phone holds settings and
 * status, or becomes the tuner itself when the phone mic is selected.
 *
 * Nothing here assumes the glasses are present. If the page cannot be drawn,
 * the app falls back to tuning on the phone.
 */

import {
  waitForEvenAppBridge,
  AudioInputSource,
  OsEventTypeList,
  StartUpPageCreateResult,
  validateEvenHubPageContainer,
  formatEvenHubPageContainerValidationError,
  type EvenAppBridge,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk'

import { Tuner, DEFAULT_SETTINGS, type TunerSettings, type Surface } from './tuner'
import { GlassesRenderer } from './glasses/display'
import { mountPhoneUi, type PhoneUi } from './phone/ui'
import { STANDARD_TUNING, midiToFreq } from './tuning/notes'

/** Analysis cadence. 10 fps is past the point where the needle feels live. */
const FRAME_MS = 100
const SETTINGS_KEY = 'tuneful.settings.v1'

const tuner = new Tuner()
let bridge: EvenAppBridge | null = null
let renderer: GlassesRenderer | null = null
let phone: PhoneUi | null = null
let frameTimer: ReturnType<typeof setInterval> | null = null

/** Which surface is driving the tuner. Follows the chosen microphone. */
let surface: Surface = 'glasses'
let micSource: AudioInputSource = AudioInputSource.Glasses
let glassesAvailable = false

const teardown: Array<() => void> = []

async function main(): Promise<void> {
  phone = mountPhoneUi({
    onA4Change: (a4) => {
      tuner.settings.a4 = a4
      persistSettings()
      paint()
    },
    onCalibrationChange: (cents) => {
      tuner.settings.calibration = cents
      persistSettings()
      paint()
    },
    onMicSourceChange: (source) => {
      micSource = source
      // The phone mic makes the phone the tuner; the glasses stand down.
      surface = source === AudioInputSource.Phone ? 'phone' : 'glasses'
      void restartMic()
    },
    onResetSession: () => {
      tuner.clearSession()
      paint()
    },
  })

  bridge = await waitForEvenAppBridge()

  // Fires exactly once, so it is registered before anything can miss it.
  teardown.push(bridge.onLaunchSource(() => {}))

  await loadSettings()

  glassesAvailable = await setUpGlasses()
  if (!glassesAvailable) {
    // No glasses page, so hand the job to the phone rather than stopping.
    surface = 'phone'
    micSource = AudioInputSource.Phone
    phone?.setStatus({
      connection: 'degraded',
      message: 'Glasses unavailable — tuning on the phone.',
    })
  }

  phone?.setSurface(surface)

  teardown.push(bridge.onEvenHubEvent(onHubEvent))
  teardown.push(
    bridge.onDeviceStatusChanged((status) => {
      phone?.setDevice({
        battery: status.batteryLevel ?? null,
        connected: status.isConnected(),
      })
    }),
  )

  await startMic()

  frameTimer = setInterval(tick, FRAME_MS)
  window.addEventListener('beforeunload', cleanup)

  installDevHarness()
}

/** Returns true when the glasses page is up and can be rendered to. */
async function setUpGlasses(): Promise<boolean> {
  if (!bridge) return false

  const view = tuner.view()
  const page = GlassesRenderer.initialPage(view)

  // The SDK validates the page and returns `invalid` without calling native,
  // so a bare result code hides the reason.
  const validation = validateEvenHubPageContainer(page)
  if (validation && (validation as { code?: string }).code) {
    const detail = formatEvenHubPageContainerValidationError(
      validation as Parameters<typeof formatEvenHubPageContainerValidationError>[0],
    )
    console.error('TUNEFUL_PAGE_INVALID', JSON.stringify(validation), detail)
    return false
  }

  let result: StartUpPageCreateResult
  try {
    result = await bridge.createStartUpPageContainer(page)
  } catch {
    return false
  }

  if (result !== StartUpPageCreateResult.success) {
    console.warn('TUNEFUL_STARTUP_RESULT', result)
    // `invalid` here usually means the host still holds a page from a previous
    // run, not a bad layout - the SDK already validated it. Happens on every
    // hot reload. Rebuild is the way back in.
    const recovered =
      result === StartUpPageCreateResult.invalid &&
      (await bridge.rebuildPageContainer(GlassesRenderer.rebuildPage(view)).catch(() => false))
    if (!recovered) return false
    console.log('TUNEFUL_RECOVERED_VIA_REBUILD')
  }

  renderer = new GlassesRenderer(bridge)
  phone?.setStatus({ connection: 'ok', message: 'Running on your glasses.' })
  return true
}

// --- Audio ---------------------------------------------------------------

async function startMic(): Promise<void> {
  if (!bridge) return
  try {
    const ok = await bridge.audioControl(true, micSource)
    if (!ok) throw new Error('audioControl returned false')
    tuner.setPhase('listening')
    tuner.markActive(Date.now())
    phone?.setMic({ active: true, source: micSource })
  } catch {
    tuner.setPhase('micError')
    phone?.setMic({ active: false, source: micSource })
    phone?.setStatus({
      connection: 'error',
      message:
        micSource === AudioInputSource.Glasses
          ? 'The glasses microphone did not start. Check they are connected and worn, or switch to the phone microphone.'
          : 'The phone microphone did not start. Check microphone permission for the Even app.',
    })
  }
  paint()
}

async function restartMic(): Promise<void> {
  if (!bridge) return
  try {
    await bridge.audioControl(false)
  } catch {
    // Already closed; starting the new source is what matters.
  }
  tuner.reset()
  await startMic()
}

/** Releases the mic after a long silence. */
async function goIdle(): Promise<void> {
  if (!bridge || tuner.currentPhase === 'idle') return
  tuner.setPhase('idle')
  tuner.reset()
  tuner.clearSession()
  try {
    await bridge.audioControl(false)
  } catch {
    // Nothing to do; the phase is already idle either way.
  }
  phone?.setMic({ active: false, source: micSource })
  paint()
}

async function resumeFromIdle(): Promise<void> {
  if (tuner.currentPhase !== 'idle') return
  tuner.setPhase('listening')
  await startMic()
}

// --- Events --------------------------------------------------------------

function onHubEvent(event: EvenHubEvent): void {
  if (event.audioEvent) {
    // The host still pushes live mic audio during a demo; mixing it with the
    // synthetic tone interleaves silence and makes the reading drift.
    if (!demoTimer) tuner.ingest(event.audioEvent.audioPcm)
    return
  }

  // Scroll gestures arrive as textEvent; clicks do not, they come through
  // sysEvent. This is the most common event-handling bug on this platform.
  if (event.textEvent) {
    const type = event.textEvent.eventType ?? 0
    const up = type === OsEventTypeList.SCROLL_TOP_EVENT
    const down = type === OsEventTypeList.SCROLL_BOTTOM_EVENT
    if (demoTimer) {
      if (up) demoStep(1)
      else if (down) demoStep(-1)
    } else if (up) tuner.step(1)
    else if (down) tuner.step(-1)
    paint()
    return
  }

  if (event.sysEvent) {
    // Protobuf omits zero values, so a single click arrives as undefined.
    const type = event.sysEvent.eventType ?? 0
    switch (type) {
      case OsEventTypeList.CLICK_EVENT:
        if (tuner.currentPhase === 'idle') void resumeFromIdle()
        else tuner.toggleLock()
        paint()
        break
      case OsEventTypeList.DOUBLE_CLICK_EVENT:
        // Nothing is torn down here: the user can still cancel, and cleaning
        // up now would leave a live app that has stopped listening.
        void bridge?.shutDownPageContainer(1)
        break
      case OsEventTypeList.FOREGROUND_ENTER_EVENT:
        // The host may have migrated us through a headless WebView.
        tuner.reset()
        renderer?.invalidate()
        paint()
        break
      case OsEventTypeList.FOREGROUND_EXIT_EVENT:
        flushSettings()
        break
      case OsEventTypeList.ABNORMAL_EXIT_EVENT:
      case OsEventTypeList.SYSTEM_EXIT_EVENT:
        cleanup()
        break
    }
  }
}

// --- Frame loop ----------------------------------------------------------

function tick(): void {
  const now = Date.now()
  tuner.advance(now)

  if (tuner.currentPhase !== 'idle' && tuner.isIdle(now)) {
    void goIdle()
    return
  }
  paint()
}

/**
 * Pushes the current view to both surfaces. Never advances detection: that is
 * `tick`'s job, so a gesture cannot inject a duplicate reading.
 */
function paint(): void {
  const view = tuner.view()
  if (surface === 'glasses') renderer?.render(view)
  else renderer?.renderStandby()
  phone?.setReading(view, surface)
}

// --- Settings persistence -----------------------------------------------

let persistTimer: ReturnType<typeof setTimeout> | null = null

/** Debounced: setLocalStorage shares the BLE link with rendering. */
function persistSettings(): void {
  phone?.setSettings(tuner.settings)
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(flushSettings, 600)
}

function flushSettings(): void {
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  void bridge?.setLocalStorage(SETTINGS_KEY, JSON.stringify(tuner.settings))
}

/** Browser localStorage is unreliable across restarts in this WebView. */
async function loadSettings(): Promise<void> {
  if (!bridge) return
  try {
    const raw = await bridge.getLocalStorage(SETTINGS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<TunerSettings>
      tuner.settings = {
        a4: clamp(parsed.a4 ?? DEFAULT_SETTINGS.a4, 415, 445),
        calibration: clamp(parsed.calibration ?? DEFAULT_SETTINGS.calibration, -50, 50),
      }
    }
  } catch {
    tuner.settings = { ...DEFAULT_SETTINGS }
  }
  phone?.setSettings(tuner.settings)
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

// --- Development harness -------------------------------------------------

const DEMO_STATES: Array<{ label: string; index: number; cents: number }> = [
  { label: 'E2 flat', index: 0, cents: -18 },
  { label: 'E2 settling', index: 0, cents: 0.4 },
  { label: 'A2 fine', index: 1, cents: 4.2 },
  { label: 'D3 near', index: 2, cents: -3.1 },
  { label: 'G3 in tune', index: 3, cents: 0 },
  { label: 'B3 far sharp', index: 4, cents: 31 },
  { label: 'E4 rail', index: 5, cents: 48 },
]

let demoIndex = 0
let demoTimer: ReturnType<typeof setInterval> | null = null

function inDemoMode(): boolean {
  return import.meta.env.DEV && new URLSearchParams(location.search).has('demo')
}

/**
 * Injects a synthetic plucked string, so the display can be driven without an
 * instrument. Vite strips this from a production build.
 */
function installDevHarness(): void {
  if (!import.meta.env.DEV) return

  // Phase carries across calls; restarting at zero each chunk put a discontinuity
  // inside the analysis window and the harness read the wrong pitch.
  let phase = 0

  const play = (freq: number, seconds = 0.12) => {
    const sr = 16000
    const n = Math.round(sr * seconds)
    const bytes = new Uint8Array(n * 2)
    const partials = [0.3, 0.85, 0.55, 0.4, 0.28, 0.18, 0.12]
    const step = (2 * Math.PI * freq) / sr
    for (let i = 0; i < n; i++) {
      let s = 0
      for (let k = 0; k < partials.length; k++) {
        s += partials[k] * Math.sin(phase * (k + 1))
      }
      phase += step
      if (phase > 2 * Math.PI * 1e6) phase -= 2 * Math.PI * 1e6
      const q = Math.round(Math.max(-1, Math.min(1, 0.25 * s)) * 32767)
      bytes[i * 2] = q & 0xff
      bytes[i * 2 + 1] = (q >> 8) & 0xff
    }
    tuner.ingest(bytes)
  }

  const win = window as unknown as Record<string, unknown>
  win.__tuneful = {
    play,
    string(index: number, cents = 0) {
      const s = STANDARD_TUNING[index]
      play(midiToFreq(s.midi, tuner.settings.a4) * Math.pow(2, cents / 1200))
    },
  }
  console.log('TUNEFUL_DEV_READY')

  if (inDemoMode()) {
    const pump = () => {
      const st = DEMO_STATES[demoIndex]
      ;(win.__tuneful as { string(i: number, c: number): void }).string(st.index, st.cents)
    }
    pump()
    demoTimer = setInterval(pump, 120)
    console.log(`TUNEFUL_DEMO ${demoIndex} ${DEMO_STATES[demoIndex].label}`)
  }
}

function demoStep(direction: 1 | -1): void {
  demoIndex = (demoIndex + direction + DEMO_STATES.length) % DEMO_STATES.length
  tuner.reset()
  tuner.clearSession()
  console.log(`TUNEFUL_DEMO ${demoIndex} ${DEMO_STATES[demoIndex].label}`)
}

// --- Teardown ------------------------------------------------------------

let cleanedUp = false

function cleanup(): void {
  if (cleanedUp) return
  cleanedUp = true

  if (frameTimer) clearInterval(frameTimer)
  frameTimer = null
  if (demoTimer) clearInterval(demoTimer)
  demoTimer = null
  flushSettings()

  // Otherwise the mic keeps draining the glasses after exit.
  void bridge?.audioControl(false)
  for (const off of teardown.splice(0)) {
    try {
      off()
    } catch {
      // Nothing useful to do while tearing down.
    }
  }
}

void main().catch((err) => {
  phone?.setStatus({
    connection: 'error',
    message: `Tuneful could not start: ${err instanceof Error ? err.message : String(err)}`,
  })
})
