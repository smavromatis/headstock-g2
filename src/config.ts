/** Shared tuning thresholds. Both surfaces and the settle logic read these. */

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

export const METER_COARSE_CENTS = 50
export const METER_FINE_CENTS = 10

/** Hysteresis: equal thresholds would make the scale flap on the boundary. */
export const FINE_ENTER_CENTS = 8
export const FINE_EXIT_CENTS = 12
