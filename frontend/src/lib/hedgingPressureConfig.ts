/**
 * Configuration parameters for Hedging Pressure calculations.
 *
 * These parameters can be tuned based on market behavior and user feedback.
 * All values are unitless or in the units indicated.
 */

export const HEDGING_PRESSURE_CONFIG = {
    /**
     * Proximity weight scale calculation:
     * baseScale = spot * BASE_SCALE_PERCENT
     * finalScale = baseScale * ivAdjustment
     *
     * DEFAULT: 0.01 (1% of spot)
     * RANGE: 0.005 (0.5%) to 0.02 (2%)
     *
     * Lower = tighter focus around ATM (higher weights decay faster)
     * Higher = broader focus (weights decay slower, more strikes matter)
     */
    BASE_SCALE_PERCENT: 0.01,

    /**
     * IV normalization factor for proximity scale adjustment.
     * scale adjustment = min(IV / IV_NORMALIZATION, MAX_IV_ADJUSTMENT)
     *
     * DEFAULT: 25 (assumes ~25% IV is "normal")
     * RANGE: 15 to 35
     *
     * Lower = more sensitive to IV changes, scale widens with higher IV
     * Higher = less sensitive, scale changes less dramatically
     */
    IV_NORMALIZATION: 25,

    /**
     * Max and min IV adjustment multipliers for proximity scale.
     *
     * At IV = 50%, scale = baseScale * 2.0
     * At IV = 5%, scale = baseScale * 0.5
     *
     * DEFAULT: max = 2.0, min = 0.5
     * RANGE: max [1.5, 3.0], min [0.3, 0.7]
     */
    MAX_IV_ADJUSTMENT: 2.0,
    MIN_IV_ADJUSTMENT: 0.5,

    /**
     * Minimum scale floor to prevent extremely tight focus.
     * If scale calculation < SCALE_FLOOR, use SCALE_FLOOR instead.
     *
     * DEFAULT: 0.5 (price points)
     * RANGE: 0.2 to 2.0
     */
    SCALE_FLOOR: 0.5,

    /**
     * Normalization window size for z-score calculation.
     * Rolling window of recent pressure values.
     *
     * DEFAULT: 20 (20 snapshots × 10 sec = ~3.3 min lookback)
     * RANGE: 10 to 60
     *
     * Lower = more responsive to recent changes, more jumpy
     * Higher = smoother, less responsive
     */
    NORMALIZATION_WINDOW: 20,

    /**
     * Z-score saturation bounds for normalization.
     * Raw z-scores beyond this are clipped before scaling to [-100, 100].
     *
     * DEFAULT: 3.0 (handles ~99.7% of normal distribution)
     * RANGE: 2.0 to 4.0
     *
     * Lower = more aggressive clipping, wider range of values map to extremes
     * Higher = less clipping, more compression in the middle
     */
    ZSCORE_BOUNDS: 3.0,

    /**
     * Acceleration score velocity scaling factors.
     * accelerationScore = pressure × (1 + spotVelScale × SPOT_VEL_FACTOR) × (1 + ivVelScale × IV_VEL_FACTOR)
     *
     * DEFAULT: 0.5 for both
     * RANGE: 0.1 to 1.0
     *
     * Controls how much velocity affects the acceleration score.
     */
    SPOT_VEL_FACTOR: 0.5,
    IV_VEL_FACTOR: 0.5,

    /**
     * Velocity scaling normalization: typical velocity values expected.
     * Used to normalize spot and IV velocities before applying factors.
     *
     * DEFAULT: spot = 0.1 points/sec, iv = 2 bps/sec
     * These assume ~10s polling interval
     */
    SPOT_VEL_SCALE: 0.1, // 0.1 points/sec = typical movement
    IV_VEL_SCALE: 2, // 2 bps/sec = typical IV movement

    /**
     * Vega-to-Hedging-Pressure scaling factor.
     * hedgingPressure = (vanna * spot * VANNA_SCALE) / 1e6
     *
     * DEFAULT: 0.01
     * RANGE: 0.005 to 0.02
     *
     * Converts vanna (in dollars per 1% IV change) to millions of $ like GEX.
     */
    VANNA_SCALE: 0.01,

    /**
     * Minimum vega/delta magnitude to consider valid.
     * Values with |vega| < MIN_VEGA_MAGNITUDE are treated as null.
     *
     * DEFAULT: 1e-8
     * RANGE: 1e-10 to 1e-6
     */
    MIN_VEGA_MAGNITUDE: 1e-8,

    /**
     * Risk zone identification thresholds.
     * Zones with |pressure| >= HIGH_PRESSURE_THRESHOLD are marked as "high".
     * Zones with |pressure| >= MEDIUM_PRESSURE_THRESHOLD are marked as "medium".
     *
     * DEFAULT: high = 50, medium = 25
     * RANGE: high [30, 80], medium [15, 50]
     *
     * Lower thresholds = more zones flagged as risky
     * Higher thresholds = fewer zones flagged
     */
    HIGH_PRESSURE_THRESHOLD: 50,
    MEDIUM_PRESSURE_THRESHOLD: 25,

    /**
     * Proximity weight threshold for risk zones.
     * Zones with proximity >= PROXIMITY_THRESHOLD are flagged as "close to ATM".
     *
     * DEFAULT: 0.7 (70% of max weight)
     * RANGE: 0.5 to 0.9
     */
    HIGH_PROXIMITY_THRESHOLD: 0.7,
} as const;

/**
 * Apply configuration to values before calculation.
 * Validate and log warnings for out-of-range values.
 */
export function validateConfig(): { valid: boolean; warnings: string[] } {
    const warnings: string[] = [];

    if (HEDGING_PRESSURE_CONFIG.BASE_SCALE_PERCENT < 0.005 || HEDGING_PRESSURE_CONFIG.BASE_SCALE_PERCENT > 0.02) {
        warnings.push(`BASE_SCALE_PERCENT ${HEDGING_PRESSURE_CONFIG.BASE_SCALE_PERCENT} outside recommended range [0.005, 0.02]`);
    }

    if (HEDGING_PRESSURE_CONFIG.IV_NORMALIZATION < 15 || HEDGING_PRESSURE_CONFIG.IV_NORMALIZATION > 35) {
        warnings.push(`IV_NORMALIZATION ${HEDGING_PRESSURE_CONFIG.IV_NORMALIZATION} outside recommended range [15, 35]`);
    }

    if (HEDGING_PRESSURE_CONFIG.NORMALIZATION_WINDOW < 10 || HEDGING_PRESSURE_CONFIG.NORMALIZATION_WINDOW > 60) {
        warnings.push(`NORMALIZATION_WINDOW ${HEDGING_PRESSURE_CONFIG.NORMALIZATION_WINDOW} outside recommended range [10, 60]`);
    }

    return { valid: warnings.length === 0, warnings };
}
