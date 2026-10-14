import { api } from './bridge';
import { onMidi, startMidi } from './midi';
import { initMonitor } from './monitor';
import { initDecks } from './decks';
import { Mixer } from './engine/mixer';
import { initMixerControl } from './mixerctl';
import { initMenu } from './menu';
import { initBrowser } from './browser';
import { initLevels } from './levels';
import { initAudioPanel, initProbe } from './probe';
import type { MidiMap } from './types';

(async () => {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const map: MidiMap = (await api.loadMapping()) ?? { version: 1, device: 'DDJ-400', controls: {} };
  initMonitor(map);

  $('decksView').innerHTML = '<div class="rxbar" id="rxbar"></div><div class="stage"><div class="screen" id="screen"></div></div>';
  const screen = $('screen');

  // Aviso curto no topo da tela.
  const toastEl = document.createElement('div'); toastEl.className = 'toast'; toastEl.hidden = true;
  let toastTimer = 0;
  const toast = (m: string) => { toastEl.textContent = m; toastEl.hidden = false; clearTimeout(toastTimer); toastTimer = window.setTimeout(() => toastEl.hidden = true, 2500); };

  const ctx = new AudioContext();
  const mixer = new Mixer(ctx, map.settings ?? {});
  const mixerCtl = initMixerControl(map, mixer, m => toast(m));
  initLevels(map, mixer);
  initProbe(map);
  initAudioPanel(mixer, ctx, toast);
  let view = 'decksView';
  // LOAD 1 / LOAD 2: com o navegador aberto carregam a faixa; fora dele movem o cursor do menu (esquerda / direita).
  const decks = initDecks(map, screen, ctx, mixer, { notify: toast, onLoad: n => {
    if (view !== 'decksView') return;
    if (browser.isOpen()) void browser.loadSelected(n); else menu.move(n === 1 ? -1 : 1);
  } });
  screen.append(toastEl);
  const browser = initBrowser(screen, decks.loadPath, toast);
  const menu = initMenu($('rxbar'), item => {
    if (item === 'SOURCE') void browser.chooseRoot();
    else if (item === 'BROWSE') void browser.open();
    else toast(`${item} — em breve`);
  });

  // Encoder do browse: aceita dois formatos de MIDI relativo (centro 64 ou complemento de dois) sem precisar configurar.
  const relDelta = (v: number) => v >= 97 ? v - 128 : v <= 31 ? v : v - 64;
  const nav = new Map<string, 'turn' | 'push'>();
  const buildNav = () => {
    nav.clear();
    for (const [name, a] of [['browse.turn', 'turn'], ['browse.push', 'push']] as const) {
      const b = map.controls[name]; if (b) nav.set(`${b.kind}:${b.channel}:${b.number}`, a);
    }
  };
  buildNav();
  onMidi(p => {
    if (view !== 'decksView') return;
    const a = nav.get(`${p.kind}:${p.channel}:${p.number}`);
    if (a === 'turn') { if (browser.isOpen()) browser.scroll(relDelta(p.value)); else decks.setZoom(relDelta(p.value)); } // fora do navegador: zoom da waveform
    else if (a === 'push' && p.on) { if (browser.isOpen()) void browser.push(); else menu.activate(); }
  });

  document.querySelectorAll<HTMLButtonElement>('nav button').forEach(btn => btn.onclick = () => {
    view = btn.dataset.view!;
    document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === view));
    if (view === 'decksView') { decks.rebuild(); mixerCtl.rebuild(); buildNav(); }
  });
  await startMidi($('inputSelect'), $('status'), $('devices'));
})();
