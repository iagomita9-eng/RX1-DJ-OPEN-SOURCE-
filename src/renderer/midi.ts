import type { Parsed } from './types';

export function parse(d: Uint8Array): Parsed | null {
  const s = d[0];
  if (s >= 0xF0) return null; // clock, active sensing, sysex: ignorados
  const type = s & 0xF0, channel = (s & 0x0F) + 1;
  const raw = Array.from(d).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
  if (type === 0x90 && d[2] > 0) return { kind: 'note', channel, number: d[1], value: d[2], on: true, raw };
  if (type === 0x90 || type === 0x80) return { kind: 'note', channel, number: d[1], value: d[2], on: false, raw };
  if (type === 0xB0) return { kind: 'cc', channel, number: d[1], value: d[2], raw };
  if (type === 0xE0) return { kind: 'pitchbend', channel, number: null, value: (d[2] << 7) | d[1], raw };
  return null;
}

// Saída MIDI para a DDJ-400 (LEDs). Escolhida pelo mesmo nome da entrada.
let outPort: MIDIOutput | null = null;
export function send(kind: 'cc' | 'note', channel: number, number: number, value: number) {
  if (!outPort) return false;
  outPort.send([(kind === 'cc' ? 0xB0 : 0x90) | ((channel - 1) & 0x0F), number & 0x7F, value & 0x7F]);
  return true;
}

// Acende LOOP IN/4BEAT e LOOP OUT dos dois decks como sinal de "app pronto" (códigos oficiais da lista de
// mensagens MIDI da DDJ-400: NOTE 16 e 17, canais 1/2 — não vêm do mapa, porque loop ainda não foi mapeado).
function readyLeds() {
  for (const ch of [1, 2]) { send('note', ch, 16, 127); send('note', ch, 17, 127); }
}

// Hub simples: quem quiser mensagens MIDI se inscreve aqui (monitor, decks...).
type Listener = (p: Parsed) => void;
const listeners = new Set<Listener>();
export const onMidi = (fn: Listener) => { listeners.add(fn); };

export async function startMidi(inputSelect: HTMLSelectElement, statusEl: HTMLElement, devicesEl: HTMLElement) {
  let access: MIDIAccess;
  try { access = await navigator.requestMIDIAccess({ sysex: false }); }
  catch (e) { statusEl.textContent = 'Sem acesso ao MIDI: ' + e; return; }

  let current: MIDIInput | null = null;
  const onMessage = (ev: MIDIMessageEvent) => {
    const p = ev.data ? parse(ev.data) : null;
    if (p) listeners.forEach(fn => fn(p));
  };
  function bind(inp: MIDIInput | null) {
    if (current) current.onmidimessage = null;
    current = inp;
    if (inp) { inp.onmidimessage = onMessage; statusEl.textContent = `ouvindo: ${inp.name}`; }
    else statusEl.textContent = 'nenhuma entrada MIDI — plugue a DDJ-400';
  }
  function refresh() {
    const inputs = [...access.inputs.values()], outputs = [...access.outputs.values()];
    const prevId = inputSelect.value;
    inputSelect.innerHTML = inputs.map(i => `<option value="${i.id}">${i.name}</option>`).join('');
    const pick = inputs.find(i => i.id === prevId) ?? inputs.find(i => /DDJ-?400/i.test(i.name ?? '')) ?? inputs[0];
    if (pick) inputSelect.value = pick.id;
    bind(pick ?? null);
    const hadPort = !!outPort;
    outPort = outputs.find(o => o.name === pick?.name) ?? outputs.find(o => /DDJ-?400/i.test(o.name ?? '')) ?? null;
    if (outPort && !hadPort) readyLeds(); // porta de saída ficou disponível agora: acende os LEDs de "pronto"
    devicesEl.textContent = 'Entradas:\n' + (inputs.map(i => ` • ${i.name} (${i.state})`).join('\n') || ' (nenhuma)') +
      '\nSaídas:\n' + (outputs.map(o => ` • ${o.name} (${o.state})`).join('\n') || ' (nenhuma)');
  }
  inputSelect.onchange = () => bind([...access.inputs.values()].find(i => i.id === inputSelect.value) ?? null);
  access.onstatechange = refresh; // plug/unplug em tempo real
  refresh();
}
