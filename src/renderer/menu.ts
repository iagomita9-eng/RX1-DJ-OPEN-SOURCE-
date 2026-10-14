// Barra de menu (SOURCE … MENU) com cursor. Na DDJ-400: LOAD 1 ← / LOAD 2 →, BROWSE push seleciona.
export const MENU_ITEMS = ['SOURCE', 'BROWSE', 'TAG LIST', 'PLAYLIST', 'SEARCH', 'MENU'];

export function initMenu(bar: HTMLElement, onActivate: (item: string) => void) {
  let cur = 1; // começa em BROWSE
  bar.innerHTML = MENU_ITEMS.map(t => `<button>${t}</button>`).join('');
  const btns = [...bar.querySelectorAll('button')];
  const paint = () => btns.forEach((b, i) => b.classList.toggle('cursor', i === cur));
  btns.forEach((b, i) => b.onclick = () => { cur = i; paint(); onActivate(MENU_ITEMS[i]); });
  paint();
  return {
    move(d: number) { cur = Math.min(Math.max(cur + d, 0), MENU_ITEMS.length - 1); paint(); },
    activate() { onActivate(MENU_ITEMS[cur]); },
  };
}
