# Tuneful

A classical guitar tuner for Even Realities G2 smart glasses.

Hands stay on the instrument: the glasses show the note, a live needle, and
which way to turn the peg. The phone screen is settings and status only, and
can be locked while you tune.

> **Before submitting:** `package_id` in `app.json` is the placeholder
> `com.example.tuneful`, and `author` in `package.json` is empty. The package id
> is your permanent identifier on the Even Hub store and follows reverse-domain
> convention, so set it to a domain you control before you submit.

## Running it

```bash
npm install
npm run dev                  # Vite dev server on :5173
npx evenhub qr               # scan with the Even app to load on the glasses
```

Testing without hardware:

```bash
npm run sim                  # desktop simulator, automation API on :9898
```

Add `?demo=1` to the URL in a dev build to walk a scripted set of tuning states
with the swipe-up / swipe-down gestures — useful for checking the display
without an instrument.

Packaging:

```bash
npm run pack                 # -> tuneful.ehpk
```

## Accuracy

Frequencies are derived from the A4 reference at run time rather than hard-coded,
so 442 Hz ensemble pitch and 415 Hz baroque pitch stay exact. At A4 = 440 the six
open strings are 82.407 / 110.000 / 146.832 / 195.998 / 246.942 / 329.628 Hz.

Detection runs in two stages, and the second one is not optional:

1. **YIN** over a 4096-sample (256 ms) window gives a robust, octave-safe period.
2. **Phase-vocoder refinement** measures the true frequency from the phase
   advance between two overlapping windows.

YIN alone is systematically *sharp* on a nylon low E — measured at **+4.2 cents**,
because the string's upper partials sit slightly above exact harmonics and drag
the period estimate with them. The phase stage removes that bias.

Measured error against synthetic plucked-string signals (12 trials per case,
with noise, decay, and inharmonic partials):

| String | Worst-case error |
|---|---|
| E2 (weak fundamental) | 0.41 ¢ |
| A2 | 0.05 ¢ |
| D3 | 0.03 ¢ |
| G3 | 0.04 ¢ |
| B3 | 0.02 ¢ |
| E4 | 0.02 ¢ |

The "in tune" band is ±1.5 cents, which is comfortably above the measurement
floor and below what the ear resolves on a single sustained note.

The one accuracy limit worth knowing: everything is referenced to the glasses'
16 kHz sample clock. If that clock is off, readings shift proportionally. The
phone's calibration control exists to null that out against a reference you
trust.

## Display design

The G2 is 576×288, 4-bit greyscale, one firmware font at one fixed size, with a
27 px line height and no CSS. Three constraints drove the whole layout:

**Everything is text.** An image container costs 0.5–2 s per frame over BLE, so
a bitmap needle would run at well under 1 fps. Every frame here goes out as
`textContainerUpgrade`, which updates in place with no flicker at 10 fps.

**The font is proportional, so the meter is built from measured cells.** Glyph
widths were measured with `@evenrealities/pretext` rather than assumed. Block,
box-drawing and geometric glyphs are all exactly 320/16 = 20 px; a space is
80/16 = 5 px. The needle row is therefore 108 dots of 5 px, and the marker glyph
is exactly four dots wide — so swapping four dots for one marker keeps the row's
pixel width identical at every position. That is what stops the meter shivering
as the needle moves. Needle resolution is 5 px ≈ 0.9 cents.

Several popular box-drawing and symbol characters are **missing from the
firmware font** (`╌ ╍ ┄ ┅ ┈ ┉ ╎ ┆ ▪ ▫ ✓ ✔ ✗ ░ ▓ ▀ ▐ ♮`, advance width 0) and are
silently dropped when rendered. All of them are avoided here.

**"Large text" has to be built.** There is no font-size control, so the note name
is drawn as a 5-row × 3-column dot-matrix font (`src/glasses/blockfont.ts`) out
of 20 px block glyphs — 140 px wide, 135 px tall.

Hierarchy comes from `textColor`, the 0–4 per-container brightness added in SDK
0.0.14. The note dims when a reading goes stale, and the needle brightens as it
closes on the target, so the display never looks confidently wrong.

## Settling, not snapshotting

A reading passing through the in-tune band is not the same as a string that is
in tune. Nylon runs sharp during the attack and sags as it decays, so an
instantaneous check flashes IN TUNE at strings that are still moving.

Two things prevent that:

- **Attack rejection.** A sharp jump in level marks a pluck, and analysis pauses
  for 250 ms - slightly longer than the 256 ms analysis window - so the first
  trusted reading comes from a window that no longer contains the transient.
- **Confirmation hold.** The pitch must stay inside +/-1.5 cents for 800 ms
  before it counts. Only then does the needle go solid and the string get
  marked off.

The needle shows all three states, because the logic is invisible otherwise:
`▲` live, `◆` inside the band, `█` held and confirmed.

## Fine mode

Inside 8 cents the meter rescales to +/-10, taking needle resolution from 0.9
to 0.19 cents per step; it returns to +/-50 above 12 cents. The gap between
those thresholds is hysteresis - entering and leaving at the same value makes
the scale flap while the needle sits on the boundary.

A needle occupies the same pixels on both scales, so the scale itself has to
say which is in force. It does so twice over: a double rule instead of a single
one, **and** a brightness lift. The rule change alone turned out to be too
subtle to catch at a glance.

## Gestures

| Gesture | Action |
|---|---|
| Tap | Lock to the current string, or unlock (resume, when idle) |
| Swipe up / down | Choose the string by hand |
| Double tap | Exit (via the system confirmation dialog) |

Auto-detect snaps to the nearest open string; the open strings are at least 400
cents apart, so the choice is unambiguous within ~200 cents. Locking is there
for a string so far off that auto-detect would name its neighbour - and a locked
string is never treated as off-scale, so the target stays on screen however far
out it is.

The header carries session progress (`3/6`) and the string row marks each string
that has been confirmed, so tuning the whole guitar has a finish line. After
three minutes of silence the microphone is released and the display offers
`TAP TO RESUME`.

## Two surfaces

The microphone choice decides which surface is the tuner. With the glasses mic
the phone is a quiet settings panel; choose the phone mic and the phone becomes
the tuner while the glasses stand down to a `TUNING ON PHONE` card. One reading
is authoritative at a time.

If the glasses page cannot be created at all, the app falls back to the phone
tuner rather than failing - it does not assume the glasses are there.

## Platform notes

Things that cost time to discover, recorded so they don't have to be
rediscovered:

- **`createStartUpPageContainer` is one-shot.** A second call — after a dev hot
  reload, or reopening the app before the host tore the old page down — is
  rejected with `invalid` (code 1) even though the layout is fine. The app
  detects this and recovers via `rebuildPageContainer`.
- **Clicks arrive as `sysEvent`, not `textEvent`.** Only scroll gestures come
  through `textEvent`.
- **Protobuf omits zero values.** A single click's `eventType: 0` arrives as
  `undefined`, as does list index 0. Everything reading these uses `?? 0`.
- **Browser `localStorage` is not reliable** across restarts in the Even app's
  WebView. Settings go to `bridge.setLocalStorage`, debounced, because it shares
  the BLE link with rendering.
- **`setBackgroundState` / `onBackgroundRestore` do not exist in SDK 0.0.14**,
  despite being documented. State is rebuilt on `FOREGROUND_ENTER_EVENT`
  instead.
- **Many common glyphs are absent from the firmware font** and render as
  nothing. `▮`, `▬`, `╫`, `▪`, `▫`, `✓`, `░`, `▓`, `▀`, `▐` all measure zero
  advance. Check with `getAdvW` before using any character on the display;
  `npm run check:glyphs` verifies every glyph this app draws.
- **Text that exactly fills a container wraps to an invisible second line.**
  Padding is computed against the measured width of the *composed* string, not
  the sum of its parts, because kerning at the join was enough to lose the
  trailing "Hz".

## Layout

```
src/
  main.ts                 bridge lifecycle, mic, input routing, persistence
  tuner.ts                state machine: audio in, view model out
  audio/pitch.ts          YIN + phase refinement
  audio/stream.ts         PCM decoding, ring buffer, smoothing
  tuning/notes.ts         note maths, string tables, cents
  glasses/blockfont.ts    5x3 dot-matrix font
  glasses/display.ts      layout, row builders, serialised renderer
  phone/ui.ts             settings panel / phone tuner
  config.ts               shared thresholds, so both surfaces agree
```

`advance()` mutates detection state and `view()` is a pure read. They are
separate deliberately: when they were one method, every gesture and settings
change ran a second detection pass over the same audio and pushed a duplicate
reading into the smoother.
