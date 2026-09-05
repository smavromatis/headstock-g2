# Headstock

A guitar tuner for Even Realities G2 smart glasses.

The glasses show the note, a needle and which way to turn the peg, so you can
tune with both hands on the instrument and never look at a phone.

## Using it

Play a string. Headstock names it, shows how far off it is in cents, and says
whether to tighten or loosen. It only reports **in tune** once the pitch has
held steady, so it will not flash green at a string that is still moving.

| Gesture | Action |
|---|---|
| Tap | Lock to the current string, or unlock. Resumes when paused. |
| Swipe up or down | Choose the string by hand |
| Long press | Change tuning |
| Double tap | Exit to the glasses menu |

Auto-detect follows whatever you play. Lock a string when another instrument is
audible nearby, or when a string is so far out that its neighbour would be
named instead.

The header counts strings you have finished, so tuning a whole guitar has a
finish line. After three minutes of silence the microphone is released and the
display offers `TAP TO RESUME`.

### Tunings

| Preset | Strings |
|---|---|
| Standard | E2 A2 D3 G3 B3 E4 |
| Drop D | D2 A2 D3 G3 B3 E4 |
| DADGAD | D2 A2 D3 G3 A3 D4 |
| Open G | D2 G2 D3 G3 B3 D4 |
| Open D | D2 A2 D3 F#3 A3 D4 |
| Half step down | Eb2 Ab2 Db3 Gb3 Bb3 Eb4 |

A capo can be set from 0 to 12; the tuner then targets and names the sounding
notes. Reference pitch is adjustable from 415 to 445 Hz, so 442 for ensemble
playing and 415 for baroque are exact.

### The phone

With the glasses microphone the phone is a settings panel you can put away.
Choose the phone microphone and the phone becomes the tuner instead, with the
glasses standing down. If the glasses are unavailable the app falls back to the
phone rather than failing.

## Accuracy

Detection is YIN for an octave-safe period, refined by the phase advance
between two overlapping windows. Worst measured error against synthetic
plucked-string signals is 0.35 cents, and under 0.1 on most strings. In tune
means within 1.5 cents, held for 800 ms.

Everything is referenced to the glasses' 16 kHz sample clock. Crystal tolerance
is around 50 ppm, or 0.09 cents, so the clock is not a practical source of
error.

## Development

    npm install
    npm run dev                # dev server on :5173
    npx evenhub qr             # scan with the Even app to load on the glasses
    npm run sim                # desktop simulator, no audio input
    npm run check              # all checks
    npm run pack               # produces headstock.ehpk

Add `?demo=1` in a dev build to step through fixed tuning states with the swipe
gestures. `npm run gen:metrics` regenerates the font table after adding a
character to any string the glasses draw.

The package id is `com.headstock.tuner`. It follows reverse-domain convention
but is not backed by a domain, which the store does not check.

### Platform notes

Behaviour of the G2 platform that is not discoverable from the code, and cost
real time to find:

- `createStartUpPageContainer` is one-shot. A second call is rejected with
  `invalid` (code 1) even when the layout is fine, which happens on every hot
  reload. Recovery is `rebuildPageContainer`.
- Clicks arrive as `sysEvent`, not `textEvent`. Only scroll gestures come
  through `textEvent`.
- Protobuf omits zero values, so a click's `eventType: 0` arrives as
  `undefined`, as does list index 0. Use `?? 0`.
- The host emits a bare `sysEvent` carrying only `eventSource` as the page comes
  up, which is indistinguishable from a real click. Input is ignored for 750 ms
  after startup.
- Anything the host draws over the page, such as the exit dialog, is clipped by
  a running frame loop. Rendering pauses while it is up and while the app is
  backgrounded.
- Every bridge call shares one BLE link, so they all queue through
  `src/bridge-queue.ts`. Concurrent calls can drop the connection, including
  storage writes and microphone control.
- Browser `localStorage` is unreliable across restarts in this WebView.
- `setBackgroundState` and `onBackgroundRestore` do not exist in SDK 0.0.14
  despite being documented, and `LONG_PRESS_EVENT` and the contextual-menu API
  exist but are absent from it.
- Some glyphs are missing from the firmware font and render as nothing:
  `▮ ▬ ╫ ▪ ▫ ✓ ░ ▓ ▀ ▐`. `npm run check:glyphs` verifies every glyph drawn.
- Text that exactly fills a container wraps to an invisible second line, so
  padding is measured against the composed string, kerning included.

### Files

    src/main.ts               bridge lifecycle, mic, input, persistence
    src/tuner.ts              state machine: audio in, view model out
    src/bridge-queue.ts       serialises every call over the BLE link
    src/config.ts             shared thresholds
    src/audio/                pitch detection, PCM decoding, smoothing
    src/tuning/notes.ts       note maths, tunings, capo
    src/glasses/              block font, layout, renderer, font metrics
    src/phone/ui.ts           settings panel and phone tuner

The checks in `scripts/` guard the failures that have actually happened here:
row overflow, needle discontinuity, pitch drift, a noise gate that closed on a
sustained note, and a search that fed back on itself. Each has been verified to
fail when its bug is reintroduced.
