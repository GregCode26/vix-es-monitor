using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using TradingPlatform.BusinessLayer;

namespace GregDashboard
{
    /// <summary>
    /// L'Order Flow Imbalance multilivello di /bookmap, in un pannello sotto il grafico.
    ///
    /// Stesso conto di mlofiMobile() nella pagina: la somma dell'OFI dei primi N
    /// livelli negli ultimi `Finestra` secondi, divisa per N volte la coda media
    /// della finestra. +2 = e' entrata pressione in acquisto per due code intere.
    ///
    /// Disegnato come nella pagina, non a candele: una linea secondo per secondo,
    /// verde sopra lo zero e rossa sotto, con l'area riempita fino allo zero.
    /// Le due serie di Quantower ci sono solo per la scala (+/- il massimo
    /// modulo di ogni candela, trasparenti): cosi' l'asse resta simmetrico
    /// attorno allo zero e stretto su quello che si vede, come `ySbil`.
    /// </summary>
    public class GregMlofi : Indicator
    {
        [InputParameter("URL dashboard", 0)]
        public string BaseUrl = "http://localhost:3000";

        /// <summary>1 = OFI classico del solo migliore. L'add-on ne manda 15.</summary>
        [InputParameter("Livelli OFI", 10, 1, 15, 1, 0)]
        public int Livelli = 10;

        [InputParameter("Finestra (secondi)", 11, 1, 600, 1, 0)]
        public int Finestra = 30;

        [InputParameter("Alias Bookmap (vuoto = tutti)", 12)]
        public string AliasBookmap = "";

        public GregMlofi() : base()
        {
            Name = "Greg MLOFI";
            Description = "Order Flow Imbalance multilivello di Bookmap, dalla dashboard locale";
            SeparateWindow = true;
            AddLineSeries("Scala +", Color.Transparent, 1, LineStyle.Solid);
            AddLineSeries("Scala -", Color.Transparent, 1, LineStyle.Solid);
            foreach (var l in LinesSeries) l.ShowLineMarker = false;
        }

        private static readonly Color VERDE = ColorTranslator.FromHtml("#34d399");
        private static readonly Color ROSSO = ColorTranslator.FromHtml("#f43f5e");
        private static readonly Color GRIGIO = ColorTranslator.FromHtml("#94a3b8");
        /// <summary>Due campioni piu' distanti di cosi' spezzano la linea (Bookmap fermo, buco nei dati).</summary>
        private const double BUCO_SEC = 5;

        private sealed class Campione
        {
            public DateTime Utc;
            public double[] Ofi;
            public double? Qm;
            public double? Q1;
        }

        private static readonly HttpClient http = new HttpClient { Timeout = TimeSpan.FromSeconds(20) };
        private CancellationTokenSource cts;

        // Solo il thread delle richieste.
        private readonly List<Campione> campioni = new List<Campione>();
        private string ultimoTempo;
        private string giorno;
        private string aliasUsato;

        /// <summary>La serie calcolata (orario UTC, MLOFI), pubblicata intera a ogni giro.</summary>
        private sealed class Serie
        {
            public DateTime[] T = Array.Empty<DateTime>();
            public double[] V = Array.Empty<double>();
        }

        private volatile Serie serie = new Serie();
        private volatile int versione;
        private int versioneApplicata = -1;
        private int barreApplicate;

        private const int MAX_SEC = 3 * 3600;

        protected override void OnInit()
        {
            cts?.Cancel();
            cts = new CancellationTokenSource();
            var token = cts.Token;
            versioneApplicata = -1;
            Task.Run(() => Ciclo(token), token);
        }

        protected override void OnClear()
        {
            cts?.Cancel();
            cts = null;
            base.OnClear();
        }

        /// <summary>
        /// I dati arrivano su un altro thread: qui, a ogni tick, si riportano
        /// sulle candele solo se la serie e' cambiata o e' nata una candela.
        /// </summary>
        protected override void OnUpdate(UpdateArgs args)
        {
            var count = HistoricalData?.Count ?? 0;
            if (count == 0) return;
            var v = versione;
            if (v == versioneApplicata && count == barreApplicate) return;
            versioneApplicata = v;
            barreApplicate = count;

            var s = serie;
            var t = s.T;
            var val = s.V;
            if (t.Length == 0) return;
            // Dalla candela piu' recente all'indietro, finche' ci sono campioni.
            for (var i = count - 1; i >= 0; i--)
            {
                var barra = HistoricalData[i, SeekOriginHistory.Begin];
                var inizio = barra.TimeLeft;
                var fine = i + 1 < count ? HistoricalData[i + 1, SeekOriginHistory.Begin].TimeLeft : DateTime.MaxValue;
                if (fine <= t[0]) break;
                var offset = count - 1 - i;
                var max = 0.0;
                for (var j = UltimoPrima(t, fine); j >= 0 && t[j] >= inizio; j--)
                    if (!double.IsNaN(val[j])) max = Math.Max(max, Math.Abs(val[j]));
                if (max <= 0) continue;
                // Il 15% d'aria della pagina, con un minimo di mezza coda.
                var semi = Math.Max(0.5, max * 1.15);
                SetValue(semi, 0, offset);
                SetValue(-semi, 1, offset);
            }
        }

        public override void OnPaintChart(PaintChartEventArgs args)
        {
            base.OnPaintChart(args);
            if (CurrentChart == null || args.WindowIndex < 0 || args.WindowIndex >= CurrentChart.Windows.Length) return;
            var conv = CurrentChart.Windows[args.WindowIndex].CoordinatesConverter;
            var g = args.Graphics;
            var area = args.Rectangle;
            var s = serie;
            var t = s.T;
            var v = s.V;

            var clipPrima = g.Clip;
            var modo = g.SmoothingMode;
            g.SetClip(area);
            g.SmoothingMode = SmoothingMode.AntiAlias;
            try
            {
                var zero = (float)conv.GetChartY(0);
                using (var penZero = new Pen(Color.FromArgb(90, GRIGIO), 1f))
                    g.DrawLine(penZero, area.Left, zero, area.Right, zero);

                if (t.Length > 0)
                {
                    // Solo i campioni visibili, con un campione di margine ai lati.
                    var da = Math.Max(0, UltimoPrima(t, conv.GetTime(area.Left)));
                    var a = Math.Min(t.Length - 1, UltimoPrima(t, conv.GetTime(area.Right)) + 1);
                    DisegnaSerie(g, conv, t, v, da, a, zero);
                }
                Intestazione(g, area, v);
            }
            finally
            {
                g.SmoothingMode = modo;
                g.Clip = clipPrima;
            }
        }

        /// <summary>
        /// Tratti consecutivi dello stesso segno diventano un poligono riempito
        /// fino allo zero e una spezzata: verde sopra, rosso sotto, il colore del
        /// punto d'arrivo come `segment` nella pagina. Con piu' campioni che
        /// pixel, per ogni colonna si tengono il minimo e il massimo.
        /// </summary>
        private static void DisegnaSerie(Graphics g, TradingPlatform.BusinessLayer.Chart.IChartWindowCoordinatesConverter conv,
            DateTime[] t, double[] v, int da, int a, float zero)
        {
            var punti = new List<(float x, float y, double val)>();
            using var penV = new Pen(VERDE, 1.8f) { LineJoin = LineJoin.Round };
            using var penR = new Pen(ROSSO, 1.8f) { LineJoin = LineJoin.Round };
            using var fillV = new SolidBrush(Color.FromArgb(71, VERDE));
            using var fillR = new SolidBrush(Color.FromArgb(71, ROSSO));

            void Chiudi()
            {
                // Spezza in tratti dello stesso segno; il punto di confine sta in entrambi.
                var inizio = 0;
                for (var i = 1; i <= punti.Count; i++)
                {
                    var fine = i == punti.Count || (punti[i].val >= 0) != (punti[i - 1].val >= 0);
                    if (!fine) continue;
                    var sopra = punti[i - 1].val >= 0;
                    var linea = new List<PointF>();
                    for (var k = Math.Max(0, inizio - 1); k < i; k++) linea.Add(new PointF(punti[k].x, punti[k].y));
                    if (linea.Count >= 2)
                    {
                        var poli = new List<PointF>(linea) { new PointF(linea[^1].X, zero), new PointF(linea[0].X, zero) };
                        g.FillPolygon(sopra ? fillV : fillR, poli.ToArray());
                        g.DrawLines(sopra ? penV : penR, linea.ToArray());
                    }
                    inizio = i;
                }
                punti.Clear();
            }

            var colonna = int.MinValue;
            (float x, float y, double val)? minimo = null, massimo = null;
            void Svuota()
            {
                if (minimo == null) return;
                punti.Add(minimo.Value);
                if (massimo.Value.val != minimo.Value.val) punti.Add(massimo.Value);
                minimo = massimo = null;
            }

            for (var i = da; i <= a; i++)
            {
                var buco = i > da && (t[i] - t[i - 1]).TotalSeconds > BUCO_SEC;
                if (double.IsNaN(v[i]) || buco)
                {
                    Svuota();
                    Chiudi();
                    if (double.IsNaN(v[i])) continue;
                }
                var x = (float)conv.GetChartX(t[i]);
                var y = (float)conv.GetChartY(v[i]);
                var c = (int)Math.Floor(x);
                if (c != colonna) { Svuota(); colonna = c; }
                var p = (x, y, v[i]);
                if (minimo == null || v[i] < minimo.Value.val) minimo = p;
                if (massimo == null || v[i] > massimo.Value.val) massimo = p;
            }
            Svuota();
            Chiudi();
        }

        /// <summary>L'intestazione della pagina: cosa si guarda e il valore di adesso, colorato per segno.</summary>
        private void Intestazione(Graphics g, Rectangle area, double[] v)
        {
            using var font = new Font("Arial", 8.5f, FontStyle.Regular);
            using var grassetto = new Font("Arial", 8.5f, FontStyle.Bold);
            var titolo = Livelli == 1
                ? $"Order Flow Imbalance al migliore (OFI) · somma {Finestra} s · "
                : $"Order Flow Imbalance multilivello (MLOFI) · primi {Livelli} livelli · somma {Finestra} s · ";
            using var grigio = new SolidBrush(GRIGIO);
            g.DrawString(titolo, font, grigio, area.Left + 6, area.Top + 4);
            var w = g.MeasureString(titolo, font).Width;

            double? ultimo = null;
            for (var i = v.Length - 1; i >= 0 && ultimo == null; i--) if (!double.IsNaN(v[i])) ultimo = v[i];
            var testo = (Livelli == 1 ? "OFI " : "MLOFI ") + (ultimo == null ? "-" : Compatto(ultimo.Value));
            using var colore = new SolidBrush(ultimo == null ? Color.White : ultimo >= 0 ? VERDE : ROSSO);
            g.DrawString(testo, grassetto, colore, area.Left + 6 + w, area.Top + 4);
        }

        /// <summary>Come valoreBook() della pagina: segno, e un decimale sotto 10.</summary>
        private static string Compatto(double x) =>
            (x > 0 ? "+" : "") + (Math.Abs(x) >= 10 ? x.ToString("0", CultureInfo.InvariantCulture) : x.ToString("0.0", CultureInfo.InvariantCulture));

        /// <summary>Indice dell'ultimo orario strettamente prima di `limite`, -1 se nessuno.</summary>
        private static int UltimoPrima(DateTime[] t, DateTime limite)
        {
            int lo = 0, hi = t.Length - 1, r = -1;
            while (lo <= hi)
            {
                var m = (lo + hi) >> 1;
                if (t[m] < limite) { r = m; lo = m + 1; }
                else hi = m - 1;
            }
            return r;
        }

        private async Task Ciclo(CancellationToken token)
        {
            var livelliUsati = -1;
            var finestraUsata = -1;
            while (!token.IsCancellationRequested)
            {
                try
                {
                    var nuovi = await Leggi(token);
                    if (nuovi || livelliUsati != Livelli || finestraUsata != Finestra)
                    {
                        livelliUsati = Livelli;
                        finestraUsata = Finestra;
                        Calcola(livelliUsati, finestraUsata);
                    }
                }
                catch (Exception) when (!token.IsCancellationRequested)
                {
                    // dashboard spenta o risposta rotta: si riprova al giro dopo
                }
                try { await Task.Delay(2000, token); } catch (TaskCanceledException) { return; }
            }
        }

        private async Task<bool> Leggi(CancellationToken token)
        {
            var alias = (AliasBookmap ?? "").Trim();
            if (aliasUsato != alias) { campioni.Clear(); ultimoTempo = null; aliasUsato = alias; }

            var since = ultimoTempo;
            var url = BaseUrl.TrimEnd('/') + (since != null ? "/api/bookmap?since=" + since : "/api/bookmap");
            using var res = await http.GetAsync(url, token);
            if (!res.IsSuccessStatusCode) return false;
            using var doc = await JsonDocument.ParseAsync(await res.Content.ReadAsStreamAsync(token), cancellationToken: token);
            var root = doc.RootElement;

            var data = Stringa(root, "date");
            if (data != giorno)
            {
                giorno = data;
                campioni.Clear();
                if (since != null) { ultimoTempo = null; return true; }
            }
            if (data == null || !DateTime.TryParseExact(data, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var mezzanotte)) return false;
            if (!root.TryGetProperty("points", out var punti) || punti.ValueKind != JsonValueKind.Array) return false;

            var nuovi = false;
            foreach (var p in punti.EnumerateArray())
            {
                var t = Stringa(p, "time");
                if (t == null) continue;
                ultimoTempo = t;
                if (alias.Length > 0 && Stringa(p, "alias") != alias) continue;
                double[] ofi = null;
                if (p.TryGetProperty("ofi", out var o) && o.ValueKind == JsonValueKind.Array)
                {
                    ofi = new double[o.GetArrayLength()];
                    var k = 0;
                    foreach (var x in o.EnumerateArray()) ofi[k++] = x.ValueKind == JsonValueKind.Number ? x.GetDouble() : 0;
                }
                var q1B = Numero(p, "q1B");
                var q1A = Numero(p, "q1A");
                // Gli orari dell'add-on sono ora locale di questo PC; Quantower ragiona in UTC.
                var utc = DateTime.SpecifyKind(mezzanotte.AddSeconds(Secondi(t)), DateTimeKind.Local).ToUniversalTime();
                campioni.Add(new Campione
                {
                    Utc = utc,
                    Ofi = ofi,
                    Qm = Numero(p, "qm"),
                    Q1 = q1B != null && q1A != null ? (q1B + q1A) / 2 : null,
                });
                nuovi = true;
            }
            if (nuovi && campioni.Count > 0)
            {
                var limite = campioni[^1].Utc.AddSeconds(-MAX_SEC);
                campioni.RemoveAll(c => c.Utc < limite);
            }
            return nuovi;
        }

        /// <summary>mlofiMobile() della pagina: somme mobili di OFI e code sulla finestra.</summary>
        private void Calcola(int n, int finestraSec)
        {
            var t = new DateTime[campioni.Count];
            var v = new double[campioni.Count];
            var e = new double?[campioni.Count];
            var q = new double[campioni.Count];
            for (var i = 0; i < campioni.Count; i++)
            {
                var c = campioni[i];
                t[i] = c.Utc;
                var coda = n == 1 ? c.Q1 : c.Qm;
                if (c.Ofi == null || coda is not > 0) continue;
                double s = 0;
                for (var m = 0; m < n && m < c.Ofi.Length; m++) s += c.Ofi[m];
                e[i] = s;
                q[i] = coda.Value;
            }

            int j = 0, k = 0;
            double sommaE = 0, sommaQ = 0;
            for (var i = 0; i < t.Length; i++)
            {
                if (e[i] != null) { sommaE += e[i].Value; sommaQ += q[i]; k++; }
                while ((t[i] - t[j]).TotalSeconds >= finestraSec)
                {
                    if (e[j] != null) { sommaE -= e[j].Value; sommaQ -= q[j]; k--; }
                    j++;
                }
                v[i] = e[i] != null && k > 0 ? sommaE / (n * (sommaQ / k)) : double.NaN;
            }
            serie = new Serie { T = t, V = v };
            versione++;
        }

        private static int Secondi(string hhmmss)
        {
            var p = hhmmss.Split(':');
            if (p.Length < 3) return 0;
            int.TryParse(p[0], out var h);
            int.TryParse(p[1], out var m);
            int.TryParse(p[2], out var s);
            return h * 3600 + m * 60 + s;
        }

        private static double? Numero(JsonElement e, string nome) =>
            e.TryGetProperty(nome, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetDouble(out var d) && double.IsFinite(d) ? d : null;

        private static string Stringa(JsonElement e, string nome) =>
            e.TryGetProperty(nome, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
    }
}
