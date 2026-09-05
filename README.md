# Tuneful

A tuner for classical guitar that runs on Even Realities G2 glasses.

The glasses show the note, a needle, and which way to turn the peg. The phone
holds settings, or becomes the tuner itself if you pick the phone microphone.

Before submitting to the Even Hub store, set `package_id` in `app.json` (it is
the placeholder `com.example.tuneful`) and `author` in `package.json`. The
package id is permanent and follows reverse-domain convention, so use a domain
you own.

## Running it

    npm install
    npm run dev            # dev server on :5173
    npx evenhub qr         # scan with the Even app to load on the glasses

Without hardware:

    npm run sim            # desktop simulator, automation API on :9898

Add `?demo=1` in a dev build to step through fixed tuning states with the
swipe gestures.

To package:

    npm run pack           # produces tuneful.ehpk

## Tuning reference

Frequencies come from the A4 reference at run time, so 442 Hz and 415 Hz stay
exact. At A4 = 440 the open strings are 82.407, 110.000, 146.832, 195.998,
246.942 and 329.628 Hz.

## Pitch detection

Two stages, in `src/audio/pitch.ts`:

1. YIN over a 4096-sample window (256 ms) gives an octave-safe period.
2. A phase-vocoder step measures the frequency from the phase advance between
   two overlapping windows.

The second stage is not optional. YIN alone reads 4.2 cents sharp on a nylon
low E, because the string's upper partials sit above exact harmonics and pull
the period estimate with them.

Worst-case error against synthetic plucked-string signals, 12 trials each, with
noise, decay and inharmonic partials:

| String | Error |
|---|---|
| E2 | 0.37 cents |
| A2 | 0.05 |
| D3 | 0.03 |
| G3 | 0.04 |
| B3 | 0.02 |
| E4 | 0.02 |

Everything is referenced to the glasses' 16 kHz sample clock. If that clock is
off, readings shift with it. The calibration setting on the phone corrects for
this.

## Display

The G2 is 576x288, 4-bit greyscale, one font at one fixed size, 27 px line
height, no CSS. Three things follow from that.

Everything is text. An image container costs 0.5 to 2 seconds per frame over
BLE, so a bitmap needle would run below 1 fps. Frames go out as
`textContainerUpgrade`, which updates in place without flicker at 10 fps.

The font is proportional, so the meter is built from measured cells. Block, box
and geometric glyphs are all 20 px; a space is 5 px. The needle row is 108 dots
of 5 px and the marker is exactly four dots wide, so swapping dots for the
marker leaves the row the same width at every position. Needle resolution is
5 px, about 0.9 cents.

Large text has to be drawn. The note name is a 5x3 dot-matrix font in
`src/glasses/blockfont.ts`, 140 px wide and 135 px tall. Row hierarchy uses
`textColor`, the 0-4 per-container brightness.

Font metrics are generated at build time by `scripts/gen-metrics.mjs` for the 57
characters the app can draw. Add a character to a glasses string and rerun
`npm run gen:metrics`; `prebuild` does this for normal builds.

## Behaviour

A reading counts as in tune only after holding within 1.5 cents for 800 ms.
Analysis pauses for 250 ms after each pluck, which is longer than the analysis
window, so the attack transient is excluded. Nylon runs sharp during the attack
and sags as it decays, so an instant check reports strings that are still
moving.

The needle shows three states: `▲` live, `◆` inside the band, `█` held.

Inside 8 cents the meter rescales to plus or minus 10, taking needle resolution
to 0.19 cents. It returns to plus or minus 50 above 12 cents. The gap is
hysteresis. The scale row changes rule and brightness so the two scales cannot
be confused.

The header counts confirmed strings. After three minutes of silence the
microphone is released and the display offers `TAP TO RESUME`.

| Gesture | Action |
|---|---|
| Tap | Lock to the current string, or unlock. Resumes when idle. |
| Swipe up or down | Choose the string |
| Double tap | Exit |

Auto-detect picks the nearest open string. They are at least 400 cents apart,
so the choice is unambiguous within about 200 cents. Lock a string when it is
far enough out that auto-detect would name its neighbour. A locked string is
never treated as off-scale.

The microphone choice decides which surface is the tuner. With the glasses mic
the phone is a settings panel. With the phone mic the phone is the tuner and
the glasses show a standby card. If the glasses page cannot be created, the app
falls back to the phone.

## Platform notes

- `createStartUpPageContainer` is one-shot. A second call is rejected with
  `invalid` (code 1) even when the layout is fine, which happens on every hot
  reload. Recovery is `rebuildPageContainer`.
- Clicks arrive as `sysEvent`, not `textEvent`. Only scroll gestures come
  through `textEvent`.
- Protobuf omits zero values, so a click's `eventType: 0` arrives as
  `undefined`, as does list index 0. Use `?? 0`.
- Browser `localStorage` is unreliable across restarts in this WebView.
  Settings go to `bridge.setLocalStorage`, debounced, since it shares the BLE
  link with rendering.
- `setBackgroundState` and `onBackgroundRestore` do not exist in SDK 0.0.14
  despite being documented. State is rebuilt on `FOREGROUND_ENTER_EVENT`.
- Some common glyphs are missing from the firmware font and render as nothing:
  `▮ ▬ ╫ ▪ ▫ ✓ ░ ▓ ▀ ▐`. Check with `getAdvW` first. `npm run check:glyphs`
  verifies every glyph the app draws.
- Text that exactly fills a container wraps to an invisible second line.
  Padding is measured against the composed string, because kerning at the join
  is enough to lose a trailing word.

## Files

    src/main.ts               bridge lifecycle, mic, input, persistence
    src/tuner.ts              state machine: audio in, view model out
    src/config.ts             shared thresholds
    src/audio/pitch.ts        YIN and phase refinement
    src/audio/stream.ts       PCM decoding, ring buffer, smoothing
    src/tuning/notes.ts       note maths and string table
    src/glasses/blockfont.ts  5x3 dot-matrix font
    src/glasses/display.ts    layout, row builders, renderer
    src/glasses/metrics.ts    generated font metrics
    src/phone/ui.ts           settings panel and phone tuner

`advance()` mutates detection state and `view()` is a pure read. Keeping them
separate stops a gesture or settings change from running a second detection
pass and pushing a duplicate reading into the smoother.
