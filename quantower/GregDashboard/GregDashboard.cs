using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
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
    ///     da /api/bookmap, con la stessa costruzione dei segmenti della pagina.
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

        // Il minimo e' quello dell'add-on: sotto MIN_CONTRATTI_BOOK (20) i livelli non arrivano proprio.
        [InputParameter("Soglia contratti limit", 31, 20, 5000, 1, 0)]
        public int SogliaContratti = 50;

        [InputParameter("Durata minima linea (s)", 32, 1, 600, 1, 0)]
        public int DurataMinima = 5;

        [InputParameter("Spessore linee liquidita'", 33, 0.5, 5, 0.5, 1)]
        public double SpessoreLiquidita = 1;

        [InputParameter("Alias Bookmap (vuoto = tutti)", 34)]
        public string AliasBookmap = "";

        [InputParameter("Palle assorbimento", 40)]
        public bool MostraAssorbimenti = true;

        // Il minimo e' quello dell'add-on: sotto ASS_MIN_CONTRATTI (30) non rileva niente.
        [InputParameter("Assorbimento minimo (contratti)", 41, 30, 5000, 1, 0)]
        public int MinAssorbimento = 60;

        /// <summary>
        /// Passo 3 dell'add-on reso regolabile: secondi in cui il livello deve
        /// restare al migliore dopo l'ultimo trade. L'add-on ne controlla gia' 1;
        /// oltre si verifica qui sul bid/ask di ogni secondo, e la palla compare
        /// solo quando la tenuta e' raggiunta. Vedi studio_assorbimenti.py.
        /// </summary>
        [InputParameter("Tenuta assorbimento (s)", 42, 1, TENUTA_MAX, 1, 0)]
        public int TenutaAssorbimento = 1;

        #endregion

        public GregDashboard() : base()
        {
            Name = "Greg Dashboard";
            Description = "Range, profilo GEX in ES e liquidita' Bookmap dalla dashboard locale";
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

        private sealed class CampioneBook
        {
            public int Sec;
            public (double prezzo, double contratti)[] B;
            public (double prezzo, double contratti)[] A;
        }

        private static readonly HttpClient http = new HttpClient { Timeout = TimeSpan.FromSeconds(20) };

        private CancellationTokenSource cts;

        private volatile List<Livello> livelliRange = new List<Livello>();
        private volatile List<RigaGex> profilo = new List<RigaGex>();
        private volatile List<Segmento> segmentiPronti = new List<Segmento>();
        private volatile List<Assorbimento> assorbimentiPronti = new List<Assorbimento>();
        private volatile string stato = "in attesa della dashboard...";

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
            base.OnClear();
        }

        #region Richieste

        private async Task Ciclo(CancellationToken token)
        {
            var prossimaMarket = DateTime.MinValue;
            var prossimoStorico = DateTime.MinValue;
            var prossimoGex = DateTime.MinValue;
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
                        prossimoGex = ora.AddSeconds(15);
                    }
                    if (MostraLiquidita || MostraAssorbimenti) await LeggiBookmap(token).ContinueWith(t => { if (t.IsFaulted) errori.Add("bookmap"); });

                    stato = errori.Count == 0 ? null : "dashboard non raggiungibile (" + string.Join(", ", errori) + ") su " + BaseUrl;
                }
                catch (Exception e)
                {
                    stato = e.Message;
                }
                try { await Task.Delay(2000, token); } catch (TaskCanceledException) { return; }
            }
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
            ("r1Down", ColorTranslator.FromHtml("#ef4444"), "R1↓"),
            ("r2Down", ColorTranslator.FromHtml("#f97316"), "R2↓"),
            ("r3Down", ColorTranslator.FromHtml("#facc15"), "R3↓"),
            ("r1Up", ColorTranslator.FromHtml("#3b82f6"), "R1↑"),
            ("r2Up", ColorTranslator.FromHtml("#06b6d4"), "R2↑"),
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
            lock (lockBase)
            {
                if (giornoBase != Oggi()) { serieBase.Clear(); giornoBase = Oggi(); }
                if (serieBase.Count == 0 || sec > serieBase[^1].sec) serieBase.Add((sec, esf.Value - spx.Value));
            }
        }

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

        private async Task LeggiBookmap(CancellationToken token)
        {
            // Soglia o alias cambiati dalle impostazioni: i segmenti si rifanno dai campioni gia' in memoria.
            var alias = (AliasBookmap ?? "").Trim();
            if (sogliaUsata != SogliaContratti || aliasUsato != alias)
            {
                sogliaUsata = SogliaContratti;
                if (aliasUsato != alias) { campioni.Clear(); assorbimenti.Clear(); quoteRecenti.Clear(); ultimoTempoBook = null; }
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
                if (since != null)
                {
                    ultimoTempoBook = null;
                    segmentiPronti = new List<Segmento>();
                    assorbimentiPronti = new List<Assorbimento>();
                    return;
                }
            }
            if (!root.TryGetProperty("points", out var punti) || punti.ValueKind != JsonValueKind.Array) return;

            var nuovi = 0;
            foreach (var p in punti.EnumerateArray())
            {
                var t = Stringa(p, "time");
                if (t == null) continue;
                ultimoTempoBook = t;
                if (alias.Length > 0 && Stringa(p, "alias") != alias) continue;
                // Prima il secondo nuovo allunga le tenute aperte, poi arrivano gli assorbimenti nuovi.
                if (Quota(Secondi(t), Numero(p, "bid"), Numero(p, "ask"))) nuovi++;
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
            assorbimenti.RemoveAll(a => a.Sec < limite);
            Pubblica();
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
                if (MostraAssorbimenti) DisegnaAssorbimenti(g, area, conv);

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
            var segmenti = segmentiPronti;
            var giorno = giornoBook;
            if (segmenti.Count == 0 || giorno == null) return;
            if (!DateTime.TryParseExact(giorno, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var mezzanotte)) return;

            var soglia = (double)sogliaUsata;
            // Un tick di altezza (almeno 1,5 px), come nella pagina.
            var alto = (float)(Math.Max(1.5, Math.Abs(conv.GetChartY(0) - conv.GetChartY(TICK)) * 0.8) * SpessoreLiquidita);
            using var verde = new SolidBrush(Color.Empty);
            foreach (var seg in segmenti)
            {
                if (seg.A - seg.Da + 1 < DurataMinima) continue;
                var y = (float)conv.GetChartY(seg.Prezzo);
                if (y < area.Top - alto || y > area.Bottom + alto) continue;
                // Gli orari dell'add-on sono ora locale di questo PC; Quantower ragiona in UTC.
                var x1 = (float)conv.GetChartX(Utc(mezzanotte, seg.Da));
                var x2 = (float)conv.GetChartX(Utc(mezzanotte, seg.A + 1));
                if (x2 < area.Left || x1 > area.Right) continue;
                // da 0,25 alla soglia fino a pieno a 5 volte la soglia
                var alfa = Math.Min(1, 0.25 + 0.75 * (seg.Contratti - soglia) / (soglia * 4));
                var a = (int)Math.Round(Math.Clamp(alfa, 0, 1) * 255);
                verde.Color = seg.Bid ? Color.FromArgb(a, 52, 211, 153) : Color.FromArgb(a, 244, 63, 94);
                g.FillRectangle(verde, x1, y - alto / 2, Math.Max(1, x2 - x1), alto);
            }
        }

        /// <summary>Come /bookmap: raggio dalla radice dei contratti (4-20 px), verde/rosso semitrasparente, bordo bianco.</summary>
        private void DisegnaAssorbimenti(Graphics g, Rectangle area, TradingPlatform.BusinessLayer.Chart.IChartWindowCoordinatesConverter conv)
        {
            var lista = assorbimentiPronti;
            var giorno = giornoBook;
            if (lista.Count == 0 || giorno == null) return;
            if (!DateTime.TryParseExact(giorno, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var mezzanotte)) return;

            var modo = g.SmoothingMode;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            using var compratori = new SolidBrush(Color.FromArgb(140, 52, 211, 153));
            using var venditori = new SolidBrush(Color.FromArgb(140, 244, 63, 94));
            using var bordo = new Pen(Color.FromArgb(217, 255, 255, 255), 1f);
            foreach (var a in lista)
            {
                if (a.Contratti < MinAssorbimento) continue;
                // Con 1 s vale il controllo dell'add-on; oltre, la palla compare a tenuta raggiunta.
                if (TenutaAssorbimento > 1 && a.Tenuta < TenutaAssorbimento) continue;
                var x = (float)conv.GetChartX(Utc(mezzanotte, a.Sec));
                var y = (float)conv.GetChartY(a.Prezzo);
                if (x < area.Left - 20 || x > area.Right + 20 || y < area.Top - 20 || y > area.Bottom + 20) continue;
                var r = (float)Math.Min(20, Math.Max(4, Math.Sqrt(a.Contratti) * 0.9));
                g.FillEllipse(a.Verso > 0 ? compratori : venditori, x - r, y - r, 2 * r, 2 * r);
                g.DrawEllipse(bordo, x - r, y - r, 2 * r, 2 * r);
            }
            g.SmoothingMode = modo;
        }

        private void DisegnaRange(Graphics g, Rectangle area, TradingPlatform.BusinessLayer.Chart.IChartWindowCoordinatesConverter conv)
        {
            var livelli = livelliRange;
            if (livelli.Count == 0) return;
            using var font = new Font("Arial", 8f, FontStyle.Bold);
            // Le etichette stanno a sinistra del profilo GEX, se c'e'.
            var destra = area.Right - (MostraGex ? LarghezzaGex + 6 : 4);
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
            if (righe.Count == 0)
            {
                g.DrawString("GEX: nessun dato (il poller volumi lavora 13:30-22:00)", font, Brushes.Gray, area.Right - 300, area.Top + 8);
                return;
            }
            var baseEs = BaseCorrente();
            if (baseEs == null)
            {
                g.DrawString("GEX: base ES-SPX non ancora misurata (SPX cash dalle 15:30) - impostala a mano", font, Brushes.Gray, area.Right - 430, area.Top + 8);
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

        #region Utilita'

        private static string Oggi() => DateTime.Now.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

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
