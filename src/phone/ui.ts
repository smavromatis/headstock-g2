/**
 * Phone surface. With the glasses mic it is a settings and status panel; with
 * the phone mic the phone is the tuner and the reading takes the upper screen.
 */

import { AudioInputSource } from '@evenrealities/even_hub_sdk'
import { STANDARD_TUNING } from '../tuning/notes'
import { IN_TUNE_CENTS } from '../config'
import type { TunerSettings, TunerView, Surface } from '../tuner'
import './styles.css'

export interface PhoneUiHandlers {
  onA4Change(a4: number): void
  onMicSourceChange(source: AudioInputSource): void
  onResetSession(): void
}

export interface PhoneUi {
  setReading(view: TunerView, surface: Surface): void
  setSettings(settings: TunerSettings): void
  setStatus(status: { connection: 'ok' | 'degraded' | 'error'; message: string }): void
  setDevice(device: { battery: number | null; connected: boolean }): void
  setMic(mic: { active: boolean; source: AudioInputSource }): void
  setSurface(surface: Surface): void
}

const A4_MIN = 415
const A4_MAX = 445

export function mountPhoneUi(handlers: PhoneUiHandlers): PhoneUi {
  const root = document.getElementById('app')
  if (!root) throw new Error('#app container is missing from the page')

  root.innerHTML = `
    <div class="top">
      <div class="mark">Tuneful</div>
      <div class="state" id="state">connecting</div>
    </div>

    <div class="reading">
      <div class="note" id="note" data-idle="true">&mdash;</div>
      <div class="deviation">
        <div class="cents" id="cents" data-idle="true">&nbsp;</div>
        <div class="action" id="action"></div>
      </div>
    </div>

    <div class="meter" id="meter">
      <div class="needle" id="needle" data-idle="true" style="left:50%"></div>
    </div>
    <div class="scale"><span id="scale-lo">&minus;50</span><span>0</span><span id="scale-hi">+50</span></div>

    <div class="session">
      <div class="pips" id="pips"></div>
      <button type="button" id="reset">Reset</button>
    </div>

    <div class="notice" id="notice"></div>

    <div class="rows">
      <div class="row">
        <span class="row-label">Reference</span>
        <div class="row-control">
          <button class="step" type="button" id="a4-down" aria-label="Lower reference pitch">&minus;</button>
          <span class="val" id="a4">440</span>
          <button class="step" type="button" id="a4-up" aria-label="Raise reference pitch">+</button>
        </div>
      </div>
      <div class="row">
        <span class="row-label">Listen with</span>
        <div class="choice" id="mic">
          <button type="button" data-source="glasses" aria-pressed="true">Glasses</button>
          <button type="button" data-source="phone" aria-pressed="false">Phone</button>
        </div>
      </div>
      <div class="row">
        <span class="row-label">Glasses</span>
        <span class="val" id="device" style="font-size:15px">&mdash;</span>
      </div>
    </div>

    <div class="legend" id="legend">
      <b>Tap</b><span>Lock to the current string</span>
      <b>Swipe</b><span>Choose the string</span>
      <b>Double tap</b><span>Exit</span>
    </div>
  `

  const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

  const noteEl = el('note')
  const centsEl = el('cents')
  const actionEl = el('action')
  const needleEl = el('needle')
  const meterEl = el('meter')
  const stateEl = el('state')
  const noticeEl = el('notice')
  const legendEl = el('legend')
  const scaleLo = el('scale-lo')
  const scaleHi = el('scale-hi')

  let settings: TunerSettings = { a4: 440 }
  let micActive = false
  let micSource: AudioInputSource = AudioInputSource.Glasses
  let currentSurface: Surface = 'glasses'
  let lastRange = 50

  // --- meter ticks (drawn once) -----------------------------------------
  for (const pct of [0, 25, 50, 75, 100]) {
    const t = document.createElement('div')
    t.className = pct === 50 ? 'tick centre' : 'tick'
    t.style.left = `${pct}%`
    meterEl.appendChild(t)
  }

  // --- session pips ------------------------------------------------------
  const pipsEl = el('pips')
  const pips = STANDARD_TUNING.map((s) => {
    const d = document.createElement('div')
    d.className = 'pip'
    d.innerHTML = `<i></i>${s.label}`
    pipsEl.appendChild(d)
    return d
  })

  el('reset').addEventListener('click', () => handlers.onResetSession())

  // --- controls ----------------------------------------------------------
  const applyA4 = (next: number) => {
    settings = { a4: clamp(Math.round(next), A4_MIN, A4_MAX) }
    paintSettings()
    handlers.onA4Change(settings.a4)
  }
  el('a4-down').addEventListener('click', () => applyA4(settings.a4 - 1))
  el('a4-up').addEventListener('click', () => applyA4(settings.a4 + 1))

  const micButtons = Array.from(el('mic').querySelectorAll<HTMLButtonElement>('button'))
  for (const b of micButtons) {
    b.addEventListener('click', () => {
      const source =
        b.dataset.source === 'phone' ? AudioInputSource.Phone : AudioInputSource.Glasses
      for (const other of micButtons) other.setAttribute('aria-pressed', String(other === b))
      handlers.onMicSourceChange(source)
    })
  }

  function paintSettings(): void {
    el('a4').textContent = String(settings.a4)
  }

  /** The gesture legend is meaningless when the phone is the tuner. */
  function paintSurface(): void {
    legendEl.style.display = currentSurface === 'phone' ? 'none' : ''
  }

  function paintState(): void {
    if (!micActive) {
      stateEl.textContent = 'not listening'
      stateEl.dataset.live = 'false'
      return
    }
    // Names the microphone: that is what you point the guitar at.
    stateEl.textContent =
      micSource === AudioInputSource.Phone ? 'listening · phone' : 'listening · glasses'
    stateEl.dataset.live = 'true'
  }

  paintSettings()

  return {
    setReading(view, surface) {
      if (surface !== currentSurface) {
        currentSurface = surface
        paintSurface()
      }

      // Labels must follow the auto-zoom, or the needle changes meaning.
      if (view.meterRange !== lastRange) {
        lastRange = view.meterRange
        scaleLo.textContent = `−${view.meterRange}`
        scaleHi.textContent = `+${view.meterRange}`
      }

      for (let i = 0; i < pips.length; i++) {
        pips[i].dataset.done = String(view.tuned[i] === true)
        pips[i].dataset.active = String(i === view.stringIndex && !view.offScale)
      }

      const hasReading =
        view.stringIndex !== null && view.cents !== null && !view.offScale

      if (!hasReading) {
        noteEl.dataset.idle = 'true'
        noteEl.innerHTML = view.offScale ? '?' : '&mdash;'
        centsEl.dataset.idle = 'true'
        centsEl.dataset.tuned = 'false'
        centsEl.innerHTML = '&nbsp;'
        actionEl.dataset.tuned = 'false'
        actionEl.textContent =
          view.phase === 'idle'
            ? 'paused'
            : view.offScale
              ? 'no string match'
              : micActive
                ? 'play a string'
                : ''
        needleEl.dataset.idle = 'true'
        needleEl.dataset.tuned = 'false'
        paintState()
        return
      }

      const s = STANDARD_TUNING[view.stringIndex!]
      const cents = view.cents!

      noteEl.dataset.idle = 'false'
      noteEl.textContent = s.label

      centsEl.dataset.idle = 'false'
      centsEl.dataset.tuned = String(view.confirmed)
      const abs = Math.abs(cents)
      const magnitude = abs >= 10 ? abs.toFixed(0) : abs.toFixed(1)
      centsEl.textContent = `${cents > 0 ? '+' : '−'}${magnitude}`

      actionEl.dataset.tuned = String(view.confirmed)
      actionEl.textContent = view.confirmed
        ? 'in tune'
        : abs <= IN_TUNE_CENTS
          ? 'hold'
          : cents > 0
            ? 'loosen'
            : 'tighten'

      const pct = clamp(50 + (cents / view.meterRange) * 50, 0, 100)
      needleEl.style.left = `${pct}%`
      needleEl.dataset.idle = 'false'
      needleEl.dataset.tuned = String(view.confirmed)

      paintState()
    },

    setSettings(next) {
      settings = { ...next }
      paintSettings()
    },

    setStatus(status) {
      noticeEl.textContent = status.connection === 'ok' ? '' : status.message
      if (status.connection === 'error') stateEl.dataset.live = 'error'
    },

    setDevice(device) {
      el('device').textContent = device.connected
        ? device.battery === null
          ? 'connected'
          : `connected · ${device.battery}%`
        : 'not connected'
    },

    setMic(mic) {
      micActive = mic.active
      micSource = mic.source
      paintState()
    },

    setSurface(surface) {
      currentSurface = surface
      paintSurface()
      paintState()
    },
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}
