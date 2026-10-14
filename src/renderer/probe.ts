// Sondagem de saída MIDI: o app NÃO sabe quais mensagens acendem os LEDs da DDJ-400.
// Aqui você envia mensagens de teste, vê na controladora o que acende e salva o código que funcionou no mapa.
import { api } from './bridge';
import { send } from './midi';
import { listAudioOutputs, mirrorMaster, type MirrorHandle } from './audioout';
import type { Mixer } from './engine/mixer';
import type { MidiMap } from './types';

export function initAudioPanel(mixer: Mixer, ctx: AudioContext, notify: (m: string) => void) {
  // Diagnóstico ao vivo: mostra o que o app está de fato recebendo dos knobs de pré-escuta, para
  // separar "o CUE não está roteando" de "o knob físico não está na posição que eu pensava".
  const diag = document.getElementById('cueDiag')!;
  setInterval(() => {
    const pct = (v: number) => Math.round(v * 100) + '%';
    diag.textContent = `CUE ch1: ${mixer.isCue(1) ? 'ligado' : 'desligado'} · CUE ch2: ${mixer.isCue(2) ? 'ligado' : 'desligado'} · MASTER CUE: ${mixer.isMasterCue() ? 'ligado' : 'desligado'} · HEADPHONES MIXING: ${pct(mixer.getPhonesMix())} master (${pct(1 - mixer.getPhonesMix())} cue) · HEADPHONES LEVEL: ${pct(mixer.getPhonesLevel())}`;
  }, 250);
  const info = document.getElementById('audioInfo')!;
  info.textContent = mixer.phones
    ? `Saída de áudio com ${mixer.outChannels} canais: master nos canais 1-2, pré-escuta (fone) nos canais 3-4.`
    : `Saída de áudio com só ${mixer.outChannels} canais: a pré-escuta precisa de 4. Deixe a DDJ-400 como saída padrão do Windows e veja se o driver oferece 4 canais (ou ajuste masterChannels/cueChannels em settings).`;
  document.getElementById('toneMaster')!.onclick = () => { mixer.testTone('master'); };
  document.getElementById('tonePhones')!.onclick = () => { if (!mixer.testTone('phones')) notify('Pré-escuta indisponível nesta saída'); };

  // Espelhar o master em outras saídas de áudio ao mesmo tempo (ex.: caixa de retorno + fone do PC),
  // além da saída principal (DDJ-400). Cada dispositivo tem seu próprio botão de ligar/desligar.
  const list = document.getElementById('outList') as HTMLElement;
  const active = new Map<string, MirrorHandle>();
  async function refreshList() {
    if (!('setSinkId' in HTMLAudioElement.prototype)) { list.innerHTML = '<span class="dim">este navegador não permite escolher a saída de áudio (setSinkId)</span>'; return; }
    const outs = await listAudioOutputs();
    if (!outs.length) { list.innerHTML = '<span class="dim">nenhum dispositivo encontrado</span>'; return; }
    list.innerHTML = '';
    for (const o of outs) {
      const row = document.createElement('div'); row.className = 'mapitem';
      const label = document.createElement('span'); label.textContent = o.label || 'dispositivo de áudio';
      const btn = document.createElement('button'); const on = active.has(o.deviceId);
      btn.textContent = on ? 'Parar' : 'Espelhar'; btn.classList.toggle('active', on);
      btn.onclick = () => {
        const h = active.get(o.deviceId);
        if (h) { h.stop(); active.delete(o.deviceId); btn.textContent = 'Espelhar'; btn.classList.remove('active'); }
        else { active.set(o.deviceId, mirrorMaster(ctx, mixer.masterTap(), o.deviceId)); btn.textContent = 'Parar'; btn.classList.add('active'); }
      };
      row.append(label, btn); list.append(row);
    }
  }
  void refreshList();
  document.getElementById('refreshOut')!.onclick = () => void refreshList();
}

export function initProbe(map: MidiMap) {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const kind = $<HTMLSelectElement>('pKind'), ch = $<HTMLInputElement>('pCh'), num = $<HTMLInputElement>('pNum'), val = $<HTMLInputElement>('pVal');
  const msg = $('pMsg'), name = $<HTMLInputElement>('pName'), sweepBtn = $<HTMLButtonElement>('pSweep');
  const cur = () => ({ k: kind.value as 'cc' | 'note', c: Number(ch.value), n: Number(num.value) });
  const fire = (v: number) => { const { k, c, n } = cur(); msg.textContent = send(k, c, n, v) ? `enviado: ${k} canal ${c} nº ${n} valor ${v}` : 'sem porta de saída MIDI da DDJ-400'; };
  $('pSend').onclick = () => fire(Number(val.value));
  $('pOff').onclick = () => fire(0);
  $('pPrev').onclick = () => { fire(0); num.value = String(Math.max(0, Number(num.value) - 1)); fire(Number(val.value)); };
  $('pNext').onclick = () => { fire(0); num.value = String(Math.min(127, Number(num.value) + 1)); fire(Number(val.value)); };

  // Varredura: liga cada número por ~200 ms. Quando o que você procura acender, clique em Parar: o número fica no campo.
  let timer = 0;
  const stop = () => { clearInterval(timer); timer = 0; sweepBtn.textContent = 'Varrer números'; sweepBtn.classList.remove('active'); };
  sweepBtn.onclick = () => {
    if (timer) { stop(); return; }
    sweepBtn.textContent = 'Parar'; sweepBtn.classList.add('active');
    let first = true;
    timer = window.setInterval(() => {
      if (!first) { fire(0); num.value = String(Number(num.value) + 1); }   // apaga o anterior e avança
      first = false;
      if (Number(num.value) > 127) { stop(); msg.textContent = 'varredura terminou (127)'; return; }
      fire(Number(val.value));
    }, 200);
  };
  $('pSave').onclick = async () => {
    const n = name.value.trim(); if (!n) { msg.textContent = 'digite um nome (ex.: out.ch1.level)'; return; }
    const { k, c, n: number } = cur();
    map.controls[n] = { kind: k, channel: c, number };
    await api.saveMapping(map); msg.textContent = `"${n}" salvo: ${k} canal ${c} nº ${number}`;
  };
}
