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
    else if (Math.abs(this.pos - this.cuePoint) < 0.02) { this.previewing = true; void this.ctx.resume(); this.startAt(this.cuePoint); } // no cue: prévia enquanto segura - toca o ponto EXATO marcado, não a posição crua do jog (que pode estar a até 20ms de distância)
    else { // parado em outro ponto: define o cue
      // QUANTIZE ligado: trava na batida mais próxima da grade. QUANTIZE desligado: marca exatamente
      // onde o DJ parou, sem nenhum ajuste automático - marcação 100% manual, no lugar que ele escolher.
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

  // "Stutter cue": com o deck pausado, repete um trecho curto que começa no primeiro ataque
  // significativo encontrado na posição atual. Isso evita reproduzir o silêncio/pré-ringing que vem
  // imediatamente antes do kick e faz a audição coincidir com o transiente mostrado na linha.
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
  // Monta o buffer do loop: dura stutterFrame (o período da repetição), mas apenas stutterBurst
  // segundos têm áudio. O ataque recebe uma rampa curtíssima, só para evitar clique digital;
  // não há mais fade-in de 1 ms apagando a primeira borda do kick.
  private renderStutter(t: number): AudioBuffer | null {
    const b = this.buffer; if (!b) return null;
    const sr = b.sampleRate, n = Math.max(2, Math.round(this.stutterFrame * sr)), start = Math.round(t * sr);
    const burstN = this.stutterBurst > 0 ? Math.min(n, Math.max(2, Math.round(this.stutterBurst * sr))) : n;
    const out = this.ctx.createBuffer(b.numberOfChannels, n, sr);
    const fi = Math.min(burstN >> 1, Math.max(1, Math.round(0.00025 * sr)));
    const fo = Math.min(burstN >> 1, Math.max(1, Math.round(0.002 * sr)));
    for (let c = 0; c < b.numberOfChannels; c++) {
      const src = b.getChannelData(c), dst = out.getChannelData(c);
      const initial = src[start] ?? 0;
      for (let i = 0; i < burstN; i++) {
        let v = src[start + i] ?? 0;
        if (i < fi) v *= (i + 1) / fi;
        else if (i >= burstN - fo) v *= Math.max(0, (burstN - 1 - i) / fo);
        dst[i] = v;
      }
      // Se o corte começa longe de zero, force o primeiro sample a zero para impedir um clique.
      // O segundo sample já entra na rampa curta, preservando o impacto do transiente.
      if (Math.abs(initial) > 0.02) dst[0] = 0;
    }
    return out;
  }
  // Desliga um trecho antigo com um fade curtinho (4 ms), pra trocar de posição sem estalar.
  private retire(s: AudioBufferSourceNode, g: GainNode) {
    const now = this.ctx.currentTime;
    try { g.gain.cancelScheduledValues(now); g.gain.setValueAtTime(g.gain.value, now); g.gain.linearRampToValueAtTime(0, now + 0.004); s.stop(now + 0.006); }
    catch { try { s.stop(); } catch { /* já parou */ } }
  }
  // Procura o primeiro ataque significativo logo à frente do jog. A energia é calculada em mono com
  // envelope RMS curto; o limiar se adapta ao pico da janela, evitando confundir ruído/pré-ringing com kick.
  private findStutterTransient(from: number) {
    const b = this.buffer; if (!b) return from;
    const sr = b.sampleRate;
    const start = Math.max(0, Math.min(Math.round(from * sr), b.length - 1));
    const searchN = Math.min(b.length - start, Math.max(1, Math.round(0.035 * sr)));
    if (searchN < 4) return start / sr;

    const channels = Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c));
    const hop = Math.max(1, Math.round(0.0005 * sr));
    const win = Math.max(hop, Math.round(0.0015 * sr));
    const env: number[] = [];
    let peak = 0;
    for (let i = 0; i < searchN; i += hop) {
      let sum = 0, count = 0;
      const end = Math.min(searchN, i + win);
      for (let j = i; j < end; j++) {
        let mono = 0;
        for (const ch of channels) mono += ch[start + j] ?? 0;
        mono /= channels.length;
        sum += mono * mono; count++;
      }
      const rms = Math.sqrt(sum / Math.max(1, count));
      env.push(rms); peak = Math.max(peak, rms);
    }
    if (peak < 0.006) return start / sr;

    const floorCount = Math.max(1, Math.min(env.length, Math.ceil(0.006 / (hop / sr))));
    let floor = 0;
    for (let i = 0; i < floorCount; i++) floor += env[i];
    floor /= floorCount;
    const threshold = Math.max(0.008, floor * 3, peak * 0.18);

    for (let i = 1; i < env.length; i++) {
      const rising = env[i] >= env[i - 1] * 1.12 || env[i] - env[i - 1] > peak * 0.025;
      if (env[i] >= threshold && rising) {
        // Recuo pequeno pega o começo da subida, sem voltar ao pré-ringing anterior ao golpe.
        const onset = Math.max(0, i * hop - Math.round(0.00075 * sr));
        return (start + onset) / sr;
      }
    }
    return start / sr;
  }
  // stutterDelay continua disponível como calibração; depois dele, o início é refinado para o primeiro
  // transiente nos próximos 35 ms. O período do loop permanece inalterado.
  private stutterWindow() {
    const raw = Math.max(0, Math.min(this.pos + this.stutterDelay, Math.max(0, this.getDuration() - this.stutterFrame)));
    const onset = this.findStutterTransient(raw);
    return Math.max(0, Math.min(onset, Math.max(0, this.getDuration() - this.stutterFrame)));
  }
  private stopStutter() {
    if (!this.stutterSrc) return;
    const s = this.stutterSrc, g = this.stutterGain;
    this.stutterSrc = null; this.stutterGain = null; this.stutterT = -1;
    if (g) this.retire(s, g); else { try { s.stop(); } catch { /* já parou */ } }
  }
}
