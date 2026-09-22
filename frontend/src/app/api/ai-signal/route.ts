import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { oraRoma, riassumi, SCHEMA_SEGNALE, SYSTEM_PROMPT, type Segnale } from '@/lib/aiSignal';

/**
 * POST /api/ai-signal — bias su ES (LONG/SHORT/NEUTRALE) da Claude, a titolo di studio.
 * GET  /api/ai-signal — solo il riassunto che verrebbe mandato al modello (gratis, per controllarlo).
 *
 * Legge le altre route di questa stessa app, ne fa un riassunto compatto
 * (lib/aiSignal.ts) e lo passa al modello con uno schema di output fisso.
 * Va chiamata su richiesta o al massimo ogni qualche minuto: ogni chiamata
 * scarica la serie di /api/market da Supabase e costa una richiesta al modello.
 *
 * Senza ANTHROPIC_API_KEY passa da `claude -p` (Claude Code), cioè dall'abbonamento.
 *
 * Ogni segnale viene aggiunto a .tmp/ai-signals.jsonl insieme al prezzo di ES,
 * così più avanti si può misurare se ci ha preso. Su Vercel la scrittura fallisce
 * in silenzio.
 */

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const MODEL = 'claude-opus-5';
const LOG_FILE = path.join(process.cwd(), '..', '.tmp', 'ai-signals.jsonl');

async function leggi<T>(origin: string, percorso: string): Promise<T | null> {
    try {
        const res = await fetch(`${origin}${percorso}`, { cache: 'no-store', signal: AbortSignal.timeout(30_000) });
        return res.ok ? ((await res.json()) as T) : null;
    } catch {
        return null;
    }
}

async function raccogli(origin: string) {
    // ?since= dove la route lo supporta: l'IV monitor pesa ~8 MB a sessione intera.
    const [latest, storia, gex, iv, tide, hedging] = await Promise.all([
        leggi<Record<string, unknown>>(origin, '/api/market'),
        leggi<{ history: Record<string, unknown>[] }>(origin, '/api/market?history=true'),
        leggi<Parameters<typeof riassumi>[0]['gex']>(origin, '/api/gex?flow=0'),
        leggi<Parameters<typeof riassumi>[0]['iv']>(origin, `/api/iv-monitor?since=${oraRoma(16)}`),
        leggi<Parameters<typeof riassumi>[0]['tide']>(origin, `/api/market-tide?since=${oraRoma(31)}`),
        leggi<Record<string, unknown>>(origin, '/api/hedging-pressure'),
    ]);

    if (!latest && !storia?.history?.length) return null;
    const riassunto = riassumi({
        market: { latest: latest as never, history: (storia?.history ?? []) as never },
        gex, iv, tide, hedging,
    });
    return { riassunto, esf: (latest as { esf?: number } | null)?.esf ?? null, gex: !!gex, hedging: !!hedging };
}

const NESSUN_DATO = { error: 'Nessun dato di mercato disponibile: i poller girano?' };

export async function GET(request: Request) {
    const raccolto = await raccogli(new URL(request.url).origin);
    if (!raccolto) return NextResponse.json(NESSUN_DATO, { status: 503 });
    return NextResponse.json(raccolto.riassunto);
}

type Esito = { segnale: Segnale; modello: string; usage: { input: number; output: number } };

class ErroreSegnale extends Error {
    constructor(message: string, readonly status: number) { super(message); }
}

/** Con una chiave API: chiamata diretta, pagata a consumo. */
async function viaApi(riassunto: unknown): Promise<Esito> {
    const client = new Anthropic();
    try {
        const risposta = await client.beta.messages.create({
            model: MODEL,
            max_tokens: 16000,
            thinking: { type: 'adaptive' },
            // Se i classificatori rifiutano, il server ripete la richiesta sul modello di riserva.
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default',
            output_config: { format: { type: 'json_schema', schema: SCHEMA_SEGNALE } },
            system: SYSTEM_PROMPT,
            messages: [{ role: 'user', content: `Dati attuali:\n${JSON.stringify(riassunto)}` }],
        });
        if (risposta.stop_reason === 'refusal') throw new ErroreSegnale('Il modello ha rifiutato la richiesta.', 502);
        if (risposta.stop_reason === 'max_tokens') throw new ErroreSegnale('Risposta troncata (max_tokens).', 502);
        const testo = risposta.content.find((b) => b.type === 'text');
        if (!testo || testo.type !== 'text') throw new ErroreSegnale('Risposta senza testo.', 502);
        return {
            segnale: JSON.parse(testo.text) as Segnale,
            modello: risposta.model,
            usage: { input: risposta.usage.input_tokens, output: risposta.usage.output_tokens },
        };
    } catch (err) {
        if (err instanceof Anthropic.AuthenticationError) throw new ErroreSegnale('Chiave Anthropic non valida.', 503);
        if (err instanceof Anthropic.RateLimitError) throw new ErroreSegnale('Limite di richieste Anthropic raggiunto, riprova tra poco.', 429);
        if (err instanceof Anthropic.APIError) throw new ErroreSegnale(`Errore API Anthropic: ${err.message}`, 502);
        throw err;
    }
}

/** Il server parte da un task pianificato, senza il PATH della shell: si cerca l'installazione nativa. */
function claudeCli(): string {
    if (process.env.CLAUDE_CLI) return process.env.CLAUDE_CLI;
    const nativo = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
    return fs.existsSync(nativo) ? nativo : 'claude';
}

/**
 * Senza chiave API: `claude -p` di Claude Code, che usa il login dell'abbonamento.
 * Funziona solo in locale (su Vercel non c'è il CLI). Nessun tool, nessun setting
 * né CLAUDE.md di progetto (gira in una cartella temporanea), nessuna sessione salvata.
 */
function viaClaudeCode(riassunto: unknown): Promise<Esito> {
    const args = [
        '-p',
        '--output-format', 'json',
        '--tools', '',
        '--setting-sources', '',
        '--strict-mcp-config',
        '--no-session-persistence',
        '--system-prompt', SYSTEM_PROMPT,
        '--json-schema', JSON.stringify(SCHEMA_SEGNALE),
    ];
    return new Promise((resolve, reject) => {
        const proc = spawn(claudeCli(), args, { cwd: os.tmpdir(), windowsHide: true });
        let out = '';
        let err = '';
        const timer = setTimeout(() => proc.kill(), 110_000);
        proc.stdout.on('data', (d) => (out += d));
        proc.stderr.on('data', (d) => (err += d));
        proc.on('error', (e) => {
            clearTimeout(timer);
            reject(new ErroreSegnale(`Claude Code non trovato (${e.message}). Installalo o imposta ANTHROPIC_API_KEY.`, 503));
        });
        proc.on('close', (code) => {
            clearTimeout(timer);
            try {
                const j = JSON.parse(out);
                if (j.is_error || !j.structured_output) {
                    return reject(new ErroreSegnale(`Claude Code: ${j.result || j.api_error_status || 'nessun output strutturato'}`, 502));
                }
                resolve({
                    segnale: j.structured_output as Segnale,
                    modello: Object.keys(j.modelUsage ?? {})[0] ?? 'claude-code',
                    usage: { input: j.usage?.input_tokens ?? 0, output: j.usage?.output_tokens ?? 0 },
                });
            } catch {
                reject(new ErroreSegnale(`Claude Code è uscito con codice ${code}: ${(err || out).slice(0, 300)}`, 502));
            }
        });
        proc.stdin.end(`Dati attuali:\n${JSON.stringify(riassunto)}`);
    });
}

export async function POST(request: Request) {
    const raccolto = await raccogli(new URL(request.url).origin);
    if (!raccolto) return NextResponse.json(NESSUN_DATO, { status: 503 });
    const { riassunto } = raccolto;

    const conChiave = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
    let esito: Esito;
    try {
        esito = conChiave ? await viaApi(riassunto) : await viaClaudeCode(riassunto);
    } catch (err) {
        const status = err instanceof ErroreSegnale ? err.status : 500;
        return NextResponse.json({ error: (err as Error).message }, { status });
    }

    const voce = {
        creato: new Date().toISOString(),
        ora: riassunto.oraRoma,
        esf: raccolto.esf,
        modello: esito.modello,
        via: conChiave ? 'api' : 'claude-code',
        fonti: {
            gex: raccolto.gex, iv: !!riassunto.ivSpx0dte, tide: !!riassunto.marketTide, hedging: raccolto.hedging,
        },
        usage: esito.usage,
        segnale: esito.segnale,
    };
    try {
        fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
        fs.appendFileSync(LOG_FILE, JSON.stringify(voce) + '\n');
    } catch {
        // Vercel: filesystem in sola lettura, pazienza.
    }
    return NextResponse.json(voce);
}
