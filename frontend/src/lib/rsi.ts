/**
 * RSI classico (Wilder) di ES per il pannello sotto il grafico di /market.
 *
 * Si calcola su barre di `barraMin` minuti costruite dai punti della pagina
 * (uno ogni ~15 s): la chiusura della barra e' l'ultimo punto che ci cade.
 * La barra in corso e' "provvisoria" come su qualunque piattaforma: ogni punto
 * mostra l'RSI che si avrebbe se la barra chiudesse li'.
 *
 * I segnali sono quelli classici all'uscita dalla zona (RSI che riscende sotto
 * la soglia alta = massimo, che risale sopra la bassa = minimo). Con
 * `immediato` (predefinito dal 13/11/2026, su richiesta) la freccia va sul
 * punto in cui l'RSI provvisorio esce dalla zona, senza aspettare la chiusura
 * della barra, al massimo una per tipo per barra; una volta segnata resta.
 * Altrimenti solo a barra chiusa.
 *
 * Valori di partenza da `execution/studio_rsi_swing.py` (13/11/2026): barra
 * 1 minuto, periodo 5, soglie 20/80. Sugli swing di ES da 10 punti (35 sedute
 * locali) prende un pivot il 19-20% delle volte contro il 9-10% di segnali a
 * orari casuali, e lo stesso nella meta' di conferma; il classico 14 30/70 ne
 * prende meno (F1 0,16 contro 0,24). Su SPX a 5 minuti 2023-26 vince ancora
 * il periodo 5 con soglie larghe. Segna bene gli estremi, ma il movimento di
 * ES nel verso del segnale a 15/30 minuti e' nullo o negativo fuori campione:
 * descrive gli swing, non li anticipa.
 *
 * `studio_rsi_swing.py --immediato` (37 sedute, punti da 15 s): il segnale
 * immediato segna meglio gli swing (1m RSI 5 20/80: F1 0,30-0,31 contro
 * 0,23-0,24 a barra chiusa, in entrambe le meta'; 25/75 0,32) ma arriva prima
 * e da operare va peggio (primo fra +4/-4: 49% vinte, -0,32 punti contro
 * -0,16). 10/90: un quarto dei segnali, F1 piu' bassa, conferma negativa.
 *
 * Con `soloLivelli` (predefinito, 13/11/2026 su richiesta) restano solo i
 * segnali con ES entro LIVELLO_PUNTI da un livello disegnato: le linee
 * orizzontali di `chart.$etichette` (range, 0γ GEXBot/Cboe) e, al momento del
 * segnale, GEX+/GEX- e la traccia 0γ se visibili. Le linee dei range valgono
 * per tutta la giornata: un segnale prima delle 15:35 vicino a un R OB e'
 * filtrato con un livello che allora non c'era ancora.
 */

/** Distanza massima, in punti ES, fra il prezzo del segnale e un livello. */
export const LIVELLO_PUNTI = 2;

export interface ImpostazioniRsi {
    barraMin: number;
    periodo: number;
    basso: number;
    alto: number;
    /** Segnale al punto in cui l'RSI provvisorio esce dalla zona, non a barra chiusa. */
    immediato: boolean;
    /** Tenere solo i segnali entro LIVELLO_PUNTI da un livello disegnato. */
    soloLivelli: boolean;
}

export const RSI_PREDEFINITO: ImpostazioniRsi = { barraMin: 1, periodo: 5, basso: 20, alto: 80, immediato: true, soloLivelli: true };

export interface SegnaleRsi {
    /** Indice del punto: dove l'RSI esce dalla zona, o l'ultimo della barra chiusa. */
    indice: number;
    /** +1 minimo (uscita dalla zona bassa), -1 massimo. */
    tipo: 1 | -1;
}

export interface CalcoloRsi {
    valori: (number | null)[];
    segnali: SegnaleRsi[];
}

function minuto(t: string): number {
    const [h, m] = t.split(':');
    return Number(h) * 60 + Number(m);
}

export function calcolaRsi(
    punti: { time: string; esf: number | null }[],
    { barraMin, periodo, basso, alto, immediato }: ImpostazioniRsi,
): CalcoloRsi {
    const valori: (number | null)[] = new Array(punti.length).fill(null);
    const segnali: SegnaleRsi[] = [];
    const n = Math.max(2, Math.round(periodo));
    const b = Math.max(1, Math.round(barraMin));

    let barraCorrente: number | null = null;
    let ultimoIndiceBarra = -1;
    let chiusuraBarra: number | null = null;
    let chiusuraPrec: number | null = null;   // chiusura dell'ultima barra chiusa
    let barreChiuse = 0;
    let somSu = 0, somGiu = 0;                // somme per il seme (prime n differenze)
    let mediaSu = 0, mediaGiu = 0;
    let rsiPrec: number | null = null;        // RSI dell'ultima barra chiusa
    let rsiPunto: number | null = null;       // RSI provvisorio del punto prima
    let fattiMax = false, fattiMin = false;   // segnali immediati gia' dati nella barra

    const rsiDa = (su: number, giu: number) => (giu === 0 ? (su === 0 ? 50 : 100) : 100 - 100 / (1 + su / giu));

    const chiudi = () => {
        if (chiusuraBarra === null) return;
        if (chiusuraPrec !== null) {
            const d = chiusuraBarra - chiusuraPrec;
            const diffAssorbite = barreChiuse; // questa e' la differenza numero barreChiuse
            if (diffAssorbite <= n) {
                somSu += Math.max(d, 0);
                somGiu += Math.max(-d, 0);
                if (diffAssorbite === n) {
                    mediaSu = somSu / n;
                    mediaGiu = somGiu / n;
                }
            } else {
                mediaSu = (mediaSu * (n - 1) + Math.max(d, 0)) / n;
                mediaGiu = (mediaGiu * (n - 1) + Math.max(-d, 0)) / n;
            }
            if (diffAssorbite >= n) {
                const r = rsiDa(mediaSu, mediaGiu);
                // rodaggio di 2n barre come nello studio
                if (!immediato && rsiPrec !== null && barreChiuse >= 2 * n) {
                    if (rsiPrec >= alto && r < alto) segnali.push({ indice: ultimoIndiceBarra, tipo: -1 });
                    else if (rsiPrec <= basso && r > basso) segnali.push({ indice: ultimoIndiceBarra, tipo: 1 });
                }
                rsiPrec = r;
            }
        }
        chiusuraPrec = chiusuraBarra;
        barreChiuse += 1;
    };

    for (let i = 0; i < punti.length; i++) {
        const p = punti[i];
        if (p.esf === null || p.esf === undefined || !p.time) continue;
        const barra = Math.floor(minuto(p.time) / b);
        if (barraCorrente !== null && barra !== barraCorrente) {
            chiudi();
            fattiMax = fattiMin = false;
        }
        barraCorrente = barra;
        chiusuraBarra = p.esf;
        ultimoIndiceBarra = i;
        // valore provvisorio: le medie come se la barra chiudesse adesso
        if (chiusuraPrec !== null && barreChiuse > n) {
            const r = rsiDa(
                (mediaSu * (n - 1) + Math.max(p.esf - chiusuraPrec, 0)) / n,
                (mediaGiu * (n - 1) + Math.max(chiusuraPrec - p.esf, 0)) / n,
            );
            valori[i] = r;
            if (immediato && rsiPunto !== null && barreChiuse >= 2 * n) {
                if (rsiPunto >= alto && r < alto && !fattiMax) {
                    segnali.push({ indice: i, tipo: -1 });
                    fattiMax = true;
                } else if (rsiPunto <= basso && r > basso && !fattiMin) {
                    segnali.push({ indice: i, tipo: 1 });
                    fattiMin = true;
                }
            }
            rsiPunto = r;
        }
    }
    return { valori, segnali };
}

/** Quello che il plugin legge da `chart.$rsi` (null = pannello spento). */
export interface DatiRsiChart extends CalcoloRsi {
    impostazioni: ImpostazioniRsi;
    canvas: HTMLCanvasElement | null;
    /** Disegnare i triangoli dei segnali sulla linea di ES. */
    segniSuPrezzo: boolean;
}

const COLORE_LINEA = '#a78bfa';

/** Indici del grafico di /market con livelli che cambiano nel tempo: GEX+, GEX-, traccia 0γ. */
const DATASET_LIVELLI = [6, 7, 9];

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- come gli altri plugin di /market
function segnaliDaMostrare(chart: any, d: DatiRsiChart): SegnaleRsi[] {
    if (!d.impostazioni.soloLivelli) return d.segnali;
    const es = chart.data.datasets[0]?.data as (number | null)[] | undefined;
    if (!es) return [];
    const fissi: number[] = ((chart.$etichette ?? []) as { valore: number }[])
        .map((e) => e.valore).filter((v) => Number.isFinite(v));
    const mobili = DATASET_LIVELLI
        .map((k) => chart.data.datasets[k])
        .filter((ds) => ds && !ds.hidden)
        .map((ds) => ds.data as (number | null)[]);
    return d.segnali.filter((s) => {
        const prezzo = es[s.indice];
        if (prezzo === null || prezzo === undefined) return false;
        if (fissi.some((v) => Math.abs(v - prezzo) <= LIVELLO_PUNTI)) return true;
        return mobili.some((serie) => {
            const v = serie[s.indice];
            return v !== null && v !== undefined && Math.abs(v - prezzo) <= LIVELLO_PUNTI;
        });
    });
}
const COLORE_MAX = '#ef4444';
const COLORE_MIN = '#22c55e';

/**
 * Disegna l'RSI su un canvas separato sotto il grafico, usando la scala x del
 * grafico principale: ogni ridisegno (dati, zoom, pan, mirino) ridisegna anche
 * il pannello, quindi i due restano allineati senza sincronizzare niente.
 * I segnali vanno anche sulla linea di ES (triangolo rosso sopra i massimi,
 * verde sotto i minimi).
 */
export const rsiPlugin = {
    id: 'rsiPannello',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- come gli altri plugin di /market
    afterDatasetsDraw: (chart: any) => {
        const d: DatiRsiChart | null | undefined = chart.$rsi;
        if (!d || !d.segniSuPrezzo || !d.segnali.length) return;
        const segnali = segnaliDaMostrare(chart, d);
        const es = chart.data.datasets[0]?.data as (number | null)[] | undefined;
        const x = chart.scales.x;
        const y = chart.scales['y-right'];
        if (!es || !x || !y) return;
        const { ctx, chartArea } = chart;
        ctx.save();
        ctx.beginPath();
        ctx.rect(chartArea.left, chartArea.top, chartArea.right - chartArea.left, chartArea.bottom - chartArea.top);
        ctx.clip();
        for (const s of segnali) {
            if (s.indice < x.min - 1 || s.indice > x.max + 1) continue;
            const v = es[s.indice];
            if (v === null || v === undefined) continue;
            const px = x.getPixelForValue(s.indice);
            const py = y.getPixelForValue(v);
            const o = s.tipo === -1 ? -9 : 9;      // sopra i massimi, sotto i minimi
            const punta = s.tipo === -1 ? 4 : -4;  // il vertice guarda il prezzo
            ctx.fillStyle = s.tipo === -1 ? COLORE_MAX : COLORE_MIN;
            ctx.beginPath();
            ctx.moveTo(px, py + o + punta);
            ctx.lineTo(px - 4, py + o - punta);
            ctx.lineTo(px + 4, py + o - punta);
            ctx.closePath();
            ctx.fill();
        }
        ctx.restore();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    afterDraw: (chart: any) => {
        const d: DatiRsiChart | null | undefined = chart.$rsi;
        const cv = d?.canvas;
        if (!d || !cv) return;
        const dpr = window.devicePixelRatio || 1;
        const larg = chart.width;
        const alt = cv.clientHeight || 120;
        if (cv.width !== Math.round(larg * dpr) || cv.height !== Math.round(alt * dpr)) {
            cv.width = Math.round(larg * dpr);
            cv.height = Math.round(alt * dpr);
            cv.style.width = `${larg}px`;
        }
        const ctx = cv.getContext('2d');
        if (!ctx) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, larg, alt);

        const x = chart.scales.x;
        const { left, right } = chart.chartArea;
        const top = 6, bottom = alt - 6;
        const yv = (v: number) => bottom - (v / 100) * (bottom - top);
        const { basso, alto, periodo, barraMin } = d.impostazioni;

        // zone e livelli
        ctx.fillStyle = 'rgba(239, 68, 68, 0.07)';
        ctx.fillRect(left, yv(100), right - left, yv(alto) - yv(100));
        ctx.fillStyle = 'rgba(34, 197, 94, 0.07)';
        ctx.fillRect(left, yv(basso), right - left, yv(0) - yv(basso));
        ctx.lineWidth = 1;
        ctx.font = '10px Arial';
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        for (const [v, col, tratto] of [[alto, 'rgba(239,68,68,0.6)', [4, 3]], [50, 'rgba(148,163,184,0.35)', [2, 4]], [basso, 'rgba(34,197,94,0.6)', [4, 3]]] as const) {
            ctx.strokeStyle = col;
            ctx.setLineDash(tratto as unknown as number[]);
            ctx.beginPath();
            ctx.moveTo(left, yv(v) + 0.5);
            ctx.lineTo(right, yv(v) + 0.5);
            ctx.stroke();
            ctx.fillStyle = '#94a3b8';
            ctx.fillText(String(v), right + 6, yv(v));
        }
        ctx.setLineDash([]);
        ctx.strokeStyle = 'rgba(51, 65, 85, 0.6)';
        ctx.strokeRect(left + 0.5, top + 0.5, right - left - 1, bottom - top - 1);

        // linea
        ctx.save();
        ctx.beginPath();
        ctx.rect(left, 0, right - left, alt);
        ctx.clip();
        const i0 = Math.max(0, Math.floor(x.min) - 1);
        const i1 = Math.min(d.valori.length - 1, Math.ceil(x.max) + 1);
        ctx.strokeStyle = COLORE_LINEA;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        let aperto = false;
        for (let i = i0; i <= i1; i++) {
            const v = d.valori[i];
            if (v === null || v === undefined) { aperto = false; continue; }
            const px = x.getPixelForValue(i);
            if (!aperto) { ctx.moveTo(px, yv(v)); aperto = true; } else ctx.lineTo(px, yv(v));
        }
        ctx.stroke();
        for (const s of segnaliDaMostrare(chart, d)) {
            if (s.indice < i0 || s.indice > i1) continue;
            const v = d.valori[s.indice];
            if (v === null || v === undefined) continue;
            ctx.fillStyle = s.tipo === -1 ? COLORE_MAX : COLORE_MIN;
            ctx.beginPath();
            ctx.arc(x.getPixelForValue(s.indice), yv(v), 3, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();

        // titolo e ultimo valore
        let ultimo: number | null = null;
        for (let i = Math.min(d.valori.length - 1, Math.floor(x.max)); i >= 0; i--) {
            const v = d.valori[i];
            if (v !== null && v !== undefined) { ultimo = v; break; }
        }
        ctx.textAlign = 'left';
        ctx.fillStyle = '#94a3b8';
        ctx.fillText(`RSI ${periodo} · ${barraMin}m · ${basso}/${alto} · ${d.impostazioni.immediato ? 'immediato' : 'a chiusura'}${d.impostazioni.soloLivelli ? ` · solo a ${LIVELLO_PUNTI} pt dai livelli` : ''}`, left + 6, top + 8);
        if (ultimo !== null) {
            const col = ultimo >= alto ? COLORE_MAX : ultimo <= basso ? COLORE_MIN : COLORE_LINEA;
            const ty = Math.min(Math.max(yv(ultimo), top + 7), bottom - 7);
            ctx.fillStyle = col;
            ctx.fillRect(right + 2, ty - 7, 34, 14);
            ctx.fillStyle = '#0c0d10';
            ctx.fillText(ultimo.toFixed(1), right + 5, ty);
        }

        // mirino: verticale e valore sotto il cursore
        const cr = chart.crosshair;
        if (cr && cr.x >= left && cr.x <= right) {
            ctx.strokeStyle = 'rgba(255,255,255,0.5)';
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(cr.x + 0.5, top);
            ctx.lineTo(cr.x + 0.5, bottom);
            ctx.stroke();
            ctx.setLineDash([]);
            const i = Math.round(x.getValueForPixel(cr.x));
            const v = d.valori[i];
            if (v !== null && v !== undefined) {
                const t = v.toFixed(1);
                const w = ctx.measureText(t).width + 8;
                ctx.fillStyle = '#2a2e39';
                ctx.fillRect(cr.x - w / 2, yv(v) - 8, w, 16);
                ctx.fillStyle = '#d1d4dc';
                ctx.textAlign = 'center';
                ctx.fillText(t, cr.x, yv(v));
            }
        }
    },
};
