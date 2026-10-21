// Prepara el audio (16 kHz, mono) y lo transcribe en un worker con Whisper.
export const WHISPER_MODELS = [
  { id: 'onnx-community/whisper-base', name: 'Rápido (Whisper base, ~80 MB)' },
  { id: 'onnx-community/whisper-small', name: 'Recomendado (Whisper small, ~250 MB)' },
  { id: 'onnx-community/whisper-large-v3-turbo', name: 'Máxima calidad (Whisper large v3 turbo, ~1 GB, necesita tarjeta gráfica)' },
];

async function decode(blob) {
  const ctx = new AudioContext({ sampleRate: 16000 });
  try {
    const audio = await ctx.decodeAudioData(await blob.arrayBuffer());
    if (audio.numberOfChannels === 1) return new Float32Array(audio.getChannelData(0));
    const out = new Float32Array(audio.length);
    for (let c = 0; c < audio.numberOfChannels; c++) {
      const ch = audio.getChannelData(c);
      for (let i = 0; i < ch.length; i++) out[i] += ch[i] / audio.numberOfChannels;
    }
    return out;
  } catch {
    throw new Error('No se pudo leer el audio. Prueba con MP3, M4A, WAV, OGG o WEBM.');
  } finally {
    ctx.close();
  }
}

// onStatus(texto, fracción 0-1 | null). Devuelve { promise, cancel }.
export function transcribe(blob, model, onStatus) {
  let worker = null;
  let cancelled = false;
  let rejectRun = null;
  const promise = (async () => {
    onStatus('Preparando el audio…', null);
    const audio = await decode(blob);
    if (cancelled) throw new Error('Cancelado');
    const minutes = Math.max(1, Math.round(audio.length / 16000 / 60));
    worker = new Worker(new URL('./whisper-worker.js', import.meta.url), { type: 'module' });
    return new Promise((resolve, reject) => {
      rejectRun = reject;
      worker.onmessage = ({ data }) => {
        if (data.type === 'status') onStatus(data.text, null);
        else if (data.type === 'download') onStatus(`Descargando el modelo (solo la primera vez): ${Math.round(data.loaded / 1e6)} de ${Math.round(data.total / 1e6)} MB`, data.loaded / data.total);
        else if (data.type === 'progress')
          onStatus(`Transcribiendo ${minutes} min de audio en este ordenador${data.webgpu ? ' (tarjeta gráfica)' : ''}… ${Math.round((data.done / data.total) * 100)} %`, data.done / data.total);
        else if (data.type === 'done') {
          worker.terminate();
          resolve(data.segments);
        } else if (data.type === 'error') {
          worker.terminate();
          reject(new Error(`Error al transcribir: ${data.message}`));
        }
      };
      worker.onerror = (e) => {
        worker.terminate();
        reject(new Error(`Error al transcribir: ${e.message || 'no se pudo iniciar el modelo'}`));
      };
      worker.postMessage({ type: 'run', audio, model }, [audio.buffer]);
    });
  })();
  return {
    promise,
    cancel() {
      cancelled = true;
      worker?.terminate();
      rejectRun?.(new Error('Cancelado'));
    },
  };
}
