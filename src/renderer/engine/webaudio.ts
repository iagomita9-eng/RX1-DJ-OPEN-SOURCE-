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
  private pos = 0;        // posição (s) no instante t0 — ou parada, quando não há src
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
    else if (Math.abs(this.pos - this.cuePoint) < 0.02) { this.previewing = true; void this.ctx.resume(); this.startAt(this.cuePoint); } // no cue: prévia enquanto segura — toca o ponto EXATO marcado
    else { // parado em outro ponto: define o cue
      // QUANTIZE ligado: trava na batida mais próxima da grade. QUANTIZE desligado: trava no início real do golpe mais próximo.
      const raw = quantizeGrid
        ? quantizeGrid.first + Math.round((this.pos - quantizeGrid.first) / quantizeGrid.period) * quantizeGrid.period
        : (this.buffer ? refineCue(this.buffer, this.pos) : this.pos);
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
    s.onended = () => { if (this.src === s) { this.src = null; this.pos = this.getDuration(); } };
    s.start(0, t); this.src = s;
  }
  private stopSource() {
    if (!this.src) return;
    const s = this.src;
    this.pos = this.getPosition(); this.src = null; s.onended = null;
    try { s.stop(); } catch { /* já parou */ }
  }

  // "Stutter cue": com o deck pausado, repete um trecho curto. O trecho é copiado para um buffer próprio
  // com fades curtos, e esse buffer fica em loop (evita o estalo da emenda).
  private stutterSrc: AudioBufferSourceNode | null = null;
  private stutterGain: GainNode | null = null;
  private stutterT = -1;

  scrub(active: boolean) {
    if (!active) { this.stopStutter(); return; }
    if (this.src || !this.buffer) return;
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
  // Buffer do loop: dura stutterFrame (período), mas só os primeiros stutterBurst segundos têm áudio.
  // Fade-in mínimo (0,25 ms) pra não amolecer o ataque do kick; fade-out de 2 ms.
  private renderStutter(t: number): AudioBuffer | null {
    const b = this.buffer; if (!b) return null;
    const sr = b.sampleRate, n = Math.max(2, Math.round(this.stutterFrame * sr)), start = Math.round(t * sr);
    const burstN = this.stutterBurst > 0 ? Math.min(n, Math.max(2, Math.round(this.stutterBurst * sr))) : n;
    const out = this.ctx.createBuffer(b.numberOfChannels, n, sr);
    const fi = Math.min(burstN >> 1, Math.max(1, Math.round(0.00025 * sr))), fo = Math.min(burstN >> 1, Math.max(1, Math.round(0.002 * sr)));
    for (let c = 0; c < b.numberOfChannels; c++) {
      const src = b.getChannelData(c), dst = out.getChannelData(c);
      for (let i = 0; i < burstN; i++) {
        let v = src[start + i] ?? 0;
        if (i < fi) v *= i / fi; else if (i >= burstN - fo) v *= (burstN - 1 - i) / fo;
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
  // Janela ATRÁS da linha: o trecho audível termina exatamente na posição do jog (this.pos).
  // Antes ela ia PARA FRENTE da linha, então o kick soava até stutterBurst ms ANTES de a linha chegar nele.
  // Agora o kick só aparece no som depois que a linha cruza o início dele. stutterDelayMs segue como ajuste fino.
  private stutterWindow() {
    const back = this.stutterBurst > 0 ? this.stutterBurst : 0;
    return Math.max(0, Math.min(this.pos - back + this.stutterDelay, Math.max(0, this.getDuration() - this.stutterFrame)));
  }
  private stopStutter() {
    if (!this.stutterSrc) return;
    const s = this.stutterSrc, g = this.stutterGain;
    this.stutterSrc = null; this.stutterGain = null; this.stutterT = -1;
    if (g) this.retire(s, g); else { try { s.stop(); } catch { /* já parou */ } }
  }
}
