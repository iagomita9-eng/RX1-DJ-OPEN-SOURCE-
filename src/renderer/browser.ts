// Navegador de faixas (BROWSE): lista pastas e áudios da pasta-raiz escolhida em SOURCE.
import { api } from './bridge';

interface Row { label: string; kind: 'close' | 'up' | 'dir' | 'file'; path?: string; }

export function initBrowser(screen: HTMLElement, loadPath: (deck: number, path: string) => Promise<void>, toast: (m: string) => void) {
  const el = document.createElement('div');
  el.className = 'browser'; el.hidden = true;
  el.innerHTML = '<div class="bhead"></div><div class="blist"></div><div class="bfoot">girar: rolar · LOAD 1 / LOAD 2: carregar no deck · push: abrir pasta / voltar</div>';
  screen.append(el);
  const head = el.querySelector('.bhead') as HTMLElement, list = el.querySelector('.blist') as HTMLElement;

  let root = ''; try { root = localStorage.getItem('musicRoot') ?? ''; } catch { /* sem storage */ }
  let dir = '', rows: Row[] = [], sel = 0, isOpen = false;

  function render() {
    head.textContent = 'BROWSE — ' + (dir || '(sem pasta)');
    list.innerHTML = '';
    rows.forEach((r, i) => {
      const d = document.createElement('div');
      d.className = 'brow' + (i === sel ? ' sel' : ''); d.textContent = r.label;
      d.onclick = () => { sel = i; render(); }; d.ondblclick = () => void push();
      list.append(d);
    });
    (list.children[sel] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
  }
  async function show(d: string) {
    const r = await api.listDir(d);
    if (!r) { toast('não consegui ler essa pasta'); return; }
    dir = r.dir;
    rows = [{ label: '◀ VOLTAR', kind: 'close' }];
    if (dir !== root && r.parent !== dir) rows.push({ label: '⬆ pasta acima', kind: 'up', path: r.parent });
    for (const e of r.entries) rows.push({ label: (e.dir ? '▸ ' : '♪ ') + e.name, kind: e.dir ? 'dir' : 'file', path: e.path });
    sel = Math.max(0, rows.findIndex(x => x.kind === 'dir' || x.kind === 'file'));
    render();
  }
  async function chooseRoot() {
    const p = await api.pickFolder(); if (!p) return;
    root = p; try { localStorage.setItem('musicRoot', p); } catch { /* ok */ }
    toast('pasta de músicas definida'); if (isOpen) await show(p);
  }
  async function open() {
    if (!root) { await chooseRoot(); if (!root) return; }
    isOpen = true; el.hidden = false; await show(dir || root);
  }
  function close() { isOpen = false; el.hidden = true; }
  async function push() {
    const r = rows[sel]; if (!r) return;
    if (r.kind === 'close') close();
    else if (r.kind === 'up' || r.kind === 'dir') await show(r.path!);
    else toast('use LOAD 1 ou LOAD 2 para carregar');
  }
  return {
    isOpen: () => isOpen, open, close, chooseRoot, push,
    scroll(d: number) { sel = Math.min(Math.max(sel + d, 0), rows.length - 1); render(); },
    async loadSelected(deck: number) { const r = rows[sel]; if (r?.kind !== 'file') { toast('escolha uma faixa (♪)'); return; } await loadPath(deck, r.path!); close(); }, // volta pra tela normal depois de carregar
  };
}
