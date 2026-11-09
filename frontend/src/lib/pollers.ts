import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

// Next runs from `frontend/`, i poller vivono nella root del repo.
const ROOT_DIR = path.join(process.cwd(), '..');
const LOCK_FILE = path.join(ROOT_DIR, '.tmp', 'pollers.lock');
const LOG_DIR = path.join(ROOT_DIR, '.tmp', 'poller-logs');

/**
 * `script` e' la chiave nel lock (per i tre poller il percorso, come prima),
 * `args` cio' che segue `python -u`, `firma` il pezzo di riga di comando che
 * prova che il processo e' davvero quello, `log` il nome del file di log.
 */
type Poller = { script: string; args: string[]; firma: string; log: string };
const POLLERS: Poller[] = [
    ...['execution/tws_poller.py', 'execution/tws_volumes_poller.py', 'execution/tws_iv_poller.py'].map((s) => ({
        script: s, args: [s], firma: path.basename(s), log: path.basename(s, '.py'),
    })),
    // Scanner SPX 0-90 DTE per /spx-scanner (dal 09/11/2026 parte da solo come
    // i poller): `scansiona` legge i volumi a cicli di 10 minuti con poche
    // linee, `trade` i singoli trade dallo storico tick. Fuori orario aspettano.
    ...['scansiona', 'trade'].map((cmd) => ({
        script: `spx_flow_scanner ${cmd}`, args: ['-m', 'spx_flow_scanner.main', cmd],
        firma: `spx_flow_scanner.main ${cmd}`, log: `spx_flow_scanner_${cmd}`,
    })),
];
const POLLER_SCRIPTS = POLLERS.map((p) => p.script);

/**
 * Un poller vivo scrive sul suo log ogni 10-16 secondi. Lo scanner no (un
 * ciclo ogni 10 minuti, 5 a mercato chiuso): per lui il battito non e' una
 * prova, e conta solo la riga di comando.
 */
const HEARTBEAT_MS = 3 * 60 * 1000;

type LockEntry = { pid: number; script: string };
type Lock = { processes: LockEntry[]; startedAt: string };
/** Formato vecchio: solo i PID, senza sapere quale script fosse quale. */
type LegacyLock = { pids: number[]; startedAt: string };

function pollerDi(script: string): Poller | undefined {
    return POLLERS.find((p) => p.script === script);
}

function logFileFor(script: string): string {
    return path.join(LOG_DIR, `${pollerDi(script)?.log ?? path.basename(script, '.py')}.log`);
}

/** Il segnale 0 non viene inviato: serve solo a verificare che il PID esista. */
function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/**
 * Riga di comando dei PID indicati, per capire *cosa* siano davvero.
 * Windows ricicla i PID in fretta: senza questo controllo il lock di ieri
 * puntava a un PID che oggi era di Chrome, i poller risultavano "gia' attivi"
 * e non ripartivano piu' (giornata intera senza dati).
 * Ritorna null se non siamo riusciti a interrogare il sistema.
 */
function commandLines(pids: number[]): Map<number, string> | null {
    if (pids.length === 0) return new Map();
    try {
        const filter = pids.map((p) => `ProcessId=${p}`).join(' or ');
        const out =
            process.platform === 'win32'
                ? execFileSync(
                      'powershell',
                      [
                          '-NoProfile',
                          '-NonInteractive',
                          '-Command',
                          `Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { "$($_.ProcessId)|$($_.CommandLine)" }`,
                      ],
                      { encoding: 'utf8', timeout: 15000, windowsHide: true },
                  )
                : execFileSync('ps', ['-o', 'pid=,args=', '-p', pids.join(',')], {
                      encoding: 'utf8',
                      timeout: 15000,
                  });

        const map = new Map<number, string>();
        for (const line of out.split('\n')) {
            const match = line.trim().match(/^(\d+)[|\s]\s*(.*)$/);
            if (match) map.set(Number(match[1]), match[2]);
        }
        return map;
    } catch (err: unknown) {
        // `ps` esce 1 quando nessuno dei PID esiste: non e' un guasto.
        const status = (err as { status?: number }).status;
        if (process.platform !== 'win32' && status === 1) return new Map();
        return null;
    }
}

function readLock(): LockEntry[] {
    try {
        const raw = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')) as Partial<Lock & LegacyLock>;
        if (Array.isArray(raw.processes)) {
            return raw.processes.filter((e) => typeof e?.pid === 'number');
        }
        if (Array.isArray(raw.pids)) {
            return raw.pids.map((pid) => ({ pid, script: '' }));
        }
        return [];
    } catch {
        return [];
    }
}

function writeLock(entries: LockEntry[]): void {
    const lock: Lock = { processes: entries, startedAt: new Date().toISOString() };
    fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
    fs.writeFileSync(LOCK_FILE, JSON.stringify(lock, null, 2));
}

/** Il poller ha scritto sul suo log di recente? Prova indiretta ma affidabile. */
function heartbeatFresh(script: string): boolean {
    try {
        return Date.now() - fs.statSync(logFileFor(script)).mtimeMs < HEARTBEAT_MS;
    } catch {
        return false;
    }
}

/**
 * Poller di cui abbiamo la *prova* che stiano girando: script -> PID.
 * Un PID vivo non basta, deve essere davvero il nostro processo Python.
 */
export function runningPollers(): Map<string, number> {
    const found = new Map<string, number>();
    const alive = readLock().filter((e) => isAlive(e.pid));
    if (alive.length === 0) return found;

    const cmds = commandLines(alive.map((e) => e.pid));

    for (const entry of alive) {
        if (cmds === null) {
            // Sistema non interrogabile: ripieghiamo sul battito del log, che
            // e' comunque piu' solido del semplice "il PID esiste".
            if (entry.script && !entry.script.startsWith('spx_flow_scanner') && heartbeatFresh(entry.script)) {
                found.set(entry.script, entry.pid);
            }
            continue;
        }
        const cmd = cmds.get(entry.pid);
        if (!cmd) continue;
        // Lo script vero lo dice la riga di comando: vale anche per i lock
        // vecchi, che il PID lo registravano senza dire a chi appartenesse.
        const poller = POLLERS.find((p) => cmd.includes(p.firma));
        if (poller) found.set(poller.script, entry.pid);
    }

    return found;
}

/** PID registrati nel lock che risultano ancora vivi *e* nostri. */
export function runningPollerPids(): number[] {
    return [...runningPollers().values()];
}

export type StartResult = {
    started: boolean;
    pids: number[];
    message: string;
};

function spawnPoller(script: string): number | null {
    // Senza questo l'output finiva in 'ignore': un push su Supabase che
    // falliva restava invisibile per mesi. Ora ogni poller ha il suo log.
    const fd = fs.openSync(logFileFor(script), 'a');
    fs.writeSync(fd, `\n=== avvio ${new Date().toISOString()} ===\n`);

    // `-u` disattiva il buffering di Python, altrimenti il log resta
    // vuoto finche' il buffer non si riempie.
    const child = spawn('python', ['-u', ...(pollerDi(script)?.args ?? [script])], {
        cwd: ROOT_DIR,
        detached: true,
        stdio: ['ignore', fd, fd],
    });
    // spawn non lancia in modo sincrono se `python` non e' nel PATH.
    child.on('error', (err) => {
        console.error(`[pollers] impossibile avviare ${script}:`, err.message);
    });
    child.unref();
    // Il figlio ha la sua copia del descrittore: qui possiamo chiuderlo.
    fs.closeSync(fd);
    return child.pid ?? null;
}

/**
 * Avvia i poller mancanti come processi detached.
 * Senza `force` riavvia solo quelli che non risultano vivi: niente duplicati a
 * ogni restart del dev server, ma se ne muore uno solo (TWS che cade) quello
 * riparte senza aspettare che muoiano entrambi.
 */
export function startPollers({ force = false } = {}): StartResult {
    fs.mkdirSync(LOG_DIR, { recursive: true });

    const running = force ? new Map<string, number>() : runningPollers();
    const toStart = POLLER_SCRIPTS.filter((s) => !running.has(s));

    if (toStart.length === 0) {
        const pids = [...running.values()];
        return {
            started: false,
            pids,
            message: `Poller gia' attivi (PID ${pids.join(', ')})`,
        };
    }

    const entries: LockEntry[] = [...running.entries()].map(([script, pid]) => ({ pid, script }));
    const avviati: string[] = [];
    for (const script of toStart) {
        const pid = spawnPoller(script);
        if (pid) {
            entries.push({ pid, script });
            avviati.push(`${path.basename(script)} (PID ${pid})`);
        }
    }

    writeLock(entries);

    return {
        started: avviati.length > 0,
        pids: entries.map((e) => e.pid),
        message: `Poller avviati: ${avviati.join(', ')} - log in .tmp/poller-logs/`,
    };
}
