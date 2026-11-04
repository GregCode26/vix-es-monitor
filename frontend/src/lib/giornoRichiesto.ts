/**
 * La giornata chiesta a una rotta con `?date=YYYY-MM-DD`, o oggi.
 *
 * Una giornata passata si legge SOLO dai file locali dei poller, mai da
 * Supabase: rileggere una sessione intera dal database costa 12-17 MB di
 * egress, ed e' il budget che nell'ottobre 2026 ha fatto sospendere il
 * progetto. Quindi su Vercel, dove i file non ci sono, `?date=` risponde
 * vuoto: rivedere le giornate e' una cosa da macchina locale.
 */

export function chiaveOggi(adesso: Date = new Date()): string {
    const y = adesso.getFullYear();
    const m = String(adesso.getMonth() + 1).padStart(2, '0');
    const d = String(adesso.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

export function giornoRichiesto(searchParams: URLSearchParams): { data: string; passato: boolean } {
    const oggi = chiaveOggi();
    const chiesto = searchParams.get('date');
    if (chiesto && /^\d{4}-\d{2}-\d{2}$/.test(chiesto) && chiesto < oggi) {
        return { data: chiesto, passato: true };
    }
    return { data: oggi, passato: false };
}

/** Mezzogiorno di quella giornata: l'istante con cui chiedere a `orarioNy` lo scarto di quel giorno. */
export function mezzogiornoDi(data: string): Date {
    const [y, m, d] = data.split('-').map(Number);
    return new Date(y, m - 1, d, 12, 0, 0);
}
