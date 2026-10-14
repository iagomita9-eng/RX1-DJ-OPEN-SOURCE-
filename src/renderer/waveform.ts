// Waveform em 3 bandas, mesma paleta nos dois decks: grave em azul (atrás), médio em âmbar, agudo em branco (na frente).
import type { Bands, Grid } from './engine/types';

const LOW = '#2a7cf6', MID = '#f0902a', HIGH = '#f4f8ff', CUE = '#ffb000';

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
  g.fillStyle = '#050505'; g.fillRect(0, 0, W, H);
  for (let x = 0; b && x < W; x++) {
    const i0 = Math.floor((pos + ((x - W / 2) / W) * windowSec) * pps);
    const i1 = Math.max(i0, Math.floor((pos + ((x + 1 - W / 2) / W) * windowSec) * pps));
    if (i1 < 0 || i0 >= b.low.length) continue;
    column(g, x, H / 2, maxIn(b.low, i0, i1), maxIn(b.mid, i0, i1), maxIn(b.high, i0, i1));
  }
  if (grid) { // marcas de batida em vermelho no topo e na base; o início de cada compasso é maior
    const t0 = pos - windowSec / 2, t1 = pos + windowSec / 2, dpr = window.devicePixelRatio || 1;
    for (let k = Math.ceil((t0 - grid.first) / grid.period); grid.first + k * grid.period <= t1; k++) {
      const x = Math.round(((grid.first + k * grid.period - t0) / windowSec) * W), bar = (((k - grid.barOffset) % 4) + 4) % 4 === 0;
      g.fillStyle = bar ? '#ff4d4d' : '#b83232';
      const h = (bar ? 0.22 : 0.11) * H, wd = (bar ? 2 : 1) * dpr;
      g.fillRect(x, 0, wd, h); g.fillRect(x, H - h, wd, h);
    }
  }
  // A bandeira fica apagada quando a posição atual já não está mais em cima do CUE marcado — sinal de
  // que você está procurando um ponto NOVO (jog/stutter) e essa marca é de uma vez anterior, não "ao vivo".
  if (cue !== null) cueMark(g, Math.round(((cue - (pos - windowSec / 2)) / windowSec) * W), H, Math.abs(pos - cue) < 0.05 ? 1 : 0.35);
  g.fillStyle = '#fff'; g.fillRect(Math.floor(W / 2) - 1, 0, 2, H);
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

// Barra de pontos estilo CDJ-350/850: fileira de segmentos que vão acendendo da esquerda para a direita
// conforme a faixa toca (sem detalhe de forma de onda, só progresso), como no display de cristal líquido.
export function drawDots(c: HTMLCanvasElement, pos: number, dur: number, cue: number | null = null) {
  const g = fit(c), W = c.width, H = c.height, dpr = window.devicePixelRatio || 1;
  g.fillStyle = '#050505'; g.fillRect(0, 0, W, H);
  const gap = 11 * dpr, r = 3.6 * dpr, n = Math.max(1, Math.floor(W / gap)), y = H / 2, frac = dur ? pos / dur : 0;
  for (let i = 0; i < n; i++) {
    const x = gap / 2 + i * gap, on = i / n <= frac;
    g.fillStyle = on ? '#ffb733' : '#3a2a10';
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  if (cue !== null && dur) {
    const x = (cue / dur) * W; g.globalAlpha = Math.abs(pos - cue) < 0.05 ? 1 : 0.35;
    g.fillStyle = '#ffb000'; g.fillRect(x, 0, 2 * dpr, H); g.globalAlpha = 1;
  }
}

// Visão geral da faixa inteira; a parte já tocada fica mais escura.
export function drawOverview(c: HTMLCanvasElement, ov: Bands | null, pos: number, dur: number, cue: number | null = null) {
  const g = fit(c), W = c.width, H = c.height, px = dur ? (pos / dur) * W : 0;
  g.fillStyle = '#050505'; g.fillRect(0, 0, W, H);
  for (let x = 0; ov && x < W; x++) {
    const i = Math.floor((x / W) * ov.low.length);
    g.globalAlpha = x < px ? 0.4 : 1; column(g, x, H / 2, ov.low[i], ov.mid[i], ov.high[i]);
  }
  g.globalAlpha = 1;
  if (cue !== null && dur) cueMark(g, Math.round((cue / dur) * W), H, Math.abs(pos - cue) < 0.05 ? 1 : 0.35);
  g.fillStyle = '#fff'; g.fillRect(Math.floor(px), 0, 2, H);
}
