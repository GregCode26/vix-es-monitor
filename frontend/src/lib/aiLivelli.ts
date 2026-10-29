/**
 * Analisi AI avviata dal prezzo: quando ES arriva a DISTANZA_PUNTI da un
 * livello tracciato su /market (range R1/R2/R3 e GEX+/GEX-), la pagina chiama
 * /api/ai-signal da sola e segna sulla linea del prezzo una freccia col
 * risultato: verde LONG, rossa SHORT, grigia NEUTRALE. Poi aspetta RIARMO_MS
 * prima di poter ripartire, qualunque sia il livello.
 *
 * Le frecce del giorno stanno in localStorage, cosi' restano dopo un reload;
 * ogni segnale e' comunque nel log del server (.tmp/ai-signals.jsonl).
 */
import type { Bias } from './aiSignal';

export const DISTANZA_PUNTI = 1;
export const RIARMO_MS = 5 * 60_000;
/** Un punto piu' vecchio di cosi' non e' il prezzo di adesso (cache, storico): non innesca. */
export const PUNTO_RECENTE_MS = 2 * 60_000;

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

/** Il livello tracciato piu' vicino entro DISTANZA_PUNTI, o null. */
export function livelloToccato(esf: number, livelli: LivelloTracciato[]): LivelloTracciato | null {
    let migliore: LivelloTracciato | null = null;
    for (const l of livelli) {
        const d = Math.abs(esf - l.valore);
        if (d <= DISTANZA_PUNTI && (!migliore || d < Math.abs(esf - migliore.valore))) migliore = l;
    }
    return migliore;
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
