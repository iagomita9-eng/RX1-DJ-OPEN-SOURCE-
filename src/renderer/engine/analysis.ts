import type { Bands, Grid } from './types';

// Detecção de BPM e grade de batidas, pensada para música eletrônica com bumbo marcado (psy, drum and bass...).
// Passos: (1) energia dos graves → (2) "onsets" (subidas de energia) → (3) autocorrelação para achar o andamento
// → (4) refino fino do BPM e da fase → (5) escolha de qual batida abre o compasso.
const RATE = 400; // pontos por segundo (alvo) no envelope de onsets (~2,5 ms)

export function analyzeGrid(buf: { sampleRate: number; length: number; numberOfChannels: number; getChannelData(c: number): Float32Array },
  minBpm = 120, maxBpm = 190): Grid | null {
  const sr = buf.sampleRate, hop = Math.round(sr / RATE), n = Math.floor(buf.length / hop);
  const rate = sr / hop; // taxa REAL do envelope (hop é inteiro): usar RATE aqui deslocaria o BPM em ~0,2%
  if (n < rate * 10) return null; // faixa curta demais para estimar
  const chs = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));

  // 1) Duas bandas por fatia: grave (passa-baixa ~150 Hz, o bumbo) e agudos (x menos passa-baixa ~1 kHz: caixa, chimbal)
  const aLo = 1 - Math.exp(-2 * Math.PI * 150 / sr), aMid = 1 - Math.exp(-2 * Math.PI * 1000 / sr);
  const eL = new Float32Array(n), eH = new Float32Array(n);
  let yl = 0, ym = 0;
  for (let i = 0; i < n; i++) {
    let sl = 0, sh = 0;
    for (let j = i * hop, end = j + hop; j < end; j++) {
      let x = 0; for (const c of chs) x += c[j];
      x /= chs.length; yl += aLo * (x - yl); ym += aMid * (x - ym);
      const h = x - ym; sl += yl * yl; sh += h * h;
    }
    eL[i] = Math.sqrt(sl / hop); eH[i] = Math.sqrt(sh / hop);
  }
  // 2) onsets = só as subidas de energia de cada banda, normalizadas pela média e somadas
  //    (só o grave não basta em drum and bass: o andamento aparece na caixa e nos chimbais)
  const flux = (e: Float32Array) => { const o = new Float32Array(n); let m = 0; for (let i = 1; i < n; i++) { o[i] = Math.max(0, e[i] - e[i - 1]); m += o[i]; } m = m / n || 1; for (let i = 0; i < n; i++) o[i] /= m; return o; };
  const oL = flux(eL), oH = flux(eH), o = new Float32Array(n);
  for (let i = 0; i < n; i++) o[i] = oL[i] + 0.6 * oH[i];
  const smooth = (src: Float32Array) => { // leve alisamento (±2 pontos) tolera jitter
    const r = new Float32Array(n);
    for (let i = 2; i < n - 2; i++) r[i] = (src[i - 2] + 2 * src[i - 1] + 3 * src[i] + 2 * src[i + 1] + src[i + 2]) / 9;
    return r;
  };
  const os = smooth(o);
  // Para decidir ONDE está a batida, o grave pesa mais: em psytrance, chimbal e baixo nos contratempos são fortes e
  // podiam roubar a fase do bumbo (grade meia batida deslocada).
  const oK = new Float32Array(n);
  for (let i = 0; i < n; i++) oK[i] = oL[i] + 0.25 * oH[i];
  const osK = smooth(oK);

  // 3) Andamento por autocorrelação. Cada lag candidato L é pontuado junto com seus múltiplos (2L, 3L, 4L):
  //    o período de uma batida real repete também a cada 2, 3 e 4 batidas; um "falso" 3/2 do andamento não.
  //    Usa até 150 s do meio da faixa (basta para o andamento; o refino abaixo usa a faixa toda).
  const m = Math.min(n, Math.floor(rate * 150)), s0 = Math.floor((n - m) / 2);
  const lMin = Math.floor(rate * 60 / maxBpm), lMax = Math.ceil(rate * 60 / minBpm);
  const memo = new Float64Array(4 * (lMax + 2) + 1).fill(NaN);
  const corr = (L: number) => {
    if (!Number.isNaN(memo[L])) return memo[L];
    let sum = 0; for (let i = s0; i + L < s0 + m; i++) sum += os[i] * os[i + L];
    return (memo[L] = sum / (m - L));
  };
  const score = (L: number) => corr(L) + 0.7 * corr(2 * L) + 0.5 * corr(3 * L) + 0.35 * corr(4 * L);
  let best = lMin;
  for (let L = lMin; L <= lMax; L++) if (score(L) > score(best)) best = L;
  const r0 = score(best - 1), r1 = score(best), r2 = score(best + 1), d = r0 - 2 * r1 + r2;
  const lag = best + (d !== 0 ? 0.5 * (r0 - r2) / d : 0); // pico interpolado
  const bpm0 = 60 * rate / lag;

  // 4) refino: para cada BPM candidato e cada fase, soma o onset nos instantes das batidas
  const dur = n / rate;
  const scan = (center: number, half: number, step: number, phaseStep: number, arr: Float32Array = os) => {
    let top = { bpm: center, phase: 0, score: -1 };
    for (let bpm = center - half; bpm <= center + half + 1e-9; bpm += step) {
      const P = 60 / bpm;
      for (let ph = 0; ph < P; ph += phaseStep) {
        let s = 0, cnt = 0;
        for (let t = ph; t < dur - 0.05; t += P) { s += arr[Math.round(t * rate)]; cnt++; }
        s /= cnt || 1;
        if (s > top.score) top = { bpm, phase: ph, score: s };
      }
    }
    return top;
  };
  let fit = scan(bpm0, 1.0, 0.02, 0.005);
  fit = scan(fit.bpm, 0.03, 0.002, 0.002);
  fit = scan(fit.bpm, 0.004, 0.0005, 0.001); // refino final: passo de 0,0005 BPM (0,03 ms de erro por batida)
  const snapped = Math.round(fit.bpm);
  // BPM "redondo": só trava se estiver praticamente em cima (0,003 BPM ≈ 6 ms de deriva em 5 min)
  if (Math.abs(fit.bpm - snapped) < 0.003) fit = scan(snapped, 0, 1, 0.001);

  fit = scan(fit.bpm, 0, 1, 0.002, osK); // fase pelo "bumbo" (tempo já está decidido)

  // 4b) Regressão batida a batida na faixa toda: mede quanto o onset real se afasta de cada batida prevista e ajusta
  //     período e fase por mínimos quadrados (usa só as batidas fortes; corta os desvios grandes). Também mede a qualidade.
  const line = (P0: number, first0: number, lockP: boolean) => {
    let P = P0, first = first0, quality = 0, jitter = 99;
    for (let it = 0; it < 3; it++) {
      const w = Math.max(2, Math.round(Math.min(0.05, 0.12 * P) * rate));
      const ks: number[] = [], ds: number[] = [], ss: number[] = []; let total = 0;
      for (let k = 0; ; k++) {
        const t = first + k * P; if (t >= dur - 0.1) break;
        total++;
        const c = Math.round(t * rate); if (c < w || c + w >= n) continue;
        let bi = c, bv = 0; for (let j = c - w; j <= c + w; j++) if (osK[j] > bv) { bv = osK[j]; bi = j; }
        ks.push(k); ds.push(bi / rate - t); ss.push(bv);
      }
      if (ks.length < 16) break;
      const med = [...ss].sort((x, y) => x - y)[ss.length >> 1];
      let idx = ks.map((_, i) => i).filter(i => ss[i] >= med);
      let a0 = 0, b0 = 0, mad = 1e-3;
      for (let pass = 0; pass < 2 && idx.length >= 8; pass++) {
        let sk = 0, sd = 0, skk = 0, skd = 0;
        for (const i of idx) { sk += ks[i]; sd += ds[i]; skk += ks[i] * ks[i]; skd += ks[i] * ds[i]; }
        const m = idx.length, den = m * skk - sk * sk;
        b0 = lockP || Math.abs(den) < 1e-9 ? 0 : (m * skd - sk * sd) / den;
        a0 = (sd - b0 * sk) / m;
        const res = idx.map(i => Math.abs(ds[i] - a0 - b0 * ks[i]));
        mad = [...res].sort((x, y) => x - y)[res.length >> 1] || 1e-4;
        idx = idx.filter((_, ii) => res[ii] <= 3.5 * mad + 0.002);
      }
      first += a0; P += b0;
      // qualidade: das batidas com algum onset relevante, quantas caem a menos de 12 ms da grade ajustada
      const ok = ks.filter((k, i) => ss[i] >= 0.5 * med && Math.abs(ds[i] - a0 - b0 * k) < 0.012).length;
      quality = ok / Math.max(total, 1); jitter = mad * 1.4826 * 1000;
    }
    while (first >= P) first -= P; while (first < 0) first += P;
    return { P, first, quality, jitter };
  };
  let line1 = line(60 / fit.bpm, fit.phase, false);
  if (Math.abs(60 / line1.P - fit.bpm) > 0.05) line1 = { P: 60 / fit.bpm, first: fit.phase, quality: 0, jitter: 99 }; // regressão discordou demais: mantém o ajuste por comb
  else if (Math.abs(60 / line1.P - Math.round(60 / line1.P)) < 0.003) line1 = line(60 / Math.round(60 / line1.P), line1.first, true); // BPM redondo: trava e ajusta só a fase
  fit = { bpm: 60 / line1.P, phase: line1.first, score: fit.score };

  // 5) qual das 4 batidas do compasso tem mais energia? (empate → a primeira)
  const P = 60 / fit.bpm, acc = [0, 0, 0, 0];
  for (let k = 0, t = fit.phase; t < dur - 0.05; k++, t += P) acc[k % 4] += osK[Math.round(t * rate)];
  let barOffset = 0; for (let m = 1; m < 4; m++) if (acc[m] > acc[barOffset] * 1.05) barOffset = m;

  return { bpm: fit.bpm, first: fit.phase, period: P, barOffset, quality: line1.quality, jitterMs: line1.jitter };
}

// Waveform em 3 bandas (grave / médio / agudo): pico de cada banda por fatia de 1/perSecond s.
export function computeBands(buf: { sampleRate: number; length: number; numberOfChannels: number; getChannelData(c: number): Float32Array }, perSecond: number): Bands {
  const step = buf.sampleRate / perSecond, n = Math.ceil(buf.length / step);
  const low = new Float32Array(n), mid = new Float32Array(n), high = new Float32Array(n);
  const chs = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
  const a1 = 1 - Math.exp(-2 * Math.PI * 200 / buf.sampleRate), a2 = 1 - Math.exp(-2 * Math.PI * 2000 / buf.sampleRate);
  let y1 = 0, y2 = 0;
  for (let i = 0; i < n; i++) {
    let ml = 0, mm = 0, mh = 0;
    for (let j = Math.floor(i * step), e = Math.min(buf.length, Math.floor((i + 1) * step)); j < e; j++) {
      let x = 0; for (const c of chs) x += c[j];
      x /= chs.length; y1 += a1 * (x - y1); y2 += a2 * (x - y2);
      const l = Math.abs(y1), m = Math.abs(y2 - y1), h = Math.abs(x - y2); // grave <200 Hz, médio 200 Hz–2 kHz, agudo >2 kHz
      if (l > ml) ml = l; if (m > mm) mm = m; if (h > mh) mh = h;
    }
    low[i] = ml; mid[i] = mm; high[i] = mh;
  }
  return { low, mid, high };
}

// Acha o início real de um golpe (kick/snare) perto de uma posição candidata — usado só ao MARCAR o
// CUE (QUANTIZE desligado), nunca durante a busca com o stutter (que toca sempre a posição crua, pra
// nunca descolar do que a tela mostra). Energia de banda larga: o golpe costuma ter conteúdo em todas
// as frequências, e isso bate com o que a waveform desenha.
export function refineCue(buf: { sampleRate: number; length: number; numberOfChannels: number; getChannelData(c: number): Float32Array },
  candidate: number, before = 0.08, after = 0.08): number {
  const sr = buf.sampleRate;
  const i0 = Math.max(0, Math.floor((candidate - before) * sr)), i1 = Math.min(buf.length - 1, Math.floor((candidate + after) * sr));
  if (i1 - i0 < 64) return candidate;
  const chs = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
  const win = Math.max(1, Math.round(0.0015 * sr));
  const n = i1 - i0 + 1, raw = new Float32Array(n), env = new Float32Array(n);
  for (let i = i0; i <= i1; i++) { let x = 0; for (const c of chs) x += c[i]; raw[i - i0] = (x / chs.length) ** 2; }
  let acc = 0;
  for (let i = 0; i < n; i++) { acc += raw[i]; if (i >= win) acc -= raw[i - win]; env[i] = acc / Math.min(win, i + 1); }
  let peak = 0, peakE = -1, mean = 0;
  for (let i = 0; i < n; i++) { mean += env[i]; if (env[i] > peakE) { peakE = env[i]; peak = i; } }
  mean /= n;
  // Sem transiente de verdade na janela (silêncio, ou tudo parecido): não força nada, fica na posição
  // pedida. Sem isto, uma janela sem golpe caía sempre no início dela mesma (viés pra trás a cada chamada
  // — grave numa busca contínua, onde isto roda a cada tique do jog).
  if (peakE < 1e-9 || peakE < mean * 3) return candidate;
  const thresh = peakE * 0.15;
  let onset = peak;
  while (onset > 0 && env[onset - 1] > thresh) onset--;
  return (i0 + onset) / sr;
}

