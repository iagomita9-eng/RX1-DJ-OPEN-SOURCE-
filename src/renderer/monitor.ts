// Monitor MIDI + modo "Aprender" (Fase 1), agora como módulo.
import { api } from './bridge';
import { onMidi } from './midi';
import type { Binding, MidiMap, Parsed } from './types';

export function initMonitor(map: MidiMap) {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const logEl = $('log'), nameInput = $<HTMLInputElement>('nameInput'), learnBtn = $<HTMLButtonElement>('learnBtn');
  const learnMsg = $('learnMsg'), mapList = $('mapList'), pauseBtn = $('pauseBtn');

  // Só sugestões de NOMES (rótulos). Os códigos MIDI vêm da captura, nunca daqui.
  const names: string[] = [];
  for (const d of ['deck1', 'deck2']) {
    names.push(`${d}.play`, `${d}.cue`, `${d}.sync`, `${d}.load`, `${d}.tempo`, `${d}.jog.turn`, `${d}.jog.touch`);
    for (let i = 1; i <= 8; i++) names.push(`${d}.pad${i}`);
  }
  for (const c of ['ch1', 'ch2']) names.push(`mixer.${c}.volume`, `mixer.${c}.trim`, `mixer.${c}.eq.hi`, `mixer.${c}.eq.mid`, `mixer.${c}.eq.low`, `mixer.${c}.filter`, `mixer.${c}.cue`);
  names.push('mixer.crossfader', 'browse.turn', 'browse.push');
  $('names').innerHTML = names.map(n => `<option value="${n}">`).join('');

  const keyOf = (b: Binding) => `${b.kind}:${b.channel}:${b.number ?? ''}`;
  const saveMap = () => api.saveMapping(map);
  function renderMap() {
    mapList.innerHTML = '';
    for (const [name, b] of Object.entries(map.controls)) {
      const item = document.createElement('div'); item.className = 'mapitem';
      const label = document.createElement('span');
      label.textContent = `${name}  →  ${b.kind} ch${b.channel}${b.number === null ? '' : ' #' + b.number}`;
      const del = document.createElement('button'); del.textContent = '×';
      del.onclick = async () => { delete map.controls[name]; renderMap(); await saveMap(); };
      item.append(label, del); mapList.append(item);
    }
    if (!Object.keys(map.controls).length) mapList.innerHTML = '<span class="dim">nenhum controle mapeado ainda</span>';
  }
  renderMap();

  let paused = false;
  const rows = new Map<string, { el: HTMLElement; count: number; t: number }>();
  pauseBtn.onclick = () => { paused = !paused; pauseBtn.classList.toggle('active', paused); pauseBtn.textContent = paused ? 'Retomar' : 'Pausar'; };
  $('clearBtn').onclick = () => { logEl.innerHTML = ''; rows.clear(); };

  function logMessage(p: Parsed) {
    if (paused) return;
    const key = `${p.kind}:${p.channel}:${p.number ?? ''}${p.kind === 'note' ? (p.on ? ':on' : ':off') : ''}`;
    const type = p.kind === 'note' ? (p.on ? 'Note On' : 'Note Off') : p.kind === 'cc' ? 'CC' : 'Pitch Bend';
    const cells = [new Date().toLocaleTimeString('pt-BR'), type, String(p.channel), p.number === null ? '—' : String(p.number), String(p.value), p.raw];
    const now = performance.now();
    const prev = rows.get(key);
    // Jog e knobs disparam dezenas de mensagens iguais: reaproveita a linha (×N) se for <500 ms da anterior.
    if (prev && prev.el.isConnected && now - prev.t < 500) {
      prev.count++; prev.t = now;
      prev.el.children[0].textContent = cells[0]; prev.el.children[4].textContent = cells[4];
      prev.el.children[5].textContent = cells[5]; prev.el.children[6].textContent = '×' + prev.count;
      return;
    }
    const el = document.createElement('div'); el.className = 'row flash';
    for (const c of cells) { const s = document.createElement('span'); s.textContent = c; el.append(s); }
    const cnt = document.createElement('span'); cnt.className = 'cnt'; el.append(cnt);
    logEl.prepend(el); setTimeout(() => el.classList.remove('flash'), 250);
    rows.set(key, { el, count: 1, t: now });
    while (logEl.children.length > 300) logEl.lastElementChild!.remove();
  }

  let learning: string | null = null;
  learnBtn.onclick = () => {
    const name = nameInput.value.trim();
    if (!name) { learnMsg.textContent = 'Digite um nome primeiro.'; return; }
    learning = name; learnBtn.classList.add('active');
    learnMsg.textContent = `Mexa no controle "${name}" na DDJ-400…`;
  };
  async function tryLearn(p: Parsed) {
    if (!learning || (p.kind === 'note' && !p.on)) return;
    const b: Binding = { kind: p.kind, channel: p.channel, number: p.number };
    const dup = Object.entries(map.controls).find(([n, x]) => keyOf(x) === keyOf(b) && n !== learning && !n.startsWith('out.'));
    if (dup) { learnMsg.textContent = `Esse sinal já é "${dup[0]}". Apague-o antes ou mexa em outro controle.`; return; }
    map.controls[learning] = b;
    learnMsg.textContent = `"${learning}" salvo: ${b.kind} ch${b.channel}${b.number === null ? '' : ' #' + b.number}`;
    learning = null; learnBtn.classList.remove('active'); nameInput.value = '';
    renderMap(); await saveMap();
  }
  onMidi(p => { logMessage(p); void tryLearn(p); });
}
