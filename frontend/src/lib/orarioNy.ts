/**
 * Gli orari del cash americano (apertura 9:30, range Opening Bell alle 9:35,
 * chiusura 16:00) sono di New York, e Italia e Stati Uniti non cambiano l'ora
 * lo stesso giorno: fra l'ultima domenica di ottobre e la prima di novembre (e
 * due-tre settimane a marzo) il cash apre alle 14:30 italiane e non alle
 * 15:30. Scritti fissi in ora italiana, quei giorni range e apertura erano
 * un'ora dopo il vero.
 *
 * Tutto in ora di Roma, come i `time` 'HH:MM:SS' scritti dai poller: vale
 * anche sul server, che su Vercel gira in UTC.
 */

/** Scarto in minuti di un fuso da UTC in un dato istante. */
function scarto(fuso: string, istante: Date): number {
    const parti = Object.fromEntries(
        new Intl.DateTimeFormat('en-US', {
            timeZone: fuso, hourCycle: 'h23',
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
        }).formatToParts(istante).map((p) => [p.type, p.value]),
    );
    const comeUtc = Date.UTC(+parti.year, +parti.month - 1, +parti.day, +parti.hour, +parti.minute, +parti.second);
    return Math.round((comeUtc - istante.getTime()) / 60000);
}

/** Un orario di New York ('HH:MM') di oggi, in minuti da mezzanotte in ora di Roma. */
export function minutiRomaDaNy(hhmm: string, adesso: Date = new Date()): number {
    const [h, m] = hhmm.split(':').map(Number);
    const differenza = scarto('Europe/Rome', adesso) - scarto('America/New_York', adesso);
    return h * 60 + m + differenza;
}

/** Come `minutiRomaDaNy`, nel formato 'HH:MM:SS' dei `time` dei poller. */
export function oraRomaDaNy(hhmm: string, adesso: Date = new Date()): string {
    const minuti = minutiRomaDaNy(hhmm, adesso);
    const hh = (n: number) => String(n).padStart(2, '0');
    return `${hh(Math.floor(minuti / 60))}:${hh(minuti % 60)}:00`;
}
