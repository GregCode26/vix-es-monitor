/**
 * Mirino per un grafico Chart.js (26/11/2026, "puntatore a croce fino sulle scale su tutte le pagine"):
 * due linee tratteggiate dal puntatore fin dentro le scale e, su ogni scala visibile, il valore sotto
 * il puntatore in un'etichetta. Generico: per i grafici che non avevano gia' un mirino loro.
 * Uso: plugins={[mirinoChartJs()]} (oppure nell'array `plugins` di new Chart).
 */
import type { Chart, Plugin, Scale } from 'chart.js';

type ConMirino = Chart & { $mirinoPos?: { x: number; y: number } | null };

const formato = (s: Scale, v: number): string => {
  if (s.type === 'category') return String(s.getLabelForValue(Math.round(v)));
  if (s.type === 'time' || s.type === 'timeseries') {
    const d = new Date(v);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  const ampiezza = Math.abs((s.max as number) - (s.min as number));
  const dec = ampiezza >= 1000 ? 0 : ampiezza >= 20 ? 1 : ampiezza >= 1 ? 2 : 4;
  return v.toLocaleString('it-IT', { minimumFractionDigits: dec, maximumFractionDigits: dec });
};

export function mirinoChartJs(id = 'mirinoAssi'): Plugin {
  return {
    id,
    afterEvent(chart, args) {
      const c = chart as ConMirino;
      const e = args.event;
      const a = chart.chartArea;
      if (e.type === 'mouseout' || e.x == null || e.y == null || e.x < a.left || e.x > a.right || e.y < a.top || e.y > a.bottom) {
        if (c.$mirinoPos) { c.$mirinoPos = null; args.changed = true; }
        return;
      }
      c.$mirinoPos = { x: e.x, y: e.y };
      args.changed = true;
    },
    afterDraw(chart) {
      const m = (chart as ConMirino).$mirinoPos;
      if (!m) return;
      const { ctx, chartArea: a } = chart;
      const scale = Object.values(chart.scales).filter((s) => s.options.display !== false);
      const orizzontali = scale.filter((s) => s.isHorizontal());
      const verticali = scale.filter((s) => !s.isHorizontal());
      const sinistra = Math.min(a.left, ...verticali.map((s) => s.left));
      const destra = Math.max(a.right, ...verticali.map((s) => s.right));
      const alto = Math.min(a.top, ...orizzontali.map((s) => s.top));
      const basso = Math.max(a.bottom, ...orizzontali.map((s) => s.bottom));

      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.75)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(m.x, alto);
      ctx.lineTo(m.x, basso);
      ctx.moveTo(sinistra, m.y);
      ctx.lineTo(destra, m.y);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.font = 'bold 10px ui-sans-serif, system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      const etichetta = (testo: string, cx: number, cy: number) => {
        const w = ctx.measureText(testo).width + 8;
        ctx.fillStyle = '#1e293b';
        ctx.fillRect(cx - w / 2, cy - 8, w, 16);
        ctx.fillStyle = '#f8fafc';
        ctx.fillText(testo, cx, cy);
      };
      for (const s of orizzontali) {
        const v = s.getValueForPixel(m.x);
        if (v == null || !Number.isFinite(v)) continue;
        etichetta(formato(s, v), m.x, s.position === 'top' ? s.bottom - 8 : s.top + 8);
      }
      for (const s of verticali) {
        const v = s.getValueForPixel(m.y);
        if (v == null || !Number.isFinite(v)) continue;
        etichetta(formato(s, v), (s.left + s.right) / 2, m.y);
      }
      ctx.restore();
    },
  };
}
