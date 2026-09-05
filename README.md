# Headstock (Guitar Tuner)

A guitar tuner for Even Realities G2 smart glasses.

The glasses show the note, a needle and which way to turn the peg, so you can
tune with both hands on the instrument and never look at a phone.

## Using it

Play a string. Headstock names it, shows how far off it is in cents, and says
whether to tighten or loosen. It reports **in tune** only once the pitch has
held steady, so it will not flash at a string that is still moving.

| Gesture | Action |
|---|---|
| Tap | Lock to the current string, or unlock. Resumes when paused. |
| Swipe up or down | Choose the string by hand |
| Long press | Change tuning |
| Double tap | Exit to the glasses menu |

Auto-detect follows whatever you play. Lock a string when another instrument is
audible nearby, or when a string is so far out that its neighbour would be named
instead.

The header counts the strings you have finished, so tuning a whole guitar has a
finish line. After three minutes of silence the microphone is released and the
display offers `TAP TO RESUME`.

## Tunings

| Preset | Strings |
|---|---|
| Standard | E2 A2 D3 G3 B3 E4 |
| Drop D | D2 A2 D3 G3 B3 E4 |
| DADGAD | D2 A2 D3 G3 A3 D4 |
| Open G | D2 G2 D3 G3 B3 D4 |
| Open D | D2 A2 D3 F#3 A3 D4 |
| Half step down | Eb2 Ab2 Db3 Gb3 Bb3 Eb4 |

A capo can be set from 0 to 12, and the tuner then targets and names the
sounding notes. Reference pitch is adjustable from 415 to 445 Hz, so 442 for
ensemble playing and 415 for baroque are both exact.

## The phone

The phone holds the settings: tuning, capo and reference pitch. Set them once
and put it away. Headstock needs the glasses to run.

## Accuracy

In tune means within 1.5 cents, held for 800 ms. Worst measured error against
synthetic plucked-string signals is 0.35 cents, and under 0.1 on most strings.

## Building it

    npm install
    npm run dev                # dev server on :5173
    npx evenhub qr             # scan with the Even app to load on the glasses
    npm run check              # all checks
    npm run pack               # produces headstock.ehpk

See [AGENTS.md](AGENTS.md) for how it works, the G2 platform behaviour worth
knowing before changing anything, and what the checks are guarding.
