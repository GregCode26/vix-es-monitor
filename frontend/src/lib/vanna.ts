/**
 * Vanna calculation utilities for hedging pressure analysis.
 *
 * Vanna = ∂Delta / ∂IV (change in delta per 1% change in IV)
 *
 * This is approximated using the Black-Scholes relationship:
 * Vanna ≈ -Vega * d2 / σ
 *
 * Where:
 * - Vega = ∂OptionPrice / ∂IV (in dollars per 1% IV change)
 * - d2 = ln(S/K) + (r - 0.5*σ²)*T / (σ*√T)
 * - σ = implied volatility (as decimal, e.g., 0.25 for 25%)
 * - S = spot price
 * - K = strike price
 * - T = time to expiration (in years)
 * - r = risk-free rate (approximated as 0 for simplicity)
 */

/**
 * Calculate d2 parameter from Black-Scholes model.
 * d2 = ln(S/K) + (r - 0.5*σ²)*T / (σ*√T)
 *
 * For simplicity, risk-free rate r ≈ 0.
 * Returns 0 and logs edge cases for debugging.
 */
function calculateD2(spot: number, strike: number, iv: number, timeToExpiry: number): number {
    // Guard against invalid inputs
    if (iv <= 0 || timeToExpiry <= 0 || !Number.isFinite(spot) || !Number.isFinite(strike) || strike <= 0 || spot <= 0) {
        return 0;
    }

    const sqrtT = Math.sqrt(timeToExpiry);
    const lnS_K = Math.log(spot / strike);

    // Guard against NaN from log
    if (!Number.isFinite(lnS_K)) {
        return 0;
    }

    const sigmaT = iv * sqrtT;
    if (sigmaT === 0) return 0;

    const d2 = (lnS_K - 0.5 * iv * iv * timeToExpiry) / sigmaT;

    return Number.isFinite(d2) ? d2 : 0;
}

/**
 * Estimate Vanna from Vega using Black-Scholes approximation.
 *
 * Vanna ≈ -Vega * d2 / σ
 *
 * Args:
 *   vega: Vega from IBKR (dollars per 1% IV change)
 *   spot: Current spot price
 *   strike: Strike price
 *   iv: Implied volatility as decimal (e.g., 0.25)
 *   timeToExpiry: Time to expiration in years
 *
 * Returns:
 *   Vanna estimate (dollars per 1% IV change in delta), or null if calculation fails
 */
export function estimateVanna(
    vega: number | null,
    spot: number | null,
    strike: number,
    iv: number | null,
    timeToExpiry: number
): number | null {
    // Guard against all invalid inputs
    if (
        vega == null ||
        spot == null ||
        iv == null ||
        iv <= 0 ||
        timeToExpiry <= 0 ||
        !Number.isFinite(vega) ||
        !Number.isFinite(spot) ||
        !Number.isFinite(strike) ||
        spot <= 0 ||
        strike <= 0
    ) {
        return null;
    }

    // Avoid division by zero and extremely small vega
    if (Math.abs(vega) < 1e-8) {
        return null;
    }

    const d2 = calculateD2(spot, strike, iv, timeToExpiry);

    // Vanna ≈ -Vega * d2 / σ
    const vanna = (-vega * d2) / iv;

    return Number.isFinite(vanna) ? vanna : null;
}

/**
 * Calculate Vanna for multiple strikes.
 * Returns only non-null values.
 */
export function calculateVannaForStrikes(
    strikes: Array<{
        strike: number;
        vega: number | null;
    }>,
    spot: number,
    iv: number,
    timeToExpiry: number
): Record<number, number | null> {
    const result: Record<number, number | null> = {};

    for (const row of strikes) {
        result[row.strike] = estimateVanna(row.vega, spot, row.strike, iv, timeToExpiry);
    }

    return result;
}

/**
 * Calculate Vanna normalized to same units as GEX (in millions of $ per 1% IV change).
 *
 * IBKR Vega is typically in dollars per 1% IV move.
 * For consistency with GEX (millions), we need to scale appropriately.
 *
 * VannaPressure per 1% IV move ≈ Vanna (in units compatible with delta hedge)
 */
export function vannaToHedgingPressure(
    vanna: number | null,
    spot: number | null
): number | null {
    if (
        vanna == null ||
        spot == null ||
        !Number.isFinite(vanna) ||
        !Number.isFinite(spot) ||
        spot <= 0
    ) {
        return null;
    }

    // IBKR vega is roughly ∂price/∂IV% per contract.
    // For 0DTE, near ATM, vega is typically 0.5-5 depending on position.
    // Vanna would be on similar scale.
    // Scale: vanna * spot * 0.01 gives approximate option price impact,
    // divide by 1e6 to get millions of dollars like GEX.
    const hedgingPressure = (vanna * spot * 0.01) / 1e6;

    return Number.isFinite(hedgingPressure) ? hedgingPressure : null;
}
