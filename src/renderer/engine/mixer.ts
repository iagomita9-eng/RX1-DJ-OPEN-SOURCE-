import type { Settings } from '../types';

// Mixer em Web Audio. Cada canal: trim → EQ (low/mid/high) → filtro → fader → crossfader → master.
// Todos os controles recebem v em 0..1 (posição física do controle).
type Band = 'low' | 'mid' | 'high';
interface Chan { cueSend: GainNode; an: AnalyserNode; trim: GainNode; eq: Record<Band, BiquadFilterNode>; filt: BiquadFilterNode; vol: GainNode; xf: GainNode; }

const dbToGain = (db: number) => Math.pow(10, db / 20);
// EQ estilo DJ: centro = 0 dB, todo à esquerda ≈ kill (-26 dB), todo à direita = +6 dB.
const eqDb = (v: number) => Math.abs(v - 0.5) < 0.01 ? 0 : v < 0.5 ? -26 * (1 - v * 2) : 6 * (v * 2 - 1);

export class Mixer {
  private chans: Chan[] = [];
  private cf = 0.5;
  private master: GainNode;
  readonly phones: boolean;      // há canais suficientes para a pré-escuta?
  readonly outChannels: number;  // máximo de canais da saída de áudio
  private cueBus: GainNode; private phCue: GainNode; private phMaster: GainNode; private phLevel: GainNode; private phBoost: GainNode; private limiter: DynamicsCompressorNode;
  private cueOn = [false, false]; private masterCue = false; private phMix = 0; private phLvl = 0.5;

  constructor(private ctx: AudioContext, private cfg: Settings = {}) {
    this.master = ctx.createGain();
    // Saída: com 4+ canais disponíveis, master vai nos canais 1-2 e a pré-escuta (fone) nos 3-4 (ajustável em settings).
    const mch = cfg.masterChannels ?? [0, 1], pch = cfg.cueChannels ?? [2, 3], need = Math.max(...mch, ...pch) + 1;
    this.outChannels = ctx.destination.maxChannelCount;
    this.phones = need > 2 && this.outChannels >= need;
    let route = (node: AudioNode, _pair: [number, number]) => { node.connect(ctx.destination); };
    if (this.phones) {
      ctx.destination.channelCount = need; ctx.destination.channelCountMode = 'explicit'; ctx.destination.channelInterpretation = 'discrete';
      const merger = ctx.createChannelMerger(need); merger.connect(ctx.destination);
      route = (node, pair) => { const sp = ctx.createChannelSplitter(2); node.connect(sp); sp.connect(merger, 0, pair[0]); sp.connect(merger, 1, pair[1]); };
    }
    route(this.master, mch);
    // Bus do fone: [pré-escuta dos canais × (1-mix)] + [master × mix] → nível → boost → limitador. O boost vale SÓ aqui.
    this.cueBus = ctx.createGain(); this.phCue = ctx.createGain(); this.phMaster = ctx.createGain();
    this.phLevel = ctx.createGain(); this.phBoost = ctx.createGain(); this.limiter = ctx.createDynamicsCompressor();
    this.phBoost.gain.value = dbToGain(cfg.cueBoostDb ?? 16);
    this.limiter.threshold.value = -4; this.limiter.knee.value = 0; this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002; this.limiter.release.value = 0.12;
    this.cueBus.connect(this.phCue); this.master.connect(this.phMaster);
    this.phCue.connect(this.phLevel); this.phMaster.connect(this.phLevel);
    this.phLevel.connect(this.phBoost); this.phBoost.connect(this.limiter);
    if (this.phones) route(this.limiter, pch);
    this.applyPhones();
    const mk = (type: BiquadFilterType, f: number, q = 0.7) => { const n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = f; n.Q.value = q; return n; };
    for (let i = 0; i < 2; i++) {
      const c: Chan = { cueSend: ctx.createGain(), an: ctx.createAnalyser(), trim: ctx.createGain(), eq: { low: mk('lowshelf', 90), mid: mk('peaking', 1000), high: mk('highshelf', 8000) },
        filt: mk('allpass', 1000, 0.9), vol: ctx.createGain(), xf: ctx.createGain() };
      c.an.fftSize = 2048; c.trim.connect(c.an); // medidor de nível: logo após o trim, antes do fader
      c.filt.connect(c.cueSend); c.cueSend.gain.value = 0; c.cueSend.connect(this.cueBus); // pré-escuta: depois de trim/EQ/filtro, antes do fader
      c.trim.connect(c.eq.low); c.eq.low.connect(c.eq.mid); c.eq.mid.connect(c.eq.high);
      c.eq.high.connect(c.filt); c.filt.connect(c.vol); c.vol.connect(c.xf); c.xf.connect(this.master);
      this.chans.push(c);
    }
    this.applyCrossfader();
  }

  // ---- Pré-escuta (fone) ----
  isCue(n: number) { return this.cueOn[n - 1]; }
  isMasterCue() { return this.masterCue; }
  toggleCue(n: number) { this.cueOn[n - 1] = !this.cueOn[n - 1]; this.set(this.chans[n - 1].cueSend.gain, this.cueOn[n - 1] ? 1 : 0); return this.cueOn[n - 1]; }
  toggleMasterCue() { this.masterCue = !this.masterCue; this.applyPhones(); return this.masterCue; }
  setPhonesMix(v: number) { this.phMix = v; this.applyPhones(); }     // 0 = só CUE, 1 = só master
  setPhonesLevel(v: number) { this.phLvl = v; this.applyPhones(); }
  getPhonesMix() { return this.phMix; }
  getPhonesLevel() { return this.phLvl; }
  private applyPhones() {
    // CUE (por canal) e MASTER CUE são ADITIVOS: MASTER CUE não deve silenciar o CUE dos canais.
    this.set(this.phCue.gain, 1 - this.phMix);
    this.set(this.phMaster.gain, this.masterCue ? 1 : this.phMix);
    this.set(this.phLevel.gain, this.phLvl * this.phLvl);
  }
  // Tom de teste (440 Hz, 0,8 s) direto em cada saída, para conferir em qual jack sai o quê.
  testTone(target: 'master' | 'phones') {
    if (target === 'phones' && !this.phones) return false;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.frequency.value = 440; g.gain.value = 0.15; o.connect(g); g.connect(target === 'master' ? this.master : this.phLevel);
    void this.ctx.resume(); o.start(); o.stop(this.ctx.currentTime + 0.8); return true;
  }

  input(n: number): AudioNode { return this.chans[n - 1].trim; }
  masterTap(): AudioNode { return this.master; } // para espelhar a saída master em outro dispositivo de áudio
  tap(n: number): AnalyserNode { return this.chans[n - 1].an; }

  // Rampa curta evita "zipper noise" quando o valor muda a cada mensagem MIDI.
  private set(p: AudioParam, v: number) { p.setTargetAtTime(v, this.ctx.currentTime, 0.01); }

  setTrim(n: number, v: number) { this.set(this.chans[n - 1].trim.gain, dbToGain((v - 0.5) * 2 * (this.cfg.trimRangeDb ?? 12))); }
  setEq(n: number, band: Band, v: number) { this.set(this.chans[n - 1].eq[band].gain, eqDb(v)); }
  setVolume(n: number, v: number) { this.set(this.chans[n - 1].vol.gain, v * v); }
  setMaster(v: number) { this.set(this.master.gain, v); }
  setCrossfader(v: number) { this.cf = v; this.applyCrossfader(); }
  private applyCrossfader() {
    const v = this.cfg.crossfaderInvert ? 1 - this.cf : this.cf;
    this.set(this.chans[0].xf.gain, Math.min(1, 2 * (1 - v)));
    this.set(this.chans[1].xf.gain, Math.min(1, 2 * v));
  }
  // Filtro de um knob só: esquerda = passa-baixa, centro = neutro, direita = passa-alta.
  setFilter(n: number, v: number) {
    const f = this.chans[n - 1].filt;
    if (Math.abs(v - 0.5) < 0.02) { f.type = 'allpass'; return; }
    if (v < 0.5) { f.type = 'lowpass'; f.frequency.value = 20 * Math.pow(1000, Math.min(1, v / 0.48)); }
    else { f.type = 'highpass'; f.frequency.value = 20 * Math.pow(1000, Math.min(1, (v - 0.52) / 0.48)); }
  }
}
