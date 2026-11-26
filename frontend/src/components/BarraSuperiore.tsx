'use client';

/**
 * Barra fissata in alto su tutte le pagine (richiesta utente 26/11/2026): logo "Market Monitor"
 * piccolo a sinistra, i tasti delle pagine su una riga al centro, gli orologi Roma/New York a destra.
 * Prima stava solo dentro /market. Nascosta su login e sulla pagina iniziale.
 * Altezza = --barra-h (globals.css), usata dalle pagine a tutto schermo per togliersela.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

const PAGINE: { href: string; nome: string; titolo?: string }[] = [
  { href: '/market', nome: 'MARKET' },
  { href: '/gex', nome: 'GEX' },
  { href: '/spx-volumes', nome: 'VOLUMI SPX' },
  { href: '/hedging-pressure', nome: 'MARKET MAKER' },
  { href: '/spx-scanner', nome: 'SCANNER 3D', titolo: 'Singoli trade da almeno 500 contratti sulle opzioni SPX 0-90 DTE, in 3D' },
  { href: '/market-tide', nome: 'MARKET TIDE' },
  { href: '/bookmap', nome: 'BOOKMAP' },
  { href: '/iv-monitor', nome: 'IV MONITOR' },
  { href: '/operativita', nome: "OPERATIVITA'" },
  { href: '/sbilanciamento', nome: 'SBILANCIAMENTO', titolo: "Call sopra contro put sotto alla stessa distanza dall'ATM, SPX 0DTE (in prova)" },
  { href: '/flusso-greche', nome: 'FLUSSO GRECHE', titolo: 'Comp/Vend Lee-Ready per strike con DEX, Gamma, Vanna, Charm e Max Change, SPX 0DTE (in prova)' },
  { href: '/linea-alta', nome: 'LINEA ALTA', titolo: "Verifica: la linea piu' alta della serie di MARKET MAKER contro ES" },
  { href: '/livelli-azionari', nome: 'LIVELLI AZIONARI', titolo: "Straddle e livelli L1/L2/L3 di un'azione sulle 3 scadenze più vicine, da IBKR (solo locale)" },
  { href: '/vendita-opzioni', nome: 'VENDITA OPZIONI', titolo: 'Put e call da vendere a ~45 giorni sui titoli in portafoglio, con la IV rispetto al suo anno (solo locale)' },
  { href: '/dax', nome: 'DAX' },
];

/** Roma e New York, aggiornati ogni secondo; vuoti fino al montaggio (niente differenze server/client). */
function Orologi() {
  const [adesso, setAdesso] = useState<Date | null>(null);
  useEffect(() => {
    const tick = () => setAdesso(new Date());
    const primo = setTimeout(tick, 0);
    const id = setInterval(tick, 1000);
    return () => { clearTimeout(primo); clearInterval(id); };
  }, []);
  const ora = (tz: string) => adesso
    ? adesso.toLocaleTimeString('it-IT', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '--:--:--';
  const giorno = (tz: string) => adesso
    ? adesso.toLocaleDateString('it-IT', { timeZone: tz, weekday: 'short', day: '2-digit', month: '2-digit' })
    : '';
  return (
    <div className="shrink-0 flex items-center gap-4">
      {([['ROMA', 'Europe/Rome', 'text-blue-400'], ['NY', 'America/New_York', 'text-orange-400']] as const)
        .map(([nome, tz, colore]) => (
          <div key={tz} className="flex items-baseline gap-1.5" title={giorno(tz)}>
            <span className="text-[10px] font-bold tracking-widest text-slate-500">{nome}</span>
            <span className={`text-base font-bold tabular-nums ${colore}`}>{ora(tz)}</span>
          </div>
        ))}
    </div>
  );
}

export default function BarraSuperiore() {
  const percorso = usePathname() ?? '';
  if (percorso === '/' || percorso.startsWith('/login')) return null;
  const attiva = (href: string) => percorso === href || percorso.startsWith(href + '/');
  return (
    <header className="sticky top-0 z-50 h-[var(--barra-h)] bg-[#0c0d10]/95 backdrop-blur border-b border-slate-800 px-3 flex items-center gap-4 font-sans">
      <Link href="/market" className="shrink-0 text-base font-bold leading-none bg-gradient-to-r from-blue-400 to-orange-400 bg-clip-text text-transparent whitespace-nowrap"
        title="VIX & S&P 500 Futures — ODD LOGIC">
        Market Monitor
      </Link>
      {/* Tutti su una riga: se lo spazio non basta scorre in orizzontale (mx-auto centra
          senza tagliare il bordo sinistro, che justify-center renderebbe irraggiungibile) */}
      <nav className="flex-1 min-w-0 overflow-x-auto flex">
        <div className="mx-auto flex flex-nowrap shrink-0 bg-slate-900 border border-slate-700 rounded-lg p-0.5">
          {PAGINE.map((p) => (
            <Link key={p.href} href={p.href} title={p.titolo}
              className={`px-2 py-0.5 text-[11px] font-bold rounded whitespace-nowrap ${attiva(p.href) ? 'bg-slate-700 text-white' : 'text-slate-500 hover:text-white'}`}>
              {p.nome}
            </Link>
          ))}
        </div>
      </nav>
      <Orologi />
    </header>
  );
}
