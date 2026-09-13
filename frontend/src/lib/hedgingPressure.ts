/**
 * Hedging Pressure Analysis
 *
 * Model: HedgingPressure = GammaPressure + VannaPressure
 * where:
 *   GammaPressure = GEX × ΔSpot × ProximityWeight
 *   VannaPressure = Vanna × ΔIV × ProximityWeight
 *
 * ProximityWeight = exp(-Distance / Scale)
 * where Scale is linked to ATM and volatility.
 *
 * All parameters are configurable in hedgingPressureConfig.ts
 */

import { HEDGING_PRESSURE_CONFIG } from './hedgingPressureConfig';

/**
 * Calculate proximity weight for a strike relative to spot.
 *
 * Uses exponential decay: weight = exp(-distance / scale)
 * Edge cases handled: distance = 0 → weight = 1, scale → ∞ → weight → 1
 *
 * Args:
 *   strike: Strike price
 *   spot: Current spot price
 *   scale: Distance scale (typically ATM_IV × spot, or 1-2% of spot for ITM weighting)
 *
 * Returns:
 *   Weight between 0 and 1 (1 = at spot, 0 = far from spot)
 */
export function proximityWeight(strike: number, spot: number, scale: number): number {
    // Guard against invalid inputs
    if (scale <= 0 || !Number.isFinite(strike) || !Number.isFinite(spot) || !Number.isFinite(scale)) {
        return 0;
    }

    const distance = Math.abs(strike - spot);

    // At the spot price, weight = 1
    if (distance === 0) return 1;

    // Exponential decay with minimum threshold
    const weight = Math.exp(-distance / scale);

    return Number.isFinite(weight) ? Math.max(0, Math.min(1, weight)) : 0;
}

/**
 * Calculate scale parameter for proximity weighting.
 * Uses ATM IV and spot price to determine relevant distance.
 *
 * A typical scale is 0.5% to 1% of the spot (1-2 standard deviations intraday).
 * For 0DTE, this represents the zone where immediate hedging pressure concentrates.
 */
export function calculateProximityScale(spot: number, atmIv: number): number {
    // Guard against invalid inputs
    if (!Number.isFinite(spot) || !Number.isFinite(atmIv) || spot <= 0 || atmIv <= 0) {
        // Fallback to conservative value if inputs invalid
        return HEDGING_PRESSURE_CONFIG.SCALE_FLOOR;
    }

    // For 0DTE, 1 standard deviation ≈ spot * IV * sqrt(1/252)
    // For intraday: roughly [BASE_SCALE_PERCENT]% of spot
    const baseScale = Math.max(HEDGING_PRESSURE_CONFIG.SCALE_FLOOR, spot * HEDGING_PRESSURE_CONFIG.BASE_SCALE_PERCENT);

    // Adjust by IV: higher IV = wider relevant zone
    const ivNorm = Math.max(0.1, atmIv); // Ensure non-zero
    const ivAdjustment = Math.max(
        HEDGING_PRESSURE_CONFIG.MIN_IV_ADJUSTMENT,
        Math.min(HEDGING_PRESSURE_CONFIG.MAX_IV_ADJUSTMENT, ivNorm / HEDGING_PRESSURE_CONFIG.IV_NORMALIZATION)
    );

    const finalScale = baseScale * ivAdjustment;

    return Number.isFinite(finalScale) ? Math.max(HEDGING_PRESSURE_CONFIG.SCALE_FLOOR, finalScale) : HEDGING_PRESSURE_CONFIG.SCALE_FLOOR;
}

interface PressureRow {
    strike: number;
    gex: number; // in millions
    vanna: number | null; // in millions
    spotDelta: number; // price change since last snapshot
    ivDelta: number; // IV change in basis points
    proximity: number;
    gammaPressure: number;
    vannaPressure: number;
    totalPressure: number;
}

/**
 * Calculate hedging pressure profile for all strikes.
 *
 * Args:
 *   strikes: Array of strike data with GEX and Vanna
 *   spot: Current spot price
 *   spotDelta: Change in spot since last snapshot
 *   atmIv: ATM implied volatility (as decimal, e.g., 0.25)
 *   ivDelta: Change in ATM IV since last snapshot (in basis points / 100)
 *
 * Returns:
 *   Array of PressureRow with calculated pressures
 */
export function calculateHedgingPressure(
    strikes: Array<{ strike: number; gex: number; vanna: number | null }>,
    spot: number,
    spotDelta: number,
    atmIv: number,
    ivDelta: number
): PressureRow[] {
    // Guard against invalid inputs
    if (!Array.isArray(strikes) || strikes.length === 0) {
        return [];
    }

    if (!Number.isFinite(spot) || spot <= 0 || !Number.isFinite(spotDelta) || !Number.isFinite(atmIv) || !Number.isFinite(ivDelta)) {
        // Return strikes with zero pressure if inputs invalid
        return strikes.map((row) => ({
            strike: row.strike,
            gex: row.gex,
            vanna: row.vanna,
            spotDelta: 0,
            ivDelta: 0,
            proximity: 0,
            gammaPressure: 0,
            vannaPressure: 0,
            totalPressure: 0,
        }));
    }

    const scale = calculateProximityScale(spot, atmIv);

    return strikes.map((row) => {
        if (!Number.isFinite(row.strike) || !Number.isFinite(row.gex)) {
            return {
                strike: row.strike,
                gex: row.gex,
                vanna: row.vanna,
                spotDelta,
                ivDelta,
                proximity: 0,
                gammaPressure: 0,
                vannaPressure: 0,
                totalPressure: 0,
            };
        }

        const proximity = proximityWeight(row.strike, spot, scale);

        // Gamma component: GEX × ΔSpot × Weight
        const gammaPressure = Number.isFinite(row.gex * spotDelta * proximity) ? row.gex * spotDelta * proximity : 0;

        // Vanna component: Vanna × ΔIV × Weight
        const vannaPressure =
            row.vanna != null && Number.isFinite(row.vanna * ivDelta * proximity) ? row.vanna * ivDelta * proximity : 0;

        const totalPressure = gammaPressure + vannaPressure;

        return {
            strike: row.strike,
            gex: row.gex,
            vanna: row.vanna,
            spotDelta,
            ivDelta,
            proximity,
            gammaPressure,
            vannaPressure,
            totalPressure: Number.isFinite(totalPressure) ? totalPressure : 0,
        };
    });
}

/**
 * Calculate acceleration score combining pressure magnitude and velocity.
 *
 * AccelerationScore = Pressure × (1 + abs(SpotVelocity)) × (1 + abs(IVVelocity))
 *
 * Returns value in [-100, 100] range after normalization.
 */
export function calculateAccelerationScore(
    totalPressure: number,
    spotVelocity: number, // points/sec or similar
    ivVelocity: number // bps/sec or similar
): number {
    // Velocity scaling: normalize to typical ranges
    // Typical intraday spot velocity: 0-5 points/min = 0-0.08 points/sec
    // Typical IV velocity: 0-100 bps/min = 0-1.67 bps/sec
    const spotVelScale = Math.abs(spotVelocity) / 0.1; // 0.1 points/sec ~ 1 movement
    const ivVelScale = Math.abs(ivVelocity) / 2; // 2 bps/sec ~ 1 movement

    const acceleration = totalPressure * (1 + spotVelScale * 0.5) * (1 + ivVelScale * 0.5);

    return acceleration;
}

/**
 * Normalize pressure values to [-100, 100] range using rolling z-score.
 *
 * Robust to outliers using windowed standard deviation.
 * Edge cases: uniform values → zero, empty array → empty, single value → zero.
 *
 * Args:
 *   pressures: Array of raw pressure values
 *   windowSize: Number of recent values to use for normalization (default from config)
 *
 * Returns:
 *   Array of normalized pressures in [-100, 100]
 */
export function normalizeHedgingPressure(pressures: number[], windowSize = HEDGING_PRESSURE_CONFIG.NORMALIZATION_WINDOW): number[] {
    if (pressures.length === 0) return [];

    // Validate window size
    const window = Math.max(2, Math.min(windowSize, pressures.length));

    return pressures.map((_, index) => {
        const start = Math.max(0, index - window + 1);
        const currentWindow = pressures.slice(start, index + 1).filter((v) => Number.isFinite(v));

        // Not enough valid data
        if (currentWindow.length < 2) {
            return 0;
        }

        const mean = currentWindow.reduce((a, b) => a + b, 0) / currentWindow.length;
        const variance = currentWindow.reduce((a, b) => a + (b - mean) ** 2, 0) / (currentWindow.length - 1);
        const stdDev = Math.sqrt(Math.max(0, variance)); // sqrt can be negative due to floating point

        // All values are the same (or near-identical)
        if (stdDev < 1e-10) {
            return 0;
        }

        // Z-score with guard
        const currentValue = pressures[index];
        if (!Number.isFinite(currentValue)) {
            return 0;
        }

        const zScore = (currentValue - mean) / stdDev;

        // Limit to [-ZSCORE_BOUNDS, +ZSCORE_BOUNDS] to handle outliers, then scale to [-100, 100]
        const bounds = HEDGING_PRESSURE_CONFIG.ZSCORE_BOUNDS;
        const limited = Math.max(-bounds, Math.min(bounds, zScore));
        const normalized = (limited / bounds) * 100;

        return Math.round(Math.max(-100, Math.min(100, normalized)));
    });
}

/**
 * Identify zones of hedging risk.
 *
 * Returns strikes where combined pressure factors suggest potential acceleration.
 */
export interface HedgingRiskZone {
    strike: number;
    riskLevel: 'high' | 'medium' | 'low';
    reason: string[];
    pressure: number;
}

export function identifyRiskZones(pressures: PressureRow[]): HedgingRiskZone[] {
    const zones: HedgingRiskZone[] = [];

    for (const row of pressures) {
        const reasons: string[] = [];
        let riskLevel: 'high' | 'medium' | 'low' = 'low';

        const absPressure = Math.abs(row.totalPressure);

        // High pressure indicator
        if (absPressure > HEDGING_PRESSURE_CONFIG.HIGH_PRESSURE_THRESHOLD) {
            reasons.push('High total pressure');
            riskLevel = 'high';
        } else if (absPressure > HEDGING_PRESSURE_CONFIG.MEDIUM_PRESSURE_THRESHOLD) {
            reasons.push('Moderate pressure');
            riskLevel = 'medium';
        }

        // Gamma + Vanna aligned (same direction = stronger effect)
        if (
            row.gammaPressure !== 0 &&
            row.vannaPressure !== 0 &&
            Math.sign(row.gammaPressure) === Math.sign(row.vannaPressure)
        ) {
            reasons.push('Gamma & Vanna aligned');
            if (riskLevel === 'low') riskLevel = 'medium';
        }

        // High proximity (close to ATM)
        if (row.proximity > HEDGING_PRESSURE_CONFIG.HIGH_PROXIMITY_THRESHOLD) {
            reasons.push('Close to ATM');
        }

        if (reasons.length > 0) {
            zones.push({
                strike: row.strike,
                riskLevel,
                reason: reasons,
                pressure: row.totalPressure,
            });
        }
    }

    return zones;
}
