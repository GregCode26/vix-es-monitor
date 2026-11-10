using System;
using System.IO;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using TradingPlatform.BusinessLayer;

namespace GregDashboard
{
    /// <summary>
    /// La dashboard dentro Quantower, sul grafico di ES:
    ///   - i range R1/R2/R3 (Opening Bell delle 15:35 e mattino delle 10:35),
    ///     gia' in prezzi ES, da /api/market?history=true (campo `range`);
    ///   - il profilo GEX per strike a destra, da /api/gex?flow=0, con gli
    ///     strike SPX portati in ES con la base ES - SPX;
    ///   - la liquidita' limit di Bookmap come linee orizzontali nel tempo,
    ///     da /api/bookmap, con la stessa costruzione dei segmenti della pagina;
    ///   - lo smile SPX 0DTE di /market (lib/smileChart.ts) in una colonna a
    ///     sinistra del profilo GEX, da /api/smile, con le linee Spot +-1/2
    ///     sigma e il vertice IV MIN a gradini nel tempo, tutto portato in ES
    ///     con la stessa base del GEX.
    ///
    /// Non calcola niente di suo: legge le stesse API delle pagine, quindi la
    /// dashboard (npm run dev) deve girare. Le richieste stanno su un thread a
    /// parte; il disegno legge solo fotografie gia' pronte.
    /// </summary>
    public class GregDashboard : Indicator
    {
        #region Impostazioni

        [InputParameter("URL dashboard", 0)]
        public string BaseUrl = "http://localhost:3000";

        [InputParameter("Range Opening Bell (15:35)", 10)]
        public bool MostraRangeOb = true;

        [InputParameter("Range mattino (10:35)", 11)]
        public bool MostraRangeMattino = false;

        [InputParameter("Profilo GEX", 20)]
        public bool MostraGex = true;

        [InputParameter("Base GEX", 21, variants: new object[] { "Volume (flusso)", 0, "Open interest", 1, "Lee-Ready (dealer)", 2 })]
        public int BaseGex = 1;

        [InputParameter("Larghezza profilo GEX (px)", 22, 40, 600, 10, 0)]
        public int LarghezzaGex = 160;

        [InputParameter("Linee Major Pos/Neg Gamma", 23)]
        public bool MostraMajor = true;

        [InputParameter("Base ES-SPX manuale (0 = automatica)", 24, -500, 500, 0.25, 2)]
        public double BaseManuale = 0;

        [InputParameter("Liquidita' Bookmap", 30)]
        public bool MostraLiquidita = true;

        /// <summary>
        /// Heatmap: la scala termica di Bookmap, come /bookmap (lib/bookHeatmap.ts):
        /// ogni colonna di pixel e' la media dei contratti per tick nei secondi
        /// che copre, blu il book normale, arancio-bianco i muri, e un livello
        /// sfuma invece di accendersi alla soglia. Linee: i segmenti di prima.
        /// </summary>
        [InputParameter("Stile liquidita'", 29, variants: new object[] { "Heatmap (Bookmap)", 0, "Linee", 1 })]
        public int StileLiquidita = 0;

        /// <summary>Solo heatmap: sopra 1 il colore pieno arriva prima e i livelli piccoli si accendono.</summary>
        [InputParameter("Contrasto heatmap", 38, 0.3, 4, 0.05, 2)]
        public double ContrastoHeatmap = 1;

        // Il minimo e' quello dell'add-on: sotto MIN_CONTRATTI_BOOK (20) i livelli non arrivano proprio.
        [InputParameter("Soglia contratti limit", 31, 20, 5000, 1, 0)]
        public int SogliaContratti = 50;

        [InputParameter("Durata minima linea (s)", 32, 1, 600, 1, 0)]
        public int DurataMinima = 5;

        [InputParameter("Spessore linee liquidita'", 33, 0.5, 5, 0.5, 1)]
        public double SpessoreLiquidita = 1;

        /// <summary>0 = il livello piu' grosso fra quelli in vista prende il colore pieno.</summary>
        [InputParameter("Contratti per colore pieno (0 = automatico)", 35, 0, 20000, 10, 0)]
        public int ContrattiPieno = 0;

        /// <summary>0 = linee opache, 90 = quasi invisibili: lascia vedere le candele sotto.</summary>
        [InputParameter("Trasparenza liquidita' (%)", 36, 0, 90, 5, 0)]
        public int TrasparenzaLiquidita = 10;

        /// <summary>
        /// Quanto in fretta la sfumatura va verso il colore scuro: 1 = scala
        /// logaritmica com'e', sopra 1 i livelli medi si scuriscono prima, sotto
        /// 1 restano chiari e si distinguono meglio i grossi.
        /// </summary>
        [InputParameter("Intensita' colori liquidita'", 37, 0.25, 4, 0.25, 2)]
        public double IntensitaLiquidita = 1;

        [InputParameter("Alias Bookmap (vuoto = tutti)", 34)]
        public string AliasBookmap = "";

        [InputParameter("Frecce assorbimento", 40)]
        public bool MostraAssorbimenti = true;

        // Il minimo e' quello dell'add-on: sotto ASS_MIN_CONTRATTI (30) non rileva niente.
        [InputParameter("Assorbimento minimo (contratti)", 41, 30, 5000, 1, 0)]
        public int MinAssorbimento = 60;

        /// <summary>
        /// Passo 3 dell'add-on reso regolabile: secondi in cui il livello deve
        /// restare al migliore dopo l'ultimo trade. L'add-on ne controlla gia' 1;
        /// oltre si verifica qui sul bid/ask di ogni secondo, e la freccia compare
        /// solo quando la tenuta e' raggiunta. Vedi studio_assorbimenti.py.
        /// </summary>
        [InputParameter("Tenuta assorbimento (s)", 42, 1, TENUTA_MAX, 1, 0)]
        public int TenutaAssorbimento = 1;

        /// <summary>
        /// La regola trovata il 04/11/2026 su 12 sessioni (vedi CalcolaConferme): IN PROVA,
        /// da validare con execution/studio_conferma_range.py sulle sessioni nuove.
        /// </summary>
        [InputParameter("Conferma sui range OB (in prova)", 45)]
        public bool MostraConferme = true;

        // Stessa regola sulle wall GEX e sullo Zero Gamma, a richiesta (04/11/2026). Rifatta sulle
        // stesse giornate: GEX+/GEX- 28 operazioni, 43% vinte, -0,25 pt a operazione (perde);
        // Zero Gamma 30, 53%, +0,48 (t 0,8: non si sa). Il conto in basso e' separato per tipo.
        [InputParameter("Conferma anche su GEX+/GEX- (in prova)", 46)]
        public bool ConfermeGex = true;

        [InputParameter("Conferma anche sullo Zero Gamma (in prova)", 47)]
        public bool ConfermeZeroGamma = true;

        /// <summary>LONG diventa SHORT e viceversa (10/11/2026): stesso ingresso, stesso target/stop, verso opposto.
        /// Stessa cosa di execution/studio_conferma_range.py --inverti.</summary>
        [InputParameter("Conferma: inverti segnale", 48)]
        public bool InvertiConferme = false;

        [InputParameter("Smile IV (SPX 0DTE)", 50)]
        public bool MostraSmile = true;

        [InputParameter("Larghezza smile (px)", 51, 100, 400, 10, 0)]
        public int LarghezzaSmile = 180;

        [InputParameter("Linee bande chiusura 68/95% (o Spot +-1/2 sigma)", 52)]
        public bool MostraSigma = true;

        [InputParameter("Linea IV MIN", 53)]
        public bool MostraIvMin = true;

        /// <summary>
        /// Lo Zero Gamma SPX di /api/zero-gamma, portato su ES con la base:
        /// il valore di GEXBot inserito a mano su /market (linea piena) e la traccia
        /// in tempo reale dal nostro poller (gialla tratteggiata, come GEXBot); il
        /// Cboe ritardato di 15 minuti solo quando la traccia manca.
        /// </summary>
        [InputParameter("Zero Gamma (GEXBot / Cboe)", 60)]
        public bool MostraZeroGamma = true;

        #endregion

        public GregDashboard() : base()
        {
            Name = "Greg Dashboard";
            Description = "Range, profilo GEX in ES, smile SPX 0DTE e liquidita' Bookmap dalla dashboard locale";
            SeparateWindow = false;
            OnBackGround = true;
        }

        #region Stato (scritto dal thread delle richieste, letto dal disegno)

        private sealed class Livello
        {
            public double Prezzo;
            public Color Colore;
            public string Etichetta;
            public bool Tratteggiato;
        }

        private sealed class RigaGex
        {
            public double Strike;
            public double Gex;
            public double GexOi;
            public double GexLr;
        }

        private sealed class Segmento
        {
            public int Da;
            public int A;
            public double Prezzo;
            public double Contratti;
            public bool Bid;
        }

        /// <summary>Un assorbimento dell'add-on. Verso +1 = compratori passivi che assorbono le vendite.</summary>
        private sealed class Assorbimento
        {
            public int Sec;
            public double Prezzo;
            public double Contratti;
            public int Verso;
            /// <summary>Secondi dopo l'ultimo trade in cui il livello e' risultato ancora al migliore.</summary>
            public volatile int Tenuta;
            /// <summary>Il livello ha ceduto entro TENUTA_MAX: la tenuta non cresce piu'.</summary>
            public volatile bool Ceduto;
        }

        /// <summary>Un'entrata a conferma su un range OB. Esito null = ancora aperta.</summary>
        private sealed class Conferma
        {
            /// <summary>"range", "gex" o "0γ": il conto si tiene separato.</summary>
            public string Tipo;
            public string Livello;
            public double Prezzo;
            public int Tocco;
            public int Sec;
            public int Verso;
            public double Entrata;
            public double? Esito;
            public int? FineSec;
        }

        private sealed class CampioneBook
        {
            public int Sec;
            public (double prezzo, double contratti)[] B;
            public (double prezzo, double contratti)[] A;
        }

        /// <summary>Uno strike di /api/smile. IV in %, null dove scartata.</summary>
        private sealed class PuntoSmile
        {
            public double Strike;
            public double? CallIv;
            public double? PutIv;
            public double? IvOtm;
            public double? IvLiscia;
            public double? Conv;
        }

        /// <summary>L'ultima risposta di /api/smile: prezzi SPX, ore italiane.</summary>
        private sealed class DatiSmile
        {
            public string Giorno;
            public double Spot;
            public double? IvAtm;
            public double? Em;
            public double? VerticeStrike;
            public double VerticeIv;
            public double? VerticeSigma;
            public string Base;
            public bool ConZ;
            public double? ZTilt;
            public double? ZCurv;
            public double? ZAtm;
            public string Regime;
            public bool Sospeso;
            /// <summary>Dopo la chiusura: niente curva, resta solo la traccia del vertice.</summary>
            public bool Chiuso;
            public bool Est25;
            public double IvFermaSec;
            /// <summary>(secondi da mezzanotte ora locale, strike) a ogni cambio del vertice.</summary>
            public List<(int sec, double strike)> StoriaVertice;
            public List<PuntoSmile> Punti;
            /// <summary>Bande di chiusura 68/95% in prezzi SPX (vol.bande di /api/smile, lib/volContesto.ts); null = si ripiega su +-1/2 sigma.</summary>
            public double[] Bande;   // su95, su68, giu68, giu95
            public double BandaQ68Pt, BandaQ95Pt, Vix1d;
            public double? RvIv;
            /// <summary>Contesto della giornata: "GIORNATA AMPIA x1.20" e le righe delle misure.</summary>
            public string Attesa;
            public double AttesaRange;
            public List<string> VociContesto = new List<string>();
            public string UltimaRiga;
            public string Divergenza;
            public bool DivRimbalzo;
        }

        /// <summary>La traccia IV MIN di un giorno passato (/api/smile?giorni=), con la basis ES-SPX di quel giorno.</summary>
        private sealed class TracciaGiorno
        {
            public DateTime Mezzanotte;
            public double? Basis;
            public int Fine;
            public List<(int sec, double strike)> Storia;
        }

        private static readonly HttpClient http = new HttpClient { Timeout = TimeSpan.FromSeconds(20) };

        private CancellationTokenSource cts;

        private volatile List<Livello> livelliRange = new List<Livello>();
        private volatile List<RigaGex> profilo = new List<RigaGex>();
        private volatile List<Segmento> segmentiPronti = new List<Segmento>();
        /// <summary>I campioni del book per la heatmap: copia fatta dal thread delle richieste, i campioni non cambiano dopo l'arrivo.</summary>
        private volatile CampioneBook[] campioniPronti = Array.Empty<CampioneBook>();
        private volatile List<Assorbimento> assorbimentiPronti = new List<Assorbimento>();
        private volatile DatiSmile smile;
        // Le tracce dei giorni passati: si rileggono al cambio di giorno e ogni 30 minuti.
        private volatile List<TracciaGiorno> tracce = new List<TracciaGiorno>();
        private DateTime prossimeTracce = DateTime.MinValue;
        private const int GIORNI_TRACCE = 5;
        private volatile string stato = "in attesa della dashboard...";
        // Zero Gamma in prezzi SPX; NaN = assente. Double non e' volatile: si scrive tutto insieme con un array.
        private volatile double[] zeroGamma = { double.NaN, double.NaN };
        // La traccia dal poller (una lettura al minuto, ora italiana = di questo PC); null se manca.
        private volatile TracciaZeroGamma zgTraccia;

        private sealed class TracciaZeroGamma
        {
            public DateTime Mezzanotte;
            public (int sec, double valore)[] Punti;
        }

        /// <summary>Giorno (yyyy-MM-dd) dei segmenti: i secondi sono dall'inizio di quel giorno, ora locale.</summary>
        private volatile string giornoBook;

        // Base ES - SPX: misure dallo stesso snapshot del poller, come in /bookmap.
        private readonly object lockBase = new object();
        private readonly List<(int sec, double valore)> serieBase = new List<(int, double)>();
        private string giornoBase;

        // Solo il thread delle richieste tocca questi.
        private readonly List<CampioneBook> campioni = new List<CampioneBook>();
        private readonly Dictionary<(bool, double), Segmento> aperti = new Dictionary<(bool, double), Segmento>();
        private readonly List<Segmento> chiusi = new List<Segmento>();
        private readonly List<Assorbimento> assorbimenti = new List<Assorbimento>();
        /// <summary>Il mid Bookmap di ogni secondo della giornata, in ordine: serve alla conferma sui range.</summary>
        private readonly List<(int sec, double mid)> midGiorno = new List<(int, double)>();
        private volatile List<Conferma> confermePronte = new List<Conferma>();
        /// <summary>
        /// GEX+ / GEX- (strike SPX) come li ha visti l'indicatore, ogni 15 s: l'API da' solo il
        /// profilo di adesso, e rileggere la sessione intera da /api/gex vorrebbe dire scaricarla
        /// da Supabase. Si salva in un file temporaneo per ritrovarla dopo un riavvio di Quantower.
        /// </summary>
        private readonly List<(int sec, double pos, double neg)> serieGex = new List<(int, double, double)>();
        private string giornoSerieGex;
        /// <summary>Bid/ask degli ultimi secondi: un assorbimento arriva dopo il secondo a cui e' datato.</summary>
        private readonly List<(int sec, double bid, double ask)> quoteRecenti = new List<(int, double, double)>();
        private string ultimoTempoBook;
        private int sogliaUsata = -1;
        private string aliasUsato;
        private bool rangeObTrovato;
        private string giornoRange;

        #endregion

        /// <summary>Quanto tenere di book in memoria: come la pagina, tre ore a un campione al secondo.</summary>
        private const int MAX_SEC_BOOK = 3 * 3600;
        /// <summary>Due campioni piu' distanti di cosi' spezzano la linea.</summary>
        private const int BUCO_MAX_SEC = 3;
        /// <summary>Finestra della mediana della base: una lettura sola e' rumorosa (~0,4 punti).</summary>
        private const int BASE_FINESTRA_SEC = 300;
        /// <summary>Il primo caricamento del GEX chiede solo gli ultimi minuti, non la sessione.</summary>
        private const int GEX_FINESTRA_MIN = 5;
        private string giornoGex;
        private string ultimoGex;
        private const double TICK = 0.25;
        private const int TENUTA_MAX = 10;

        protected override void OnInit()
        {
            cts?.Cancel();
            cts = new CancellationTokenSource();
            var token = cts.Token;
            Task.Run(() => Ciclo(token), token);
        }

        protected override void OnUpdate(UpdateArgs args) { }

        protected override void OnClear()
        {
            cts?.Cancel();
            cts = null;
            AppDomain.CurrentDomain.SetData(CHIAVE_LIVELLI, null);
            base.OnClear();
        }

        /// <summary>
        /// Dove gli altri indicatori (ZoneFootprint) trovano i livelli chiave in
        /// prezzi ES. Sono DLL separate: si passa un double[] nell'AppDomain,
        /// che e' di tipo base e quindi leggibile da qualunque assembly.
        /// </summary>
        public const string CHIAVE_LIVELLI = "GregDashboard.LivelliChiave";

        /// <summary>I livelli accesi nelle impostazioni: range, Major Pos/Neg Gamma, IV MIN e Spot +-1/2 sigma, in ES.</summary>
        private void PubblicaLivelli()
        {
            var livelli = new List<double>();
            foreach (var l in livelliRange)
                if (l.Tratteggiato ? MostraRangeMattino : MostraRangeOb) livelli.Add(l.Prezzo);

            var b = BaseCorrente();
            if (b != null)
            {
                var righe = profilo;
                if (MostraGex && MostraMajor && righe.Count > 0)
                {
                    double Valore(RigaGex r) => BaseGex switch { 0 => r.Gex, 2 => r.GexLr, _ => r.GexOi };
                    var major = righe.OrderByDescending(Valore).First();
                    var minor = righe.OrderBy(Valore).First();
                    if (Valore(major) > 0) livelli.Add(major.Strike + b.Value);
                    if (Valore(minor) < 0) livelli.Add(minor.Strike + b.Value);
                }

                var dati = smile;
                if (MostraSmile && dati != null)
                {
                    var em = dati.Em ?? 0;
                    if (MostraSigma && dati.Bande != null)
                        foreach (var p in dati.Bande) livelli.Add(p + b.Value);
                    else if (MostraSigma && em > 0)
                        foreach (var k in new[] { -2, -1, 1, 2 }) livelli.Add(dati.Spot + k * em + b.Value);
                    var vertice = dati.StoriaVertice.Count > 0 ? dati.StoriaVertice[^1].strike : dati.VerticeStrike;
                    if (MostraIvMin && vertice != null) livelli.Add(vertice.Value + b.Value);
                }
            }

            var b0 = BaseCorrente();
            if (MostraZeroGamma && b0 != null)
                foreach (var v in zeroGamma) if (!double.IsNaN(v)) livelli.Add(v + b0.Value);

            AppDomain.CurrentDomain.SetData(CHIAVE_LIVELLI, livelli.ToArray());
        }

        #region Richieste

        private async Task Ciclo(CancellationToken token)
        {
            var prossimaMarket = DateTime.MinValue;
            var prossimoStorico = DateTime.MinValue;
            var prossimoGex = DateTime.MinValue;
            var prossimoSmile = DateTime.MinValue;
            var prossimoZg = DateTime.MinValue;
            while (!token.IsCancellationRequested)
            {
                var ora = DateTime.Now;
                var errori = new List<string>();
                try
                {
                    // Lo storico porta i range e la serie della base; una volta
                    // trovati i range OB della giornata non cambiano piu', e
                    // lo storico (~400 KB) non serve riscaricarlo.
                    if (ora >= prossimoStorico)
                    {
                        if (giornoRange != Oggi()) { rangeObTrovato = false; giornoRange = Oggi(); }
                        if (!rangeObTrovato) await LeggiStorico(token).ContinueWith(t => { if (t.IsFaulted) errori.Add("market"); });
                        prossimoStorico = ora.AddSeconds(60);
                    }
                    if (ora >= prossimaMarket)
                    {
                        await LeggiUltimaBase(token).ContinueWith(t => { if (t.IsFaulted) errori.Add("base"); });
                        prossimaMarket = ora.AddSeconds(15);
                    }
                    if (ora >= prossimoGex)
                    {
                        if (MostraGex) await LeggiGex(token).ContinueWith(t => { if (t.IsFaulted) errori.Add("gex"); });
                        if (MostraGex) RegistraGex();
                        prossimoGex = ora.AddSeconds(15);
                    }
                    // Come /market: ogni 10 s (~3 KB, solo locale).
                    if (ora >= prossimoSmile)
                    {
                        if (MostraSmile) await LeggiSmile(token).ContinueWith(t => { if (t.IsFaulted) errori.Add("smile"); });
                        if (MostraSmile && MostraIvMin && ora >= prossimeTracce)
                        {
                            await LeggiTracce(token).ContinueWith(t => { if (t.IsFaulted) errori.Add("tracce"); });
                            prossimeTracce = ora.AddMinutes(30) < DateTime.Today.AddDays(1) ? ora.AddMinutes(30) : DateTime.Today.AddDays(1);
                        }
                        prossimoSmile = ora.AddSeconds(10);
                    }
                    // Lo Zero Gamma cambia piano (Cboe ogni 5 minuti, il manuale quando lo si inserisce).
                    if (ora >= prossimoZg)
                    {
                        if (MostraZeroGamma) await LeggiZeroGamma(token).ContinueWith(t => { if (t.IsFaulted) errori.Add("zero gamma"); });
                        prossimoZg = ora.AddSeconds(60);
                    }
                    if (MostraLiquidita || MostraAssorbimenti) await LeggiBookmap(token).ContinueWith(t => { if (t.IsFaulted) errori.Add("bookmap"); });
                    PubblicaLivelli();

                    stato = errori.Count == 0 ? null : "dashboard non raggiungibile (" + string.Join(", ", errori) + ") su " + BaseUrl;
                }
                catch (Exception e)
                {
                    stato = e.Message;
                }
                try { await Task.Delay(2000, token); } catch (TaskCanceledException) { return; }
            }
        }

        private async Task LeggiZeroGamma(CancellationToken token)
        {
            using var doc = await Get("/api/zero-gamma", token);
            if (doc == null) return;
            var r = doc.RootElement;
            var manuale = r.TryGetProperty("manuale", out var m) && m.ValueKind == JsonValueKind.Object ? Numero(m, "valore") : null;
            var cboe = r.TryGetProperty("cboe", out var c) && c.ValueKind == JsonValueKind.Object ? Numero(c, "principale") : null;
            // La traccia del nostro poller (stessa definizione di GEXBot, in tempo reale): se c'e',
            // il suo ultimo valore prende il posto del Cboe ritardato di 15 minuti.
            TracciaZeroGamma traccia = null;
            if (r.TryGetProperty("poller", out var pl) && pl.ValueKind == JsonValueKind.Object
                && pl.TryGetProperty("serie", out var serie) && serie.ValueKind == JsonValueKind.Array
                && r.TryGetProperty("date", out var dt)
                && DateTime.TryParseExact(dt.GetString(), "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var mezzanotte))
            {
                var punti = new List<(int, double)>();
                foreach (var e in serie.EnumerateArray())
                    if (e.ValueKind == JsonValueKind.Array && e.GetArrayLength() >= 2)
                        punti.Add((Secondi(e[0].GetString()), e[1].GetDouble()));
                if (punti.Count > 0) traccia = new TracciaZeroGamma { Mezzanotte = mezzanotte, Punti = punti.ToArray() };
            }
            zgTraccia = traccia;
            var attuale = traccia != null ? traccia.Punti[^1].valore : cboe;
            zeroGamma = new[] { manuale ?? double.NaN, attuale ?? double.NaN };
        }

        /// <summary>Le linee dello Zero Gamma, con il nome a sinistra (a destra ci sono profilo GEX e smile).</summary>
        private void DisegnaZeroGamma(Graphics g, Rectangle area, TradingPlatform.BusinessLayer.Chart.IChartWindowCoordinatesConverter conv)
        {
            var b = BaseCorrente();
            var zg = zeroGamma;
            if (b == null) return;
            using var font = new Font("Arial", 9f, FontStyle.Bold, GraphicsUnit.Pixel);
            for (var i = 0; i < 2; i++)
            {
                var v = zg[i];
                if (double.IsNaN(v)) continue;
                // La traccia del poller, quando c'e', al posto della linea Cboe.
                if (i == 1 && zgTraccia is { } traccia) { DisegnaTracciaZeroGamma(g, area, conv, traccia, b.Value, font); continue; }
                // Il Cboe solo se diverso dal manuale di almeno mezzo punto, come nelle pagine.
                if (i == 1 && !double.IsNaN(zg[0]) && Math.Abs(v - zg[0]) < 0.5) continue;
                var y = (float)conv.GetChartY(v + b.Value);
                if (y < area.Top || y > area.Bottom) continue;
                var colore = i == 0 ? ZG_COLORE : Color.FromArgb(190, ZG_COLORE);
                using var pen = new Pen(colore, 1.5f);
                if (i == 1) pen.DashPattern = new float[] { 5, 4 };
                g.DrawLine(pen, area.Left, y, area.Right, y);
                var testo = $"{(i == 0 ? "0γ GEXBot" : "0γ Cboe")} SPX {v:0.0}";
                var dim = g.MeasureString(testo, font);
                using (var fondo = new SolidBrush(Color.FromArgb(220, 15, 23, 42)))
                    g.FillRectangle(fondo, area.Left + 4, y - dim.Height / 2 - 1, dim.Width + 4, dim.Height + 2);
                using var br = new SolidBrush(colore);
                g.DrawString(testo, font, br, area.Left + 6, y - dim.Height / 2);
            }
        }

        private static readonly Color ZG_COLORE = ColorTranslator.FromHtml("#fb923c");
        private static readonly Color ZG_TRACCIA = ColorTranslator.FromHtml("#eab308");

        /// <summary>
        /// Lo Zero Gamma nel tempo, come la linea gialla tratteggiata di GEXBot: una
        /// lettura al minuto dal poller, tutta portata su ES con la base di adesso
        /// (come la traccia IV MIN), l'ultima prolungata fino al bordo destro.
        /// </summary>
        private static void DisegnaTracciaZeroGamma(Graphics g, Rectangle area, TradingPlatform.BusinessLayer.Chart.IChartWindowCoordinatesConverter conv,
            TracciaZeroGamma traccia, double baseEs, Font font)
        {
            var punti = new List<PointF>(traccia.Punti.Length + 1);
            foreach (var (sec, valore) in traccia.Punti)
            {
                var x = (float)conv.GetChartX(Utc(traccia.Mezzanotte, sec));
                if (x < area.Left - 50 || x > area.Right + 50) continue;
                punti.Add(new PointF(x, (float)conv.GetChartY(valore + baseEs)));
            }
            var ultimo = traccia.Punti[^1].valore;
            var yU = (float)conv.GetChartY(ultimo + baseEs);
            var xU = (float)conv.GetChartX(Utc(traccia.Mezzanotte, traccia.Punti[^1].sec));
            if (xU < area.Right) punti.Add(new PointF(area.Right, yU));
            var stato = g.Save();
            g.SetClip(area);
            if (punti.Count >= 2)
            {
                using var pen = new Pen(ZG_TRACCIA, 2f) { DashPattern = new float[] { 4, 2 } };
                g.DrawLines(pen, punti.ToArray());
            }
            if (yU >= area.Top && yU <= area.Bottom)
            {
                var testo = $"0γ SPX {ultimo:0.0}";
                var dim = g.MeasureString(testo, font);
                var xT = Math.Clamp(xU + 6, area.Left + 4, area.Right - dim.Width - 8);
                using (var fondo = new SolidBrush(Color.FromArgb(220, 15, 23, 42)))
                    g.FillRectangle(fondo, xT - 2, yU - dim.Height - 3, dim.Width + 4, dim.Height + 2);
                using var br = new SolidBrush(ZG_TRACCIA);
                g.DrawString(testo, font, br, xT, yU - dim.Height - 2);
            }
            g.Restore(stato);
        }

        private async Task<JsonDocument> Get(string percorso, CancellationToken token)
        {
            var url = BaseUrl.TrimEnd('/') + percorso;
            using var res = await http.GetAsync(url, token);
            // /api/gex risponde 503 quando non c'e' ancora gamma: e' normale la mattina.
            if (!res.IsSuccessStatusCode) return null;
            var stream = await res.Content.ReadAsStreamAsync(token);
            return await JsonDocument.ParseAsync(stream, cancellationToken: token);
        }

        private static readonly (string chiave, Color colore, string nome)[] RANGE = {
            ("r1Down", ColorTranslator.FromHtml("#ef4444"), "R2↓"),
            ("r2Down", ColorTranslator.FromHtml("#f97316"), "R1↓"),
            ("r3Down", ColorTranslator.FromHtml("#facc15"), "R3↓"),
            ("r1Up", ColorTranslator.FromHtml("#3b82f6"), "R2↑"),
            ("r2Up", ColorTranslator.FromHtml("#06b6d4"), "R1↑"),
            ("r3Up", ColorTranslator.FromHtml("#10b981"), "R3↑"),
        };

        private async Task LeggiStorico(CancellationToken token)
        {
            using var doc = await Get("/api/market?history=true", token);
            if (doc == null) return;
            var root = doc.RootElement;

            if (root.TryGetProperty("history", out var storico) && storico.ValueKind == JsonValueKind.Array)
            {
                var serie = new List<(int, double)>();
                foreach (var p in storico.EnumerateArray())
                {
                    var t = Stringa(p, "time");
                    var esf = Numero(p, "esf");
                    var spx = Numero(p, "spx");
                    if (t == null || esf is not > 0 || spx is not > 0) continue;
                    var sec = Secondi(t);
                    if (!DentroCash(sec)) continue;
                    if (serie.Count > 0 && sec <= serie[^1].Item1) continue;
                    serie.Add((sec, esf.Value - spx.Value));
                }
                lock (lockBase)
                {
                    serieBase.Clear();
                    serieBase.AddRange(serie);
                    giornoBase = Oggi();
                }
            }

            var livelli = new List<Livello>();
            if (root.TryGetProperty("range", out var range) && range.ValueKind == JsonValueKind.Object)
            {
                foreach (var (sessione, suffisso, tratteggio) in new[] { ("ob", " OB", false), ("morning", " AM", true) })
                {
                    if (!range.TryGetProperty(sessione, out var s) || s.ValueKind != JsonValueKind.Object) continue;
                    if (sessione == "ob") rangeObTrovato = true;
                    foreach (var r in RANGE)
                    {
                        var v = Numero(s, r.chiave);
                        if (v is > 0)
                            livelli.Add(new Livello { Prezzo = v.Value, Colore = r.colore, Etichetta = r.nome + suffisso, Tratteggiato = tratteggio });
                    }
                }
            }
            livelliRange = livelli;
        }

        private async Task LeggiUltimaBase(CancellationToken token)
        {
            using var doc = await Get("/api/market", token);
            if (doc == null) return;
            var root = doc.RootElement;
            var t = Stringa(root, "sourceTime");
            var esf = Numero(root, "esf");
            var spx = Numero(root, "spx");
            if (t == null || esf is not > 0 || spx is not > 0) return;
            var sec = Secondi(t);
            if (!DentroCash(sec)) return;
            lock (lockBase)
            {
                if (giornoBase != Oggi()) { serieBase.Clear(); giornoBase = Oggi(); }
                if (serieBase.Count == 0 || sec > serieBase[^1].sec) serieBase.Add((sec, esf.Value - spx.Value));
            }
        }

        /// <summary>
        /// Solo le misure del cash (9:30-16:00 NY): dopo la chiusura IBKR lascia
        /// l'SPX fermo all'ultimo valore mentre ES continua, e la differenza non e'
        /// piu' la base (28/10/2026: 16,8 invece di 35 alle 22:00). Dopo la
        /// chiusura resta cosi' la base degli ultimi 5 minuti del cash.
        /// </summary>
        private static bool DentroCash(int sec) =>
            sec >= Secondi(OraLocaleDaNy(9, 30) + ":00") && sec <= Secondi(OraLocaleDaNy(16, 0) + ":00");

        /// <summary>La base in vigore adesso: mediana degli ultimi 5 minuti di misure, come /bookmap.</summary>
        private double? BaseCorrente()
        {
            if (BaseManuale != 0) return BaseManuale;
            lock (lockBase)
            {
                if (serieBase.Count == 0 || giornoBase != Oggi()) return null;
                var ultimo = serieBase[^1].sec;
                var valori = serieBase.Where(p => p.sec > ultimo - BASE_FINESTRA_SEC).Select(p => p.valore).OrderBy(v => v).ToList();
                var m = valori.Count / 2;
                return valori.Count % 2 == 1 ? valori[m] : (valori[m - 1] + valori[m]) / 2;
            }
        }

        private async Task LeggiGex(CancellationToken token)
        {
            // Mai senza `since`: con Supabase attivo il server riscarica la
            // sessione intera (12-17 MB a fine giornata) a ogni chiamata, e ogni
            // 15 secondi ha esaurito l'egress del piano gratuito (ottobre 2026).
            // Il profilo e' gia' il totale di giornata dell'ultimo snapshot,
            // quindi basta la finestra degli ultimi minuti.
            if (giornoGex != Oggi()) { giornoGex = Oggi(); ultimoGex = null; }
            var since = ultimoGex ?? DateTime.Now.AddMinutes(-GEX_FINESTRA_MIN).ToString("HH:mm:ss", CultureInfo.InvariantCulture);
            using var doc = await Get("/api/gex?flow=0&since=" + since, token);
            if (doc == null) { profilo = new List<RigaGex>(); return; }
            var lastTime = Stringa(doc.RootElement, "lastTime");
            if (lastTime == null) return; // nessuno snapshot nuovo: resta il profilo che c'e'
            ultimoGex = lastTime;
            var righe = new List<RigaGex>();
            if (doc.RootElement.TryGetProperty("profile", out var p) && p.ValueKind == JsonValueKind.Array)
            {
                foreach (var r in p.EnumerateArray())
                {
                    var strike = Numero(r, "strike");
                    if (strike is not > 0) continue;
                    righe.Add(new RigaGex
                    {
                        Strike = strike.Value,
                        Gex = Numero(r, "gex") ?? 0,
                        GexOi = Numero(r, "gexOi") ?? 0,
                        GexLr = Numero(r, "gexLr") ?? 0,
                    });
                }
            }
            profilo = righe;
        }

        /// <summary>
        /// Le tracce IV MIN dei giorni passati: il grafico mostra anche quelli,
        /// e /api/smile senza parametri da' solo oggi (prima dell'apertura nemmeno).
        /// </summary>
        private async Task LeggiTracce(CancellationToken token)
        {
            using var doc = await Get($"/api/smile?giorni={GIORNI_TRACCE}", token);
            if (doc == null || !doc.RootElement.TryGetProperty("giorni", out var giorni) || giorni.ValueKind != JsonValueKind.Array) return;
            var lette = new List<TracciaGiorno>();
            foreach (var gg in giorni.EnumerateArray())
            {
                if (!DateTime.TryParseExact(Stringa(gg, "date"), "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var mezzanotte)) continue;
                if (!gg.TryGetProperty("storia", out var storia) || storia.ValueKind != JsonValueKind.Array) continue;
                var t = new TracciaGiorno
                {
                    Mezzanotte = mezzanotte,
                    Basis = Numero(gg, "basis"),
                    Fine = Secondi(Stringa(gg, "fine") ?? "00:00:00"),
                    Storia = new List<(int, double)>(),
                };
                foreach (var e in storia.EnumerateArray())
                {
                    if (e.ValueKind != JsonValueKind.Array || e.GetArrayLength() != 2) continue;
                    if (e[0].ValueKind != JsonValueKind.String || e[1].ValueKind != JsonValueKind.Number) continue;
                    t.Storia.Add((Secondi(e[0].GetString()), e[1].GetDouble()));
                }
                if (t.Storia.Count > 0) lette.Add(t);
            }
            tracce = lette;
        }

        private async Task LeggiSmile(CancellationToken token)
        {
            using var doc = await Get("/api/smile", token);
            // 503 finche' il poller dei volumi non ha scritto oggi: la colonna dice "in attesa".
            if (doc == null) { smile = null; return; }
            var root = doc.RootElement;
            if (root.TryGetProperty("local", out var locale) && locale.ValueKind == JsonValueKind.False) { smile = null; return; }
            var spot = Numero(root, "spot");
            if (spot == null || !root.TryGetProperty("smile", out var s) || s.ValueKind != JsonValueKind.Object ||
                !root.TryGetProperty("punti", out var punti) || punti.ValueKind != JsonValueKind.Array) { smile = null; return; }

            var d = new DatiSmile
            {
                Giorno = Stringa(root, "date"),
                Spot = spot.Value,
                IvAtm = Numero(s, "ivAtm"),
                Em = Numero(s, "em"),
                Base = Stringa(s, "base"),
                Regime = Stringa(s, "regime"),
                Sospeso = s.TryGetProperty("sospeso", out var so) && so.ValueKind == JsonValueKind.True,
                Chiuso = s.TryGetProperty("chiuso", out var ch) && ch.ValueKind == JsonValueKind.True,
                Est25 = s.TryGetProperty("est25", out var e25) && e25.ValueKind == JsonValueKind.True,
                IvFermaSec = Numero(s, "ivFermaSec") ?? 0,
                StoriaVertice = new List<(int, double)>(),
                Punti = new List<PuntoSmile>(),
            };
            if (s.TryGetProperty("vertice", out var v) && v.ValueKind == JsonValueKind.Object && Numero(v, "strike") is double vs)
            {
                d.VerticeStrike = vs;
                d.VerticeIv = Numero(v, "iv") ?? 0;
                d.VerticeSigma = Numero(v, "sigma");
            }
            if (s.TryGetProperty("z", out var z) && z.ValueKind == JsonValueKind.Object)
            {
                d.ConZ = true;
                d.ZTilt = Numero(z, "tilt");
                d.ZCurv = Numero(z, "curv");
                d.ZAtm = Numero(z, "ivAtm");
            }
            if (s.TryGetProperty("storiaVertice", out var storia) && storia.ValueKind == JsonValueKind.Array)
            {
                foreach (var e in storia.EnumerateArray())
                {
                    if (e.ValueKind != JsonValueKind.Array || e.GetArrayLength() != 2) continue;
                    if (e[0].ValueKind != JsonValueKind.String || e[1].ValueKind != JsonValueKind.Number) continue;
                    d.StoriaVertice.Add((Secondi(e[0].GetString()), e[1].GetDouble()));
                }
            }
            foreach (var p in punti.EnumerateArray())
            {
                var strike = Numero(p, "strike");
                if (strike is not > 0) continue;
                d.Punti.Add(new PuntoSmile
                {
                    Strike = strike.Value,
                    CallIv = Numero(p, "callIv"),
                    PutIv = Numero(p, "putIv"),
                    IvOtm = Numero(p, "ivOtm"),
                    IvLiscia = Numero(p, "ivLiscia"),
                    Conv = Numero(p, "conv"),
                });
            }
            LeggiVol(root, d);
            smile = d;
        }

        /// <summary>vol di /api/smile (dal 03/11/2026): bande calibrate, divergenze SPX/VIX1D, contesto. Come lib/smileChart.ts.</summary>
        private static void LeggiVol(JsonElement root, DatiSmile d)
        {
            if (!root.TryGetProperty("vol", out var vol) || vol.ValueKind != JsonValueKind.Object) return;
            if (vol.TryGetProperty("bande", out var b) && b.ValueKind == JsonValueKind.Object &&
                Numero(b, "su95") is double su95 && Numero(b, "su68") is double su68 &&
                Numero(b, "giu68") is double giu68 && Numero(b, "giu95") is double giu95)
            {
                d.Bande = new[] { su95, su68, giu68, giu95 };
                var em = Numero(b, "emResto") ?? 0;
                d.BandaQ68Pt = (Numero(b, "q68") ?? 0) * em;
                d.BandaQ95Pt = (Numero(b, "q95") ?? 0) * em;
                d.Vix1d = Numero(b, "vix1d") ?? 0;
                d.RvIv = Numero(b, "rvIv");
            }
            if (vol.TryGetProperty("contesto", out var c) && c.ValueKind == JsonValueKind.Object)
            {
                d.Attesa = Stringa(c, "attesa");
                d.AttesaRange = Numero(c, "rangeRelativo") ?? 1;
                if (c.TryGetProperty("voci", out var voci) && voci.ValueKind == JsonValueKind.Array)
                    foreach (var v in voci.EnumerateArray())
                    {
                        var nome = Stringa(v, "nome");
                        if (nome == null || nome == "VIX" || nome == "VIX/VIX3M") continue;
                        var valore = Numero(v, "valore") ?? 0;
                        var testo = nome == "SKEW" ? valore.ToString("0", CultureInfo.InvariantCulture) : valore.ToString("0.00", CultureInfo.InvariantCulture);
                        var rel = (Numero(v, "rangeRelativo") ?? 1).ToString("0.00", CultureInfo.InvariantCulture);
                        d.VociContesto.Add($"{nome} {testo} ({Numero(v, "percentile") ?? 0}°) ×{rel}");
                    }
            }
            if (vol.TryGetProperty("ultima", out var u) && u.ValueKind == JsonValueKind.Object)
            {
                var ds = Numero(u, "dS") ?? 0;
                var res = Numero(u, "residuo") ?? 0;
                d.UltimaRiga = $"SPX 30' {(ds >= 0 ? "+" : "")}{F1(ds)}σ · res VIX1D {(res >= 0 ? "+" : "")}{res.ToString("0.00", CultureInfo.InvariantCulture)}";
            }
            if (vol.TryGetProperty("divergenze", out var dv) && dv.ValueKind == JsonValueKind.Array && dv.GetArrayLength() > 0)
            {
                var ultima = dv[dv.GetArrayLength() - 1];
                var tipo = Stringa(ultima, "tipo");
                var ora = Stringa(ultima, "time") ?? "";
                d.DivRimbalzo = tipo == "rimbalzo";
                d.Divergenza = $"div. {tipo} {(ora.Length >= 5 ? ora.Substring(0, 5) : ora)} (in prova)";
            }
        }

        private async Task LeggiBookmap(CancellationToken token)
        {
            // Soglia o alias cambiati dalle impostazioni: i segmenti si rifanno dai campioni gia' in memoria.
            var alias = (AliasBookmap ?? "").Trim();
            if (sogliaUsata != SogliaContratti || aliasUsato != alias)
            {
                sogliaUsata = SogliaContratti;
                if (aliasUsato != alias) { campioni.Clear(); assorbimenti.Clear(); quoteRecenti.Clear(); midGiorno.Clear(); ultimoTempoBook = null; }
                aliasUsato = alias;
                RifaiSegmenti();
            }

            var since = ultimoTempoBook;
            using var doc = await Get(since != null ? "/api/bookmap?since=" + since : "/api/bookmap", token);
            if (doc == null) return;
            var root = doc.RootElement;
            var data = Stringa(root, "date");
            if (data != giornoBook)
            {
                // Giorno nuovo (o primo giro): si riparte da zero.
                giornoBook = data;
                campioni.Clear();
                aperti.Clear();
                chiusi.Clear();
                assorbimenti.Clear();
                quoteRecenti.Clear();
                midGiorno.Clear();
                confermePronte = new List<Conferma>();
                if (since != null)
                {
                    ultimoTempoBook = null;
                    segmentiPronti = new List<Segmento>();
                    campioniPronti = Array.Empty<CampioneBook>();
                    assorbimentiPronti = new List<Assorbimento>();
                    return;
                }
            }
            if (!root.TryGetProperty("points", out var punti) || punti.ValueKind != JsonValueKind.Array) return;

            var nuovi = 0;
            // Primo giro: la finestra arriva solo alle ultime 3 ore, gli assorbimenti di prima a parte.
            if (since == null) nuovi += await LeggiAssorbimentiPrima(alias, token);
            foreach (var p in punti.EnumerateArray())
            {
                var t = Stringa(p, "time");
                if (t == null) continue;
                ultimoTempoBook = t;
                if (alias.Length > 0 && Stringa(p, "alias") != alias) continue;
                // Prima il secondo nuovo allunga le tenute aperte, poi arrivano gli assorbimenti nuovi.
                if (Quota(Secondi(t), Numero(p, "bid"), Numero(p, "ask"))) nuovi++;
                if (AggiungiMid(Secondi(t), Numero(p, "bid"), Numero(p, "ask"))) nuovi++;
                nuovi += LeggiAssorbimenti(p);
                if (!p.TryGetProperty("book", out var book) || book.ValueKind != JsonValueKind.Object) continue;
                var c = new CampioneBook { Sec = Secondi(t), B = Righe(book, "b"), A = Righe(book, "a") };
                campioni.Add(c);
                Aggiungi(c);
                nuovi++;
            }
            if (nuovi == 0) return;

            // Fuori dalla finestra di memoria: via i campioni e i segmenti finiti prima.
            var ultimoSec = campioni.Count > 0 ? campioni[^1].Sec : Secondi(ultimoTempoBook ?? "00:00:00");
            var limite = ultimoSec - MAX_SEC_BOOK;
            campioni.RemoveAll(c => c.Sec < limite);
            chiusi.RemoveAll(s => s.A < limite);
            // Gli assorbimenti no: sono pochi (~2.000 al giorno) e devono restare tutta la giornata.
            Pubblica();
            if (MostraConferme) CalcolaConferme();
        }

        private static string FileSerieGex(string giorno) => Path.Combine(Path.GetTempPath(), $"GregDashboard-gex-{giorno}.txt");

        /// <summary>Lo strike piu' positivo e piu' negativo del profilo di adesso (NaN se manca), accodato alla serie del giorno.</summary>
        private void RegistraGex()
        {
            var oggi = Oggi();
            if (giornoSerieGex != oggi)
            {
                serieGex.Clear();
                giornoSerieGex = oggi;
                try
                {
                    foreach (var riga in File.ReadAllLines(FileSerieGex(oggi)))
                    {
                        var c = riga.Split(';');
                        if (c.Length == 3 && int.TryParse(c[0], out var t)
                            && double.TryParse(c[1], NumberStyles.Float, CultureInfo.InvariantCulture, out var ps)
                            && double.TryParse(c[2], NumberStyles.Float, CultureInfo.InvariantCulture, out var ng))
                            serieGex.Add((t, ps, ng));
                    }
                }
                catch (IOException) { }
            }
            var righe = profilo;
            var sec = (int)DateTime.Now.TimeOfDay.TotalSeconds;
            if (righe.Count == 0 || !DentroCash(sec)) return;
            double Valore(RigaGex r) => BaseGex switch { 0 => r.Gex, 2 => r.GexLr, _ => r.GexOi };
            var major = righe.OrderByDescending(Valore).First();
            var minor = righe.OrderBy(Valore).First();
            var pos = Valore(major) > 0 ? major.Strike : double.NaN;
            var neg = Valore(minor) < 0 ? minor.Strike : double.NaN;
            if (serieGex.Count > 0 && sec <= serieGex[^1].sec) return;
            serieGex.Add((sec, pos, neg));
            try
            {
                File.AppendAllText(FileSerieGex(oggi), string.Format(CultureInfo.InvariantCulture, "{0};{1};{2}\n", sec, pos, neg));
            }
            catch (IOException) { }
        }

        /// <summary>La base ES-SPX a un secondo: mediana delle letture dei 5 minuti prima (come BaseCorrente, ma nel passato).</summary>
        private double?[] BaseAlSecondo(int s0, int n)
        {
            var out_ = new double?[n];
            if (BaseManuale != 0) { for (var k = 0; k < n; k++) out_[k] = BaseManuale; return out_; }
            List<(int sec, double valore)> serie;
            lock (lockBase)
            {
                if (giornoBase != Oggi()) return out_;
                serie = new List<(int, double)>(serieBase);
            }
            var j = 0;
            var finestra = new List<double>();
            for (var k = 0; k < n; k += 15)
            {
                var s = s0 + k;
                while (j < serie.Count && serie[j].sec <= s) j++;
                if (j == 0) continue;
                finestra.Clear();
                var ultimo = serie[j - 1].sec;
                for (var i = j - 1; i >= 0 && serie[i].sec > ultimo - BASE_FINESTRA_SEC; i--) finestra.Add(serie[i].valore);
                finestra.Sort();
                var m = finestra.Count / 2;
                var v = finestra.Count % 2 == 1 ? finestra[m] : (finestra[m - 1] + finestra[m]) / 2;
                for (var q = k; q < Math.Min(n, k + 15); q++) out_[q] = v;
            }
            return out_;
        }

        /// <summary>Punti (sec, prezzo SPX) a gradini, in ES: l'ultimo valore entro etaMax secondi, piu' la base. NaN = assente.</summary>
        private static double[] AGradini(IReadOnlyList<(int sec, double valore)> punti, int s0, int n, int etaMax, double?[] base_)
        {
            var out_ = new double[n];
            var j = 0;
            for (var k = 0; k < n; k++)
            {
                var s = s0 + k;
                while (j < punti.Count && punti[j].sec <= s) j++;
                out_[k] = j == 0 || s - punti[j - 1].sec > etaMax || base_[k] == null || double.IsNaN(punti[j - 1].valore)
                    ? double.NaN : punti[j - 1].valore + base_[k].Value;
            }
            return out_;
        }

        private bool AggiungiMid(int sec, double? bid, double? ask)
        {
            if (bid == null || ask == null || ask <= bid) return false;
            if (midGiorno.Count > 0 && sec <= midGiorno[^1].sec) return false;
            midGiorno.Add((sec, (bid.Value + ask.Value) / 2));
            return true;
        }

        // La regola, come in execution/studio_conferma_range.py: non cambiare un numero qui senza cambiarlo li'.
        private const double CONF_RIARMO = 5, CONF_TOCCO = 0.5, CONF_PUNTI = 1.5, CONF_STOP = 3, CONF_TARGET = 4;
        private const int CONF_FINESTRA = 120, CONF_DURATA = 1800;

        /// <summary>
        /// Entrata a conferma sui range OB, la sola regola rimasta in piedi nella ricerca del
        /// 04/11/2026 (12 sessioni, prime 6 per cercare e ultime 6 per verificare, netto di
        /// 0,25 pt di costi: +0,64 e +0,97 pt a operazione, 56-60% vinte; sui livelli finti
        /// spostati di 7 pt la stessa regola perde in tutte le 81 varianti provate).
        /// Livello armato con ES ad almeno 5 pt; tocco entro 0,5 pt; se entro 120 s ES riparte
        /// di 1,5 pt dalla parte da cui e' arrivato, prima di passare 1,5 pt oltre, si entra
        /// li': stop 3, target 4, chiusura a mercato dopo 30 minuti. Si ricalcola da capo a
        /// ogni giro: sono ~25.000 secondi per 6 livelli.
        /// </summary>
        private void CalcolaConferme()
        {
            if (midGiorno.Count < 2) { confermePronte = new List<Conferma>(); return; }
            int s0 = midGiorno[0].sec, s1 = midGiorno[^1].sec, n = s1 - s0 + 1;
            var mid = new double[n];
            var j = 0;
            for (var s = s0; s <= s1; s++)
            {
                while (j + 1 < midGiorno.Count && midGiorno[j + 1].sec <= s) j++;
                mid[s - s0] = midGiorno[j].mid;
            }
            // Ogni livello e' una serie al secondo (NaN = assente): i range sono fermi, GEX e 0γ si muovono.
            var livelli = new List<(string tipo, string nome, double[] prezzi)>();
            foreach (var l in livelliRange.Where(l => !l.Tratteggiato))
                livelli.Add(("range", l.Etichetta, Enumerable.Repeat(l.Prezzo, n).ToArray()));
            if ((ConfermeGex && serieGex.Count > 0) || (ConfermeZeroGamma && zgTraccia != null))
            {
                var base_ = BaseAlSecondo(s0, n);
                if (ConfermeGex && serieGex.Count > 0)
                {
                    livelli.Add(("gex", "GEX+", AGradini(serieGex.Select(g => (g.sec, g.pos)).ToList(), s0, n, 300, base_)));
                    livelli.Add(("gex", "GEX-", AGradini(serieGex.Select(g => (g.sec, g.neg)).ToList(), s0, n, 300, base_)));
                }
                if (ConfermeZeroGamma && zgTraccia is { } zg)
                    livelli.Add(("0γ", "0γ", AGradini(zg.Punti, s0, n, 180, base_)));
            }
            if (livelli.Count == 0) { confermePronte = new List<Conferma>(); return; }
            var da = Math.Max(s0, Secondi(OraLocaleDaNy(9, 35) + ":00"));
            var fine = Math.Min(s1, Secondi(OraLocaleDaNy(16, 0) + ":00") - 60);
            var trovate = new List<Conferma>();
            foreach (var (tipo, nome, prezzi) in livelli)
            {
                var armato = false;
                var lato = 0;
                for (var s = da; s <= fine; s++)
                {
                    var L = prezzi[s - s0];
                    var prima = s > s0 ? prezzi[s - s0 - 1] : double.NaN;
                    // Livello assente o saltato su uno strike nuovo: si riarma da capo (un salto sul prezzo non e' un tocco).
                    if (double.IsNaN(L) || double.IsNaN(prima) || Math.Abs(L - prima) > 1) { armato = false; continue; }
                    var x = mid[s - s0] - L;
                    if (Math.Abs(x) >= CONF_RIARMO) { armato = true; lato = x > 0 ? 1 : -1; continue; }
                    if (!armato || Math.Abs(x) > CONF_TOCCO) continue;
                    armato = false;
                    int? k = null;
                    for (var t = s + 1; t <= Math.Min(s1, s + CONF_FINESTRA); t++)
                    {
                        var y = lato * (mid[t - s0] - L);
                        if (y <= -CONF_PUNTI) break;
                        if (y >= CONF_PUNTI) { k = t; break; }
                    }
                    if (k == null) continue;
                    var verso = InvertiConferme ? -lato : lato;
                    var c = new Conferma { Tipo = tipo, Livello = nome, Prezzo = L, Tocco = s, Sec = k.Value, Verso = verso, Entrata = mid[k.Value - s0] };
                    for (var t = k.Value + 1; t <= s1; t++)
                    {
                        var z = verso * (mid[t - s0] - c.Entrata);
                        if (z >= CONF_TARGET) { c.Esito = CONF_TARGET; c.FineSec = t; break; }
                        if (z <= -CONF_STOP) { c.Esito = -CONF_STOP; c.FineSec = t; break; }
                        if (t - k.Value >= CONF_DURATA) { c.Esito = z; c.FineSec = t; break; }
                    }
                    trovate.Add(c);
                }
            }
            confermePronte = trovate.OrderBy(c => c.Sec).ToList();
        }

        /// <summary>
        /// Gli assorbimenti di prima della finestra iniziale (/api/bookmap?assorbimenti=1),
        /// coi secondi di bid/ask che servono alla tenuta. Fino al 04/11/2026 sparivano
        /// insieme al book dopo 3 ore: a sera non c'erano frecce prima delle 17:40.
        /// </summary>
        private async Task<int> LeggiAssorbimentiPrima(string alias, CancellationToken token)
        {
            using var doc = await Get("/api/bookmap?assorbimenti=1", token);
            if (doc == null || Stringa(doc.RootElement, "date") != giornoBook) return 0;
            if (!doc.RootElement.TryGetProperty("points", out var punti) || punti.ValueKind != JsonValueKind.Array) return 0;
            var n = 0;
            foreach (var p in punti.EnumerateArray())
            {
                var t = Stringa(p, "time");
                if (t == null) continue;
                if (alias.Length > 0 && Stringa(p, "alias") != alias) continue;
                Quota(Secondi(t), Numero(p, "bid"), Numero(p, "ask"));
                AggiungiMid(Secondi(t), Numero(p, "bid"), Numero(p, "ask"));
                n += LeggiAssorbimenti(p);
            }
            return n;
        }

        /// <summary>Gli assorbimenti del campione: [prezzo, contratti, verso, "HH:MM:SS"]. Le righe rotte si saltano.</summary>
        private int LeggiAssorbimenti(JsonElement p)
        {
            if (!p.TryGetProperty("abs", out var abs) || abs.ValueKind != JsonValueKind.Array) return 0;
            var n = 0;
            foreach (var e in abs.EnumerateArray())
            {
                if (e.ValueKind != JsonValueKind.Array || e.GetArrayLength() != 4) continue;
                if (e[0].ValueKind != JsonValueKind.Number || e[1].ValueKind != JsonValueKind.Number ||
                    e[2].ValueKind != JsonValueKind.Number || e[3].ValueKind != JsonValueKind.String) continue;
                var a = new Assorbimento
                {
                    Prezzo = e[0].GetDouble(),
                    Contratti = e[1].GetDouble(),
                    Verso = e[2].GetDouble() > 0 ? 1 : -1,
                    Sec = Secondi(e[3].GetString()),
                    // L'add-on l'ha gia' visto reggere 1 s.
                    Tenuta = 1,
                };
                // I secondi gia' passati da quando e' datato.
                foreach (var q in quoteRecenti) Allunga(a, q.sec, q.bid, q.ask);
                assorbimenti.Add(a);
                n++;
            }
            return n;
        }

        /// <summary>Un secondo di bid/ask: allunga (o chiude) la tenuta degli assorbimenti ancora aperti.</summary>
        private bool Quota(int sec, double? bid, double? ask)
        {
            if (bid == null || ask == null || ask <= bid) return false;
            quoteRecenti.Add((sec, bid.Value, ask.Value));
            quoteRecenti.RemoveAll(q => q.sec < sec - 2 * TENUTA_MAX);
            var cambiato = false;
            foreach (var a in assorbimenti)
            {
                if (a.Ceduto || a.Tenuta >= TENUTA_MAX || sec < a.Sec || sec > a.Sec + TENUTA_MAX) continue;
                var prima = a.Tenuta;
                Allunga(a, sec, bid.Value, ask.Value);
                cambiato |= a.Tenuta != prima || a.Ceduto;
            }
            return cambiato;
        }

        /// <summary>
        /// Come tiene() nello studio: il livello resta al migliore (bid >= prezzo
        /// per il verso +1, ask <= prezzo per il -1) in ogni secondo dopo l'ultimo
        /// trade. I secondi mancanti non contano; il primo che non regge chiude.
        /// </summary>
        private static void Allunga(Assorbimento a, int sec, double bid, double ask)
        {
            if (a.Ceduto || sec < a.Sec || sec > a.Sec + TENUTA_MAX) return;
            var regge = a.Verso > 0 ? bid >= a.Prezzo : ask <= a.Prezzo;
            if (!regge) { a.Ceduto = true; return; }
            a.Tenuta = Math.Max(a.Tenuta, sec - a.Sec);
        }

        private static (double, double)[] Righe(JsonElement book, string lato)
        {
            if (!book.TryGetProperty(lato, out var arr) || arr.ValueKind != JsonValueKind.Array) return Array.Empty<(double, double)>();
            var out_ = new List<(double, double)>();
            foreach (var r in arr.EnumerateArray())
            {
                if (r.ValueKind != JsonValueKind.Array || r.GetArrayLength() < 2) continue;
                out_.Add((r[0].GetDouble(), r[1].GetDouble()));
            }
            return out_.ToArray();
        }

        private void RifaiSegmenti()
        {
            aperti.Clear();
            chiusi.Clear();
            foreach (var c in campioni) Aggiungi(c);
            Pubblica();
        }

        /// <summary>Lo stesso algoritmo di segmentiBook() in /bookmap, un campione alla volta.</summary>
        private void Aggiungi(CampioneBook c)
        {
            var visti = new HashSet<(bool, double)>();
            foreach (var (bid, righe) in new[] { (true, c.B), (false, c.A) })
            {
                foreach (var (prezzo, contratti) in righe)
                {
                    if (contratti < sogliaUsata) continue;
                    var k = (bid, prezzo);
                    visti.Add(k);
                    if (aperti.TryGetValue(k, out var seg) && c.Sec - seg.A <= BUCO_MAX_SEC)
                    {
                        seg.A = c.Sec;
                        seg.Contratti = Math.Max(seg.Contratti, contratti);
                    }
                    else
                    {
                        if (seg != null) chiusi.Add(seg);
                        aperti[k] = new Segmento { Da = c.Sec, A = c.Sec, Prezzo = prezzo, Contratti = contratti, Bid = bid };
                    }
                }
            }
            foreach (var k in aperti.Keys.Where(k => !visti.Contains(k)).ToList())
            {
                chiusi.Add(aperti[k]);
                aperti.Remove(k);
            }
        }

        /// <summary>Copia per il disegno: i segmenti aperti si clonano, il thread continua ad allungarli.</summary>
        private void Pubblica()
        {
            var lista = new List<Segmento>(chiusi.Count + aperti.Count);
            lista.AddRange(chiusi.Select(Clona));
            lista.AddRange(aperti.Values.Select(Clona));
            segmentiPronti = lista;
            campioniPronti = campioni.ToArray();
            // Gli assorbimenti non cambiano dopo l'arrivo: basta copiare la lista.
            assorbimentiPronti = new List<Assorbimento>(assorbimenti);
        }

        private static Segmento Clona(Segmento s) =>
            new Segmento { Da = s.Da, A = s.A, Prezzo = s.Prezzo, Contratti = s.Contratti, Bid = s.Bid };

        #endregion

        #region Disegno

        public override void OnPaintChart(PaintChartEventArgs args)
        {
            base.OnPaintChart(args);
            if (CurrentChart == null) return;

            var g = args.Graphics;
            var area = args.Rectangle;
            var conv = CurrentChart.MainWindow.CoordinatesConverter;
            var clipPrima = g.Clip;
            g.SetClip(area);
            try
            {
                if (MostraLiquidita) DisegnaLiquidita(g, area, conv);
                if (MostraRangeOb || MostraRangeMattino) DisegnaRange(g, area, conv);
                if (MostraGex) DisegnaGex(g, area, conv);
                if (MostraZeroGamma) DisegnaZeroGamma(g, area, conv);
                if (MostraSmile) DisegnaSmile(g, area, conv);
                if (MostraAssorbimenti) DisegnaAssorbimenti(g, area, conv);
                if (MostraConferme) DisegnaConferme(g, area, conv);

                var s = stato;
                if (s != null)
                {
                    using var f = new Font("Arial", 9f, FontStyle.Bold);
                    g.DrawString("Greg Dashboard: " + s, f, Brushes.OrangeRed, area.Left + 8, area.Top + 8);
                }
            }
            finally
            {
                g.Clip = clipPrima;
            }
        }

        private void DisegnaLiquidita(Graphics g, Rectangle area, TradingPlatform.BusinessLayer.Chart.IChartWindowCoordinatesConverter conv)
        {
            if (StileLiquidita == 0) { DisegnaHeatmap(g, area, conv); return; }
            var segmenti = segmentiPronti;
            var giorno = giornoBook;
            if (segmenti.Count == 0 || giorno == null) return;
            if (!DateTime.TryParseExact(giorno, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var mezzanotte)) return;

            var soglia = (double)sogliaUsata;
            // Un tick di altezza (almeno 1,5 px), come nella pagina.
            var alto = (float)(Math.Max(1.5, Math.Abs(conv.GetChartY(0) - conv.GetChartY(TICK)) * 0.8) * SpessoreLiquidita);

            // Prima i segmenti in vista, per sapere quale prende il colore pieno.
            var visibili = new List<(Segmento seg, float x1, float x2, float y)>();
            foreach (var seg in segmenti)
            {
                if (seg.A - seg.Da + 1 < DurataMinima) continue;
                var y = (float)conv.GetChartY(seg.Prezzo);
                if (y < area.Top - alto || y > area.Bottom + alto) continue;
                // Gli orari dell'add-on sono ora locale di questo PC; Quantower ragiona in UTC.
                var x1 = (float)conv.GetChartX(Utc(mezzanotte, seg.Da));
                var x2 = (float)conv.GetChartX(Utc(mezzanotte, seg.A + 1));
                if (x2 < area.Left || x1 > area.Right) continue;
                visibili.Add((seg, x1, x2, y));
            }
            if (visibili.Count == 0) return;
            var pieno = ContrattiPieno > 0 ? ContrattiPieno : visibili.Max(v => v.seg.Contratti);
            pieno = Math.Max(pieno, soglia * 1.5);

            // I piu' grossi per ultimi, cosi' stanno sopra.
            using var pennello = new SolidBrush(Color.Empty);
            foreach (var (seg, x1, x2, y) in visibili.OrderBy(v => v.seg.Contratti))
            {
                pennello.Color = ColoreLiquidita(seg.Bid, Intensita(seg.Contratti, soglia, pieno));
                g.FillRectangle(pennello, x1, y - alto / 2, Math.Max(1, x2 - x1), alto);
            }
            LegendaLiquidita(g, area, soglia, pieno);
        }

        #region Heatmap stile Bookmap

        /// <summary>La scala termica di /bookmap e /gex (SCALA_TERMICA in lib/gexHeatmap.ts): q, r, g, b.</summary>
        private static readonly double[][] SCALA_TERMICA =
        {
            new double[] { 0.0, 12, 22, 48 }, new double[] { 0.18, 22, 60, 130 }, new double[] { 0.36, 30, 125, 200 },
            new double[] { 0.5, 70, 185, 215 }, new double[] { 0.64, 215, 205, 85 }, new double[] { 0.78, 238, 140, 45 },
            new double[] { 0.9, 222, 72, 38 }, new double[] { 1.0, 255, 236, 220 },
        };

        /// <summary>Colore e opacita' (0-255) a quota q, come coloreTermico(): l'opacita' sale piu' in fretta all'inizio.</summary>
        private static (int r, int g, int b, int a) Termico(double q)
        {
            q = Math.Clamp(q, 0, 1);
            var s = SCALA_TERMICA;
            int i = 1;
            while (i < s.Length - 1 && q > s[i][0]) i++;
            var f = Math.Clamp((q - s[i - 1][0]) / (s[i][0] - s[i - 1][0]), 0, 1);
            int Mix(int k) => (int)Math.Round(s[i - 1][k] + (s[i][k] - s[i - 1][k]) * f);
            var alfa = Math.Min(1, Math.Pow(q, 0.6) * 1.15);
            return (Mix(1), Mix(2), Mix(3), (int)Math.Round(alfa * 255));
        }

        private Bitmap heatmap;
        private string chiaveHeatmap;
        private double heatmapAlto, heatmapBasso, heatmapPieno;
        private const int RIGHE_MAX = 1200;

        /// <summary>
        /// La liquidita' come immagine larga quanto il grafico, una colonna per
        /// pixel e una riga per tick (o piu' tick per riga se la vista e' molto
        /// alta). Si ricostruisce solo se cambiano vista, dati o impostazioni.
        /// </summary>
        private void DisegnaHeatmap(Graphics g, Rectangle area, TradingPlatform.BusinessLayer.Chart.IChartWindowCoordinatesConverter conv)
        {
            var camp = campioniPronti;
            var giorno = giornoBook;
            if (camp.Length == 0 || giorno == null || area.Width <= 0 || area.Height <= 0) return;
            if (!DateTime.TryParseExact(giorno, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var mezzanotte)) return;

            double SecDi(DateTime t)
            {
                var utc = t.Kind == DateTimeKind.Local ? t.ToUniversalTime() : DateTime.SpecifyKind(t, DateTimeKind.Utc);
                return (utc.ToLocalTime() - mezzanotte).TotalSeconds;
            }

            var pAlto = conv.GetPrice(area.Top);
            var pBasso = conv.GetPrice(area.Bottom);
            if (!(pAlto > pBasso)) return;
            var sx0 = SecDi(conv.GetTime(area.Left));
            var sx1 = SecDi(conv.GetTime(area.Right));
            var soglia = Math.Max(1, sogliaUsata);
            var chiave = string.Join("|", area.Width, area.Height, pAlto, pBasso, sx0, sx1, camp.Length, camp[^1].Sec,
                soglia, ContrastoHeatmap, ContrattiPieno, TrasparenzaLiquidita);
            if (chiave != chiaveHeatmap || heatmap == null) CostruisciHeatmap(area, conv, camp, SecDi, pAlto, pBasso, soglia, chiave);
            if (heatmap == null) return;

            var yA = (float)conv.GetChartY(heatmapAlto);
            var yB = (float)conv.GetChartY(heatmapBasso);
            var interp = g.InterpolationMode;
            var offset = g.PixelOffsetMode;
            // Niente sfumatura in verticale: ogni tick resta netto, come in Bookmap.
            g.InterpolationMode = InterpolationMode.NearestNeighbor;
            g.PixelOffsetMode = PixelOffsetMode.Half;
            g.DrawImage(heatmap, new RectangleF(area.Left, yA, area.Width, yB - yA));
            g.InterpolationMode = interp;
            g.PixelOffsetMode = offset;
            LegendaHeatmap(g, area, soglia, heatmapPieno);
        }

        private void CostruisciHeatmap(Rectangle area, TradingPlatform.BusinessLayer.Chart.IChartWindowCoordinatesConverter conv,
            CampioneBook[] camp, Func<DateTime, double> secDi, double pAlto, double pBasso, double soglia, string chiave)
        {
            var C = area.Width;
            var livAlto = (int)Math.Ceiling(pAlto / TICK);
            var livBasso = (int)Math.Floor(pBasso / TICK);
            var tickPerRiga = Math.Max(1, (int)Math.Ceiling((livAlto - livBasso + 1) / (double)RIGHE_MAX));
            var R = (int)Math.Ceiling((livAlto - livBasso + 1) / (double)tickPerRiga);
            var somma = new float[C * R];
            var presente = new bool[C];
            var riga = new float[R];

            // Il tempo di ogni colonna lo dice Quantower: l'asse puo' non essere
            // lineare (barre, buchi di sessione), quindi niente proporzioni.
            var bordi = new double[C + 1];
            for (var c = 0; c <= C; c++) bordi[c] = secDi(conv.GetTime(area.Left + c));

            int PrimoDa(double v)
            {
                int lo = 0, hi = camp.Length;
                while (lo < hi) { var m = (lo + hi) >> 1; if (camp[m].Sec < v) lo = m + 1; else hi = m; }
                return lo;
            }

            for (var c = 0; c < C; c++)
            {
                double t0 = Math.Min(bordi[c], bordi[c + 1]), t1 = Math.Max(bordi[c], bordi[c + 1]);
                var i0 = PrimoDa(t0);
                var i1 = PrimoDa(t1);
                if (i1 <= i0)
                {
                    // Colonna piu' stretta di un secondo: il campione piu' vicino al centro, se c'e'.
                    var centro = (t0 + t1) / 2;
                    var migliore = -1;
                    foreach (var j in new[] { i0 - 1, i0 })
                        if (j >= 0 && j < camp.Length && Math.Abs(camp[j].Sec - centro) <= 1.5 &&
                            (migliore < 0 || Math.Abs(camp[j].Sec - centro) < Math.Abs(camp[migliore].Sec - centro))) migliore = j;
                    if (migliore < 0) continue;
                    i0 = migliore;
                    i1 = migliore + 1;
                }
                var quanti = 0;
                for (var i = i0; i < i1; i++)
                {
                    quanti++;
                    Array.Clear(riga, 0, R);
                    foreach (var lato in new[] { camp[i].B, camp[i].A })
                        foreach (var (prezzo, contratti) in lato)
                        {
                            var r = (livAlto - (int)Math.Round(prezzo / TICK)) / tickPerRiga;
                            if (r < 0 || r >= R) continue;
                            if (contratti > riga[r]) riga[r] = (float)contratti;
                        }
                    for (var r = 0; r < R; r++) if (riga[r] > 0) somma[r * C + c] += riga[r];
                }
                if (quanti == 0) continue;
                presente[c] = true;
                for (var r = 0; r < R; r++) somma[r * C + c] /= quanti;
            }

            // Sfumatura leggera fra colonne vicine (1-2-1, due passate), mai attraverso un buco.
            var tmp = new float[C];
            for (var passata = 0; passata < 2; passata++)
                for (var r = 0; r < R; r++)
                {
                    var b = r * C;
                    for (var c = 0; c < C; c++)
                    {
                        if (!presente[c]) { tmp[c] = 0; continue; }
                        var sx = c > 0 && presente[c - 1] ? somma[b + c - 1] : somma[b + c];
                        var dx = c < C - 1 && presente[c + 1] ? somma[b + c + 1] : somma[b + c];
                        tmp[c] = (sx + 2 * somma[b + c] + dx) / 4;
                    }
                    Array.Copy(tmp, 0, somma, b, C);
                }

            // Fondo scala: il 99esimo percentile dei livelli in vista, diviso il
            // contrasto (o i contratti fissati a mano nelle impostazioni).
            double pieno;
            if (ContrattiPieno > 0) pieno = ContrattiPieno;
            else
            {
                var valori = new List<float>();
                for (var k = 0; k < somma.Length; k += 3) if (somma[k] > 0) valori.Add(somma[k]);
                valori.Sort();
                pieno = valori.Count > 0 ? valori[(int)(0.99 * (valori.Count - 1))] : soglia;
                pieno = Math.Max(soglia, pieno) / Math.Max(0.05, ContrastoHeatmap);
            }

            var trasp = 1 - Math.Clamp(TrasparenzaLiquidita, 0, 90) / 100.0;
            var mezza = soglia / 2;
            var bmp = new Bitmap(C, R, PixelFormat.Format32bppArgb);
            var dati = bmp.LockBits(new Rectangle(0, 0, C, R), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
            var pixel = new int[C * R];
            for (var k = 0; k < pixel.Length; k++)
            {
                var v = somma[k];
                if (!(v > mezza)) continue;
                // Lineare, come la pagina: con la radice il book normale diventava tutto giallo.
                var (cr, cg, cb, ca) = Termico(v / pieno);
                var rampa = Math.Min(1, (v - mezza) / Math.Max(1, soglia - mezza));
                var a = (int)Math.Round(ca * rampa * trasp);
                pixel[k] = (a << 24) | (cr << 16) | (cg << 8) | cb;
            }
            // Righe una per una: lo stride della bitmap puo' essere piu' largo di C * 4.
            for (var r = 0; r < R; r++)
                System.Runtime.InteropServices.Marshal.Copy(pixel, r * C, dati.Scan0 + r * dati.Stride, C);
            bmp.UnlockBits(dati);

            heatmap?.Dispose();
            heatmap = bmp;
            chiaveHeatmap = chiave;
            heatmapAlto = (livAlto + 0.5) * TICK;
            heatmapBasso = (livAlto - R * tickPerRiga + 0.5) * TICK;
            heatmapPieno = pieno;
        }

        /// <summary>In basso a sinistra: la scala termica con la soglia e i contratti del colore pieno.</summary>
        private static void LegendaHeatmap(Graphics g, Rectangle area, double soglia, double pieno)
        {
            const int largo = 120, alto = 8, passi = 40;
            float x0 = area.Left + 8, y0 = area.Bottom - 28;
            using var font = new Font("Arial", 9f, FontStyle.Regular, GraphicsUnit.Pixel);
            using (var fondo = new SolidBrush(Color.FromArgb(200, 15, 23, 42)))
                g.FillRectangle(fondo, x0 - 4, y0 - 4, largo + 8, alto + 20);
            using var pennello = new SolidBrush(Color.Empty);
            for (var i = 0; i < passi; i++)
            {
                var (r, gg, b, a) = Termico(i / (double)(passi - 1));
                pennello.Color = Color.FromArgb(Math.Max(a, 60), r, gg, b);
                g.FillRectangle(pennello, x0 + i * largo / (float)passi, y0, largo / (float)passi + 0.5f, alto);
            }
            var ty = y0 + alto + 2;
            g.DrawString($"{soglia:0}", font, Brushes.Silver, x0, ty);
            using var sfDestra = new StringFormat { Alignment = StringAlignment.Far };
            g.DrawString($"pieno {pieno:0}", font, Brushes.Silver, x0 + largo, ty, sfDestra);
        }

        #endregion

        // Dal quasi bianco al verde / rosso scuro: la tinta chiara tiene distinti i due lati anche sui livelli piccoli.
        private static readonly Color BID_CHIARO = ColorTranslator.FromHtml("#f0fdf4");
        private static readonly Color BID_SCURO = ColorTranslator.FromHtml("#166534");
        private static readonly Color ASK_CHIARO = ColorTranslator.FromHtml("#fef2f2");
        private static readonly Color ASK_SCURO = ColorTranslator.FromHtml("#991b1b");

        /// <summary>
        /// 0 alla soglia, 1 a `pieno` e oltre, in scala logaritmica: i contratti
        /// vanno da 50 a qualche migliaio, e in scala lineare i livelli normali
        /// finirebbero tutti nello stesso bianco.
        /// </summary>
        private static double Intensita(double contratti, double soglia, double pieno) =>
            Math.Clamp(Math.Log(Math.Max(contratti, soglia) / soglia) / Math.Log(pieno / soglia), 0, 1);

        /// <summary>Il colore a intensita' t (0-1), con i due regolatori delle impostazioni.</summary>
        private Color ColoreLiquidita(bool bid, double t)
        {
            var (da, a) = bid ? (BID_CHIARO, BID_SCURO) : (ASK_CHIARO, ASK_SCURO);
            t = Math.Pow(Math.Clamp(t, 0, 1), 1 / Math.Clamp(IntensitaLiquidita, 0.25, 4));
            int Mix(int x, int y) => (int)Math.Round(x + (y - x) * t);
            var alfa = (int)Math.Round(255 * (1 - Math.Clamp(TrasparenzaLiquidita, 0, 90) / 100.0));
            return Color.FromArgb(alfa, Mix(da.R, a.R), Mix(da.G, a.G), Mix(da.B, a.B));
        }

        /// <summary>In basso a sinistra: le due sfumature con i contratti agli estremi e a meta'.</summary>
        private void LegendaLiquidita(Graphics g, Rectangle area, double soglia, double pieno)
        {
            const int largo = 120, alto = 6, passi = 24;
            float x0 = area.Left + 8, y0 = area.Bottom - 34;
            using var font = new Font("Arial", 9f, FontStyle.Regular, GraphicsUnit.Pixel);
            using (var fondo = new SolidBrush(Color.FromArgb(200, 15, 23, 42)))
                g.FillRectangle(fondo, x0 - 4, y0 - 4, largo + 8, 2 * alto + 22);
            using var pennello = new SolidBrush(Color.Empty);
            for (var i = 0; i < passi; i++)
            {
                var t = i / (double)(passi - 1);
                pennello.Color = ColoreLiquidita(true, t);
                g.FillRectangle(pennello, x0 + i * largo / (float)passi, y0, largo / (float)passi + 0.5f, alto);
                pennello.Color = ColoreLiquidita(false, t);
                g.FillRectangle(pennello, x0 + i * largo / (float)passi, y0 + alto + 2, largo / (float)passi + 0.5f, alto);
            }
            // Il valore a meta' della scala logaritmica e' la media geometrica.
            var meta = Math.Sqrt(soglia * pieno);
            var ty = y0 + 2 * alto + 4;
            using var sf = new StringFormat { Alignment = StringAlignment.Center };
            g.DrawString($"{soglia:0}", font, Brushes.Silver, x0, ty);
            g.DrawString($"{meta:0}", font, Brushes.Silver, x0 + largo / 2f, ty, sf);
            using var sfDestra = new StringFormat { Alignment = StringAlignment.Far };
            g.DrawString($"{pieno:0}", font, Brushes.Silver, x0 + largo, ty, sfDestra);
        }

        /// <summary>
        /// Frecce invece delle palle di /bookmap: blu verso l'alto quando i limit
        /// buy assorbono i market sell, rossa verso il basso quando i limit sell
        /// assorbono i market buy. La punta sta sul prezzo dell'assorbimento; la
        /// misura segue la stessa regola delle palle (4-20 px dalla radice dei contratti).
        /// </summary>
        private void DisegnaAssorbimenti(Graphics g, Rectangle area, TradingPlatform.BusinessLayer.Chart.IChartWindowCoordinatesConverter conv)
        {
            var lista = assorbimentiPronti;
            var giorno = giornoBook;
            if (lista.Count == 0 || giorno == null) return;
            if (!DateTime.TryParseExact(giorno, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var mezzanotte)) return;

            var modo = g.SmoothingMode;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            using var compratori = new SolidBrush(Color.FromArgb(200, 59, 130, 246));
            using var venditori = new SolidBrush(Color.FromArgb(200, 244, 63, 94));
            using var bordo = new Pen(Color.FromArgb(217, 255, 255, 255), 1f);
            foreach (var a in lista)
            {
                if (a.Contratti < MinAssorbimento) continue;
                // Con 1 s vale il controllo dell'add-on; oltre, la freccia compare a tenuta raggiunta.
                if (TenutaAssorbimento > 1 && a.Tenuta < TenutaAssorbimento) continue;
                var x = (float)conv.GetChartX(Utc(mezzanotte, a.Sec));
                var y = (float)conv.GetChartY(a.Prezzo);
                if (x < area.Left - 40 || x > area.Right + 40 || y < area.Top - 40 || y > area.Bottom + 40) continue;
                var r = (float)Math.Min(20, Math.Max(4, Math.Sqrt(a.Contratti) * 0.9));
                var freccia = FrecciaAssorbimento(x, y, r, a.Verso > 0);
                g.FillPolygon(a.Verso > 0 ? compratori : venditori, freccia);
                g.DrawPolygon(bordo, freccia);
            }
            g.SmoothingMode = modo;
        }

        /// <summary>
        /// Freccia alta 2r con la punta in (x, y): verso l'alto ha il corpo sotto
        /// il prezzo, verso il basso sopra. Testa larga 1,6r, stelo largo 0,6r.
        /// </summary>
        private static PointF[] FrecciaAssorbimento(float x, float y, float r, bool versoAlto)
        {
            var v = versoAlto ? 1 : -1; // +1: il corpo scende sotto la punta (y cresce verso il basso)
            var testa = r;          // altezza della testa
            var mezzaTesta = 0.8f * r;
            var mezzoStelo = 0.3f * r;
            return new[]
            {
                new PointF(x, y),
                new PointF(x + mezzaTesta, y + v * testa),
                new PointF(x + mezzoStelo, y + v * testa),
                new PointF(x + mezzoStelo, y + v * 2 * r),
                new PointF(x - mezzoStelo, y + v * 2 * r),
                new PointF(x - mezzoStelo, y + v * testa),
                new PointF(x - mezzaTesta, y + v * testa),
            };
        }

        /// <summary>
        /// Le entrate a conferma: triangolo giallo sull'entrata (punta nel verso), target verde
        /// e stop rosso tratteggiati fino all'esito (o fino a destra se aperta), etichetta col
        /// livello e l'esito; in basso a sinistra il conto della giornata. Netto = meno 0,25 pt
        /// a operazione, come nella ricerca.
        /// </summary>
        private void DisegnaConferme(Graphics g, Rectangle area, TradingPlatform.BusinessLayer.Chart.IChartWindowCoordinatesConverter conv)
        {
            var lista = confermePronte;
            var giorno = giornoBook;
            using var font = new Font("Arial", 8f, FontStyle.Bold);
            var parti = new List<string>();
            foreach (var tipo in new[] { "range", "gex", "0γ" })
            {
                var diTipo = lista.Where(c => c.Tipo == tipo).ToList();
                if (diTipo.Count == 0) continue;
                var chiuse = diTipo.Where(c => c.Esito != null).ToList();
                var netto = chiuse.Sum(c => c.Esito.Value - 0.25);
                parti.Add($"{tipo} {chiuse.Count(c => c.Esito > 0)}/{chiuse.Count} vinti {netto:+0.00;-0.00} pt");
            }
            var riassunto = (InvertiConferme ? "Conferma INVERTITA (in prova): " : "Conferma (in prova): ") + (parti.Count == 0 ? "nessun segnale oggi" : string.Join(" | ", parti));
            g.DrawString(riassunto, font, Brushes.Gold, area.Left + 8, area.Bottom - 34);
            if (lista.Count == 0 || giorno == null) return;
            if (!DateTime.TryParseExact(giorno, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var mezzanotte)) return;

            var modo = g.SmoothingMode;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            using var giallo = new SolidBrush(Color.FromArgb(235, 250, 204, 21));
            using var bordo = new Pen(Color.FromArgb(230, 15, 23, 42), 1f);
            using var verde = new Pen(Color.FromArgb(220, 34, 197, 94), 1.5f) { DashStyle = DashStyle.Dash };
            using var rosso = new Pen(Color.FromArgb(220, 239, 68, 68), 1.5f) { DashStyle = DashStyle.Dash };
            using var sfondo = new SolidBrush(Color.FromArgb(200, 15, 23, 42));
            foreach (var c in lista)
            {
                var x = (float)conv.GetChartX(Utc(mezzanotte, c.Sec));
                var x2 = c.FineSec != null ? (float)conv.GetChartX(Utc(mezzanotte, c.FineSec.Value)) : area.Right;
                if (x2 < area.Left - 20 || x > area.Right + 20) continue;
                var y = (float)conv.GetChartY(c.Entrata);
                var yT = (float)conv.GetChartY(c.Entrata + c.Verso * CONF_TARGET);
                var yS = (float)conv.GetChartY(c.Entrata - c.Verso * CONF_STOP);
                g.DrawLine(verde, x, yT, Math.Max(x + 6, x2), yT);
                g.DrawLine(rosso, x, yS, Math.Max(x + 6, x2), yS);
                const float r = 7;
                var v = c.Verso > 0 ? 1 : -1; // punta in alto per i long: il corpo sta sotto
                var tri = new[] { new PointF(x, y), new PointF(x - r, y + v * 1.6f * r), new PointF(x + r, y + v * 1.6f * r) };
                g.FillPolygon(giallo, tri);
                g.DrawPolygon(bordo, tri);
                var esito = c.Esito == null ? "aperta" : $"{c.Esito.Value:+0.00;-0.00}";
                var testo = $"{(c.Verso > 0 ? "LONG" : "SHORT")} {c.Livello} {esito}";
                var dim = g.MeasureString(testo, font);
                var ty = c.Verso > 0 ? y + 1.6f * r + 2 : y - 1.6f * r - dim.Height - 2;
                g.FillRectangle(sfondo, x - dim.Width / 2, ty, dim.Width, dim.Height);
                g.DrawString(testo, font, Brushes.Gold, x - dim.Width / 2, ty);
            }
            g.SmoothingMode = modo;
        }

        private void DisegnaRange(Graphics g, Rectangle area, TradingPlatform.BusinessLayer.Chart.IChartWindowCoordinatesConverter conv)
        {
            var livelli = livelliRange;
            if (livelli.Count == 0) return;
            using var font = new Font("Arial", 8f, FontStyle.Bold);
            // Le etichette stanno a sinistra del profilo GEX e dello smile, se ci sono.
            var destra = area.Right - (MostraGex ? LarghezzaGex + 6 : 4) - (MostraSmile ? LarghezzaSmile + 4 : 0);
            foreach (var l in livelli)
            {
                var mattino = l.Tratteggiato;
                if (mattino && !MostraRangeMattino) continue;
                if (!mattino && !MostraRangeOb) continue;
                var y = (float)conv.GetChartY(l.Prezzo);
                if (y < area.Top || y > area.Bottom) continue;
                using var pen = new Pen(l.Colore, mattino ? 1f : 1.5f);
                if (mattino) pen.DashStyle = DashStyle.Dash;
                g.DrawLine(pen, area.Left, y, area.Right, y);
                var testo = $"{l.Etichetta} {l.Prezzo:0.00}";
                var dim = g.MeasureString(testo, font);
                using var sfondo = new SolidBrush(Color.FromArgb(200, 15, 23, 42));
                g.FillRectangle(sfondo, destra - dim.Width, y - dim.Height / 2, dim.Width, dim.Height);
                using var b = new SolidBrush(l.Colore);
                g.DrawString(testo, font, b, destra - dim.Width, y - dim.Height / 2);
            }
        }

        private void DisegnaGex(Graphics g, Rectangle area, TradingPlatform.BusinessLayer.Chart.IChartWindowCoordinatesConverter conv)
        {
            var righe = profilo;
            using var font = new Font("Arial", 7.5f, FontStyle.Regular);
            // In alto c'e' l'intestazione dello smile: con lo smile acceso gli avvisi vanno in basso.
            var yAvviso = MostraSmile ? area.Bottom - 18 : area.Top + 8;
            if (righe.Count == 0)
            {
                g.DrawString("GEX: nessun dato (il poller volumi lavora 13:30-22:00)", font, Brushes.Gray, area.Right - 300, yAvviso);
                return;
            }
            var baseEs = BaseCorrente();
            if (baseEs == null)
            {
                g.DrawString("GEX: base ES-SPX non ancora misurata (SPX cash dalle 15:30) - impostala a mano", font, Brushes.Gray, area.Right - 430, yAvviso);
                return;
            }
            var b = baseEs.Value;

            double Valore(RigaGex r) => BaseGex switch { 0 => r.Gex, 2 => r.GexLr, _ => r.GexOi };
            var max = righe.Max(r => Math.Abs(Valore(r)));
            if (max <= 0) return;

            // Altezza di una barra: la distanza fra due strike, meno un po' d'aria.
            var ordinati = righe.OrderBy(r => r.Strike).ToList();
            var passo = ordinati.Count > 1 ? ordinati.Zip(ordinati.Skip(1), (x, y) => y.Strike - x.Strike).Where(d => d > 0).DefaultIfEmpty(5).Min() : 5;
            var altoBarra = (float)Math.Max(2, Math.Abs(conv.GetChartY(0) - conv.GetChartY(passo)) * 0.75);

            float destra = area.Right - 2;
            float larghezza = LarghezzaGex;
            using (var fondo = new SolidBrush(Color.FromArgb(70, 15, 23, 42)))
                g.FillRectangle(fondo, destra - larghezza, area.Top, larghezza, area.Height);

            using var pos = new SolidBrush(Color.FromArgb(200, 52, 211, 153));
            using var neg = new SolidBrush(Color.FromArgb(200, 244, 63, 94));
            foreach (var r in ordinati)
            {
                var v = Valore(r);
                var y = (float)conv.GetChartY(r.Strike + b);
                if (y < area.Top - altoBarra || y > area.Bottom + altoBarra) continue;
                var w = (float)(Math.Abs(v) / max * (larghezza - 40));
                if (w >= 0.5f) g.FillRectangle(v >= 0 ? pos : neg, destra - w, y - altoBarra / 2, w, altoBarra);
                if (altoBarra >= 9)
                    g.DrawString(r.Strike.ToString("0", CultureInfo.InvariantCulture), font, Brushes.Silver, destra - larghezza + 2, y - 6);
            }

            if (MostraMajor)
            {
                var major = ordinati.OrderByDescending(Valore).First();
                var minor = ordinati.OrderBy(Valore).First();
                using var fontM = new Font("Arial", 8f, FontStyle.Bold);
                if (Valore(major) > 0) LineaMajor(g, area, conv, major.Strike, b, Color.FromArgb(52, 211, 153), "Major Pos Γ", fontM);
                if (Valore(minor) < 0) LineaMajor(g, area, conv, minor.Strike, b, Color.FromArgb(244, 63, 94), "Major Neg Γ", fontM);
            }

            using var fontB = new Font("Arial", 7.5f, FontStyle.Regular);
            var nomeBase = BaseGex switch { 0 => "volume", 2 => "Lee-Ready", _ => "OI" };
            g.DrawString($"GEX {nomeBase} · base {b:+0.00;-0.00}{(BaseManuale != 0 ? " (manuale)" : "")}", fontB, Brushes.Silver, destra - larghezza + 2, area.Top + 4);
        }

        private static void LineaMajor(Graphics g, Rectangle area, TradingPlatform.BusinessLayer.Chart.IChartWindowCoordinatesConverter conv, double strike, double b, Color colore, string nome, Font font)
        {
            var y = (float)conv.GetChartY(strike + b);
            if (y < area.Top || y > area.Bottom) return;
            using var pen = new Pen(Color.FromArgb(180, colore), 1f) { DashStyle = DashStyle.Dot };
            g.DrawLine(pen, area.Left, y, area.Right, y);
            using var br = new SolidBrush(colore);
            g.DrawString($"{nome} {strike:0} SPX = {strike + b:0.00} ES", font, br, area.Left + 6, y - 13);
        }

        #endregion

        #region Smile (copia di frontend/src/lib/smileChart.ts)

        private static readonly Color SM_VERDE = ColorTranslator.FromHtml("#22c55e");
        private static readonly Color SM_ROSSO = ColorTranslator.FromHtml("#ef4444");
        private static readonly Color SM_ARANCIO = ColorTranslator.FromHtml("#f59e0b");
        private static readonly Color SM_AZZURRO = ColorTranslator.FromHtml("#22d3ee");
        private static readonly Color SM_FONDO = ColorTranslator.FromHtml("#0f172a");
        private static readonly Color COLORE_1S = Color.FromArgb(140, 226, 232, 240);
        private static readonly Color COLORE_2S = Color.FromArgb(115, 148, 163, 184);
        private static readonly Color COLORE_VERTICE = Color.FromArgb(204, 192, 132, 252);
        private const float RAGGIO = 4;
        private const float FRECCIA_MAX_PX = 40;
        private const float FRECCIA_MIN_PX = 8;
        /// <summary>Sotto questa quota della convessita' piu' grande la freccia non si disegna.</summary>
        private const double FRECCIA_SOGLIA = 0.05;
        private const float MARGINE_X = 14;

        private static readonly Dictionary<string, Color> COLORE_REGIME = new Dictionary<string, Color>
        {
            ["RIALZISTA"] = SM_VERDE,
            ["RIBASSISTA"] = SM_ROSSO,
            ["RANGE A C"] = ColorTranslator.FromHtml("#a855f7"),
            ["PIATTA"] = ColorTranslator.FromHtml("#94a3b8"),
            ["PIATTA + VOL ALTA"] = SM_ARANCIO,
            ["PIATTA + VOL BASSA"] = SM_AZZURRO,
            ["NEUTRO"] = ColorTranslator.FromHtml("#cbd5e1"),
        };

        /// <summary>
        /// La colonna dello smile, a sinistra del profilo GEX: y = strike SPX
        /// portati in ES con la base, x = IV scalata sugli strike in vista.
        /// Stessi segni, colori e testi di /market.
        /// </summary>
        private void DisegnaSmile(Graphics g, Rectangle area, TradingPlatform.BusinessLayer.Chart.IChartWindowCoordinatesConverter conv)
        {
            var dati = smile;
            float x1 = MostraGex ? area.Right - 2 - LarghezzaGex - 4 : area.Right - 2;
            float x0 = x1 - LarghezzaSmile;
            float top = area.Top, bottom = area.Bottom;

            using (var fondo = new SolidBrush(Color.FromArgb(140, 15, 23, 42)))
                g.FillRectangle(fondo, x0, top, x1 - x0, bottom - top);
            using var font10 = new Font("Arial", 10f, FontStyle.Regular, GraphicsUnit.Pixel);

            var baseEs = BaseCorrente();
            if (MostraIvMin) TracceGiorniPassati(g, area, conv, x0, baseEs);
            var messaggio = dati == null ? "Smile: in attesa dei dati"
                : baseEs == null ? $"Smile: in attesa della basis ES-SPX ({OraLocaleDaNy(9, 30)})" : null;
            if (messaggio != null)
            {
                using var grigio = new SolidBrush(ColorTranslator.FromHtml("#64748b"));
                g.DrawString(messaggio, font10, grigio, x0 + 6, top + 6);
                return;
            }

            var b = baseEs.Value;
            // Fuori dall'area si limita: GDI+ non regge coordinate enormi.
            float YDi(double strike) => (float)Math.Clamp(conv.GetChartY(strike + b), top - 50000, bottom + 50000);
            var punti = dati.Punti.Where(p => p.IvOtm != null).OrderBy(p => p.Strike).ToList();
            if (punti.Count == 0)
            {
                // A mercato chiuso la curva non c'e', la traccia IV MIN della giornata si'.
                if (MostraIvMin && dati.StoriaVertice.Count > 0)
                {
                    var clip = g.Clip;
                    var modoChiuso = g.SmoothingMode;
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.SetClip(RectangleF.FromLTRB(area.Left, top, x1, bottom), CombineMode.Intersect);
                    using var font9 = new Font("Arial", 9f, FontStyle.Regular, GraphicsUnit.Pixel);
                    StoriaVertice(g, area, conv, dati, YDi, x1, font9);
                    g.Clip = clip;
                    g.SmoothingMode = modoChiuso;
                }
                IntestazioneSmile(g, dati, x0, x1, top);
                return;
            }
            bool Dentro(float y) => y >= top && y <= bottom;
            bool XDentro(float x) => x >= x0 + 2 && x <= x1 - 2;
            // La scala delle IV sugli strike che si vedono, non su tutta la catena.
            var visibili = punti.Where(p => Dentro(YDi(p.Strike))).ToList();
            var ivs = (visibili.Count >= 2 ? visibili : punti).Select(p => p.IvOtm.Value).ToList();
            var ivMin = ivs.Min();
            var ivMax = ivs.Max();
            if (ivMax - ivMin < 0.5)
            {
                var c = (ivMax + ivMin) / 2;
                ivMin = c - 0.25;
                ivMax = c + 0.25;
            }
            float XDi(double iv) => (float)(x0 + MARGINE_X + (iv - ivMin) / (ivMax - ivMin) * (x1 - x0 - 2 * MARGINE_X));
            var em = dati.Em ?? 0;
            bool Oltre2s(double strike) => em > 0 && Math.Abs(strike - dati.Spot) > 2 * em;

            var modo = g.SmoothingMode;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            var clipPrima = g.Clip;
            try
            {
                // Livelli orizzontali: Spot +-1 sigma e +-2 sigma, e il vertice
                // IV MIN. Prezzi SPX, portati su ES con la base come la curva.
                g.SetClip(RectangleF.FromLTRB(area.Left, top, x1, bottom), CombineMode.Intersect);
                using var font9 = new Font("Arial", 9f, FontStyle.Regular, GraphicsUnit.Pixel);
                var livelli = new List<(double prezzo, Color colore, float[] tratto, string nome)>();
                // Dal 03/11/2026 le bande di chiusura calibrate (VIX1D x quantili
                // osservati); lo Spot +-1/2 sigma dell'IV 0DTE solo se mancano.
                if (MostraSigma && dati.Bande != null)
                {
                    livelli.Add((dati.Bande[0], COLORE_2S, new float[] { 2, 4 }, "95%"));
                    livelli.Add((dati.Bande[1], COLORE_1S, new float[] { 6, 4 }, "68%"));
                    livelli.Add((dati.Bande[2], COLORE_1S, new float[] { 6, 4 }, "68%"));
                    livelli.Add((dati.Bande[3], COLORE_2S, new float[] { 2, 4 }, "95%"));
                }
                else if (MostraSigma && em > 0)
                {
                    livelli.Add((dati.Spot + 2 * em, COLORE_2S, new float[] { 2, 4 }, "+2σ"));
                    livelli.Add((dati.Spot + em, COLORE_1S, new float[] { 6, 4 }, "+1σ"));
                    livelli.Add((dati.Spot - em, COLORE_1S, new float[] { 6, 4 }, "−1σ"));
                    livelli.Add((dati.Spot - 2 * em, COLORE_2S, new float[] { 2, 4 }, "−2σ"));
                }
                if (MostraIvMin)
                {
                    if (dati.StoriaVertice.Count > 0) StoriaVertice(g, area, conv, dati, YDi, x1, font9);
                    else if (dati.VerticeStrike != null) livelli.Add((dati.VerticeStrike.Value, COLORE_VERTICE, null, "IV MIN"));
                }
                foreach (var (prezzo, colore, tratto, nome) in livelli)
                {
                    var y = YDi(prezzo);
                    if (Dentro(y)) LineaLivello(g, area.Left, x1, y, colore, tratto, $"{nome} {F1(prezzo)}", font9);
                }
                g.Clip = clipPrima;

                g.SetClip(RectangleF.FromLTRB(x0 - FRECCIA_MAX_PX - 12, top, x1, bottom), CombineMode.Intersect);
                var clipFrecce = g.Clip;

                // Linea grigia sulla IV OTM, tagliata sulla colonna.
                g.SetClip(RectangleF.FromLTRB(x0, top, x1, bottom), CombineMode.Intersect);
                if (punti.Count >= 2)
                {
                    using var linea = new Pen(ColorTranslator.FromHtml("#94a3b8"), 1.2f);
                    g.DrawLines(linea, punti.Select(p => new PointF(XDi(p.IvLiscia ?? p.IvOtm.Value), YDi(p.Strike))).ToArray());
                }
                g.Clip = clipFrecce;

                // Frecce del convexity ladder, prima dei pallini cosi' la punta ci arriva sotto.
                var maxConv = punti.Select(p => Math.Abs(p.Conv ?? 0)).DefaultIfEmpty(0).Max();
                if (maxConv > 0)
                {
                    foreach (var p in punti)
                    {
                        var c = p.Conv ?? 0;
                        if (Math.Abs(c) < maxConv * FRECCIA_SOGLIA) continue;
                        var y = YDi(p.Strike);
                        if (!Dentro(y)) continue;
                        var x = XDi(p.IvOtm.Value);
                        var len = (float)(FRECCIA_MIN_PX + Math.Abs(c) / maxConv * (FRECCIA_MAX_PX - FRECCIA_MIN_PX));
                        if (c < 0) Freccia(g, x - RAGGIO - 3 - len, x - RAGGIO - 2, y, SM_ARANCIO);
                        else Freccia(g, Math.Min(x1 - 2, x + RAGGIO + 3 + len), x + RAGGIO + 2, y, SM_AZZURRO);
                    }
                }

                // Pallini: prima quello staccato (il lato non OTM), poi quello sulla curva.
                foreach (var p in punti)
                {
                    var y = YDi(p.Strike);
                    if (!Dentro(y)) continue;
                    var vuoto = Oltre2s(p.Strike);
                    var sottoSpot = p.Strike < dati.Spot;
                    var altra = sottoSpot ? p.CallIv : p.PutIv;
                    if (altra != null && altra != p.IvOtm)
                    {
                        var xa = XDi(altra.Value);
                        if (XDentro(xa)) Pallino(g, xa, y, sottoSpot ? SM_VERDE : SM_ROSSO, vuoto);
                    }
                    // Sulla curva il colore e' del lato da cui viene la IV OTM (con il ripiego sull'altro lato).
                    var daCall = sottoSpot ? p.PutIv == null : p.CallIv != null;
                    Pallino(g, XDi(p.IvOtm.Value), y, daCall ? SM_VERDE : SM_ROSSO, vuoto);
                }
                g.Clip = clipPrima;
                IntestazioneSmile(g, dati, x0, x1, top);
            }
            finally
            {
                g.Clip = clipPrima;
                g.SmoothingMode = modo;
            }
        }

        /// <summary>
        /// Il vertice IV MIN nel tempo: a gradini, ogni tratto sullo strike che
        /// era il vertice da quell'ora al cambio successivo, l'ultimo fino alla
        /// colonna con l'etichetta. Tutta la storia e' portata su ES con la base
        /// di adesso, come nella pagina. Le ore sono italiane, cioe' di questo PC.
        /// </summary>
        private static void StoriaVertice(Graphics g, Rectangle area, TradingPlatform.BusinessLayer.Chart.IChartWindowCoordinatesConverter conv,
            DatiSmile dati, Func<double, float> yDi, float x1, Font font)
        {
            if (!DateTime.TryParseExact(dati.Giorno, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var mezzanotte)) return;
            float XOra(int sec) => (float)Math.Clamp(conv.GetChartX(Utc(mezzanotte, sec)), area.Left, x1);
            var storia = dati.StoriaVertice;
            var tratto = new List<PointF>();
            for (var i = 0; i < storia.Count; i++)
            {
                var x = XOra(storia[i].sec);
                if (i > 0) tratto.Add(new PointF(x, yDi(storia[i - 1].strike)));
                tratto.Add(new PointF(x, yDi(storia[i].strike)));
            }
            var ultimo = storia[^1].strike;
            var y = yDi(ultimo);
            tratto.Add(new PointF(x1, y));
            using var pen = new Pen(COLORE_VERTICE, 1.5f);
            g.DrawLines(pen, tratto.ToArray());
            using var br = new SolidBrush(COLORE_VERTICE);
            using var sf = new StringFormat { Alignment = StringAlignment.Far, LineAlignment = StringAlignment.Far };
            g.DrawString($"IV MIN {F1(ultimo)}", font, br, x1 - 3, y - 1, sf);
        }

        /// <summary>
        /// Le tracce IV MIN dei giorni passati, a gradini come quella di oggi,
        /// ognuna portata su ES con la basis del suo giorno (quella di oggi se
        /// manca) e chiusa all'ora dell'ultima lettura.
        /// </summary>
        private void TracceGiorniPassati(Graphics g, Rectangle area, TradingPlatform.BusinessLayer.Chart.IChartWindowCoordinatesConverter conv,
            float x0, double? baseOggi)
        {
            var lista = tracce;
            if (lista.Count == 0) return;
            var clip = g.Clip;
            var modo = g.SmoothingMode;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.SetClip(RectangleF.FromLTRB(area.Left, area.Top, x0, area.Bottom), CombineMode.Intersect);
            using var pen = new Pen(COLORE_VERTICE, 1.5f);
            using var br = new SolidBrush(COLORE_VERTICE);
            using var font9 = new Font("Arial", 9f, FontStyle.Regular, GraphicsUnit.Pixel);
            using var sf = new StringFormat { Alignment = StringAlignment.Far, LineAlignment = StringAlignment.Far };
            try
            {
                foreach (var t in lista)
                {
                    var b = t.Basis ?? baseOggi;
                    if (b == null) continue;
                    float X(int sec) => (float)Math.Clamp(conv.GetChartX(Utc(t.Mezzanotte, sec)), area.Left - 10, x0 + 10);
                    float Y(double strike) => (float)Math.Clamp(conv.GetChartY(strike + b.Value), area.Top - 50000, area.Bottom + 50000);
                    var xFine = X(t.Fine);
                    if (xFine <= area.Left || X(t.Storia[0].sec) >= x0) continue; // giorno fuori dalla vista
                    var punti = new List<PointF>();
                    for (var i = 0; i < t.Storia.Count; i++)
                    {
                        var x = X(t.Storia[i].sec);
                        if (i > 0) punti.Add(new PointF(x, Y(t.Storia[i - 1].strike)));
                        punti.Add(new PointF(x, Y(t.Storia[i].strike)));
                    }
                    var ultimo = t.Storia[^1].strike;
                    punti.Add(new PointF(xFine, Y(ultimo)));
                    if (punti.Count >= 2) g.DrawLines(pen, punti.ToArray());
                    g.DrawString($"IV MIN {F1(ultimo)}", font9, br, xFine - 3, Y(ultimo) - 1, sf);
                }
            }
            finally
            {
                g.Clip = clip;
                g.SmoothingMode = modo;
            }
        }

        /// <summary>Una linea orizzontale su tutto il grafico e sulla colonna, con l'etichetta a destra nella colonna.</summary>
        private static void LineaLivello(Graphics g, float x0, float x1, float y, Color colore, float[] tratto, string etichetta, Font font)
        {
            using var pen = new Pen(colore, 1f);
            if (tratto != null) pen.DashPattern = tratto;
            g.DrawLine(pen, x0, y, x1, y);
            using var br = new SolidBrush(colore);
            using var sf = new StringFormat { Alignment = StringAlignment.Far, LineAlignment = StringAlignment.Far };
            g.DrawString(etichetta, font, br, x1 - 3, y - 1, sf);
        }

        private static void Freccia(Graphics g, float da, float a, float y, Color colore)
        {
            var verso = Math.Sign(a - da);
            using var pen = new Pen(colore, 2f);
            g.DrawLine(pen, da, y, a - verso * 5, y);
            using var br = new SolidBrush(colore);
            g.FillPolygon(br, new[] { new PointF(a, y), new PointF(a - verso * 7, y - 4), new PointF(a - verso * 7, y + 4) });
        }

        private static void Pallino(Graphics g, float x, float y, Color colore, bool vuoto)
        {
            if (vuoto)
            {
                using var fondo = new SolidBrush(SM_FONDO);
                g.FillEllipse(fondo, x - RAGGIO, y - RAGGIO, 2 * RAGGIO, 2 * RAGGIO);
                using var pen = new Pen(colore, 1.5f);
                g.DrawEllipse(pen, x - RAGGIO, y - RAGGIO, 2 * RAGGIO, 2 * RAGGIO);
            }
            else
            {
                using var br = new SolidBrush(colore);
                g.FillEllipse(br, x - RAGGIO, y - RAGGIO, 2 * RAGGIO, 2 * RAGGIO);
            }
        }

        /// <summary>Regime, IV ATM, vertice e z-score in alto nella colonna: testo su fondo scuro, sopra la curva.</summary>
        private static void IntestazioneSmile(Graphics g, DatiSmile s, float x0, float x1, float top)
        {
            var grigio = ColorTranslator.FromHtml("#64748b");
            var righe = new List<(bool grassetto, Color colore, string testo)>();
            var chiaro = ColorTranslator.FromHtml("#94a3b8");
            // In testa il contesto (prevede l'ampiezza, non la direzione), poi
            // bande e divergenze; il regime dello smile resta solo come informazione.
            if (s.Attesa != null)
            {
                righe.Add((true, s.Attesa == "AMPIA" ? SM_ARANCIO : s.Attesa == "STRETTA" ? SM_AZZURRO : ColorTranslator.FromHtml("#cbd5e1"),
                    $"GIORNATA {s.Attesa} ×{s.AttesaRange.ToString("0.00", CultureInfo.InvariantCulture)}"));
                foreach (var v in s.VociContesto) righe.Add((false, chiaro, v));
            }
            if (s.Bande != null)
            {
                righe.Add((false, ColorTranslator.FromHtml("#e2e8f0"), $"chiusura 68% ±{Math.Round(s.BandaQ68Pt)} · 95% ±{Math.Round(s.BandaQ95Pt)}"));
                var rviv = s.RvIv != null ? s.RvIv.Value.ToString("0.00", CultureInfo.InvariantCulture) : "—";
                righe.Add((false, grigio, $"VIX1D {F1(s.Vix1d)} · RV/IV {rviv}"));
            }
            if (s.UltimaRiga != null) righe.Add((false, grigio, s.UltimaRiga));
            if (s.Divergenza != null) righe.Add((false, s.DivRimbalzo ? SM_VERDE : SM_ROSSO, s.Divergenza));
            var coloreRegime = s.Regime == null ? grigio
                : COLORE_REGIME.TryGetValue(s.Regime, out var cr) ? cr : ColorTranslator.FromHtml("#cbd5e1");
            righe.Add((false, coloreRegime,
                "smile: " + (s.Regime ?? (s.Chiuso ? "MERCATO CHIUSO" : s.Sospeso ? $"sospeso dalle {OraLocaleDaNy(15, 15)}" : s.Base == "in raccolta" ? "in raccolta" : "in conferma"))));
            if (s.IvAtm != null)
                righe.Add((false, ColorTranslator.FromHtml("#94a3b8"), $"IV ATM {F1(s.IvAtm.Value)}%{(s.Em != null ? $" · 1σ {F1(s.Em.Value)}" : "")}"));
            if (s.VerticeStrike != null)
            {
                var sg = s.VerticeSigma;
                righe.Add((false, ColorTranslator.FromHtml("#c084fc"),
                    $"IV MIN {s.VerticeStrike.Value.ToString(CultureInfo.InvariantCulture)} {F1(s.VerticeIv)}%{(sg != null ? $" ({(sg >= 0 ? "+" : "")}{F1(sg.Value)}σ)" : "")}"));
            }
            if (s.ConZ)
            {
                string f(double? v) => v == null ? "—" : $"{(v >= 0 ? "+" : "")}{F1(v.Value)}";
                righe.Add((false, grigio, $"z tilt {f(s.ZTilt)} curv {f(s.ZCurv)} atm {f(s.ZAtm)}{(s.Base == "provvisoria" ? " (prov.)" : "")}"));
            }
            // Avvisi sulla qualita' del dato: 25 delta fuori catena, IV che non si muove.
            var avvisi = new List<string>();
            if (s.Est25) avvisi.Add("25Δ estrapolata");
            if (s.IvFermaSec >= 60) avvisi.Add($"IV ferma da {Math.Round(s.IvFermaSec / 60)}'");
            if (avvisi.Count > 0) righe.Add((false, SM_ARANCIO, string.Join(" · ", avvisi)));

            using (var fondo = new SolidBrush(Color.FromArgb(217, 15, 23, 42)))
                g.FillRectangle(fondo, x0, top, x1 - x0, 8 + righe.Count * 13);
            using var normale = new Font("Arial", 10f, FontStyle.Regular, GraphicsUnit.Pixel);
            using var grassetto = new Font("Arial", 11f, FontStyle.Bold, GraphicsUnit.Pixel);
            for (var i = 0; i < righe.Count; i++)
            {
                using var br = new SolidBrush(righe[i].colore);
                g.DrawString(righe[i].testo, righe[i].grassetto ? grassetto : normale, br, x0 + 6, top + 5 + i * 13);
            }
        }

        private static string F1(double v) => v.ToString("0.0", CultureInfo.InvariantCulture);

        #endregion

        #region Utilita'

        private static string Oggi() => DateTime.Now.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

        /// <summary>Un'ora di New York di oggi in ora di questo PC, "HH:mm": come oraRomaDaNy() del frontend.</summary>
        private static string OraLocaleDaNy(int h, int m)
        {
            var ny = TimeZoneInfo.FindSystemTimeZoneById("Eastern Standard Time");
            var giornoNy = TimeZoneInfo.ConvertTime(DateTime.Now, ny).Date;
            var ora = DateTime.SpecifyKind(giornoNy.AddHours(h).AddMinutes(m), DateTimeKind.Unspecified);
            return TimeZoneInfo.ConvertTime(ora, ny, TimeZoneInfo.Local).ToString("HH:mm", CultureInfo.InvariantCulture);
        }

        private static DateTime Utc(DateTime mezzanotteLocale, int sec) =>
            DateTime.SpecifyKind(mezzanotteLocale.AddSeconds(sec), DateTimeKind.Local).ToUniversalTime();

        private static int Secondi(string hhmmss)
        {
            var p = hhmmss.Split(':');
            int.TryParse(p.ElementAtOrDefault(0), out var h);
            int.TryParse(p.ElementAtOrDefault(1), out var m);
            int.TryParse(p.ElementAtOrDefault(2), out var s);
            return h * 3600 + m * 60 + s;
        }

        private static double? Numero(JsonElement e, string nome) =>
            e.TryGetProperty(nome, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetDouble(out var d) && double.IsFinite(d) ? d : null;

        private static string Stringa(JsonElement e, string nome) =>
            e.TryGetProperty(nome, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

        #endregion
    }
}
