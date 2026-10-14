// Contrato da engine de áudio. A UI e os controladores só conhecem ESTA interface:
// para trocar por uma engine nativa (Rust/JUCE) no futuro, basta implementá-la de novo.
// Grade de batidas: 1ª batida em 'first' (s), uma batida a cada 'period' (s); 'barOffset' = qual batida (0-3) abre o compasso.
export interface Grid {
  bpm: number; first: number; period: number; barOffset: number;
  quality?: number;  // 0..1: fração das batidas que confirmam a grade (baixo = andamento variável ou detecção incerta)
  jitterMs?: number; // desvio típico entre a grade e os onsets reais
  manual?: boolean;  // ajustada à mão
}

export interface Bands { low: Float32Array; mid: Float32Array; high: Float32Array; }

export interface DeckEngine {
  load(data: ArrayBuffer): Promise<void>;
  play(): void;
  pause(): void;
  cue(quantizeGrid?: Grid | null, leadSec?: number): void; // apertar o botão CUE (semântica de CDJ: define/volta ao cue; segurar = prévia)
  // QUANTIZE ligado (quantizeGrid presente): o CUE trava na batida mais próxima da grade.
  // QUANTIZE desligado (quantizeGrid null/omitido): marca exatamente a posição atual, sem nenhum ajuste.
  // leadSec (settings.cueLeadMs/1000): desloca o ponto marcado esse tanto mais cedo, nos dois modos —
  // ajuste fixo e previsível pro DJ calibrar, pro caso do ataque do kick começar antes do golpe "cheio".
  cueRelease(): void;  // soltar o botão CUE
  setTempo(ratio: number): void; // 1 = velocidade original
  seek(seconds: number): void;
  scrub(active: boolean): void; // "stutter cue": em loop de 1 frame (1/75s) na posição atual, só quando pausado — ajuda a achar o exato início da batida com o jog
  getPosition(): number; // segundos
  getDuration(): number; // segundos
  isPlaying(): boolean;
  getCue(): number | null; // ponto de CUE marcado (s), ou null se ainda não foi marcado
  analyzeGrid(minBpm: number, maxBpm: number): Grid | null; // detecta BPM e batidas da faixa carregada
  getBands(perSecond: number): Bands; // picos por banda (grave/médio/agudo) por fatia de tempo, para desenhar a waveform
}
