// Waveform em 3 bandas no estilo do display XDJ-RX: tudo em tons de azul/ciano, picos agudos quase brancos.
import type { Bands, Grid } from './engine/types';

const LOW = '#1456c8', MID = '#2fb6ff', HIGH = '#c8f1ff', CUE = '#ff9a1f', BG = '#000000';

export function fit(c: HTMLCanvasElement) {
  const dpr = window.devicePixelRatio || 1, w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  return c.getContext('2d')!;
}
function column(g: CanvasRenderingContext2D, x: number, half: number, l: number, m: number, h: number) {
  const bar = (v: number, color: string) => { const hh = Math.min(v, 1) * half * 0.95; g.fillStyle = color; g.fillRect(x, half - hh, 1, hh * 2); };
  bar(l, LOW); bar(m, MID); bar(h, HIGH);
}
const maxIn = (a: Float32Array, i0: number, i1: number) => { let m = 0; for (let i = Math.max(i0, 0), e = Math.min(i1, a.length - 1); i <= e; i++) if (a[i] > m) m = a[i]; return m; };

// Janela rolante com o playhead no centro. As bandas já vêm normalizadas (0..1) a 'pps' fatias por segundo.
export function drawDetail(c: HTMLCanvasElement, b: Bands | null, pps: number, pos: number, windowSec: number, grid: Grid | null = null, cue: number | null = null) {
  const g = fit(c), W = c.width, H = c.height;
  g.fillStyle = BG; g.fillRect(0, 0, W, H);
  // linha central fina (como no display)
  g.fillStyle = '#0d2a55'; g.fillRect(0, Math.floor(H / 2), W, 1);
  for (let x = 0; b && x < W; x++) {
    const i0 = Math.floor((pos + ((x - W / 2) / W) * windowSec) * pps);
    const i1 = Math.max(i0, Math.floor((pos + ((x + 1 - W / 2) / W) * windowSec) * pps));
    if (i1 < 0 || i0 >= b.low.length) continue;
    column(g, x, H / 2, maxIn(b.low, i0, i1), maxIn(b.mid, i0, i1), maxIn(b.high, i0, i1));
  }
  if (grid) { // marcas de batida brancas no topo e na base; o início de cada compasso em vermelho e maior
    const t0 = pos - windowSec / 2, t1 = pos + windowSec / 2, dpr = window.devicePixelRatio || 1;
    for (let k = Math.ceil((t0 - grid.first) / grid.period); grid.first + k * grid.period <= t1; k++) {
      const x = Math.round(((grid.first + k * grid.period - t0) / windowSec) * W), bar = (((k - grid.barOffset) % 4) + 4) % 4 === 0;
      g.fillStyle = bar ? '#ff3b30' : '#d0d8e8';
      const h = (bar ? 0.16 : 0.08) * H, wd = (bar ? 2 : 1) * dpr;
      g.fillRect(x, 0, wd, h); g.fillRect(x, H - h, wd, h);
    }
  }
  if (cue !== null) cueMark(g, Math.round(((cue - (pos - windowSec / 2)) / windowSec) * W), H, Math.abs(pos - cue) < 0.05 ? 1 : 0.35);
  // playhead vermelho com núcleo branco
  const cx = Math.floor(W / 2), dpr = window.devicePixelRatio || 1;
  g.fillStyle = '#ff3b30'; g.fillRect(cx - dpr, 0, 3 * dpr, H);
  g.fillStyle = '#fff'; g.fillRect(cx, 0, dpr, H);
}

// Marca do ponto de CUE: linha e "bandeira" laranja no topo. alpha < 1 = marca "parada" (não é a posição atual).
function cueMark(g: CanvasRenderingContext2D, x: number, H: number, alpha = 1) {
  const dpr = window.devicePixelRatio || 1;
  if (x < -10 * dpr || x > g.canvas.width + 10 * dpr) return;
  const prevAlpha = g.globalAlpha; g.globalAlpha = alpha;
  g.fillStyle = CUE; g.fillRect(x, 0, 2 * dpr, H);
  g.beginPath(); g.moveTo(x, 0); g.lineTo(x + 12 * dpr, 0); g.lineTo(x, 12 * dpr); g.closePath(); g.fill();
  g.beginPath(); g.moveTo(x, H); g.lineTo(x + 12 * dpr, H); g.lineTo(x, H - 12 * dpr); g.closePath(); g.fill();
  g.globalAlpha = prevAlpha;
}

// Barra de pontos estilo CDJ-350/850.
export function drawDots(c: HTMLCanvasElement, pos: number, dur: number, cue: number | null = null) {
  const g = fit(c), W = c.width, H = c.height, dpr = window.devicePixelRatio || 1;
  g.fillStyle = BG; g.fillRect(0, 0, W, H);
  const gap = 11 * dpr, r = 3.6 * dpr, n = Math.max(1, Math.floor(W / gap)), y = H / 2, frac = dur ? pos / dur : 0;
  for (let i = 0; i < n; i++) {
    const x = gap / 2 + i * gap, on = i / n <= frac;
    g.fillStyle = on ? '#ffb733' : '#3a2a10';
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  if (cue !== null && dur) {
    const x = (cue / dur) * W; g.globalAlpha = Math.abs(pos - cue) < 0.05 ? 1 : 0.35;
    g.fillStyle = CUE; g.fillRect(x, 0, 2 * dpr, H); g.globalAlpha = 1;
  }
}

// Visão geral da faixa inteira (estilo RX: forma de onda branca/cinza, só a metade de cima apoiada na base;
// a parte já tocada fica acinzentada).
export function drawOverview(c: HTMLCanvasElement, ov: Bands | null, pos: number, dur: number, cue: number | null = null) {
  const g = fit(c), W = c.width, H = c.height, px = dur ? (pos / dur) * W : 0, dpr = window.devicePixelRatio || 1;
  g.fillStyle = BG; g.fillRect(0, 0, W, H);
  for (let x = 0; ov && x < W; x++) {
    const i = Math.floor((x / W) * ov.low.length);
    const v = Math.min(1, Math.max(ov.low[i], ov.mid[i], ov.high[i])), hh = v * H * 0.9;
    g.fillStyle = x < px ? '#5a6270' : '#e8eef8';
    g.fillRect(x, H - hh, 1, hh);
  }
  // marcas de minuto na base
  if (dur) { g.fillStyle = '#ff3b30'; for (let m = 60; m < dur; m += 60) g.fillRect(Math.round((m / dur) * W), H - 3 * dpr, dpr, 3 * dpr); }
  if (cue !== null && dur) cueMark(g, Math.round((cue / dur) * W), H, Math.abs(pos - cue) < 0.05 ? 1 : 0.35);
  g.fillStyle = '#ff3b30'; g.fillRect(Math.floor(px), 0, 2 * dpr, H);
}
