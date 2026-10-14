// Medidor de nível de canal nos LEDs da DDJ-400. Só envia se o mapa tiver os códigos de SAÍDA
// "out.ch1.level" e "out.ch2.level" (descobertos na aba MONITOR → Saída MIDI; nada é chutado aqui).
import { send } from './midi';
import type { Mixer } from './engine/mixer';
import type { MidiMap } from './types';

export function initLevels(map: MidiMap, mixer: Mixer) {
  const an = [mixer.tap(1), mixer.tap(2)], buf = new Float32Array(an[0].fftSize);
  const cur = [0, 0], sent = [-1, -1];
  const tick = () => {
    for (const i of [0, 1]) {
      const b = map.controls[`out.ch${i + 1}.level`];
      if (!b || b.number === null || b.kind === 'pitchbend') continue;
      an[i].getFloatTimeDomainData(buf);
      let pk = 0; for (const v of buf) { const a = v < 0 ? -v : v; if (a > pk) pk = a; }
      const target = Math.min(Math.max((20 * Math.log10(pk || 1e-6) + 48) / 48, 0), 1) * 127; // -48 dB → 0, 0 dB → 127
      cur[i] = target > cur[i] ? target : cur[i] * 0.85 + target * 0.15;                       // sobe rápido, cai devagar
      const v = Math.round(cur[i]);
      if (v !== sent[i]) { send(b.kind, b.channel, b.number, v); sent[i] = v; }
    }
  };
  setInterval(tick, 40);
  window.addEventListener('beforeunload', () => { for (const i of [0, 1]) { const b = map.controls[`out.ch${i + 1}.level`]; if (b && b.number !== null && b.kind !== 'pitchbend') send(b.kind, b.channel, b.number, 0); } });
}
