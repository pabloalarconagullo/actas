// Transcripción local con Whisper (transformers.js). El audio no sale del ordenador:
// solo se descarga el modelo la primera vez y queda guardado en la caché del navegador.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';

env.allowLocalModels = false;

const SR = 16000;
const BLOCK = SR * 300; // bloques de 5 minutos para informar del progreso

let asr = null;
let loadedKey = '';

async function hasWebGPU() {
  try {
    return !!(navigator.gpu && (await navigator.gpu.requestAdapter()));
  } catch {
    return false;
  }
}

async function load(model) {
  const webgpu = await hasWebGPU();
  const key = `${model}|${webgpu}`;
  if (asr && loadedKey === key) return webgpu;
  const files = {};
  asr = await pipeline('automatic-speech-recognition', model, {
    device: webgpu ? 'webgpu' : 'wasm',
    dtype: webgpu ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8',
    progress_callback: (p) => {
      if (p.status !== 'progress' || !p.total) return;
      files[p.file] = [p.loaded, p.total];
      const [loaded, total] = Object.values(files).reduce((a, [l, t]) => [a[0] + l, a[1] + t], [0, 0]);
      self.postMessage({ type: 'download', loaded, total });
    },
  });
  loadedKey = key;
  return webgpu;
}

self.onmessage = async ({ data }) => {
  if (data.type !== 'run') return;
  try {
    self.postMessage({ type: 'status', text: 'Cargando el modelo de transcripción…' });
    const webgpu = await load(data.model);
    const audio = data.audio;
    const segments = [];
    const blocks = Math.max(1, Math.ceil(audio.length / BLOCK));
    for (let b = 0; b < blocks; b++) {
      self.postMessage({ type: 'progress', done: b, total: blocks, webgpu });
      const offset = b * BLOCK;
      const out = await asr(audio.subarray(offset, offset + BLOCK), {
        language: 'spanish',
        task: 'transcribe',
        chunk_length_s: 30,
        stride_length_s: 5,
        return_timestamps: true,
      });
      for (const c of out.chunks ?? [{ timestamp: [0], text: out.text }]) {
        const text = c.text.trim();
        if (text) segments.push({ t: Math.round((c.timestamp?.[0] ?? 0) + offset / SR), text });
      }
    }
    self.postMessage({ type: 'done', segments });
  } catch (e) {
    self.postMessage({ type: 'error', message: e?.message || String(e) });
  }
};
