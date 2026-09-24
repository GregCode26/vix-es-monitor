"use client";

import React, { useEffect } from "react";
import styles from "./InfoModal.module.css";

interface InfoModalProps {
  aperto: boolean;
  onChiudi: () => void;
}

/**
 * La spiegazione della pagina, per intero.
 *
 * Sta qui e non in un README perche' le cose da sapere prima di fidarsi di un
 * numero -- che la IV e' invertita dai premi e non letta da IBKR, che il GEX
 * non c'e', che il VOLFLOW guarda 60 secondi indietro -- servono davanti al
 * grafico, non in un file che nessuno apre a mercato aperto.
 */
export const InfoModal: React.FC<InfoModalProps> = ({ aperto, onChiudi }) => {
  // Esc chiude: e' una finestra che si apre a mercato aperto, deve andarsene
  // senza cercare il bottone.
  useEffect(() => {
    if (!aperto) return;
    const suTasto = (e: KeyboardEvent) => {
      if (e.key === "Escape") onChiudi();
    };
    window.addEventListener("keydown", suTasto);
    return () => window.removeEventListener("keydown", suTasto);
  }, [aperto, onChiudi]);

  if (!aperto) return null;

  return (
    <div className={styles.overlay} onClick={onChiudi}>
      <div className={styles.finestra} onClick={(e) => e.stopPropagation()}>
        <div className={styles.intestazione}>
          <span className={styles.titolo}>Come si legge questa pagina</span>
          <button className={styles.chiudi} onClick={onChiudi}>
            CHIUDI (ESC)
          </button>
        </div>

        <div className={styles.corpo}>
          <div className={styles.sezione}>
            <h3>In una riga</h3>
            <p>
              La pagina misura la <span className={styles.chiave}>pressione delle opzioni SPX 0DTE</span>: chi sta
              comprando davvero fra call e put. Il numero in basso e&apos; il{" "}
              <span className={styles.chiave}>FLUSSO GAMMA</span>, da -100 (put) a +100 (call), ricavato dai contratti
              realmente scambiati.
            </p>
          </div>

          <div className={styles.sezione}>
            <h3>Da dove vengono i dati</h3>
            <p>
              Due rotte, entrambe gia&apos; in uso altrove. <span className={styles.chiave}>/api/market</span> per il
              prezzo e le quote ATM: lo storico del giorno una volta all&apos;apertura, poi solo l&apos;ultimo punto.{" "}
              <span className={styles.chiave}>/api/volumes</span> per la catena scambiata, che alimenta il riquadro in
              basso: si legge in modo incrementale con <code>?since=</code>, circa 2 KB a giro invece della sessione
              intera.
            </p>
            <p>
              Il poller scrive un punto ogni <span className={styles.chiave}>15-16 secondi</span>; la pagina chiede ogni 5,
              ma i punti ripetuti vengono scartati e non entrano nel calcolo.
            </p>
            <ul>
              <li>
                <span className={styles.chiave}>Prezzo</span>: <code>esf</code> (future ES), con ripiego su <code>spx</code>.
              </li>
              <li>
                <span className={styles.chiave}>Premi ATM</span>: il mid di <code>callBid/callAsk</code> e{" "}
                <code>putBid/putAsk</code> della chain SPX. La mattina presto SPX non quota ancora e si usano le gambe ES
                (<code>esCallBid</code> e compagnia).
              </li>
              <li>
                <span className={styles.chiave}>Strike ATM</span>: quello scelto dal poller, non ricalcolato qui.
              </li>
            </ul>
          </div>

          <div className={styles.sezione}>
            <h3>Come nascono IV e gamma</h3>
            <p>
              Non sono letti da IBKR: sono <span className={styles.chiave}>ricavati dai premi veri</span>. Per ogni punto si
              inverte Black-Scholes (tassi a zero, che su 0DTE valgono un centesimo di punto) separatamente sulla call e
              sulla put, per bisezione su [1%, 500%].
            </p>
            <span className={styles.formula}>
              T = tempo fino alle 22:00 CET (scadenza 0DTE), con un pavimento di 5 minuti{"\n"}
              IV call = sigma tale che BS(call, spot, strike, T, sigma) = mid della call{"\n"}
              IV put = lo stesso sulla put{"\n"}
              gamma = pdf(d1) / (spot * sigma * radice(T))
            </span>
            <p>
              Si invertono le due gambe separatamente perche&apos; e&apos; la <span className={styles.chiave}>differenza</span>{" "}
              fra IV call e IV put a portare informazione. Il campo <code>esAtmIv</code> che il poller salva e&apos; gia&apos;
              la media delle due, quindi da solo si annullerebbe. Resta come rete di sicurezza se l&apos;inversione non
              converge.
            </p>
            <p>
              Controprova fatta in sessione: IV ATM invertita dai premi SPX <span className={styles.chiave}>9.88%</span> contro{" "}
              <span className={styles.chiave}>9.98%</span> letta dai modelGreeks IBKR. Due strade indipendenti, un decimo di
              punto di scarto.
            </p>
          </div>

          <div className={styles.sezione}>
            <h3>Il riquadro in alto: prezzo</h3>
            <p>
              La linea bianca e&apos; il sottostante, un punto per ogni scrittura del poller. La riga tratteggiata con
              l&apos;etichetta <span className={styles.chiave}>SPOT</span> e&apos; l&apos;ultimo prezzo.
            </p>
            <p>
              Le righe LONG / SHORT / CALL / PUT GAMMA stanno tutte sullo strike ATM: i veri muri di gamma si calcolano dal
              profilo per strike, che vive in <code>/api/volumes</code> e questa pagina non lo scarica. Non sono livelli
              stimati, sono segnaposto.
            </p>
          </div>

          <div className={styles.sezione}>
            <h3>Il riquadro in basso: FLUSSO GAMMA</h3>
            <p>
              Misura <span className={styles.chiave}>quanto si compra in call rispetto alle put</span>, contratto per
              contratto, pesando ogni strike per il suo gamma. Va da <span className={styles.giu}>-100</span> (tutto put)
              a <span className={styles.su}>+100</span> (tutto call), con lo zero al centro.
            </p>
            <span className={styles.formula}>
              flusso = somma su tutti gli strike di: gamma * (call scambiate - put scambiate){"\n"}
              {"         "}misurate negli ultimi 30 secondi{"\n"}
              {"\n"}
              valore = z-score del flusso sulla mezz&apos;ora, tagliato a +/-3, poi EMA a 3 punti{"\n"}
              {"         "}riportato sulla scala -100 / +100
            </span>
            <p>
              I volumi sono cumulativi di giornata, quindi il flusso e&apos; la differenza fra due fotografie della catena.
              Il peso gamma conta perche&apos; e&apos; la copertura che i dealer devono inseguire: mille contratti su uno
              strike lontano muovono meno di cento sull&apos;ATM. Lo z-score sulla mezz&apos;ora serve perche&apos; il
              flusso cambia scala fra l&apos;apertura e le ore morte.
            </p>
            <ul>
              <li>
                <span className={styles.chiave}>Una barra per intervallo</span>: l&apos;altezza e&apos; la media delle
                letture di quel minuto, e il raggruppamento e&apos; il selettore TIMEFRAME in alto (1M, 5M, 15M).
              </li>
              <li>
                <span className={styles.su}>Verde sopra +10</span>, <span className={styles.giu}>rossa sotto -10</span>,{" "}
                <span className={styles.neutro}>gialla nel mezzo</span>: dentro dieci punti dallo zero e&apos; rumore.
                Senza la banda il colore cambierebbe 17.8 volte l&apos;ora, con la banda 9.4.
              </li>
              <li>
                Il <span className={styles.chiave}>baffo verticale</span> va dal minimo al massimo dell&apos;intervallo:
                dice se il minuto e&apos; stato compatto o se dentro ci si e&apos; contraddetti.
              </li>
              <li>
                Il <span className={styles.chiave}>filo bianco</span> unisce le medie: la direzione prima del colore.
              </li>
            </ul>
            <p>
              <span className={styles.chiave}>Quanto vale davvero.</span> Correlazione fra questo indicatore e il movimento
              del sottostante nel minuto successivo, misurata su cinque sessioni complete di volumi:{" "}
              <span className={styles.chiave}>+0.226</span> sul flusso grezzo, <span className={styles.chiave}>+0.182</span>{" "}
              nella forma disegnata qui, e positiva in <span className={styles.chiave}>cinque sessioni su cinque</span>
              {" "}(+0.25, +0.16, +0.17, +0.32, +0.45).
            </p>
            <p>
              Va letto per quello che e&apos;: 0.18 di correlazione spiega il <span className={styles.chiave}>3% della
              varianza</span>. Inclina le probabilita&apos;, non decide il prossimo minuto. Ma e&apos; un segnale vero, e
              questo lo distingue da quello che c&apos;era prima.
            </p>
            <div className={styles.nota}>
              Cosa e&apos; stato scartato, e perche&apos;. Prima il riquadro mostrava il VOLFLOW, costruito sulle variazioni
              dei premi ATM. Due misure lo hanno affondato: per la parita&apos; put-call le variazioni dei premi <em>sono</em>
              il movimento del prezzo (correlazione 0.953 su 1.283 intervalli da un minuto), quindi quel pannello rifaceva
              con piu&apos; rumore la linea gia&apos; disegnata sopra; e il poller ri-sceglie lo strike ATM nel 7.9% dei
              passaggi, dove il premio &quot;varia&quot; di 2.38 punti contro 0.10 a strike fermo, un salto 24 volte
              piu&apos; grande del segnale. La sua correlazione col minuto successivo era -0.03. Sono state provate anche le
              costruzioni sulla IV, sullo skew e sullo scarto dalla parita&apos;: tutte entro +/-0.05.
            </div>
          </div>

          <div className={styles.sezione}>
            <h3>La barra a destra e la riga in basso</h3>
            <p>
              La barra orizzontale e&apos; lo stesso VOLFLOW, valore corrente: zona rossa sotto 33, gialla fra 33 e 66,
              verde sopra.
            </p>
            <ul>
              <li>
                <span className={styles.chiave}>SPOT / ATM</span>: prezzo e strike ATM del momento.
              </li>
              <li>
                <span className={styles.chiave}>CALL IV / PUT IV / ATM IV</span>: le due IV invertite e la loro media.
              </li>
              <li>
                <span className={styles.chiave}>IV SPREAD</span>: put meno call. Positivo significa put piu&apos; care in
                volatilita&apos;, cioe&apos; skew a protezione; negativo e&apos; il contrario ed e&apos; meno comune.
              </li>
              <li>
                <span className={styles.chiave}>DATA</span>: REAL o MOCK. Se dice MOCK stai guardando dati generati, non il
                mercato.
              </li>
              <li>
                <span className={styles.chiave}>GAMMA PRESSURE / VOLATILITY PRESSURE / REGIME</span>: fermi a zero e a
                GAMMA STABLE. Vogliono il profilo per strike, che qui non c&apos;e&apos;.
              </li>
            </ul>
          </div>

          <div className={styles.sezione}>
            <h3>Cosa questa pagina non sa</h3>
            <ul>
              <li>
                <span className={styles.chiave}>Nessun profilo GEX per strike.</span> I volumi si leggono per ricavarne il
                flusso, ma il profilo per strike e i muri di gamma non vengono costruiti: il riquadro a destra lo dice
                invece di disegnare barre.
              </li>
              <li>
                <span className={styles.chiave}>Solo la giornata di oggi.</span> Come tutte le rotte di questo progetto: non
                esiste un parametro per le sessioni passate.
              </li>
              <li>
                <span className={styles.chiave}>Serve il poller acceso.</span> Senza TWS collegato la pagina resta in attesa
                e scrive perche&apos;.
              </li>
              <li>
                <span className={styles.chiave}>SPX/ES e timeframe non fanno nulla</span> per ora: il sottostante e&apos;
                quello che scrive il poller, e zoom e pan sull&apos;asse dei tempi non sono collegati al disegno.
              </li>
            </ul>
            <div className={styles.nota}>
              Il flusso gamma dice chi sta spingendo adesso e inclina leggermente le probabilita&apos; sul minuto
              successivo. Non e&apos; una previsione: un +80 dice che stanno comprando call con convinzione, non che il
              prezzo salira&apos;.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
