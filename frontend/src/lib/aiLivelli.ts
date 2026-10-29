/**
 * Analisi AI avviata dal prezzo: quando ES arriva a DISTANZA_PUNTI da un
 * livello tracciato su /market (range R1/R2/R3 e GEX+/GEX-), la pagina chiama
 * /api/ai-signal da sola e segna sulla linea del prezzo una freccia col
 * risultato: verde LONG, rossa SHORT, grigia NEUTRALE. Poi aspetta RIARMO_MS
 * prima di poter ripartire, qualunque sia il livello.
 *
 * Regole aggiunte il 29/10/2026 dopo il primo giorno (19 analisi, 12 sullo
 * stesso livello col prezzo fermo li', e 11 NEUTRALE):
 *  - un livello che ha innescato si riarma solo quando ES se ne e' allontanato
 *    di RIARMO_PUNTI e sono passati RIARMO_LIVELLO_MS: col solo riarmo a tempo
 *    R1 OB e' stato rianalizzato 5 volte in un'ora e il GEX+ 7, tutte "arrivi"
 *    finti. Rigiocando il 29/10 sull'R1 OB: 15 inneschi a 4 punti, 7 a 8
 *    punti, 6 a 8 punti + 15 minuti (ES ci ha oscillato intorno di +-5 per ore);
 *  - GEX+/GEX- contano solo se fermi sullo stesso strike da GEX_FERMO_MS e
 *    prima delle FINE_GEX_NY: nell'ultima ora la gamma 0DTE si concentra
 *    sull'ATM e il GEX+ segue il prezzo (7700 -> 7720 in 30 minuti);
 *  - solo a cash aperto (la pagina): dopo le 16:00 NY SPX e opzioni sono fermi
 *    e l'AI non ha dati;
 *  - l'innesco dice da che parte arriva ES e se e' il secondo contatto.
 *
 * Le frecce del giorno stanno in localStorage, cosi' restano dopo un reload;
 * ogni segnale e' comunque nel log del server (.tmp/ai-signals.jsonl).
 */
import type { Bias } from './aiSignal';

export const DISTANZA_PUNTI = 1;
export const RIARMO_MS = 5 * 60_000;
/** Un punto piu' vecchio di cosi' non e' il prezzo di adesso (cache, storico): non innesca. */
export const PUNTO_RECENTE_MS = 2 * 60_000;
/** Un livello che ha innescato torna armato quando ES se ne allontana di tanto. */
export const RIARMO_PUNTI = 8;
/** E non prima di tanto dal suo innesco. */
export const RIARMO_LIVELLO_MS = 15 * 60_000;
/** GEX+/GEX- innescano solo se sullo stesso strike da almeno tanto. */
export const GEX_FERMO_MS = 15 * 60_000;
/** E solo prima di quest'ora di New York. */
export const FINE_GEX_NY = '15:00';

export interface LivelloTracciato {
    nome: string;
    valore: number;
}

export interface FrecciaAi {
    /** L'etichetta HH:MM:SS del punto del grafico in cui e' scattata. */
    time: string;
    esf: number;
    livello: LivelloTracciato;
    /** null finche' l'analisi e' in corso. */
    bias: Bias | null;
    confidenza?: number;
    errore?: string;
}

const chiaveFrecce = (giorno: string) => `aiFrecce_${giorno}`;
const chiaveScarichi = (giorno: string) => `aiLivelliScarichi_${giorno}`;
/** Condiviso fra le schede aperte: una sola analisi per innesco anche con due /market. */
const CHIAVE_ULTIMO = 'aiInnescoUltimo';
export const CHIAVE_AUTO = 'aiAutoLivelli';

export function leggiFrecce(giorno: string): FrecciaAi[] {
    try {
        const v = JSON.parse(localStorage.getItem(chiaveFrecce(giorno)) ?? '[]');
        return Array.isArray(v) ? v : [];
    } catch {
        return [];
    }
}

export function salvaFrecce(giorno: string, frecce: FrecciaAi[]) {
    try {
        localStorage.setItem(chiaveFrecce(giorno), JSON.stringify(frecce));
    } catch {
        // storage pieno o bloccato: le frecce restano solo in memoria
    }
}

/** Un livello che ha innescato, con l'istante dell'innesco. */
export interface Scarico extends LivelloTracciato {
    quando: number;
}

/** I livelli che hanno gia' innescato e non sono ancora riarmati (condivisi fra le schede). */
export function leggiScarichi(giorno: string): Scarico[] {
    try {
        const v = JSON.parse(localStorage.getItem(chiaveScarichi(giorno)) ?? '[]');
        return Array.isArray(v) ? v : [];
    } catch {
        return [];
    }
}

export function salvaScarichi(giorno: string, scarichi: Scarico[]) {
    try {
        localStorage.setItem(chiaveScarichi(giorno), JSON.stringify(scarichi));
    } catch {
        // solo in memoria
    }
}

/**
 * Toglie dagli scarichi quelli da cui ES si e' allontanato di RIARMO_PUNTI dopo
 * almeno RIARMO_LIVELLO_MS. Basta un'uscita: chi si e' allontanato e torna
 * vicino resta armato.
 */
export function riarma(esf: number, adesso: number, scarichi: Scarico[]): Scarico[] {
    return scarichi.filter((s) => Math.abs(esf - s.valore) < RIARMO_PUNTI || adesso - s.quando < RIARMO_LIVELLO_MS);
}

/** Uno scarico vale per il livello con lo stesso nome rimasto li' (un GEX che cambia strike e' un altro livello). */
const scarico = (l: LivelloTracciato, scarichi: Scarico[]) =>
    scarichi.some((s) => s.nome === l.nome && Math.abs(s.valore - l.valore) < RIARMO_PUNTI);

/** Prende il turno se il riarmo e' passato; false se un'altra scheda (o questa) ha innescato da meno di RIARMO_MS. */
export function prendiTurno(adesso: number): boolean {
    try {
        const ultimo = Number(localStorage.getItem(CHIAVE_ULTIMO) ?? 0);
        if (adesso - ultimo < RIARMO_MS) return false;
        localStorage.setItem(CHIAVE_ULTIMO, String(adesso));
    } catch {
        // senza storage vale solo il controllo della pagina
    }
    return true;
}

/** Il livello tracciato e armato piu' vicino entro DISTANZA_PUNTI, o null. */
export function livelloToccato(esf: number, livelli: LivelloTracciato[], scarichi: Scarico[] = []): LivelloTracciato | null {
    let migliore: LivelloTracciato | null = null;
    for (const l of livelli) {
        if (scarico(l, scarichi)) continue;
        const d = Math.abs(esf - l.valore);
        if (d <= DISTANZA_PUNTI && (!migliore || d < Math.abs(esf - migliore.valore))) migliore = l;
    }
    return migliore;
}

/** Come ES e' arrivato al livello, per l'AI: se ci arriva dal basso e' una resistenza, dall'alto un supporto. */
export interface Arrivo {
    lato: 'da sotto' | 'da sopra';
    /** ES 10 minuti fa. */
    esf10m: number;
    /** La distanza massima dal livello negli ultimi 30 minuti, in punti. */
    distanzaMax30m: number;
    /** 1 = primo arrivo oggi su questo livello. */
    contatto: number;
}

export function descriviArrivo(
    punti: { time: string; esf: number | null }[], livello: LivelloTracciato, frecce: FrecciaAi[],
): Arrivo | null {
    const sec = (t: string) => {
        const [h, m, s] = t.split(':').map(Number);
        return h * 3600 + m * 60 + (s || 0);
    };
    const validi = punti.filter((p): p is { time: string; esf: number } => p.esf !== null);
    const ultimo = validi[validi.length - 1];
    if (!ultimo) return null;
    const ora = sec(ultimo.time);
    const p10 = [...validi].reverse().find((p) => sec(p.time) <= ora - 600) ?? validi[0];
    const recenti = validi.filter((p) => sec(p.time) >= ora - 1800);
    return {
        // Al pari si guarda il punto piu' lontano della mezz'ora.
        lato: p10.esf !== livello.valore
            ? (p10.esf < livello.valore ? 'da sotto' : 'da sopra')
            : (Math.min(...recenti.map((p) => p.esf)) < livello.valore ? 'da sotto' : 'da sopra'),
        esf10m: p10.esf,
        distanzaMax30m: Math.round(Math.max(...recenti.map((p) => Math.abs(p.esf - livello.valore))) * 100) / 100,
        contatto: 1 + frecce.filter((f) => f.livello.nome === livello.nome && Math.abs(f.livello.valore - livello.valore) < RIARMO_PUNTI).length,
    };
}

const COLORE: Record<Bias, string> = { LONG: '#22c55e', SHORT: '#ef4444', NEUTRALE: '#94a3b8' };

/** Disegna le frecce di `chart.$frecceAi` sulla linea di ES (asse y-right, x a categorie). */
export const frecceAiPlugin = {
    id: 'frecceAi',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    afterDatasetsDraw: (chart: any) => {
        const frecce: FrecciaAi[] | undefined = chart.$frecceAi;
        const x = chart.scales.x;
        const y = chart.scales['y-right'];
        if (!frecce?.length || !x || !y) return;
        const labels: string[] = chart.data.labels ?? [];
        const area = chart.chartArea;
        const ctx: CanvasRenderingContext2D = chart.ctx;
        ctx.save();
        ctx.beginPath();
        ctx.rect(area.left, area.top, area.right - area.left, area.bottom - area.top);
        ctx.clip();
        for (const f of frecce) {
            const i = labels.indexOf(f.time);
            if (i < 0) continue;
            const px = x.getPixelForValue(i);
            const py = y.getPixelForValue(f.esf);
            if (px < area.left || px > area.right) continue;
            const s = 7;
            ctx.lineWidth = 1;
            ctx.strokeStyle = '#0b0d12';
            if (f.bias === 'LONG' || f.bias === 'SHORT') {
                // LONG sotto il prezzo che punta in su, SHORT sopra che punta in giu'.
                const su = f.bias === 'LONG';
                const punta = su ? py + 4 : py - 4;
                const base = su ? punta + 2 * s : punta - 2 * s;
                ctx.fillStyle = COLORE[f.bias];
                ctx.beginPath();
                ctx.moveTo(px, punta);
                ctx.lineTo(px - s, base);
                ctx.lineTo(px + s, base);
                ctx.closePath();
                ctx.fill();
                ctx.stroke();
            } else if (f.bias === 'NEUTRALE') {
                ctx.fillStyle = COLORE.NEUTRALE;
                ctx.beginPath();
                ctx.moveTo(px, py - s);
                ctx.lineTo(px + s, py);
                ctx.lineTo(px, py + s);
                ctx.lineTo(px - s, py);
                ctx.closePath();
                ctx.fill();
                ctx.stroke();
            } else {
                // In corso (viola vuoto) o fallita (grigio vuoto).
                ctx.strokeStyle = f.errore ? '#64748b' : '#c084fc';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.arc(px, py, s - 1, 0, Math.PI * 2);
                ctx.stroke();
            }
        }
        ctx.restore();
    },
};
