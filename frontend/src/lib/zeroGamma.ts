/**
 * Livello di inversione del gamma, per somma cumulata: si sale per strike
 * finche' il totale non cambia segno, e si interpola fra i due adiacenti.
 *
 * E' un'approssimazione, e va detto: il gamma flip vero si troverebbe
 * rivalutando l'intero profilo a spot diversi, e il gamma che abbiamo e'
 * quello di adesso, misurato a questo spot. Sopra questo livello i dealer
 * risultano lunghi di gamma (movimento smorzato), sotto corti (accelerato).
 *
 * Le righe devono arrivare ordinate per strike: /api/gex le manda cosi', sia
 * `profile` sia `strikes`/`serie`.
 *
 * Sta qui e non in una pagina perche' la usano sia /spx-gamma sia /gex: due
 * copie avrebbero finito per dare due Zero Gamma diversi sullo stesso dato.
 */
export function zeroGamma(rows: { strike: number; gex: number; gexOi: number }[], chiave: 'gex' | 'gexOi'): number | null {
    if (rows.length < 2) return null;
    let cum = 0;
    let precStrike: number | null = null;
    let precCum = 0;
    for (const r of rows) {
        const nuovo = cum + r[chiave];
        // `precCum !== 0`: finche' la somma e' zero non ha ancora un segno, e
        // uno strike in fondo alla catena che vale esattamente zero seguito dal
        // primo valore non nullo passava per un'inversione.
        if (precStrike !== null && precCum !== 0 && ((precCum < 0 && nuovo >= 0) || (precCum > 0 && nuovo <= 0))) {
            const salto = nuovo - precCum;
            if (salto === 0) return r.strike;
            const frazione = -precCum / salto;
            return Math.round((precStrike + (r.strike - precStrike) * frazione) * 100) / 100;
        }
        precCum = nuovo;
        precStrike = r.strike;
        cum = nuovo;
    }
    return null;
}
