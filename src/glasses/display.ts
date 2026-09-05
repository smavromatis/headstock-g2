/**
 * Glasses display.
 *
 * The layout is built once and never rebuilt while tuning; frames go out as
 * textContainerUpgrade, which updates in place without flicker. A rebuild per
 * frame would flicker on hardware and cost far more over BLE.
 *
 * The canvas is 576x288 with a fixed 27px line height and one font size, so
 * emphasis comes from the block font and textColor (0-4 brightness).
 */

import {
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import { renderBlockText, blockTextWidth } from './blockfont'
import { STANDARD_TUNING } from '../tuning/notes'
import { NEAR_CENTS } from '../config'
import { textWidth } from './metrics'
import type { TunerView } from '../tuner'

// --- Geometry ------------------------------------------------------------

const SCREEN_W = 576
const MARGIN_X = 18
const ROW_W = SCREEN_W - MARGIN_X * 2 // 540
const CELL = 20 // px per full-width glyph
const SCALE_CELLS = ROW_W / CELL // 27
const NEEDLE_DOTS = ROW_W / 5 // 108 dots of 5px each

/** Half-span of the meter in pixels; the cents it maps to depends on scale. */
const METER_HALF_PX = 240

/**
 * Two characters, letter plus octave: standard tuning has no accidentals.
 * Fixed width matters because changing geometry needs a rebuild, which flickers.
 */
const NOTE_W = blockTextWidth('E2') // 140
const NOTE_X = Math.round((SCREEN_W - NOTE_W) / 2) // 218

export const CONTAINERS = {
  header: { id: 1, name: 'hdr', x: MARGIN_X, y: 0, w: ROW_W, h: 27, color: 2 },
  // Pinned to the block's exact 220px width and centred, so the note never
  // needs leading spaces to sit in the middle of the screen.
  note: { id: 2, name: 'note', x: NOTE_X, y: 28, w: NOTE_W, h: 136, color: 4 },
  scale: { id: 3, name: 'scale', x: MARGIN_X, y: 166, w: ROW_W, h: 27, color: 1 },
  needle: { id: 4, name: 'needle', x: MARGIN_X, y: 193, w: ROW_W, h: 27, color: 4 },
  readout: { id: 5, name: 'readout', x: MARGIN_X, y: 221, w: ROW_W, h: 27, color: 3 },
  strings: { id: 6, name: 'strings', x: MARGIN_X, y: 250, w: ROW_W, h: 27, color: 2 },
} as const

// --- Row builders --------------------------------------------------------

/**
 * The scale. Ends mark flat/sharp, the centre is the target, and the ticks sit
 * at half range, where the needle lands at that value.
 *
 * Coarse and fine use different glyphs because the needle occupies the same
 * pixels on both scales; the scale has to say which is in force.
 */
export function buildScaleRow(fine: boolean): string {
  const track = fine ? '═' : '─'
  const centre = fine ? '╪' : '┼'
  const cells: string[] = []
  for (let i = 0; i < SCALE_CELLS; i++) {
    if (i === 0) cells.push('♭')
    else if (i === SCALE_CELLS - 1) cells.push('♯')
    else if (i === 13) cells.push(centre)
    else if (i === 7 || i === 19) cells.push('┬')
    else cells.push(track)
  }
  return cells.join('')
}

/**
 * The moving needle: 108 dots of 5px. The marker is 20px, exactly four dots,
 * so swapping keeps the row's width identical at every position. Without that
 * the meter shivers as the needle moves, since the font is proportional.
 */
export function buildNeedleRow(view: TunerView): string {
  if (view.cents === null || view.stringIndex === null) {
    return '·'.repeat(NEEDLE_DOTS)
  }
  const range = view.meterRange
  const clamped = Math.max(-range, Math.min(range, view.cents))
  const centreX = ROW_W / 2 + (clamped / range) * METER_HALF_PX
  const leftX = Math.max(0, Math.min(ROW_W - CELL, centreX - CELL / 2))

  const dotIndex = Math.max(0, Math.min(NEEDLE_DOTS - 4, Math.round(leftX / 5)))

  // Arrow while live, diamond inside the band, block once it has held.
  // Without this the settle logic is invisible.
  const marker = view.confirmed ? '█' : view.inTolerance ? '◆' : '▲'
  return '·'.repeat(dotIndex) + marker + '·'.repeat(NEEDLE_DOTS - dotIndex - 4)
}

export function buildNoteBlock(view: TunerView): string {
  if (view.stringIndex === null || view.offScale) {
    return renderBlockText('--')
  }
  // offScale is never set when locked, so a locked string always shows here.
  const s = STANDARD_TUNING[view.stringIndex]
  return renderBlockText(`${s.letter}${s.octave}`)
}

export function buildHeaderRow(view: TunerView): string {
  // Session progress shares the left slot with the mode.
  const done = view.tuned.filter(Boolean).length
  const mode = view.locked ? 'LOCKED' : 'AUTO'
  const left = `${mode}   ${done}/6`
  const right = `A4 ${view.a4.toFixed(0)}`
  const state =
    view.phase === 'micError' ? 'NO MIC' : view.phase === 'idle' ? 'IDLE' :
    view.phase === 'reading' ? '●' : '○'
  return padBetween(left, `${right}   ${state}`, ROW_W)
}

export function buildReadoutRow(view: TunerView): string {
  if (view.phase === 'micError') return centreish('MICROPHONE UNAVAILABLE', ROW_W)
  if (view.phase === 'idle') return centreish('TAP TO RESUME', ROW_W)
  if (view.cents === null || view.stringIndex === null) {
    return centreish('PLAY A STRING', ROW_W)
  }
  if (view.offScale) return centreish('NO STRING MATCH', ROW_W)

  const c = view.cents
  const abs = Math.abs(c)

  // Confirmed means held inside the band, not merely passed through.
  if (view.confirmed) return centreish('IN TUNE', ROW_W)

  const dir = c > 0 ? 'LOOSEN' : 'TIGHTEN'
  const sign = c > 0 ? '+' : '-'
  // One decimal below 10 cents; above that the digit changes nothing.
  const magnitude = abs >= 10 ? abs.toFixed(0) : abs.toFixed(1)
  // No unit: the cent sign is a currency glyph.
  const left = view.inTolerance ? `HOLD  ${sign}${magnitude}` : `${dir}  ${sign}${magnitude}`
  const hz = view.freq !== null ? `${view.freq.toFixed(1)} Hz` : ''
  return padBetween(left, hz, ROW_W)
}

/** Active string bracketed; brightness is per container, not per run. */
export function buildStringsRow(view: TunerView): string {
  const parts = STANDARD_TUNING.map((s, i) => {
    const active = i === view.stringIndex && !view.offScale
    const mark = view.tuned[i] ? '●' : ' '
    return active ? `${mark}[${s.label}]` : `${mark} ${s.label} `
  })
  return centreish(parts.join(' '), ROW_W)
}

// --- Width-aware text helpers -------------------------------------------

/**
 * Pads `left` and `right` apart to fill `widthPx`.
 *
 * Uses measured widths rather than character counts because the firmware font
 * is proportional - digits alone range from 8px ("1") to 13px ("4").
 */
function padBetween(left: string, right: string, widthPx: number): string {
  const gap = widthPx - textWidth(left) - textWidth(right)
  // Floor, never round: one space of overshoot pushes the right-hand text past
  // the container edge, where it wraps to an invisible second line.
  let spaces = Math.max(1, Math.floor(gap / SPACE_PX))
  let line = left + ' '.repeat(spaces) + right

  // Measuring the halves separately misses the kerning at the join, which was
  // enough to lose the trailing "Hz". Measure what will actually be drawn.
  while (spaces > 1 && textWidth(line) > widthPx) {
    spaces--
    line = left + ' '.repeat(spaces) + right
  }
  return line
}

function centreish(text: string, widthPx: number): string {
  let pad = Math.max(0, Math.floor((widthPx - textWidth(text)) / 2 / SPACE_PX))
  let line = ' '.repeat(pad) + text
  while (pad > 0 && textWidth(line) > widthPx) {
    pad--
    line = ' '.repeat(pad) + text
  }
  return line
}

const SPACE_PX = 5

// --- Renderer ------------------------------------------------------------

/**
 * Sends changed rows, one bridge call at a time.
 *
 * Bridge calls must be serialised; concurrent renders over BLE can drop the
 * connection. A frame arriving mid-flight replaces the pending one rather than
 * queueing, so the needle stays current instead of trailing the peg.
 */
export class GlassesRenderer {
  private lastSent = new Map<string, string>()
  private lastColor = new Map<string, number>()
  private pending: TunerView | null = null
  private flushing = false

  private readonly bridge: EvenAppBridge

  constructor(bridge: EvenAppBridge) {
    this.bridge = bridge
  }

  /**
   * Page payload for createStartUpPageContainer.
   * Exactly one container sets isEventCapture; zero or several is undefined
   * behaviour. Which one does not matter: input is delivered page-wide.
   */
  static initialPage(view: TunerView): CreateStartUpPageContainer {
    const c = CONTAINERS
    return new CreateStartUpPageContainer({
      containerTotalNum: 6,
      textObject: [
        text(c.header, buildHeaderRow(view), c.header.color, 1),
        text(c.note, buildNoteBlock(view), c.note.color),
        text(c.scale, buildScaleRow(view.fine), c.scale.color),
        text(c.needle, buildNeedleRow(view), c.needle.color),
        text(c.readout, buildReadoutRow(view), c.readout.color),
        text(c.strings, buildStringsRow(view), c.strings.color),
      ],
    })
  }

  /**
   * The same layout as a rebuild payload. createStartUpPageContainer is
   * one-shot: a second call is rejected as invalid if the host still holds a
   * page for this app, so rebuild is the recovery path.
   */
  static rebuildPage(view: TunerView): RebuildPageContainer {
    const page = GlassesRenderer.initialPage(view)
    return new RebuildPageContainer({
      containerTotalNum: page.containerTotalNum,
      textObject: page.textObject,
    })
  }

  render(view: TunerView): void {
    this.pending = view
    void this.flush()
  }

  /**
   * Stands the glasses down while the phone is the tuner, rather than leaving
   * a stale reading that still looks live.
   */
  renderStandby(): void {
    this.pending = null
    void this.flushRows([
      [CONTAINERS.header, padBetween('TUNEFUL', 'PHONE', ROW_W), 2],
      [CONTAINERS.note, renderBlockText('--'), 2],
      [CONTAINERS.scale, buildScaleRow(false), 1],
      [CONTAINERS.needle, '·'.repeat(NEEDLE_DOTS), 1],
      [CONTAINERS.readout, centreish('TUNING ON PHONE', ROW_W), 3],
      [CONTAINERS.strings, centreish('', ROW_W), 1],
    ])
  }

  /** Forces the next render to resend every row (used after a foreground return). */
  invalidate(): void {
    this.lastSent.clear()
    this.lastColor.clear()
  }

  private async flush(): Promise<void> {
    if (this.flushing) return
    this.flushing = true
    try {
      while (this.pending) {
        const view = this.pending
        this.pending = null

        const near = view.cents !== null && Math.abs(view.cents) <= NEAR_CENTS

        const rows: RowSpec[] = [
          [CONTAINERS.header, buildHeaderRow(view), CONTAINERS.header.color],
          // Dim a stale reading, so a decayed string never looks live.
          [CONTAINERS.note, buildNoteBlock(view), view.phase === 'reading' ? 4 : 2],
          // Fine mode changes the rule and lifts brightness. The rule change
          // alone was too subtle to catch at a glance.
          [CONTAINERS.scale, buildScaleRow(view.fine), view.fine ? 3 : 1],
          [
            CONTAINERS.needle,
            buildNeedleRow(view),
            view.confirmed ? 4 : view.inTolerance ? 4 : near ? 3 : 2,
          ],
          [CONTAINERS.readout, buildReadoutRow(view), view.confirmed ? 4 : 3],
          [CONTAINERS.strings, buildStringsRow(view), CONTAINERS.strings.color],
        ]

        await this.sendRows(rows)
      }
    } finally {
      this.flushing = false
    }
  }

  private async flushRows(rows: RowSpec[]): Promise<void> {
    if (this.flushing) return
    this.flushing = true
    try {
      await this.sendRows(rows)
    } finally {
      this.flushing = false
    }
  }

  /** Sends only the rows whose content or brightness actually changed. */
  private async sendRows(rows: RowSpec[]): Promise<void> {
    for (const [c, content, color] of rows) {
      if (this.lastSent.get(c.name) === content && this.lastColor.get(c.name) === color) {
        continue
      }
      this.lastSent.set(c.name, content)
      this.lastColor.set(c.name, color)
      await this.upgrade(c.id, c.name, content, color)
    }
  }

  /**
   * One in-place text update. The timeout matters: a flaky BLE hop can hang
   * ~30s and stall everything queued behind it. Dropping a frame is cheaper.
   */
  private async upgrade(id: number, name: string, content: string, textColor: number): Promise<void> {
    const call = this.bridge.textContainerUpgrade(
      new TextContainerUpgrade({
        containerID: id,
        containerName: name,
        // Offset and length both zero replaces the whole content.
        contentOffset: 0,
        contentLength: 0,
        content,
        textColor,
      }),
    )
    try {
      await Promise.race([
        call,
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2500)),
      ])
    } catch {
      // Drop the frame and let the next one resend; also forget what we think
      // is on screen so the retry is not skipped as a no-op.
      this.lastSent.delete(name)
    }
  }
}

type ContainerSpec = { id: number; name: string; x: number; y: number; w: number; h: number }

/** One row to send: which container, its content, and its brightness. */
type RowSpec = [(typeof CONTAINERS)[keyof typeof CONTAINERS], string, number]

function text(
  c: ContainerSpec,
  content: string,
  textColor: number,
  isEventCapture = 0,
): TextContainerProperty {
  return new TextContainerProperty({
    containerID: c.id,
    containerName: c.name,
    xPosition: c.x,
    yPosition: c.y,
    width: c.w,
    height: c.h,
    // Padding would shrink the text area the rows are measured against.
    borderWidth: 0,
    paddingLength: 0,
    content,
    textColor,
    isEventCapture,
  })
}
