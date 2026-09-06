/** Shared tuning thresholds, read by the display and the settle logic. */

/** Cents within which a string counts as in tune. */
export const IN_TUNE_CENTS = 1.5

/** Cents within which the needle is closing in. */
export const NEAR_CENTS = 5

/**
 * How long the pitch must hold inside IN_TUNE_CENTS before it counts.
 * A nylon string passes through in-tune on its way somewhere else.
 */
export const CONFIRM_HOLD_MS = 800

/**
 * Pause after a detected pluck. Longer than the 256ms analysis window, so the
 * first trusted reading excludes the attack transient, which runs sharp.
 */
export const ATTACK_SKIP_MS = 250

/** How long a reading survives after the string stops sounding. */
export const READING_HOLD_MS = 1400

/** Silence after which the mic is released. */
export const IDLE_TIMEOUT_MS = 3 * 60 * 1000

/**
 * Noise gate. The floor tracks the room and the gate sits a margin above it,
 * so an unplugged electric and a loud dreadnought both work without a setting.
 * MIN_GATE stops a silent room from opening the gate to nothing.
 */
export const MIN_GATE = 0.0015
export const GATE_MARGIN = 4
/** Floor follows the quiet moments down. */
export const NOISE_FALL = 0.25
/**
 * The floor may only creep upward, and never above the current level.
 *
 * An averaging filter is wrong here: it rises toward whatever is playing, so a
 * sustained note drags the floor up until the gate exceeds the signal and the
 * tuner goes deaf. Measured at roughly 15 seconds. Tracking the quiet moments
 * instead means a continuous tone cannot raise the floor at all.
 */
export const NOISE_CREEP = 1.0008

/**
 * How often the displayed frequency may change.
 *
 * Its last digit churns every frame, which forced a resend of the readout row
 * ten times a second: measured at 6.1 of the 10.6 BLE writes per second during
 * tuning. Nothing is acted on from that digit, so it updates twice a second.
 */
export const HZ_UPDATE_MS = 500

/**
 * Timeout for microphone control.
 *
 * Far longer than a render: opening the microphone can raise a permission
 * dialog, and the call does not return until the user answers. At the render
 * timeout it reported failure while the microphone was starting normally.
 */
export const MIC_CONTROL_TIMEOUT_MS = 30000

/** Pause after a string confirms before the lock moves to the next one. */
export const ADVANCE_DELAY_MS = 1200

/** Highest capo position offered. */
export const MAX_CAPO = 12

/**
 * The meter is one continuous scale with an expanded centre, not two scales.
 *
 * Two scales sharing one strip of pixels made the needle teleport 150px when
 * it crossed between them. Here the inner region is stretched and the outer
 * compressed, so there is no boundary to cross.
 *
 * The inner half of the meter covers +/-4.5 cents, which puts the in-tune band
 * at exactly +/-40px: two character cells either side of centre.
 */
export const METER_MAX_CENTS = 50
export const METER_HALF_PX = 240
export const METER_INNER_CENTS = 4.5
export const METER_INNER_PX = 120

/**
 * Consecutive frames another string must win before auto-detect switches to it.
 *
 * Someone playing nearby made a third of frames name the wrong string. This
 * only delays the label, never the detection, and the counter is unconditional,
 * so a real string change always lands within this many frames.
 */
export const STRING_SWITCH_FRAMES = 3

/** Needle must move this many 5px dots before it is redrawn. */
export const NEEDLE_HYSTERESIS_DOTS = 1

/** Smoothing is heavier within this distance of the target, lighter beyond. */
export const STEADY_WITHIN_CENTS = 5
export const SMOOTH_ALPHA_NEAR = 0.15
export const SMOOTH_ALPHA_FAR = 0.5

/** Skip a frame whose level fell by more than this fraction since the last. */
export const DECAY_REJECT_RATIO = 0.6
