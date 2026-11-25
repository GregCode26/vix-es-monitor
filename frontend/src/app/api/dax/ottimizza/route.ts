import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { cercaCombinazioni, type Candidato, type CatenaScadenza } from '@/lib/daxOttimizza';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * POST /api/dax/ottimizza — la combinazione piu' conveniente per la strategia DAX.
 *  1. `dax_quote.py` modo "catena": put ODAX delle scadenze trimestrali a 75-150 giorni (IBKR)
 *  2. `cercaCombinazioni`: tutte le combinazioni con le regole del video, prezzi all'ask/bid
 *  3. Claude confronta le migliori (con supporti, skew e registro cicli) e ne sceglie una
 * La pagina /dax la preimposta in STUDIO. Solo locale (serve TWS).
 * Senza ANTHROPIC_API_KEY passa da `claude -p` (Claude Code), cioe' dall'abbonamento.
 */

const esegui = promisify(execFile);
const ROOT = path.join(process.cwd(), '..');
const SCRIPT = path.join(ROOT, 'execution', 'dax_quote.py');
const MODEL = 'claude-opus-5-5';

const SYSTEM_PROMPT = `Sei un analista di opzioni sull'indice DAX (ODAX, europee, moltiplicatore 5 EUR come il mini future FDXM) e aiuti un trader a scegliere la prossima apertura della sua strategia.

La strategia (dal metodo del suo insegnante, lezione del 18/11/2026):
- Struttura ribassista con un lato coperto: due put spread comprati finanziati interamente da put vendute molto piu' lontane. Se il DAX sale si perde ~0, se scende si guadagna; payoff a scadenza: piatto fino alla comprata del V1, sale fino alla sua venduta, piatto fino alla comprata del V2, sale fino alla sua venduta, massimo fino alle put vendute.
- Solo ODAX su scadenze TRIMESTRALI (terzo venerdi' di mar/giu/set/dic): li' ci sono volumi, open interest e la catena di strike piu' profonda (serve per vendere lontano e per rollare). Mai le giornaliere/settimanali (ODAP, venerdi' intermedi): spread larghi e senza market maker nei crolli.
- Scadenza: ideale ~3 mesi (90 giorni). Aprire a ~4 mesi (~120 giorni) va bene e anzi aiuta: quando scade la trimestrale precedente questa diventa la prima e decade di piu'. Le aperture passate sono state fatte intorno alla scadenza della trimestrale precedente (19/03/25 su giugno, 10/06/25 su settembre, 15/12/25 su marzo, 27/02/26 su giugno, 14/05/26 su settembre, 02/09/26 su dicembre).
- Sovrapposizione: si puo' aprire la nuova mentre la vecchia ha ancora ~1 mese: gli spread della vecchia fanno da cuscinetto in caso di ribasso nell'ultimo mese (e' gia' successo che pagassero). Le vendute vecchie che valgono 3-4 punti si possono ricomprare, gli spread si tengono.
- V1: put spread largo 500, comprata ~5% sotto lo spot (24500/24000 con il DAX a 25.755-25.836). Costa di solito 87-98 punti (paghi ~90-100 per farne 400-500: 400 punti di DAX = 2.000 EUR).
- V2: put spread largo 1000-1300 (21500/20200 nell'ultima versione, era 1000 a febbraio 2026), comprata ~16-17% sotto, mirata a supporti, minimi e gap ancora da chiudere del grafico.
- Put vendute: "sempre intorno al 40%" sotto lo spot (16600/16400 a settembre 2026 = -36/-37%; 15600 a novembre = -39%). In tutto 5 (in passato 6, una volta 10): non esagerare, con 6 la curva a oggi si piega verso il basso. Possono stare su uno strike o divise (3+2, 2+4); se in apertura si va in rosso si vende lo strike un po' piu' alto (15800 invece di 15600) per incassare di piu'.
- Costo netto, commissioni comprese, ~0: lui apre a -5/-6 punti di credito (25-30 EUR) che pagano i ~22 EUR di commissioni (9-10 opzioni x 2,50).
- Equilibrio delle greche: |vega| / theta intorno a 4 e non oltre (73,7/19,5 = 3,8 bene; 4,7 con una venduta in piu' no): vega troppo alto rispetto al theta incassato e' pericoloso perche' nei crolli la IV delle put lontane esplode (42 -> 60). La curva a oggi deve restare sopra lo zero anche se il DAX comincia a scendere.
- Quando entrare: sui massimi/doppi massimi del DAX ("cerco sempre di prenderle un po' sui top"), con la IV vicino allo spot bassa e quella delle put lontane alta (skew ripido). Storico IV ATM all'apertura: 18,7 / 16,0 / 14,5 / 15,3 / 18,3 / 15,9; IV della venduta lontana 39,97-43,6. Con il mercato chiuso o gli spread bid/ask larghi non si apre.
- Gestione: ideale che nel primo mese il DAX resti fra l'apertura e la prima comprata. Si chiude in anticipo in guadagno (dicembre 2026: aperta 02/09, chiusa 01/10 a +499,50; obiettivo tipico 500-1.000 EUR). Se il mercato sale il guadagno puo' arrivare comunque (~200 EUR) perche' le vendute lontane perdono delta e valore prima degli spread. Il V1 anche se bucato presto vale ~250 dei 500: si valuta di rollarlo piu' in basso incassando.
- Crolli: aprile 2025 (-20% in pochi giorni) e 5 agosto: -2.000 EUR non realizzati fra margine e perdita, nessuna chiusura in panico, chiusa dopo il rimbalzo a +900. Il rischio vero e' un crollo oltre le put vendute, con i market maker che allargano gli spread.
- Capitale: margine ~1.100-1.600 EUR su WeBank (su IBKR molto di piu'), servono almeno 10.000 EUR sul conto.

Ricevi i dati di mercato attuali (prezzi IBKR reali, si compra all'ask e si vende al bid, commissioni 2,50 EUR per opzione incluse nel netto), l'eventuale strategia ancora aperta e una lista di candidati gia' calcolati con le regole sopra (con theta/vega e P&L a oggi a -5%/-10% e a -10% con IV +10). Scegli il candidato migliore per QUESTO trader, pesando: aderenza alle regole, netto ~0 o credito, vega/theta <= 4, curva a oggi sopra zero, guadagno massimo, pareggio sotto e perdita in un crollo (-40%/-45%), supporti indicati per il V2, skew attuale contro i cicli passati, giorni alla scadenza (preferisci 90-130), sovrapposizione con la strategia aperta. Non inventare candidati: scegli fra quelli dati per id. Rispondi in italiano, conciso e concreto, citando i numeri.`;

const SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['scelta', 'seconda', 'motivazione', 'rischi', 'quando_entrare'],
    properties: {
        scelta: { type: 'integer', description: 'id del candidato scelto' },
        seconda: { type: 'integer', description: 'id della seconda scelta' },
        motivazione: { type: 'string', description: 'perche\' questo candidato, 3-6 frasi con i numeri' },
        rischi: { type: 'string', description: 'rischi principali e cosa sorvegliare, 2-4 frasi' },
        quando_entrare: { type: 'string', description: 'se aprire ora o aspettare (skew, IV, livelli), 1-3 frasi' },
    },
} as const;

interface Scelta { scelta: number; seconda: number; motivazione: string; rischi: string; quando_entrare: string }

class ErroreOttimizza extends Error {
    constructor(message: string, readonly status: number) { super(message); }
}

async function viaApi(contenuto: string): Promise<{ scelta: Scelta; modello: string }> {
    const client = new Anthropic();
    try {
        const stream = client.beta.messages.stream({
            model: MODEL,
            max_tokens: 32000,
            thinking: { type: 'adaptive' },
            output_config: { effort: 'high', format: { type: 'json_schema', schema: SCHEMA } },
            // Se i classificatori rifiutano, il server ripete la richiesta sul modello di riserva.
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default',
            system: SYSTEM_PROMPT,
            messages: [{ role: 'user', content: contenuto }],
        });
        const risposta = await stream.finalMessage();
        if (risposta.stop_reason === 'refusal') throw new ErroreOttimizza('Il modello ha rifiutato la richiesta.', 502);
        if (risposta.stop_reason === 'max_tokens') throw new ErroreOttimizza('Risposta troncata (max_tokens).', 502);
        const testo = risposta.content.find((b) => b.type === 'text');
        if (!testo || testo.type !== 'text') throw new ErroreOttimizza('Risposta senza testo.', 502);
        return { scelta: JSON.parse(testo.text) as Scelta, modello: risposta.model };
    } catch (err) {
        if (err instanceof Anthropic.AuthenticationError) throw new ErroreOttimizza('Chiave Anthropic non valida.', 503);
        if (err instanceof Anthropic.RateLimitError) throw new ErroreOttimizza('Limite di richieste Anthropic raggiunto, riprova tra poco.', 429);
        if (err instanceof Anthropic.APIError) throw new ErroreOttimizza(`Errore API Anthropic: ${err.message}`, 502);
        throw err;
    }
}

function claudeCli(): string {
    if (process.env.CLAUDE_CLI) return process.env.CLAUDE_CLI;
    const nativo = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
    return fs.existsSync(nativo) ? nativo : 'claude';
}

/** Senza chiave API: `claude -p` con il login dell'abbonamento, senza tool ne' impostazioni di progetto. */
function viaClaudeCode(contenuto: string): Promise<{ scelta: Scelta; modello: string }> {
    const args = [
        '-p', '--output-format', 'json', '--tools', '', '--setting-sources', '',
        '--strict-mcp-config', '--no-session-persistence',
        '--system-prompt', SYSTEM_PROMPT, '--json-schema', JSON.stringify(SCHEMA),
    ];
    return new Promise((resolve, reject) => {
        const proc = spawn(claudeCli(), args, { cwd: os.tmpdir(), windowsHide: true });
        let out = '';
        let err = '';
        const timer = setTimeout(() => proc.kill(), 240_000);
        proc.stdout.setEncoding('utf8'); // un carattere accentato spezzato fra due blocchi non si rovina
        proc.stderr.setEncoding('utf8');
        proc.stdout.on('data', (d) => (out += d));
        proc.stderr.on('data', (d) => (err += d));
        proc.on('error', (e) => {
            clearTimeout(timer);
            reject(new ErroreOttimizza(`Claude Code non trovato (${e.message}). Installalo o imposta ANTHROPIC_API_KEY.`, 503));
        });
        proc.on('close', (code) => {
            clearTimeout(timer);
            try {
                const j = JSON.parse(out);
                if (j.is_error || !j.structured_output) {
                    return reject(new ErroreOttimizza(`Claude Code: ${j.result || j.api_error_status || 'nessun output strutturato'}`, 502));
                }
                resolve({ scelta: j.structured_output as Scelta, modello: Object.keys(j.modelUsage ?? {})[0] ?? 'claude-code' });
            } catch {
                reject(new ErroreOttimizza(`Claude Code e' uscito con codice ${code}: ${(err || out).slice(0, 300)}`, 502));
            }
        });
        proc.stdin.end(contenuto);
    });
}

const t1 = (v: number | null | undefined, d = 1) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

/** Un candidato in forma compatta per il modello. */
function compatto(c: Candidato) {
    return {
        id: c.id, scadenza: c.scadenza, dte: c.dte,
        gambe: c.gambe.map(g => `${g.qta > 0 ? '+' : ''}${g.qta} P${g.strike} @${g.prezzo} (IV ${t1(g.iv)})`).join(', '),
        costoV1: t1(c.costoV1), costoV2: t1(c.costoV2), larghezze: `${c.larghezzaV1}/${c.larghezzaV2}`,
        incassoVendute: t1(c.incassoVendute), nettoPunti: t1(c.nettoPunti), commissioniEur: c.commissioniEur,
        maxGuadagnoEur: Math.round(c.maxGuadagnoEur), zonaMax: c.zonaMax,
        pareggioSotto: t1(c.beGiu, 0), pareggioPct: t1(c.beGiuPct), distanzaVendutePct: t1(c.distVendutePct),
        perditaA40Eur: Math.round(c.perdita40Eur), perditaA45Eur: Math.round(c.perdita45Eur),
        probSottoPareggio: c.pSottoBe != null ? `${t1(c.pSottoBe * 100)}%` : null,
        putVendute: c.nVendute, distanzaV1Pct: t1(c.distV1Pct), distanzaV2Pct: t1(c.distV2Pct),
        thetaEurGiorno: t1(c.thetaEur), vegaEur: t1(c.vegaEur), vegaSuTheta: t1(c.vegaTheta, 2),
        oggiA5Eur: Math.round(c.oggiMeno5Eur), oggiA10Eur: Math.round(c.oggiMeno10Eur), oggiA10ConIvPiu10Eur: Math.round(c.oggiMeno10IvEur),
    };
}

export async function POST(req: NextRequest) {
    if (process.env.VERCEL) return NextResponse.json({ errore: 'Funziona solo in locale' }, { status: 400 });
    const corpo = await req.json().catch(() => ({}));
    const tasso = Number(corpo?.tasso) || 2.05;
    const commOpzioni = Number(corpo?.commOpzioni) || 2.5;
    const moltOpzioni = Number(corpo?.moltOpzioni) || 5;
    const supporti: number[] = Array.isArray(corpo?.supporti) ? corpo.supporti.filter((x: unknown) => typeof x === 'number').slice(0, 20) : [];
    const registro = Array.isArray(corpo?.registro) ? corpo.registro.slice(-10) : [];
    const aperta = Array.isArray(corpo?.aperta) ? corpo.aperta.slice(0, 20) : [];

    // 1. catena da IBKR
    let dati: { errore?: string; spot: number; fonteSpot: string; catene: CatenaScadenza[] };
    try {
        const richiesta = { modo: 'catena', dteMin: 75, dteMax: 150, classeFuture: corpo?.classeFuture ?? 'FDXM' };
        const { stdout } = await esegui('python', ['-u', SCRIPT, JSON.stringify(richiesta)], { cwd: ROOT, timeout: 240_000, windowsHide: true });
        dati = JSON.parse(stdout.trim().split('\n').pop() ?? '{}');
    } catch (err) {
        return NextResponse.json({ errore: `Lettura IBKR non riuscita: ${err instanceof Error ? err.message : err}` }, { status: 500 });
    }
    if (dati.errore) return NextResponse.json({ errore: dati.errore }, { status: 502 });

    // 2. combinazioni
    const { candidati, provate } = cercaCombinazioni(dati.catene, dati.spot, { tasso, commOpzioni, moltOpzioni, massimo: 12 });
    if (!candidati.length) return NextResponse.json({ errore: 'Nessuna combinazione finanziabile con i prezzi attuali', provate }, { status: 422 });

    // 3. Claude
    const mercato = {
        oggi: new Date().toISOString().slice(0, 10),
        dax: dati.spot, fonteDax: dati.fonteSpot,
        scadenze: dati.catene.map(c => ({
            scadenza: c.scadenza, dte: c.dte, ivAtm: c.atm.iv,
            skewPut: c.put.filter(p => p.iv != null).map(p => `${p.strike} (${t1((p.strike / dati.spot - 1) * 100)}%): IV ${t1(p.iv)} bid/ask ${p.bid}/${p.ask}`),
        })),
        supportiGapIndicatiDalTrader: supporti,
        cicliPassati: registro,
        strategiaAncoraAperta: aperta.length ? aperta : 'nessuna',
        notaSovrapposizione: 'se la strategia aperta scade fra meno di ~40 giorni, aprire la nuova ora la sovrappone (cuscinetto)',
    };
    const contenuto = `Mercato attuale:\n${JSON.stringify(mercato)}\n\nCandidati (${candidati.length} su ${provate} combinazioni provate, scelti per fasce di distanza delle put vendute):\n${JSON.stringify(candidati.map(compatto))}`;
    const conChiave = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
    try {
        const { scelta, modello } = conChiave ? await viaApi(contenuto) : await viaClaudeCode(contenuto);
        return NextResponse.json({ spot: dati.spot, fonteSpot: dati.fonteSpot, provate, candidati, scelta, modello, ora: new Date().toISOString() });
    } catch (err) {
        // senza Claude si rende comunque la lista (200): la pagina la mostra con l'errore
        return NextResponse.json({ spot: dati.spot, fonteSpot: dati.fonteSpot, provate, candidati, scelta: null, erroreClaude: (err as Error).message, ora: new Date().toISOString() });
    }
}
