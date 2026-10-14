import type { Bands, DeckEngine, Grid } from './types';
import { analyzeGrid, computeBands, refineCue } from './analysis';

// Engine da Fase 2: AudioBufferSourceNode.
// O tempo muda via playbackRate, que altera também o tom (como um toca-discos).
// Key lock e scratch de verdade virão com AudioWorklet, atrás da mesma interface.
export class WebAudioDeck implements DeckEngine {
  readonly out: GainNode;
  private buffer: AudioBuffer | null = null;
  private src: AudioBufferSourceNode | null = null;
  private rate = 1;
  private pos = 0;        // posição (s) no instante t0 - ou parada, quando não há src
  private t0 = 0;         // ctx.currentTime em que 'pos' foi válida
  private cuePoint = 0;
  private cueSet = false;
  private previewing = false;

  constructor(private ctx: AudioContext, dest: AudioNode, private stutterFrame = 0.1, private stutterDelay = 0, private stutterBurst = 0) {
    this.out = ctx.createGain();
    this.out.connect(dest); // entrada do canal no mixer
  }

  async load(data: ArrayBuffer) {
    this.stopStutter();
    this.stopSource();
    this.buffer = await this.ctx.decodeAudioData(data); // mp3/wav/flac via Chromium
    this.pos = 0; this.cuePoint = 0; this.cueSet = false;
  }

  play() {
    if (!this.buffer || this.src) return;
    void this.ctx.resume();
    this.startAt(this.pos >= this.getDuration() ? 0 : this.pos);
  }
  pause() { this.stopSource(); }

  cue(quantizeGrid?: Grid | null, leadSec = 0) {
    if (!this.buffer) return;
    if (this.src) { this.stopSource(); this.pos = this.cuePoint; }       // tocando: volta ao cue e para
    else if (Math.abs(this.pos - this.cuePoint) < 0.02) { this.previewing = true; void this.ctx.resume(); this.startAt(this.cuePoint); } // no cue: prévia enquanto segura
    else { // parado em outro ponto: define o cue
      const raw = quantizeGrid
        ? quantizeGrid.first + Math.round((this.pos - quantizeGrid.first) / quantizeGrid.period) * quantizeGrid.period // QUANTIZE ligado: trava na grade
        : (this.buffer ? refineCue(this.buffer, this.pos) : this.pos); // QUANTIZE desligado: trava no início real do golpe mais próximo
      const target = Math.max(0, raw - leadSec); // calibração fixa extra (settings.cueLeadMs)
      this.cuePoint = target; this.pos = target; this.cueSet = true;
      this.updateStutter();
    }
  }
  cueRelease() {
    if (!this.previewing) return;
    this.previewing = false; this.stopSource(); this.pos = this.cuePoint;
  }

  setTempo(ratio: number) {
    if (this.src) { this.pos = this.getPosition(); this.t0 = this.ctx.currentTime; this.src.playbackRate.value = ratio; }
    this.rate = ratio;
  }
  seek(seconds: number) {
    const t = Math.min(Math.max(seconds, 0), this.getDuration());
    if (this.src) this.startAt(t); else { this.pos = t; this.updateStutter(); }
  }

  getPosition() {
    if (!this.src) return this.pos;
    return Math.min(this.pos + (this.ctx.currentTime - this.t0) * this.rate, this.getDuration());
  }
  getDuration() { return this.buffer?.duration ?? 0; }
  isPlaying() { return this.src !== null; }
  getCue() { return this.cueSet ? this.cuePoint : null; }

  analyzeGrid(minBpm: number, maxBpm: number): Grid | null { return this.buffer ? analyzeGrid(this.buffer, minBpm, maxBpm) : null; }

  getBands(perSecond: number): Bands { return this.buffer ? computeBands(this.buffer, perSecond) : { low: new Float32Array(0), mid: new Float32Array(0), high: new Float32Array(0) }; }

  // Um AudioBufferSourceNode só toca uma vez: para mover a posição, criamos outro.
  private startAt(t: number) {
    this.stopStutter();
    this.stopSource();
    if (!this.buffer) return;
    const s = this.ctx.createBufferSource();
    s.buffer = this.buffer; s.playbackRate.value = this.rate; s.connect(this.out);
    this.pos = t; this.t0 = this.ctx.currentTime;
    s.onended = () => { if (this.src === s) { this.src = null; this.pos = this.getDuration(); } }; // fim da faixa
    s.start(0, t); this.src = s;
  }
  private stopSource() {
    if (!this.src) return;
    const s = this.src;
    this.pos = this.getPosition(); this.src = null; s.onended = null;
    try { s.stop(); } catch { /* já parou */ }
  }

  // "Stutter cue": com o deck pausado, repete um trecho curto que começa no ATAQUE do golpe à frente do jog.
  //
  // Versão 2 do alinhamento:
  // 1. Detecção grossa por envelope RMS (janela 1,5 ms), como antes.
  // 2. NOVO: refino por amostra. A janela RMS olha para FRENTE, então o envelope cruza o limiar alguns
  //    décimos de ms antes do ataque real. Agora, dentro dessa região, procuramos a primeira amostra cujo
  //    valor absoluto passa de uma fração do pico local do golpe - esse é o ponto em que o kick "bate".
  // 3. NOVO: removido o recuo de 0,75 ms que puxava o início para antes do golpe.
  // 4. Ajuste fino opcional em settings.stutterDelayMs (positivo = mais tarde, negativo = mais cedo).
  private stutterSrc: AudioBufferSourceNode | null = null;
  private stutterGain: GainNode | null = null;
  private stutterT = -1; // início (s) do trecho que o loop atual está tocando

  // Fração do pico local que define o ataque. Mais alto = começa mais tarde (mais "no soco").
  private static readonly ATTACK_FRACTION = 0.3;

  scrub(active: boolean) {
    if (!active) { this.stopStutter(); return; }
    if (this.src || !this.buffer) return; // só faz sentido com o deck pausado
    if (this.stutterSrc) { this.updateStutter(); return; }
    this.startStutter();
  }
  private updateStutter() {
    if (!this.stutterSrc) return;
    if (Math.abs(this.stutterWindow() - this.stutterT) < 0.0005) return;
    const old = this.stutterSrc, oldGain = this.stutterGain;
    this.startStutter();
    if (old && oldGain) this.retire(old, oldGain);
  }
  private startStutter() {
    const t = this.stutterWindow(), buf = this.renderStutter(t);
    if (!buf) return;
    const s = this.ctx.createBufferSource(), g = this.ctx.createGain();
    s.buffer = buf; s.loop = true; s.connect(g); g.connect(this.out);
    void this.ctx.resume();
    s.start(0);
    this.stutterSrc = s; this.stutterGain = g; this.stutterT = t;
  }
  // Buffer do loop: dura stutterFrame (período), mas só stutterBurst segundos têm áudio.
  // Rampa de entrada de ~0,1 ms: o suficiente para não clicar, curta demais para "amolecer" o ataque.
  private renderStutter(t: number): AudioBuffer | null {
    const b = this.buffer; if (!b) return null;
    const sr = b.sampleRate, n = Math.max(2, Math.round(this.stutterFrame * sr)), start = Math.round(t * sr);
    const burstN = this.stutterBurst > 0 ? Math.min(n, Math.max(2, Math.round(this.stutterBurst * sr))) : n;
    const out = this.ctx.createBuffer(b.numberOfChannels, n, sr);
    const fi = Math.min(burstN >> 1, Math.max(1, Math.round(0.0001 * sr)));
    const fo = Math.min(burstN >> 1, Math.max(1, Math.round(0.002 * sr)));
    for (let c = 0; c < b.numberOfChannels; c++) {
      const src = b.getChannelData(c), dst = out.getChannelData(c);
      for (let i = 0; i < burstN; i++) {
        let v = src[start + i] ?? 0;
        if (i < fi) v *= (i + 1) / (fi + 1);
        else if (i >= burstN - fo) v *= Math.max(0, (burstN - 1 - i) / fo);
        dst[i] = v;
      }
    }
    return out;
  }
  private retire(s: AudioBufferSourceNode, g: GainNode) {
    const now = this.ctx.currentTime;
    try { g.gain.cancelScheduledValues(now); g.gain.setValueAtTime(g.gain.value, now); g.gain.linearRampToValueAtTime(0, now + 0.004); s.stop(now + 0.006); }
    catch { try { s.stop(); } catch { /* já parou */ } }
  }

  // Mono da amostra i (absoluto, média dos canais).
  private monoAbs(channels: Float32Array[], i: number) {
    let m = 0;
    for (const ch of channels) m += ch[i] ?? 0;
    return Math.abs(m / channels.length);
  }

  // Retorna o índice (amostra) do ataque do primeiro golpe nos próximos 35 ms, ou -1 se não houver.
  private findStutterTransient(fromSample: number): number {
    const b = this.buffer; if (!b) return -1;
    const sr = b.sampleRate;
    const start = Math.max(0, Math.min(fromSample, b.length - 1));
    const searchN = Math.min(b.length - start, Math.max(1, Math.round(0.035 * sr)));
    if (searchN < 8) return -1;
    const channels = Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c));

    // 1) Envelope RMS grosso.
    const hop = Math.max(1, Math.round(0.0005 * sr));
    const win = Math.max(hop, Math.round(0.0015 * sr));
    const env: number[] = [];
    let peak = 0;
    for (let i = 0; i < searchN; i += hop) {
      let sum = 0, count = 0;
      const end = Math.min(searchN, i + win);
      for (let j = i; j < end; j++) { const v = this.monoAbs(channels, start + j); sum += v * v; count++; }
      const rms = Math.sqrt(sum / Math.max(1, count));
      env.push(rms); peak = Math.max(peak, rms);
    }
    if (peak < 0.006) return -1;
    const floorCount = Math.max(1, Math.min(env.length, Math.ceil(0.006 / (hop / sr))));
    let floor = 0;
    for (let i = 0; i < floorCount; i++) floor += env[i];
    floor /= floorCount;
    const threshold = Math.max(0.008, floor * 3, peak * 0.18);

    let coarse = -1;
    for (let i = 1; i < env.length; i++) {
      const rising = env[i] >= env[i - 1] * 1.12 || env[i] - env[i - 1] > peak * 0.025;
      if (env[i] >= threshold && rising) { coarse = i * hop; break; }
    }
    if (coarse < 0) return -1;

    // 2) Refino por amostra: pico local do golpe nos ~6 ms a partir da detecção grossa...
    const regionEnd = Math.min(searchN, coarse + Math.round(0.006 * sr));
    let localPeak = 0;
    for (let j = coarse; j < regionEnd; j++) localPeak = Math.max(localPeak, this.monoAbs(channels, start + j));
    // ...e a primeira amostra que passa de ATTACK_FRACTION desse pico (acima do ruído de fundo).
    const attackLevel = Math.max(floor * 2, localPeak * WebAudioDeck.ATTACK_FRACTION);
    for (let j = coarse; j < regionEnd; j++) {
      if (this.monoAbs(channels, start + j) >= attackLevel) {
        // Volta só até o cruzamento por zero imediatamente anterior (no máx. 0,4 ms):
        // começa o ciclo do kick sem clique e sem trazer áudio de antes do golpe.
        const maxBack = Math.round(0.0004 * sr);
        let k = j;
        for (let s = 0; s < maxBack && k > coarse; s++, k--) {
          const a = (channels[0][start + k] ?? 0), p = (channels[0][start + k - 1] ?? 0);
          if (a === 0 || Math.sign(a) !== Math.sign(p)) break;
        }
        return start + k;
      }
    }
    return start + coarse;
  }

  // stutterDelay (settings.stutterDelayMs) agora é ajuste fino APÓS o alinhamento: +1 = 1 ms mais tarde.
  private stutterWindow() {
    const b = this.buffer; if (!b) return 0;
    const sr = b.sampleRate, maxT = Math.max(0, this.getDuration() - this.stutterFrame);
    const raw = Math.max(0, Math.min(this.pos, maxT));
    const onset = this.findStutterTransient(Math.round(raw * sr));
    const base = onset >= 0 ? onset / sr : raw;
    return Math.max(0, Math.min(base + this.stutterDelay, maxT));
  }
  private stopStutter() {
    if (!this.stutterSrc) return;
    const s = this.stutterSrc, g = this.stutterGain;
    this.stutterSrc = null; this.stutterGain = null; this.stutterT = -1;
    if (g) this.retire(s, g); else { try { s.stop(); } catch { /* já parou */ } }
  }
}
