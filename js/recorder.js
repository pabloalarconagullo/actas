// Grabación de audio (micrófono, o micrófono + audio de una pestaña/pantalla en videollamadas)
// y transcripción en directo con el reconocimiento de voz del navegador.
const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
export const liveSupported = !!Speech;
export const callCaptureSupported = !!navigator.mediaDevices?.getDisplayMedia;

function pickMime() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  return types.find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || '';
}

export class Recorder {
  // mode: 'mic' | 'call'. onLive(segment) recibe frases finales; onInterim(texto) la frase en curso.
  constructor({ mode = 'mic', live = false, onLive, onInterim, onLevel, onTick } = {}) {
    Object.assign(this, { mode, live: live && liveSupported, onLive, onInterim, onLevel, onTick });
    this.chunks = [];
    this.streams = [];
    this.state = 'idle';
    this.elapsedBefore = 0; // segundos acumulados antes de la última pausa
    this.startedAt = 0;
  }

  get elapsed() {
    return this.elapsedBefore + (this.state === 'recording' ? (performance.now() - this.startedAt) / 1000 : 0);
  }

  async start() {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error('Este navegador no permite grabar audio.');
    const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    this.streams.push(mic);
    this.ctx = new AudioContext();
    const dest = this.ctx.createMediaStreamDestination();
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 512;
    for (const src of [mic]) {
      const node = this.ctx.createMediaStreamSource(src);
      node.connect(dest);
      node.connect(analyser);
    }
    if (this.mode === 'call') {
      let screen;
      try {
        screen = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true, systemAudio: 'include' });
      } catch {
        this.cleanup();
        throw new Error('No se compartió ninguna pestaña o pantalla.');
      }
      this.streams.push(screen);
      if (!screen.getAudioTracks().length) {
        this.cleanup();
        throw new Error('No se compartió el audio. Elige la pestaña de la videollamada y marca "Compartir audio".');
      }
      const node = this.ctx.createMediaStreamSource(new MediaStream(screen.getAudioTracks()));
      node.connect(dest);
      node.connect(analyser);
      // Si el usuario deja de compartir desde el navegador, se detiene la grabación
      screen.getTracks().forEach((t) => (t.onended = () => this.state !== 'idle' && this.onShareEnded?.()));
    }

    const mimeType = pickMime();
    this.rec = new MediaRecorder(dest.stream, mimeType ? { mimeType } : undefined);
    this.mimeType = this.rec.mimeType || mimeType || 'audio/webm';
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.rec.start(1000);
    this.state = 'recording';
    this.startedAt = performance.now();

    const buf = new Uint8Array(analyser.fftSize);
    const loop = () => {
      if (this.state === 'idle') return;
      analyser.getByteTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
      this.onLevel?.(this.state === 'recording' ? peak / 128 : 0);
      this.onTick?.(this.elapsed);
      this.raf = requestAnimationFrame(loop);
    };
    loop();
    if (this.live) this.startLive();
  }

  startLive() {
    const r = new Speech();
    r.lang = 'es-ES';
    r.continuous = true;
    r.interimResults = true;
    let phraseStart = null;
    r.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        phraseStart ??= Math.max(0, this.elapsed - 2);
        if (res.isFinal) {
          const text = res[0].transcript.trim();
          if (text) this.onLive?.({ t: Math.round(phraseStart), text: text[0].toUpperCase() + text.slice(1) });
          phraseStart = null;
        } else interim += res[0].transcript;
      }
      this.onInterim?.(interim);
    };
    r.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') this.live = false;
    };
    // Chrome corta el reconocimiento tras silencios: se reinicia mientras se graba
    r.onend = () => {
      if (this.live && this.state === 'recording') {
        try {
          r.start();
        } catch {
          /* ya estaba arrancando */
        }
      }
    };
    this.speech = r;
    r.start();
  }

  pause() {
    if (this.state !== 'recording') return;
    this.elapsedBefore = this.elapsed;
    this.state = 'paused';
    this.rec.pause();
    this.speech?.stop();
  }

  resume() {
    if (this.state !== 'paused') return;
    this.state = 'recording';
    this.startedAt = performance.now();
    this.rec.resume();
    if (this.speech) {
      try {
        this.speech.start();
      } catch {
        /* se reinicia en onend */
      }
    }
  }

  // Devuelve { blob, duration }
  stop() {
    return new Promise((resolve) => {
      if (this.state === 'idle') return resolve(null);
      const duration = Math.round(this.elapsed);
      this.state = 'idle';
      this.speech?.abort();
      this.rec.onstop = () => {
        const blob = new Blob(this.chunks, { type: this.mimeType });
        this.cleanup();
        resolve({ blob, duration });
      };
      this.rec.stop();
    });
  }

  cleanup() {
    this.state = 'idle';
    cancelAnimationFrame(this.raf);
    this.streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    this.streams = [];
    this.ctx?.close();
  }
}
