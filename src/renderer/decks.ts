// Decks 1 e 2: liga MIDI (via mapa JSON) à engine e desenha a tela estilo player standalone.
import { api } from './bridge';
import { onMidi, send } from './midi';
import { WebAudioDeck } from './engine/webaudio';
import type { Bands, DeckEngine, Grid } from './engine/types';
import type { Mixer } from './engine/mixer';
import type { MidiMap } from './types';
import { drawDetail, drawDots, drawOverview } from './waveform';

const PPS = 200;                        // fatias de waveform por segundo
const RANGES = [0.04, 0.06, 0.08, 0.10, 0.16]; // SHIFT + SYNC alterna a faixa do fader de tempo

interface Deck {
  n: number; engine: DeckEngine; bands: Bands | null; ov: Bands | null; grid: Grid | null;
  touched: boolean; shift: boolean; base: number; nudge: number; nudgeTimer: number; msb: number; lsb: number; sync: boolean; range: number;
  ledPlay: boolean; ledCue: boolean; // último estado de LED enviado (só reenvia quando muda)
  stutterOn: boolean; // estado atual do "stutter cue" (reconciliado a cada quadro)
  padBlink: boolean; padBlinkT: number; // pisca-pisca dos pads perto do fim da faixa
  playBlinkT: number; // relógio do pisca-pisca do LED de PLAY enquanto pausado
  lastCount: number | null; // último valor mostrado no needle countdown (evita reanimar à toa)
  el: { title: HTMLElement; pos: HTMLElement; rem: HTMLElement; tempo: HTMLElement; state: HTMLElement; bpm: HTMLElement; bpmbox: HTMLElement; sync: HTMLElement; fone: HTMLElement; stutter: HTMLElement; trange: HTMLElement; bars: HTMLElement; nbeat: HTMLElement; detail: HTMLCanvasElement; ovc: HTMLCanvasElement };
}
const key = (kind: string, ch: number, num: number | null) => `${kind}:${ch}:${num ?? ''}`;
const clamp = (v: number, a: number, b: number) => Math.min(Math.max(v, a), b);
const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(3).padStart(6, '0')}`;

// Reduz as bandas para 'n' pontos (visão geral da faixa inteira).
function overview(p: Bands, n: number): Bands {
  const shrink = (a: Float32Array) => {
    const o = new Float32Array(n), step = a.length / n;
    for (let i = 0; i < n; i++) {
      let m = 0;
      for (let j = Math.floor(i * step), e = Math.max(j + 1, Math.floor((i + 1) * step)); j < e && j < a.length; j++) if (a[j] > m) m = a[j];
      o[i] = m;
    }
    return o;
  };
  return { low: shrink(p.low), mid: shrink(p.mid), high: shrink(p.high) };
}

export function initDecks(map: MidiMap, root: HTMLElement, ctx: AudioContext, mixer: Mixer, opts: { onLoad(n: number): void; notify(msg: string): void }) {
  // Ajustes opcionais no JSON do mapa ("settings"); defaults abaixo.
  const cfg = { tempoRange: 0.08, tempoInvert: false, jogScrubSeconds: 0.004, jogNudge: 0.02, jogSearchSeconds: 0.5, waveWindowSeconds: 12, bpmMin: 120, bpmMax: 190, screenFit: 'fill', stutterFrameSec: 0.15, stutterDelayMs: 0, stutterBurstMs: 25, endWarnSeconds: 20, ...map.settings };
  let winSec = cfg.waveWindowSeconds; // zoom da waveform (s); ajustável ao vivo pelo encoder do browse (fora do navegador)
  let cdjMode = false; // MODO CDJ 350: troca a waveform por uma barra de pontos de progresso (sem forma de onda)
  root.classList.toggle('aspect', cfg.screenFit === 'aspect'); // 'fill' (padrão) preenche a janela; 'aspect' mantém 5:3

  root.innerHTML = `
    <div class="topline"><span class="tag">AUTO PLAY</span><span class="zoom">ZOOM <small>${cfg.waveWindowSeconds}s</small> <span class="phase" title="Diferença de fase entre as batidas dos dois decks (deck 2 − deck 1)">Δ —</span></span><button class="tag cdjtoggle" title="CDJ 350 MODE: troca a waveform por uma barra de pontos de progresso, sem forma de onda">CDJ 350 MODE</button><button class="tag fxtoggle active" title="Mostrar/esconder o painel BEAT EFFECTS">FX</button><button class="tag infotoggle active" title="Mostrar/esconder a caixa DECK/LOCAL ao lado da waveform">INFO</button><button class="tag themetoggle" title="Alternar modo escuro/claro">☾/☀</button><button class="tag quant active" title="QUANTIZE: ao marcar o CUE parado fora do ponto, trava na batida mais próxima da grade em vez do golpe de áudio mais próximo">QUANTIZE</button></div>
    <div class="main">
      <div class="lanes">${[1, 2].map(n => `
        <div class="lane d${n}">
          <div class="lane-info"><span class="lane-tag">DECK ${n}</span><span>LOCAL</span><span class="dim">—</span><span class="dim lbars">— Bars</span></div>
          <div class="needle" title="Needle countdown: faltam N batidas pro início do próximo compasso"><span class="nbeat">–</span><small>COUNT</small></div>
          <canvas class="detail"></canvas>
        </div>`).join('')}</div>
      <div class="fxpanel"><div class="fxhead">BEAT EFFECTS</div><div class="fxname">—</div>
        <small>CH SELECT</small><b>—</b><small>PARAMETER</small><b>—</b><div class="fxbpm"><b>—</b><small>BPM</small></div></div>
    </div>
    <div class="panels">${[1, 2].map(n => `
      <section class="dpanel d${n}" id="deck${n}">
        <div class="ptitle"><span class="title">♪ sem faixa</span>
          <span class="gtools">
            <button data-g="half" title="BPM ÷ 2">÷2</button><button data-g="dbl" title="BPM × 2">×2</button>
            <button data-g="dn" title="BPM −0,01 (a batida mais próxima do playhead fica parada)">−.01</button><button data-g="up" title="BPM +0,01">+.01</button>
            <button data-g="l" title="Grade 5 ms para trás">◀</button><button data-g="r" title="Grade 5 ms para frente">▶</button>
            <button data-g="mid" title="Grade meia batida (bumbo ↔ contratempo)">½</button><button data-g="here" title="Marcar batida na posição atual (pare sobre um bumbo)">⚑</button>
          </span>
          <button class="load">CARREGAR</button></div>
        <div class="pinfo">
          <div class="pblk"><small>DECK</small><b class="pn">${n}</b></div>
          <div class="pblk"><small>TRACK</small><b class="pt">—</b></div>
          <div class="ptime"><small>REMAIN <span class="rem">-00:00.000</span></small><span class="pos">00:00.000</span></div>
          <div class="pblk"><small>TEMPO ±<span class="trange">${Math.round(cfg.tempoRange * 100)}</span>%</small><span class="tempo">+0.00%</span></div>
          <div class="bpmbox"><span class="bpm">—</span><small>BPM</small></div>
          <span class="flags"><span class="fone">FONE</span><span class="sync">SYNC</span><span class="stutter">STUTTER</span></span>
          <span class="state">❚❚</span>
        </div>
        <canvas class="overview"></canvas>
      </section>`).join('')}</div>`;

  const decks: Deck[] = [1, 2].map(n => {
    const q = <T extends HTMLElement>(c: string) => root.querySelector(`#deck${n} .${c}`) as T;
    return { n, engine: new WebAudioDeck(ctx, mixer.input(n), cfg.stutterFrameSec, (cfg.stutterDelayMs ?? 0) / 1000, (cfg.stutterBurstMs ?? 0) / 1000), bands: null, ov: null, grid: null,
      touched: false, shift: false, base: 1, nudge: 0, nudgeTimer: 0, msb: 64, lsb: 0, sync: false, range: cfg.tempoRange, ledPlay: false, ledCue: false, stutterOn: false, padBlink: false, padBlinkT: 0, playBlinkT: 0, lastCount: null,
      el: { title: q('title'), pos: q('pos'), rem: q('rem'), tempo: q('tempo'), state: q('state'), bpm: q('bpm'), bpmbox: q('bpmbox'), sync: q('sync'), fone: q('fone'), stutter: q('stutter'), trange: q('trange'), bars: root.querySelector(`.lane.d${n} .lbars`) as HTMLElement, nbeat: root.querySelector(`.lane.d${n} .nbeat`) as HTMLElement, ovc: q<HTMLCanvasElement>('overview'),
        detail: root.querySelector(`.lane.d${n} canvas`) as HTMLCanvasElement } };
  });

  // Carrega bytes já lidos na engine e prepara os dados da waveform.
  async function loadInto(d: Deck, f: { name: string; data: ArrayBuffer }) {
    if (d.engine.isPlaying()) { opts.notify(`DECK ${d.n} está tocando — pause antes de carregar`); return; } // segurança ao vivo
    d.el.title.textContent = '♪ carregando…'; d.grid = null; d.bands = null; d.ov = null;
    if (d.padBlink) { d.padBlink = false; const pc = d.n === 1 ? 8 : 10; for (let i = 0; i < 8; i++) send('note', pc, i, 0); for (const [ch, num] of [[d.n, 11], [d.n, 12], [d.n, 88], [d.n, 16], [d.n, 17]] as [number, number][]) send('note', ch, num, 0); } // apaga o pisca-pisca da faixa anterior
    try {
      await d.engine.load(f.data);
      // Bandas normalizadas por um fator comum; médio e agudo ganham realce, senão quase não aparecem ao lado do grave.
      const raw = d.engine.getBands(PPS), GM = 1.5, GH = 2.5;
      let mx = 0.0001;
      for (let i = 0; i < raw.low.length; i++) mx = Math.max(mx, raw.low[i], raw.mid[i] * GM, raw.high[i] * GH);
      d.bands = { low: raw.low.map(v => v / mx), mid: raw.mid.map(v => v * GM / mx), high: raw.high.map(v => v * GH / mx) };
      d.ov = overview(d.bands, 1200);
      d.el.title.textContent = '♪ analisando BPM…';
      await new Promise(r => setTimeout(r, 30)); // deixa a tela atualizar antes da análise (~0,3 s)
      d.grid = d.engine.analyzeGrid(cfg.bpmMin, cfg.bpmMax);
      if (d.grid && (cfg.bpmSnap ?? 0.1) > 0) { const r = Math.round(d.grid.bpm); if (Math.abs(d.grid.bpm - r) <= (cfg.bpmSnap ?? 0.1)) { d.grid.period *= d.grid.bpm / r; d.grid.bpm = r; } }
      const q = d.grid?.quality, j = d.grid?.jitterMs;
      d.el.bpmbox.title = d.grid ? `BPM detectado ${d.grid.bpm.toFixed(3)} · grade confirmada em ${Math.round((q ?? 0) * 100)}% das batidas · desvio ${(j ?? 0).toFixed(1)} ms` : 'BPM não detectado';
      if (d.sync) setSync(d, false);
      d.el.title.textContent = '♪ ' + f.name.replace(/\.[^.]+$/, '');
      padCascade(d.n); // avisa descendo HOT CUE/BEAT LOOP/BEAT JUMP/SAMPLER e depois os pads, que a faixa foi carregada
    } catch (e) { d.el.title.textContent = '♪ erro ao decodificar: ' + e; }
  }
  // Animação de cima pra baixo: primeiro os botões de modo (HOT CUE, BEAT LOOP, BEAT JUMP, SAMPLER —
  // ficam ACIMA da grade de pads na DDJ-400), depois os 8 pads (P1-P4, depois P5-P8). Cada LED acende
  // e apaga rápido, em sequência — só um sinal visual de "carregou". Códigos oficiais do PDF da DDJ-400.
  function padCascade(deckCh: number) {
    const modes: [number, number][] = [[deckCh, 27], [deckCh, 109], [deckCh, 32], [deckCh, 34]]; // HOT CUE, BEAT LOOP, BEAT JUMP, SAMPLER
    const padCh = deckCh === 1 ? 8 : 10;
    const seq: [number, number][] = [...modes, ...[0, 1, 2, 3, 4, 5, 6, 7].map(p => [padCh, p] as [number, number])];
    const step = 45;
    seq.forEach(([ch, note], i) => {
      setTimeout(() => { send('note', ch, note, 127); setTimeout(() => send('note', ch, note, 0), step); }, i * step);
    });
  }
  const loadDialog = async (d: Deck) => { const f = await api.openAudio(); if (f) await loadInto(d, f); };
  async function loadPath(n: number, path: string) { const f = await api.readAudio(path); if (f) await loadInto(decks[n - 1], f); }
  decks.forEach(d => (root.querySelector(`#deck${d.n} .load`) as HTMLElement).onclick = () => void loadDialog(d));

  const retempo = (d: Deck) => d.engine.setTempo(d.base * (1 + d.nudge));
  function applyTempo(d: Deck) {
    if (d.sync) return; // em SYNC o tempo vem do outro deck; o fader só volta a valer depois de desligar o SYNC
    let v = ((d.msb << 7) | d.lsb) / 16383; // fader de 14 bits: MSB + LSB → 0..1
    if (Math.abs(v - 0.5) < 0.004) v = 0.5;
    d.base = 1 + (v - 0.5) * 2 * d.range * (cfg.tempoInvert ? -1 : 1);
    // Fader magnético: se o BPM efetivo (grid × pitch) chegar perto de um número redondo, trava nele —
    // resolve o fader de 14 bits nunca cair exatamente em 145.00, só em 145.03/144.95.
    if (d.grid) {
      const eff = d.grid.bpm * d.base, r = Math.round(eff), snap = cfg.bpmSnap ?? 0.1;
      if (Math.abs(eff - r) <= snap) d.base = r / d.grid.bpm;
    }
    retempo(d);
  }
  const search = (d: Deck, delta: number) => d.engine.seek(d.engine.getPosition() + delta * cfg.jogSearchSeconds);
  function jog(d: Deck, delta: number) { // relativo: 64 = parado, >64 horário, <64 anti-horário
    if (!delta) return;
    if (d.shift) { search(d, delta); return; }                                           // SHIFT + jog: busca rápida
    if (!d.engine.isPlaying()) { d.engine.seek(d.engine.getPosition() + delta * cfg.jogScrubSeconds); return; } // parado: navega livre (sem travar em transiente — isso prendia o jog perto de um kick)
    d.nudge = clamp(delta * cfg.jogNudge, -0.1, 0.1); retempo(d);                        // tocando: pitch bend
    clearTimeout(d.nudgeTimer);
    d.nudgeTimer = window.setTimeout(() => { d.nudge = 0; retempo(d); }, 80);
  }

  // ---------- SYNC ----------
  // O deck com SYNC segue o BPM efetivo (BPM × pitch) do outro deck e, se os dois estão tocando, alinha a batida ao ligar.
  const other = (d: Deck) => decks[d.n === 1 ? 1 : 0];
  const syncRatio = (d: Deck) => { // razão de tempo que iguala os BPMs (dobrando/dividindo se preciso); null = impossível
    const L = other(d); if (!d.grid || !L.grid) return null;
    let r = (L.grid.bpm * L.base) / d.grid.bpm;
    while (r > 1.5) r /= 2; while (r < 0.75) r *= 2;
    return Math.abs(r - 1) <= 0.16 ? r : null;
  };
  const beatFrac = (x: Deck) => { const b = (x.engine.getPosition() - x.grid!.first) / x.grid!.period; return b - Math.floor(b); };
  const phaseErr = (a: Deck, b: Deck) => { const e = beatFrac(a) - beatFrac(b); return e - Math.round(e); }; // em batidas, −0,5..0,5
  const led = (name: string, on: boolean) => { const b = map.controls[name]; if (b && b.number !== null && b.kind !== 'pitchbend') send(b.kind, b.channel, b.number, on ? 127 : 0); };
  function setSync(d: Deck, on: boolean) {
    if (on) {
      const r = syncRatio(d);
      if (r === null) { opts.notify(d.grid && other(d).grid ? 'BPM diferente demais para SYNC' : 'SYNC precisa das duas faixas com BPM detectado'); return; }
      if (other(d).sync) setSync(other(d), false); // sempre um deck líder
      d.sync = true; d.base = r; retempo(d);
      const L = other(d);
      if (d.engine.isPlaying() && L.engine.isPlaying()) d.engine.seek(d.engine.getPosition() + phaseErr(L, d) * d.grid!.period); // alinha a batida
    } else d.sync = false;
    led(`deck${d.n}.sync`, d.sync);
  }
  function cycleRange(d: Deck) {
    d.range = RANGES[(RANGES.findIndex(r => Math.abs(r - d.range) < 1e-9) + 1) % RANGES.length];
    d.el.trange.textContent = String(Math.round(d.range * 100));
    applyTempo(d); opts.notify(`DECK ${d.n}: fader de tempo ±${Math.round(d.range * 100)}%`);
  }

  // ---------- ajuste manual da grade ----------
  const norm = (g: Grid) => { g.first = ((g.first % g.period) + g.period) % g.period; };
  // Se o BPM ficar bem perto de um número redondo (ex.: 139,90 → 140), trava nele. Limiar em settings.bpmSnap (padrão 0,10).
  function snapBpm(bpm: number) {
    const snap = cfg.bpmSnap ?? 0.1, r = Math.round(bpm);
    return Math.abs(bpm - r) <= snap ? r : bpm;
  }
  function setBpm(d: Deck, bpm: number, allowSnap = true) { // a batida mais próxima do playhead fica parada; o resto se ajusta em volta
    if (allowSnap) bpm = snapBpm(bpm);
    const g = d.grid!, t = g.first + Math.round((d.engine.getPosition() - g.first) / g.period) * g.period;
    g.bpm = bpm; g.period = 60 / bpm; g.first = t; norm(g);
  }
  function editGrid(d: Deck, act: string) {
    const g = d.grid; if (!g) return;
    if (act === 'half') setBpm(d, g.bpm / 2); else if (act === 'dbl') setBpm(d, g.bpm * 2);
    else if (act === 'dn') setBpm(d, g.bpm - 0.01); else if (act === 'up') setBpm(d, g.bpm + 0.01);
    else if (act === 'l') { g.first -= 0.005; norm(g); } else if (act === 'r') { g.first += 0.005; norm(g); }
    else if (act === 'mid') { g.first += g.period / 2; norm(g); }
    else if (act === 'here') { g.first = d.engine.getPosition(); norm(g); }
    g.manual = true;
    if (d.sync) { const r = syncRatio(d); if (r !== null) { d.base = r; retempo(d); } } // o SYNC acompanha a correção
  }
  decks.forEach(d => root.querySelectorAll(`#deck${d.n} .gtools button`).forEach(b => (b as HTMLElement).onclick = () => editGrid(d, (b as HTMLElement).dataset.g!)));

  const lookup = new Map<string, { d: Deck; action: string }>();
  function rebuild() {
    lookup.clear();
    for (const [name, b] of Object.entries(map.controls)) {
      const m = /^deck([12])\.(.+)$/.exec(name); if (!m) continue;
      const d = decks[Number(m[1]) - 1];
      lookup.set(key(b.kind, b.channel, b.number), { d, action: m[2] });
      if (m[2] === 'tempo' && b.number !== null) lookup.set(key('cc', b.channel, b.number + 32), { d, action: 'tempo.lsb' });
    }
  }
  rebuild();

  onMidi(p => {
    const hit = lookup.get(key(p.kind, p.channel, p.number)); if (!hit) return;
    const { d, action } = hit;
    switch (action) {
      case 'play': if (p.on) d.engine.isPlaying() ? d.engine.pause() : d.engine.play(); break;
      case 'cue': p.on ? d.engine.cue(quantizeOn ? d.grid : null, (cfg.cueLeadMs ?? 0) / 1000) : d.engine.cueRelease(); break;
      case 'load': if (p.on) opts.onLoad(d.n); break; // LOAD 1/2 são tratados pela tela (menu ou navegador)
      case 'shift': d.shift = !!p.on; break;
      case 'sync': if (p.on) setSync(d, !d.sync); break;       // o PDF avisa: esta mensagem vem ao SOLTAR o botão
      case 'sync.shift': if (p.on) cycleRange(d); break;      // SHIFT + SYNC: alterna a faixa do fader de tempo
      case 'jog.touch': d.touched = !!p.on; break; // o "stutter cue" é decidido a cada quadro (ver tick, abaixo)
      case 'jog.turn': jog(d, p.value - 64); break;
      case 'jog.turn.shift': search(d, p.value - 64); break; // se a DDJ-400 mandar SHIFT+jog como outro sinal, mapeie com este nome
      case 'tempo': d.msb = p.value; applyTempo(d); break;
      case 'tempo.lsb': d.lsb = p.value; applyTempo(d); break;
    }
  });

  const phaseEl = root.querySelector('.phase') as HTMLElement, zoomEl = root.querySelector('.zoom small') as HTMLElement;
  const cdjBtn = root.querySelector('.cdjtoggle') as HTMLButtonElement;
  cdjBtn.onclick = () => { cdjMode = !cdjMode; cdjBtn.classList.toggle('active', cdjMode); };

  // QUANTIZE: liga/desliga o travamento do CUE na grade de batida (em vez de ajustar pelo golpe de áudio).
  let quantizeOn = true;
  const quantBtn = root.querySelector('.quant') as HTMLButtonElement;
  quantBtn.onclick = () => { quantizeOn = !quantizeOn; quantBtn.classList.toggle('active', quantizeOn); };

  // Esconder/mostrar o painel BEAT EFFECTS e a caixa DECK/LOCAL das lanes.
  const fxBtn = root.querySelector('.fxtoggle') as HTMLButtonElement, fxPanel = root.querySelector('.fxpanel') as HTMLElement;
  fxBtn.onclick = () => { const on = fxBtn.classList.toggle('active'); fxPanel.style.display = on ? '' : 'none'; };
  const infoBtn = root.querySelector('.infotoggle') as HTMLButtonElement, infoBoxes = root.querySelectorAll('.lane-info');
  infoBtn.onclick = () => { const on = infoBtn.classList.toggle('active'); infoBoxes.forEach(el => (el as HTMLElement).style.display = on ? '' : 'none'); };

  // Modo claro/escuro: alterna uma classe no body; as cores em si vêm do CSS (variáveis :root.light).
  const themeBtn = root.querySelector('.themetoggle') as HTMLButtonElement;
  let theme: 'dark' | 'light' = cfg.theme === 'light' ? 'light' : 'dark';
  const applyTheme = () => { document.body.classList.toggle('light', theme === 'light'); themeBtn.classList.toggle('active', theme === 'light'); };
  applyTheme();
  themeBtn.onclick = () => { theme = theme === 'dark' ? 'light' : 'dark'; applyTheme(); };
  function setZoom(delta: number) {
    winSec = Math.min(40, Math.max(2, winSec + delta * 0.35));
    zoomEl.textContent = winSec.toFixed(1) + 's';
  }
  (function tick() {
    const now = performance.now();
    for (const d of decks) {
      const pos = d.engine.getPosition(), dur = d.engine.getDuration(), pct = (d.base - 1) * 100;
      d.el.pos.textContent = fmt(pos); d.el.rem.textContent = '-' + fmt(Math.max(0, dur - pos));
      d.el.tempo.textContent = `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
      d.el.state.textContent = d.engine.isPlaying() ? '▶' : '❚❚';
      // PLAY e CUE são LEDs 100% controlados por software nesta controladora: sem isto, ficam sempre apagados.
      const playing = d.engine.isPlaying();
      // PLAY aceso fixo enquanto toca; piscando (~2x/s) enquanto pausado — como numa CDJ de verdade.
      if (playing) { if (!d.ledPlay) { d.ledPlay = true; led(`deck${d.n}.play`, true); } }
      else if (now - d.playBlinkT > 250) { d.ledPlay = !d.ledPlay; d.playBlinkT = now; led(`deck${d.n}.play`, d.ledPlay); }
      if (!playing !== d.ledCue) { led(`deck${d.n}.cue`, !playing); d.ledCue = !playing; } // aceso quando pausado/pronto no cue
      if (d.sync) { const r = syncRatio(d); if (r === null) { d.sync = false; led(`deck${d.n}.sync`, false); } else if (Math.abs(r - d.base) > 1e-9) { d.base = r; retempo(d); } }
      d.el.sync.classList.toggle('on', d.sync); d.el.fone.classList.toggle('on', mixer.isCue(d.n));
      // Reconcilia o stutter a cada quadro (não só no toque do jog): se o estado de play mudar
      // enquanto o jog está pressionado, corrige sozinho — e alimenta o indicador STUTTER na tela.
      // Toca sozinho, sem precisar tocar no jog, sempre que pausado fora do ponto de CUE já marcado
      // (ou sem CUE marcado ainda); silencia assim que a posição atual bate com o CUE confirmado.
      const cuePt = d.engine.getCue();
      const wantStutter = !playing && (cuePt === null || Math.abs(pos - cuePt) >= 0.02);
      if (wantStutter !== d.stutterOn) { d.engine.scrub(wantStutter); d.stutterOn = wantStutter; }
      d.el.stutter.classList.toggle('on', d.stutterOn);
      // Entre o instante em que o motor processa uma amostra (ctx.currentTime) e o instante em que ela
      // sai de verdade pelo fone/caixa, existe uma latência real de hardware — o navegador mede e expõe
      // esse valor (outputLatency). A tela desenha com esse adianto sempre que há som audível (tocando
      // OU em stutter), pra bater com o que você já está ouvindo, em vez de com o que acabou de ser
      // processado internamente. Sem isso, o som sempre "chega antes" do desenho na tela.
      const outLatency = (ctx as AudioContext & { outputLatency?: number }).outputLatency || ctx.baseLatency || 0;
      // Durante o stutter a posição fica parada (não precisa "alcançar" nada que está avançando), então
      // só entra a latência real de hardware. Durante play, soma também o atraso de ~1 quadro de tela.
      const lead = playing ? outLatency + (cfg.visualLeadMs ?? 15) / 1000 : 0; // stutter agora usa stutterDelayMs no ÁUDIO (engine), não mais um adianto na tela
      const drawPos = lead > 0 ? Math.min(pos + lead, dur) : pos;
      const g = d.grid, kb = g ? Math.floor((drawPos - g.first) / g.period) - g.barOffset : -1;
      d.el.bpmbox.classList.toggle('warn', !!g && !g.manual && ((g.quality ?? 1) < 0.5 || (g.jitterMs ?? 0) > 5));
      d.el.bpm.textContent = g ? (g.bpm * d.base).toFixed(2) : '—';                    // BPM já com o ajuste do pitch
      d.el.bars.textContent = g && kb >= 0 ? `${Math.floor(kb / 4) + 1}.${(kb % 4) + 1} Bars` : '— Bars'; // compasso.batida
      // "Needle countdown" estilo CDJ-2000 Nexus: conta 1-2-3-4 a cada batida, no ritmo do BPM detectado.
      // Needle countdown estilo CDJ-2000 Nexus: 4-3-2-1 regressivo, "1" caindo bem antes do próximo compasso.
      const countBeat = g && kb >= 0 ? 4 - (kb % 4) : null;
      if (countBeat !== d.lastCount) {
        d.el.nbeat.textContent = countBeat === null ? '–' : String(countBeat);
        d.el.nbeat.classList.remove('pulse'); void d.el.nbeat.offsetWidth; d.el.nbeat.classList.add('pulse'); // reinicia a animação a cada troca
        d.lastCount = countBeat;
      }

      // Pisca os 8 pads e os botões PLAY, CUE, SYNC, LOOP IN/OUT perto do fim da faixa, como aviso.
      // Usa os códigos oficiais do PDF da DDJ-400 (pads no modo HOT CUE, o padrão de fábrica — se os
      // pads estiverem em outro modo na hora, o LED deles pode não responder; os outros botões valem sempre).
      const remain = dur - pos, padCh = d.n === 1 ? 8 : 10, btnCh = d.n;
      const wantBlink = playing && dur > 0 && remain <= cfg.endWarnSeconds && remain > 0;
      const extras: [number, number][] = [[btnCh, 11], [btnCh, 12], [btnCh, 88], [btnCh, 16], [btnCh, 17]]; // play, cue, sync, loop in, loop out
      if (wantBlink) {
        if (now - d.padBlinkT > 300) {
          d.padBlink = !d.padBlink; d.padBlinkT = now;
          const v = d.padBlink ? 127 : 0;
          for (let i = 0; i < 8; i++) send('note', padCh, i, v);
          for (const [ch, num] of extras) send('note', ch, num, v);
        }
      } else if (d.padBlink) {
        d.padBlink = false;
        for (let i = 0; i < 8; i++) send('note', padCh, i, 0);
        for (const [ch, num] of extras) send('note', ch, num, 0);
      }
      if (cdjMode) drawDots(d.el.detail, drawPos, dur, d.engine.getCue());
      else drawDetail(d.el.detail, d.bands, PPS, drawPos, winSec * d.base, d.grid, d.engine.getCue()); // *d.base: mesma velocidade visual (tela) nos dois decks, mesmo com pitches diferentes
      if (cdjMode) drawDots(d.el.ovc, drawPos, dur, d.engine.getCue());
      else drawOverview(d.el.ovc, d.ov, drawPos, dur, d.engine.getCue());
    }
    const [a, b] = decks;
    if (a.grid && b.grid && a.engine.isPlaying() && b.engine.isPlaying()) { // fase entre as batidas dos dois decks, em ms de tempo real
      const ms = phaseErr(b, a) * (a.grid.period / a.base) * 1000;
      phaseEl.textContent = `Δ ${ms >= 0 ? '+' : ''}${ms.toFixed(0)} ms`;
    } else phaseEl.textContent = 'Δ —';
    requestAnimationFrame(tick);
  })();

  window.addEventListener('beforeunload', () => { for (const d of decks) { led(`deck${d.n}.play`, false); led(`deck${d.n}.cue`, false); const pc = d.n === 1 ? 8 : 10; for (let i = 0; i < 8; i++) send('note', pc, i, 0); for (const [ch, num] of [[d.n, 11], [d.n, 12], [d.n, 88], [d.n, 16], [d.n, 17]] as [number, number][]) send('note', ch, num, 0); } });
  return { rebuild, loadPath, setZoom };
}
