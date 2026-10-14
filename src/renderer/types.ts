export type Kind = 'note' | 'cc' | 'pitchbend';
export interface Binding { kind: Kind; channel: number; number: number | null; }
export interface Settings {
  tempoRange?: number; tempoInvert?: boolean; jogScrubSeconds?: number; jogNudge?: number; jogSearchSeconds?: number;
  crossfaderInvert?: boolean; trimRangeDb?: number; waveWindowSeconds?: number;
  bpmMin?: number; bpmMax?: number; screenFit?: 'fill' | 'aspect';
  bpmSnap?: number; bpmSnapDeck?: boolean; zoomInvert?: boolean; cueDelayMs?: number; stutterFrameSec?: number; stutterDelayMs?: number; stutterBurstMs?: number; theme?: 'dark' | 'light'; endWarnSeconds?: number; visualLeadMs?: number; cueLeadMs?: number;
  cueBoostDb?: number; masterChannels?: [number, number]; cueChannels?: [number, number]; // saída: pares de canais (0 = primeiro)
}
export interface MidiMap { version: 1; device: string; controls: Record<string, Binding>; settings?: Settings; }
export interface Parsed { kind: Kind; channel: number; number: number | null; value: number; on?: boolean; raw: string; }
export interface LibList { dir: string; parent: string; entries: { name: string; path: string; dir: boolean }[]; }
export interface Api {
  pickFolder(): Promise<string | null>;
  listDir(dir: string): Promise<LibList | null>;
  readAudio(path: string): Promise<{ name: string; data: ArrayBuffer } | null>;
  loadMapping(): Promise<MidiMap | null>;
  saveMapping(m: MidiMap): Promise<string>;
  openAudio(): Promise<{ name: string; data: ArrayBuffer } | null>;
}
