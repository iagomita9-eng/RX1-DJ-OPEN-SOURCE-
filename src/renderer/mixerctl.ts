// Liga os controles de mixer da DDJ-400 (via mapa JSON) ao Mixer.
import { onMidi, send } from './midi';
import type { Mixer } from './engine/mixer';
import type { MidiMap } from './types';

interface Ctl { msb: number; lsb: number; haveMsb: boolean; set: (v: number) => void; }
const key = (ch: number, num: number) => `${ch}:${num}`;

export function initMixerControl(map: MidiMap, mixer: Mixer, notify: (m: string) => void = () => {}) {
  const lookup = new Map<string, { c: Ctl; part: 'msb' | 'lsb' }>();
  const notes = new Map<string, () => void>(); // botões (pré-escuta): note-on alterna
  // LED do botão acompanha o estado (o PDF da DDJ-400 diz que o LED é comandado pela mesma nota)
  const led = (name: string, on: boolean) => { const b = map.controls[name]; if (b && b.number !== null && b.kind !== 'pitchbend') send(b.kind, b.channel, b.number, on ? 127 : 0); };
  // O LED sempre responde ao apertar, mesmo sem canais de fone disponíveis (o app avisa, mas não trava o botão).
  const cueBtn = (name: string, toggle: () => boolean) => () => {
    led(name, toggle());
    if (!mixer.phones) notify('Pré-escuta indisponível: a saída de áudio tem só ' + mixer.outChannels + ' canais (veja MONITOR → Áudio)');
  };
  function rebuild() {
    lookup.clear(); notes.clear();
    const used = new Set(Object.values(map.controls).filter(b => b.kind === 'cc').map(b => key(b.channel, b.number!)));
    for (const [name, b] of Object.entries(map.controls)) {
      if (b.kind === 'note' && b.number !== null) {
        const k = key(b.channel, b.number);
        if (name === 'mixer.ch1.cue') notes.set(k, cueBtn(name, () => mixer.toggleCue(1)));
        else if (name === 'mixer.ch2.cue') notes.set(k, cueBtn(name, () => mixer.toggleCue(2)));
        else if (name === 'mixer.master.cue') notes.set(k, cueBtn(name, () => mixer.toggleMasterCue()));
        continue;
      }
      if (b.kind !== 'cc' || b.number === null) continue;
      let set: ((v: number) => void) | null = null, m: RegExpExecArray | null;
      if ((m = /^mixer\.ch([12])\.(trim|eq\.hi|eq\.mid|eq\.low|filter|volume)$/.exec(name))) {
        const n = Number(m[1]);
        set = { trim: (v: number) => mixer.setTrim(n, v), 'eq.hi': (v: number) => mixer.setEq(n, 'high', v), 'eq.mid': (v: number) => mixer.setEq(n, 'mid', v),
          'eq.low': (v: number) => mixer.setEq(n, 'low', v), filter: (v: number) => mixer.setFilter(n, v), volume: (v: number) => mixer.setVolume(n, v) }[m[2]]!;
      } else if (name === 'mixer.crossfader') set = v => mixer.setCrossfader(v);
      else if (name === 'mixer.fone.volume') set = v => mixer.setPhonesLevel(v);
      else if (name === 'mixer.fone.selector') set = v => mixer.setPhonesMix(v);
      else if (name === 'mixer.master.volume') set = v => mixer.setMaster(v);
      if (!set) continue;
      const c: Ctl = { msb: 0, lsb: 0, haveMsb: false, set };
      lookup.set(key(b.channel, b.number), { c, part: 'msb' });
      if (!used.has(key(b.channel, b.number + 32))) lookup.set(key(b.channel, b.number + 32), { c, part: 'lsb' }); // 14 bits: LSB = MSB + 32
    }
  }
  rebuild();
  for (const n of ['mixer.ch1.cue', 'mixer.ch2.cue', 'mixer.master.cue']) led(n, false); // LEDs começam apagados, como o estado do app
  onMidi(p => {
    if (p.kind === 'note' && p.on && p.number !== null) { notes.get(key(p.channel, p.number))?.(); return; }
    if (p.kind !== 'cc' || p.number === null) return;
    const hit = lookup.get(key(p.channel, p.number)); if (!hit) return;
    const { c, part } = hit;
    if (part === 'msb') { c.msb = p.value; c.haveMsb = true; } else { c.lsb = p.value; if (!c.haveMsb) return; }
    c.set(((c.msb << 7) | c.lsb) / 16383);
  });
  return { rebuild };
}
