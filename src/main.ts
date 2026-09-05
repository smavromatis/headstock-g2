/**
 * Headstock - a classical guitar tuner for Even Realities G2.
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
import { GlassesRenderer, tuningIdForMenuItem } from './glasses/display'
import { BridgeQueue } from './bridge-queue'
import { MIC_CONTROL_TIMEOUT_MS } from './config'
import { resetPcmFormat } from './audio/stream'
import { mountPhoneUi, type PhoneUi } from './phone/ui'
import { midiToFreq } from './tuning/notes'

/** Analysis cadence. 10 fps is past the point where the needle feels live. */
const FRAME_MS = 100

/**
 * Set once a contextual-menu click arrives, which proves the firmware opens
 * the menu. Until then long press cycles tunings instead.
 */
let menuConfirmed = false

/**
 * Input is ignored until this time.
 *
 * The host emits a bare `sysEvent` with only `eventSource` set as the page
 * comes up. Protobuf omits zero values, so that is byte-identical to a real
 * click and cannot be told apart by shape; without this guard it silently
 * locked the tuner at startup.
 */
let inputArmedAt = Number.POSITIVE_INFINITY
const INPUT_ARM_MS = 750

/**
 * True while the OS exit dialog is on screen.
 *
 * The dialog is drawn by the host over our page, but our frame loop does not
 * stop: at 10 fps it kept repainting the rows underneath it, and the bottom
 * row sits at y=250 on a 288px canvas, right where the dialog's border is.
 * Rendering pauses until the dialog is gone.
 */
let exitDialogOpen = false
let exitDialogOpenedAt = 0

/**
 * True between FOREGROUND_EXIT and FOREGROUND_ENTER.
 *
 * Same reason as the exit dialog: something else is on the glasses, and
 * repainting underneath it would draw over whatever the user is looking at.
 */
let backgrounded = false

/**
 * Assumed true until the host says otherwise: onDeviceStatusChanged never
 * fires in the simulator, and defaulting to false would mean never rendering.
 */
let glassesConnected = true

/** Safety net, in case cancelling the dialog reports nothing at all. */
const EXIT_DIALOG_TIMEOUT_MS = 20000
const SETTINGS_KEY = 'headstock.settings.v1'

const tuner = new Tuner()
const queue = new BridgeQueue()
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
    onCalibrate: () => {
      const result = tuner.calibrate()
      phone?.setCalibration(tuner.offset, result)
      if (result === 'ok') persistSettings()
      paint()
    },
    onClearCalibration: () => {
      tuner.clearCalibration()
      phone?.setCalibration(tuner.offset, 'ok')
      persistSettings()
      paint()
    },
    onMicSourceChange: (source) => {
      micSource = source
      tuner.setSource(source === AudioInputSource.Phone ? 'phone' : 'glasses')
      phone?.setCalibration(tuner.offset, 'ok')
      // The phone mic makes the phone the tuner; the glasses stand down.
      surface = source === AudioInputSource.Phone ? 'phone' : 'glasses'
      void restartMic()
    },
    onResetSession: () => {
      tuner.clearSession()
      paint()
    },
    onTuningChange: (id) => {
      tuner.setTuning(id)
      persistSettings()
      redrawGlasses()
    },
    onCapoChange: (semitones) => {
      tuner.setCapo(semitones)
      persistSettings()
      redrawGlasses()
    },
  })

  bridge = await waitForEvenAppBridge()

  await loadSettings()

  glassesAvailable = await setUpGlasses()
  if (!glassesAvailable) {
    // No glasses page, so hand the job to the phone rather than stopping.
    surface = 'phone'
    micSource = AudioInputSource.Phone
    phone?.setStatus({
      connection: 'degraded',
      message: 'Glasses unavailable. Tuning on the phone.',
    })
  }

  phone?.setSurface(surface)

  teardown.push(bridge.onEvenHubEvent(onHubEvent))
  teardown.push(
    bridge.onDeviceStatusChanged((status) => {
      phone?.setDevice({ battery: status.batteryLevel ?? null })

      // Without this, a disconnect leaves every render to time out at 2.5s
      // each: the app looks frozen and keeps draining the phone for nothing.
      const connected = status.isConnected()
      if (connected === glassesConnected) return
      glassesConnected = connected

      if (connected) {
        renderer?.invalidate()
        phone?.setStatus({ connection: 'ok', message: '' })
        paint()
      } else {
        phone?.setStatus({
          connection: 'degraded',
          message: 'Glasses disconnected. Reconnect them, or switch to the phone microphone.',
        })
      }
    }),
  )

  await startMic()

  inputArmedAt = Date.now() + INPUT_ARM_MS
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
    console.error('HEADSTOCK_PAGE_INVALID', JSON.stringify(validation), detail)
    return false
  }

  // Startup calls are issued directly: the frame loop has not started, so
  // there is nothing for them to race with.
  let result: StartUpPageCreateResult
  try {
    result = await bridge.createStartUpPageContainer(page)
  } catch {
    return false
  }

  if (result !== StartUpPageCreateResult.success) {
    console.warn('HEADSTOCK_STARTUP_RESULT', result)
    // `invalid` here usually means the host still holds a page from a previous
    // run, not a bad layout - the SDK already validated it. Happens on every
    // hot reload. Rebuild is the way back in.
    const recovered =
      result === StartUpPageCreateResult.invalid &&
      (await bridge.rebuildPageContainer(GlassesRenderer.rebuildPage(view)).catch(() => false))
    if (!recovered) return false
    console.log('HEADSTOCK_RECOVERED_VIA_REBUILD')
  }

  renderer = new GlassesRenderer(bridge, queue)
  phone?.setStatus({ connection: 'ok', message: 'Running on your glasses.' })
  return true
}

// --- Audio ---------------------------------------------------------------

async function startMic(): Promise<void> {
  if (!bridge) return
  try {
    const ok = await queue.run(
      () => bridge!.audioControl(true, micSource),
      MIC_CONTROL_TIMEOUT_MS,
    )
    if (!ok) throw new Error('audioControl did not start')
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
  await queue.run(() => bridge!.audioControl(false), MIC_CONTROL_TIMEOUT_MS)
  // The two microphone paths need not agree on payload format, nor on rate.
  resetPcmFormat()
  tuner.resetRateMeter(Date.now())
  tuner.reset()
  await startMic()
}

/** Releases the mic after a long silence. */
async function goIdle(): Promise<void> {
  if (!bridge || tuner.currentPhase === 'idle') return
  tuner.setPhase('idle')
  // Progress is kept: a pause is not a reason to discard the strings already
  // tuned.
  tuner.reset()
  await queue.run(() => bridge!.audioControl(false), MIC_CONTROL_TIMEOUT_MS)
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
    // Audio arriving is proof the microphone is live, whatever audioControl
    // reported. Its result cannot be trusted alone: the call can time out
    // behind a permission dialog and still succeed, which left a permanent
    // "microphone did not start" on screen while the mic was running.
    if (tuner.currentPhase === 'micError') {
      tuner.setPhase('listening')
      tuner.markActive(Date.now())
      phone?.setMic({ active: true, source: micSource })
      phone?.setStatus({ connection: 'ok', message: '' })
    }

    // The host still pushes live mic audio during a demo; mixing it with the
    // synthetic tone interleaves silence and makes the reading drift.
    if (!demoTimer) tuner.ingest(event.audioEvent.audioPcm)
    return
  }

  // Scroll gestures arrive as textEvent; clicks do not, they come through
  // sysEvent. This is the most common event-handling bug on this platform.
  if (event.textEvent) {
    // A swipe means the exit dialog is gone and the user stayed.
    closeExitDialog()
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

  // The OS contextual menu reports the item the user picked.
  if (event.menuItemClickEvent) {
    const id = tuningIdForMenuItem(event.menuItemClickEvent.itemID)
    if (id) {
      menuConfirmed = true
      tuner.setTuning(id)
      persistSettings()
      redrawGlasses()
    }
    return
  }

  if (event.sysEvent) {
    // Protobuf omits zero values, so a single click arrives as undefined.
    const type = event.sysEvent.eventType ?? 0

    // Any input means the dialog is gone and the user stayed in the app.
    if (exitDialogOpen && type !== OsEventTypeList.SYSTEM_EXIT_EVENT) closeExitDialog()

    // Lifecycle events are always acted on; user input waits for the guard.
    const isInput =
      type === OsEventTypeList.CLICK_EVENT ||
      type === OsEventTypeList.DOUBLE_CLICK_EVENT ||
      type === OsEventTypeList.LONG_PRESS_EVENT ||
      type === OsEventTypeList.LONG_PRESS_RELEASE_EVENT
    if (isInput && Date.now() < inputArmedAt) return

    switch (type) {
      case OsEventTypeList.CLICK_EVENT:
        if (tuner.currentPhase === 'idle') void resumeFromIdle()
        else tuner.toggleLock()
        paint()
        break
      case OsEventTypeList.LONG_PRESS_RELEASE_EVENT:
        // Fallback for firmware that does not open the contextual menu. Once a
        // menu click has been seen the menu is known to work, so long press
        // stops acting and leaves the gesture to the OS.
        if (!menuConfirmed) {
          tuner.cycleTuning()
          persistSettings()
          redrawGlasses()
        }
        break
      case OsEventTypeList.DOUBLE_CLICK_EVENT:
        // Nothing is torn down here: the user can still cancel, and cleaning
        // up now would leave a live app that has stopped listening.
        exitDialogOpen = true
        exitDialogOpenedAt = Date.now()
        void queue.run(() => bridge!.shutDownPageContainer(1))
        break
      case OsEventTypeList.FOREGROUND_ENTER_EVENT:
        // The host may have migrated us through a headless WebView.
        backgrounded = false
        closeExitDialog()
        tuner.reset()
        renderer?.invalidate()
        paint()
        break
      case OsEventTypeList.FOREGROUND_EXIT_EVENT:
        backgrounded = true
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

let lastRateShown = 0

function tick(): void {
  const now = Date.now()

  if (now - lastRateShown > 2000) {
    lastRateShown = now
    phone?.setSampleRate(tuner.measuredSampleRate(now))
  }

  if (exitDialogOpen && now - exitDialogOpenedAt > EXIT_DIALOG_TIMEOUT_MS) {
    closeExitDialog()
  }

  // Idle means the microphone is closed, so there is nothing new to analyse
  // and nothing on screen that changes. Running detection anyway burned a full
  // YIN pass every 100ms over a buffer that cannot change.
  if (tuner.currentPhase === 'idle') return

  tuner.advance(now)

  if (tuner.isIdle(now)) {
    void goIdle()
    return
  }
  paint()
}

/**
 * Pushes the current view to both surfaces. Never advances detection: that is
 * `tick`'s job, so a gesture cannot inject a duplicate reading.
 */
/**
 * Redraws after a change the in-place updates cannot express, such as a new
 * tuning, and resends the menu.
 */
function redrawGlasses(): void {
  phone?.setSettings(tuner.settings)
  if (!glassesAvailable || surface !== 'glasses') {
    paint()
    return
  }
  void renderer?.rebuild(tuner.view())
}

function paint(): void {
  const view = tuner.view()
  // The host owns the display while its exit dialog is up, and so does
  // whatever replaced us when we were backgrounded. Drawing underneath either
  // one paints over what the user is actually looking at.
  if (!exitDialogOpen && !backgrounded && glassesConnected) {
    if (surface === 'glasses') renderer?.render(view)
    else renderer?.renderStandby()
  }
  phone?.setReading(view, surface)
}

/**
 * The dialog was dismissed without exiting. The host drew over our containers,
 * so everything is resent rather than diffed against what we last sent.
 */
function closeExitDialog(): void {
  if (!exitDialogOpen) return
  exitDialogOpen = false
  renderer?.invalidate()
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
  const payload = JSON.stringify(tuner.settings)
  // Storage shares the BLE link with rendering, so it queues behind it.
  void queue.run(() => bridge?.setLocalStorage(SETTINGS_KEY, payload) ?? Promise.resolve(false))
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
        tuningId: parsed.tuningId ?? DEFAULT_SETTINGS.tuningId,
        capo: clamp(parsed.capo ?? DEFAULT_SETTINGS.capo, 0, 12),
        offsets: parsed.offsets ?? {},
      }
      tuner.setTuning(tuner.settings.tuningId)
      tuner.setCapo(tuner.settings.capo)
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

  // Lets a test select a tuning, since the simulator cannot press the phone
  // buttons or send a long press.
  const wanted = new URLSearchParams(location.search).get('tuning')
  if (wanted) {
    tuner.setTuning(wanted)
    persistSettings()
  }

  const win = window as unknown as Record<string, unknown>
  win.__headstock = {
    play,
    string(index: number, cents = 0) {
      const s = tuner.currentTuning.strings[index]
      play(midiToFreq(s.midi, tuner.settings.a4) * Math.pow(2, cents / 1200))
    },
  }
  console.log('HEADSTOCK_DEV_READY')

  if (inDemoMode()) {
    const pump = () => {
      const st = DEMO_STATES[demoIndex]
      ;(win.__headstock as { string(i: number, c: number): void }).string(st.index, st.cents)
    }
    pump()
    demoTimer = setInterval(pump, 120)
    console.log(`HEADSTOCK_DEMO ${demoIndex} ${DEMO_STATES[demoIndex].label}`)
  }
}

function demoStep(direction: 1 | -1): void {
  demoIndex = (demoIndex + direction + DEMO_STATES.length) % DEMO_STATES.length
  tuner.reset()
  tuner.clearSession()
  console.log(`HEADSTOCK_DEMO ${demoIndex} ${DEMO_STATES[demoIndex].label}`)
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
  void queue.run(() => bridge!.audioControl(false))
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
    message: `Headstock could not start: ${err instanceof Error ? err.message : String(err)}`,
  })
})
