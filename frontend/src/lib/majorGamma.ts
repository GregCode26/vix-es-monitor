// Major Pos / Neg Gamma: lo strike con il GEX positivo piu' alto e quello con
// il GEX negativo piu' profondo nel profilo per strike di /api/gex.
//
// Una regola sola, usata da /spx-gamma (le due linee sul profilo) e da
// /market (la loro traccia nel pomeriggio): se la si cambia qui, le due
// pagine continuano a dire la stessa cosa.

export interface RigaGamma {
    strike: number;
    gex: number;
    gexOi: number;
}

export function majorGamma(
    profile: RigaGamma[],
    chiave: 'gex' | 'gexOi',
): { maxPos: number | null; maxNeg: number | null } {
    let maxPos: RigaGamma | null = null;
    let maxNeg: RigaGamma | null = null;
    for (const r of profile) {
        if (r[chiave] > 0 && (!maxPos || r[chiave] > maxPos[chiave])) maxPos = r;
        if (r[chiave] < 0 && (!maxNeg || r[chiave] < maxNeg[chiave])) maxNeg = r;
    }
    return { maxPos: maxPos?.strike ?? null, maxNeg: maxNeg?.strike ?? null };
}
