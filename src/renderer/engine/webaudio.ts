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
    else if (Math.abs(this.pos - this.cuePoint) < 0.02) { this.previewing = true; void this.ctx.resume(); this.startAt(this.cuePoint); } // no cue: prévia enquanto segura — toca o ponto EXATO marcado, não a posição crua do jog (que pode estar a até 20ms de distância)
    else { // parado em outro ponto: define o cue
      // QUANTIZE ligado: trava na batida mais próxima da grade. QUANTIZE desligado: marca exatamente
      // onde o DJ parou, sem nenhum ajuste automático — marcação 100% manual, no lugar que ele escolher.
      const raw = quantizeGrid
        ? quantizeGrid.first + Math.round((this.pos - quantizeGrid.first) / quantizeGrid.period) * quantizeGrid.period // QUANTIZE ligado: trava na grade
        : (this.buffer ? refineCue(this.buffer, this.pos) : this.pos); // QUANTIZE desligado: trava no início real do golpe mais próximo
      const target = Math.max(0, raw - leadSec); // calibração fixa extra: adianta o ponto marcado (settings.cueLeadMs)
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
    this.stopStutter(); // playback de verdade começando: encerra o loop de stutter, se houver
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

  // "Stutter cue": com o deck pausado, repete um trecho curto (stutterFrame) que começa na posição atual.
  //
  // O trecho NÃO é repetido com loopStart/loopEnd direto no áudio da faixa: isso emenda o fim do trecho
  // com o começo sem suavização, e a emenda vira um ESTALO (medido: até 0,77 de salto numa faixa cujo
  // kick tem pico 0,90). Esse estalo cai exatamente no início do loop — a linha branca — ou seja, ANTES
  // do kick, e é o "tique" que se ouve antes do golpe de verdade. Aqui o trecho é copiado para um buffer
  // próprio, com fade curto na entrada (1 ms, preserva o ataque do kick) e na saída (2 ms), e esse buffer
  // é que fica em loop: a emenda une silêncio com silêncio e o único transiente audível é o do próprio áudio.
  private stutterSrc: AudioBufferSourceNode | null = null;
  private stutterGain: GainNode | null = null;
  private stutterT = -1; // início (s) do trecho que o loop atual está tocando

  scrub(active: boolean) {
    if (!active) { this.stopStutter(); return; }
    if (this.src || !this.buffer) return; // só faz sentido com o deck pausado
    if (this.stutterSrc) { this.updateStutter(); return; }
    this.startStutter();
  }
  // Move o trecho para a nova posição (jog / CUE marcado). Recria só se a posição mudou de verdade.
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
  // Monta o buffer do loop: dura stutterFrame (é o PERÍODO da repetição), mas só os primeiros stutterBurst
  // segundos têm áudio (copiado de t, com fade-in de 1 ms e fade-out de 2 ms); o resto é silêncio.
  // Assim a repetição continua lenta e legível (período ~150 ms), mas o trecho AUDÍVEL fica colado na linha:
  // um kick só aparece no som quando está a no máximo stutterBurst ms à frente da linha. stutterBurst = 0
  // volta ao comportamento antigo (o loop inteiro tem áudio).
  private renderStutter(t: number): AudioBuffer | null {
    const b = this.buffer; if (!b) return null;
    const sr = b.sampleRate, n = Math.max(2, Math.round(this.stutterFrame * sr)), start = Math.round(t * sr);
    const burstN = this.stutterBurst > 0 ? Math.min(n, Math.max(2, Math.round(this.stutterBurst * sr))) : n;
    const out = this.ctx.createBuffer(b.numberOfChannels, n, sr);
    const fi = Math.min(burstN >> 1, Math.max(1, Math.round(0.001 * sr))), fo = Math.min(burstN >> 1, Math.max(1, Math.round(0.002 * sr)));
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
  // Desliga um trecho antigo com um fade curtinho (4 ms), pra trocar de posição sem estalar.
  private retire(s: AudioBufferSourceNode, g: GainNode) {
    const now = this.ctx.currentTime;
    try { g.gain.cancelScheduledValues(now); g.gain.setValueAtTime(g.gain.value, now); g.gain.linearRampToValueAtTime(0, now + 0.004); s.stop(now + 0.006); }
    catch { try { s.stop(); } catch { /* já parou */ } }
  }
  // Toca a partir da posição crua do jog (this.pos) — a MESMA que a tela desenha. stutterDelay é um
  // ajuste opcional (settings.stutterDelayMs, padrão 0) só no áudio do stutter.
  private stutterWindow() {
    return Math.max(0, Math.min(this.pos + this.stutterDelay, Math.max(0, this.getDuration() - this.stutterFrame)));
  }
  private stopStutter() {
    if (!this.stutterSrc) return;
    const s = this.stutterSrc, g = this.stutterGain;
    this.stutterSrc = null; this.stutterGain = null; this.stutterT = -1;
    if (g) this.retire(s, g); else { try { s.stop(); } catch { /* já parou */ } }
  }
}
