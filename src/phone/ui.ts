/**
 * Phone surface. With the glasses mic it is a settings and status panel; with
 * the phone mic the phone is the tuner and the reading takes the upper screen.
 */

import { AudioInputSource } from '@evenrealities/even_hub_sdk'
import { TUNINGS } from '../tuning/notes'
import { IN_TUNE_CENTS, METER_HALF_PX } from '../config'
import { centsToOffsetPx } from '../glasses/display'
import type { TunerSettings, TunerView, Surface } from '../tuner'
import './styles.css'

export interface PhoneUiHandlers {
  onA4Change(a4: number): void
  onMicSourceChange(source: AudioInputSource): void
  onResetSession(): void
  onTuningChange(id: string): void
  onCapoChange(semitones: number): void
}

export interface PhoneUi {
  setReading(view: TunerView, surface: Surface): void
  setSettings(settings: TunerSettings): void
  setStatus(status: { connection: 'ok' | 'degraded' | 'error'; message: string }): void
  setDevice(device: { battery: number | null }): void
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
      <div class="mark">Headstock</div>
      <div class="state" id="state">connecting</div>
    </div>

    <div class="reading">
      <div class="note" id="note" data-idle="true">--</div>
      <div class="deviation">
        <div class="cents" id="cents" data-idle="true">&nbsp;</div>
        <div class="action" id="action"></div>
      </div>
    </div>

    <div class="meter" id="meter">
      <div class="needle" id="needle" data-idle="true" style="left:50%"></div>
    </div>
    <div class="scale"><span>&minus;50</span><span>0</span><span>+50</span></div>

    <div class="session">
      <div class="pips" id="pips"></div>
      <button type="button" id="reset">Reset</button>
    </div>

    <div class="notice" id="notice"></div>

    <div class="rows">
      <div class="row row-stack">
        <span class="row-label">Tuning</span>
        <div class="presets" id="tunings"></div>
      </div>
      <div class="row">
        <span class="row-label">Capo</span>
        <div class="row-control">
          <button class="step" type="button" id="capo-down" aria-label="Lower capo">&minus;</button>
          <span class="val" id="capo">Off</span>
          <button class="step" type="button" id="capo-up" aria-label="Raise capo">+</button>
        </div>
      </div>
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
        <span class="row-label">Battery</span>
        <span class="val" id="battery" style="font-size:15px">--</span>
      </div>
    </div>

    <div class="legend" id="legend">
      <b>Tap</b><span>Lock to the current string, or resume when paused</span>
      <b>Swipe</b><span>Choose the string</span>
      <b>Long press</b><span>Change tuning</span>
      <b>Double tap</b><span>Exit to the glasses menu</span>
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

  let settings: TunerSettings = { a4: 440, tuningId: TUNINGS[0].id, capo: 0 }
  let micActive = false
  let micSource: AudioInputSource = AudioInputSource.Glasses
  let currentSurface: Surface = 'glasses'

  // --- meter ticks (drawn once) -----------------------------------------
  // Breakpoints of the expanded-centre curve, plus the in-tune band.
  for (const cents of [-50, -4.5, 4.5, 50]) {
    const t = document.createElement('div')
    t.className = 'tick'
    t.style.left = `${50 + (centsToOffsetPx(cents) / METER_HALF_PX) * 50}%`
    meterEl.appendChild(t)
  }
  const band = document.createElement('div')
  band.className = 'band'
  const bandHalf = (centsToOffsetPx(IN_TUNE_CENTS) / METER_HALF_PX) * 50
  band.style.left = `${50 - bandHalf}%`
  band.style.width = `${bandHalf * 2}%`
  meterEl.appendChild(band)

  // --- session pips ------------------------------------------------------
  const pipsEl = el('pips')
  let pips: HTMLElement[] = []

  /** Rebuilt when the sounding strings change, from a tuning or a capo. */
  let pipLabels = ''
  function buildPips(strings: ReadonlyArray<{ label: string }>): void {
    const key = strings.map((s) => s.label).join(' ')
    if (key === pipLabels) return
    pipLabels = key
    pipsEl.innerHTML = ''
    pips = strings.map((s) => {
      const d = document.createElement('div')
      d.className = 'pip'
      d.innerHTML = `<i></i>${s.label}`
      pipsEl.appendChild(d)
      return d
    })
  }

  const tuningsEl = el('tunings')
  for (const t of TUNINGS) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'preset'
    b.dataset.tuning = t.id
    b.textContent = t.name
    b.addEventListener('click', () => handlers.onTuningChange(t.id))
    tuningsEl.appendChild(b)
  }

  el('reset').addEventListener('click', () => handlers.onResetSession())

  // --- controls ----------------------------------------------------------
  const applyA4 = (next: number) => {
    settings = { ...settings, a4: clamp(Math.round(next), A4_MIN, A4_MAX) }
    paintSettings()
    handlers.onA4Change(settings.a4)
  }
  el('a4-down').addEventListener('click', () => applyA4(settings.a4 - 1))
  el('a4-up').addEventListener('click', () => applyA4(settings.a4 + 1))

  const applyCapo = (next: number) => {
    settings = { ...settings, capo: clamp(Math.round(next), 0, 12) }
    paintSettings()
    handlers.onCapoChange(settings.capo)
  }
  el('capo-down').addEventListener('click', () => applyCapo(settings.capo - 1))
  el('capo-up').addEventListener('click', () => applyCapo(settings.capo + 1))

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
    el('capo').textContent = settings.capo === 0 ? 'Off' : `Fret ${settings.capo}`
    for (const b of tuningsEl.querySelectorAll<HTMLButtonElement>('.preset')) {
      b.setAttribute('aria-pressed', String(b.dataset.tuning === settings.tuningId))
    }
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

  buildPips(TUNINGS[0].strings)
  paintSettings()

  return {
    setReading(view, surface) {
      if (surface !== currentSurface) {
        currentSurface = surface
        paintSurface()
      }

      // Labels must follow the auto-zoom, or the needle changes meaning.
      buildPips(view.tuning.strings)
      for (let i = 0; i < pips.length; i++) {
        pips[i].dataset.done = String(view.tuned[i] === true)
        pips[i].dataset.active = String(i === view.stringIndex && !view.offScale)
      }

      const hasReading =
        view.stringIndex !== null && view.cents !== null && !view.offScale

      if (!hasReading) {
        noteEl.dataset.idle = 'true'
        noteEl.textContent = view.offScale ? '?' : '--'
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

      const s = view.tuning.strings[view.stringIndex!]
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

      // Same expanded-centre curve as the glasses, so both agree.
      const pct = clamp(50 + (centsToOffsetPx(cents) / METER_HALF_PX) * 50, 0, 100)
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
      // Connection state is already implied by the masthead, which cannot read
      // "listening · glasses" through glasses that are not connected.
      el('battery').textContent = device.battery === null ? '--' : `${device.battery}%`
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
