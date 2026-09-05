# Working on Headstock

Notes for anyone extending this code. The README is for people tuning a guitar;
this is everything technical, including platform behaviour that is not
discoverable from the source and cost real time to find.

## Commands

    npm run dev                # dev server on :5173
    npx evenhub qr             # load on the glasses over the LAN
    npm run sim                # desktop simulator (it has no audio input)
    npm run check              # glyphs, layout, detection, robustness
    npm run gen:metrics        # regenerate the font table
    npm run pack               # produces headstock.ehpk

`?demo=1` in a dev build steps through fixed tuning states with the swipe
gestures, and `?tuning=halfstep` selects a preset. Both are stripped from
production builds.

## Layout

    src/main.ts               bridge lifecycle, mic, input, persistence
    src/tuner.ts              state machine: audio in, view model out
    src/bridge-queue.ts       serialises every call over the BLE link
    src/config.ts             shared thresholds
    src/audio/pitch.ts        YIN plus phase refinement
    src/audio/stream.ts       PCM decoding, ring buffer, smoothing
    src/tuning/notes.ts       note maths, tunings, capo
    src/glasses/blockfont.ts  5x3 dot-matrix font
    src/glasses/display.ts    layout, row builders, renderer
    src/glasses/metrics.ts    generated font metrics, do not edit
    src/phone/ui.ts           settings panel and phone tuner

`advance()` mutates detection state and `view()` is a pure read. They are
separate so a gesture or settings change cannot run a second detection pass and
push a duplicate reading into the smoother.

## Pitch detection

YIN over a 4096-sample window gives an octave-safe period, then a phase-vocoder
step measures the frequency from the phase advance between two overlapping
windows. The refinement is not optional: YIN alone reads 4.2 cents sharp on a
nylon low E, whose upper partials sit above exact harmonics and pull the period
with them.

Within 8 cents the window doubles to 512 ms, halving estimate variance. When a
string is locked the search narrows to three semitones around it. Frames taken
while the level is falling steeply are skipped, since a decaying string's pitch
is genuinely moving.

## The display

576x288, 4-bit greyscale, one font at one fixed size, 27 px line height, no CSS.

Everything is text. An image container costs 0.5 to 2 seconds per frame over
BLE, so a bitmap needle would run below 1 fps. Frames go out as
`textContainerUpgrade`, which updates in place without flicker at 10 fps.

The font is proportional, so the meter is built from measured cells. Block, box
and geometric glyphs are all exactly 20 px; a space is 5 px. The needle row is
108 dots of 5 px and the marker is exactly four dots wide, so swapping dots for
the marker leaves the row the same width at every position. Without that the
meter shivers as the needle moves.

Large text has to be built: the note name is a 5x3 dot-matrix font made from
block glyphs. Row hierarchy uses `textColor`, the 0-4 per-container brightness.

The meter is one continuous scale with an expanded centre, 0.19 cents per step
near the target and 1.9 at the edges. It replaced an auto-zoom between two
scales, which teleported the needle 150 px whenever it switched. The in-tune
band is drawn as a region because at +/-1.5 cents it is 40 px wide either side,
where a centre tick was 7 px and impossible to aim into.

Font metrics are generated for the 57 characters the app can draw. Add a
character to any string the glasses render and rerun `npm run gen:metrics`;
`prebuild` does it for normal builds.

## Platform notes

- `createStartUpPageContainer` is one-shot. A second call is rejected with
  `invalid` (code 1) even when the layout is fine, which happens on every hot
  reload. Recovery is `rebuildPageContainer`.
- Clicks arrive as `sysEvent`, not `textEvent`. Only scroll gestures come
  through `textEvent`.
- Protobuf omits zero values, so a click's `eventType: 0` arrives as
  `undefined`, as does list index 0. Use `?? 0`.
- The host emits a bare `sysEvent` carrying only `eventSource` as the page comes
  up, indistinguishable from a real click. Input is ignored for 750 ms after
  startup.
- Anything the host draws over the page, such as the exit dialog, is clipped by
  a running frame loop. Rendering pauses while it is up and while the app is
  backgrounded, then resends every row.
- Every bridge call shares one BLE link and must queue through
  `src/bridge-queue.ts`. Concurrent calls can drop the connection, and that
  includes storage writes and microphone control, not only rendering.
- Browser `localStorage` is unreliable across restarts in this WebView. Settings
  go to `bridge.setLocalStorage`, debounced.
- `setBackgroundState` and `onBackgroundRestore` do not exist in SDK 0.0.14
  despite being documented. `LONG_PRESS_EVENT`, `LONG_PRESS_RELEASE_EVENT` and
  the contextual-menu API exist but are absent from it.
- The gesture that opens the OS contextual menu is undocumented and unverified
  on hardware. Long press cycles tunings as a fallback until a menu selection is
  seen.
- Some glyphs are missing from the firmware font and render as nothing:
  `▮ ▬ ╫ ▪ ▫ ✓ ░ ▓ ▀ ▐`. Check with `getAdvW` before using any character.
- Text that exactly fills a container wraps to an invisible second line. Padding
  is measured against the composed string, kerning included, because measuring
  the halves separately was enough to lose a trailing word.
- The phone microphone path reads flat. Measured on one iPhone: a well-tuned
  low E read 82.10 Hz where the glasses read 82.40, a consistent 0.37% across
  strings. The host pads that stream to hold a nominal 16 kHz while capture
  runs slightly slow, so the content is time-stretched: reproduced exactly in
  simulation by repeating one sample in every 270, which yields 82.09 Hz.
  The arrival rate still measures 16 kHz, so the padding is invisible to a
  rate meter, and the repeated-sample signature disappears under realistic
  noise, so it cannot be detected automatically either. Both were tested.
  Neither route out exists: `audioControl(isOpen, source)` takes no sample
  rate, and the WebView does not expose `getUserMedia` at all, so the host's
  padded stream is the only phone audio available. The phone therefore ships
  with a +7.8 cent default correction, which Set re-measures and Clear removes.
  Note this establishes only that the two paths differ: whether the glasses are
  right in absolute terms has not been checked against an external reference,
  and a tuner uniformly sharp would tune a guitar sharp and call it perfect. Ruled out on the way: an iPhone high-pass roll-off
  (moves the reading 0.7 cents sharp), a sample-rate mismatch (measured at
  nominal), low-frequency rumble (within 2 cents), and dropped buffers (biases
  sharp, not flat).
- The simulator has no usable audio input, so it can only verify layout.
  `onDeviceStatusChanged` never fires there either.

## Anything adaptive

Four mechanisms adapt while the app runs: the noise gate, the smoothing
constant, the analysis window and the auto-detect label. Every bug found in
them had one of two shapes, so check both before adding another:

**A threshold with no hysteresis.** A bare comparison flips every frame while
the value sits on it. The analysis window did this at 8 cents, and the two
lengths give slightly different estimates, so it injected jitter exactly where
the final adjustments are made.

**State that outlives what it described.** The pitch search was narrowed around
the last detected string; a harmonic inside that window kept the detection
fresh, which kept the window narrow. Two of ten string changes were then never
detected at all. The `number[]` payload format latch had the same shape across a
microphone change, since the glasses and phone are separate host paths that need
not agree.

Two more worth knowing. The noise floor must track the quiet moments and may
only creep upward: an averaging filter rises toward whatever is playing, so a
sustained note drags the gate above its own signal and the tuner goes deaf after
about fifteen seconds. And auto-detect cannot survive a loud instrument nearby;
locking a string is the answer, and it rejects anything outside its own window.

## Where writing goes

The README is for someone tuning a guitar. Rationale for a change goes in a
code comment at the site of the change, or in this file. It has drifted back
into the README three times, growing it from 124 to 216 lines, because every
fix arrived with a paragraph explaining itself. `npm run check:docs` fails the
build when implementation vocabulary reappears there.

## Checks

`scripts/` guards the failures that have actually happened here: row overflow,
needle discontinuity, pitch drift, a gate that closed on a sustained note, and
a search that fed back on itself. Each check has been verified to fail when its
bug is reintroduced. Do that for any new one; a check that cannot fail is worse
than none, because it reads as coverage.

## Identity

`package_id` is `com.headstock.tuner`. It follows reverse-domain convention but
is not backed by a domain, which the store does not check. It is permanent once
submitted: changing it later means a new listing rather than an update.
