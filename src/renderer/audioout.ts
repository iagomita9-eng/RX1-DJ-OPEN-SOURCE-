// Espelhar a saída para outros dispositivos de áudio (como o "Saída auxiliar" do Rekordbox).
// A DDJ-400 continua na saída principal (Web Audio → ctx.destination); isto adiciona caminhos
// extras para tocar o master também em outras placas, ao mesmo tempo.
export interface MirrorHandle { stop(): void; }

type SinkableContext = AudioContext & { setSinkId?(id: string): Promise<void> };
type SinkableAudio = HTMLAudioElement & { setSinkId?(id: string): Promise<void> };

export async function listAudioOutputs(): Promise<MediaDeviceInfo[]> {
  try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach(t => t.stop()); }
  catch { /* sem permissão: a lista some sem nomes, mas ainda funciona */ }
  const devs = await navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[]);
  return devs.filter(d => d.kind === 'audiooutput');
}

// Um <audio> tocando um MediaStream passa pelo pipeline de mídia do Chromium, que reserva um buffer
// grande (fica perceptível, ~100-200 ms) — daí o atraso que você ouviu. Preferimos abrir um SEGUNDO
// AudioContext (baixa latência, igual ao da saída principal) já preso ao dispositivo escolhido via
// setSinkId; o <audio> só entra como último recurso, se o navegador não tiver essa API.
export function mirrorMaster(ctx: AudioContext, master: AudioNode, deviceId: string): MirrorHandle {
  const dest = ctx.createMediaStreamDestination();
  master.connect(dest); // fan-out: não tira o áudio da saída principal, só duplica

  if ('setSinkId' in AudioContext.prototype) {
    const mirrorCtx = new AudioContext({ latencyHint: 'interactive', sampleRate: ctx.sampleRate }) as SinkableContext;
    const src = mirrorCtx.createMediaStreamSource(dest.stream);
    src.connect(mirrorCtx.destination);
    void mirrorCtx.setSinkId!(deviceId).catch(() => { /* dispositivo indisponível: mirrorCtx toca no padrão mesmo assim */ });
    return {
      stop() { try { master.disconnect(dest); } catch { /* já desconectado */ } src.disconnect(); void mirrorCtx.close(); },
    };
  }

  // Fallback (navegador sem AudioContext.setSinkId): mais lento, mas ainda funciona.
  const el = document.createElement('audio') as SinkableAudio;
  el.srcObject = dest.stream; el.autoplay = true; el.style.display = 'none';
  void el.setSinkId?.(deviceId).catch(() => { /* navegador sem suporte a setSinkId */ });
  document.body.append(el);
  void el.play().catch(() => { /* alguns navegadores exigem interação antes do play */ });
  return { stop() { try { master.disconnect(dest); } catch { /* já desconectado */ } el.pause(); el.remove(); } };
}
