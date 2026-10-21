// Actas — grabar, transcribir y resumir reuniones con clientes.
import * as store from './store.js';
import { MODELS, hasKey, generateSummary, separateSpeakers, askMeeting } from './ai.js';
import { Recorder, liveSupported, callCaptureSupported } from './recorder.js';
import { transcribe, WHISPER_MODELS } from './transcribe.js';
import { esc, fmtDate, fmtClock, mdToHtml, toMarkdown, downloadMarkdown, downloadWord, downloadAudio, mailtoHref, printActa } from './export.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const view = $('#view');

// Estado de la sesión (no se guarda)
let current = null; // reunión abierta
let recorder = null;
let job = null; // transcripción o llamada a Claude en curso: { kind, text, frac, cancel? }
let tab = 'acta';
let interim = '';
let saveTimer = null;

// El trabajo en curso solo se muestra en la reunión a la que pertenece
const myJob = () => (job && job.id === current?.id ? job : null);

const KINDS = { presencial: 'Presencial', videollamada: 'Videollamada', telefono: 'Teléfono' };

// ---------- utilidades de interfaz ----------
function toast(msg, type = '') {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), type === 'error' ? 7000 : 3500);
}

const icon = (name) =>
  ({
    mic: '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
    screen: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
    upload: '<svg viewBox="0 0 24 24"><path d="M12 15V4M7 9l5-5 5 5M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/></svg>',
    stop: '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M9 5v14M15 5v14"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="M7 5l12 7-12 7z"/></svg>',
    spark: '<svg viewBox="0 0 24 24"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/></svg>',
    back: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
    plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
    copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/></svg>',
    mail: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>',
    lock: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  })[name] || '';

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copiado');
  } catch {
    toast('No se pudo copiar', 'error');
  }
}

function persistSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => current && store.saveMeeting(current), 500);
}

async function persist() {
  clearTimeout(saveTimer);
  if (current) await store.saveMeeting(current);
}

// ---------- rutas ----------
async function route() {
  const hash = location.hash || '#/';
  if (recorder && !hash.startsWith(`#/r/${current?.id}`)) {
    toast('Detén la grabación antes de salir de la reunión', 'error');
    location.hash = `#/r/${current.id}`;
    return;
  }
  $$('.appbar nav a').forEach((a) => a.classList.toggle('active', hash === a.getAttribute('href') || (a.getAttribute('href') === '#/' && hash.startsWith('#/r/'))));
  if (hash.startsWith('#/r/')) return showMeeting(hash.slice(4));
  await persist();
  current = null;
  if (hash === '#/ajustes') return showSettings();
  return showHome();
}

// ---------- inicio ----------
async function showHome(query = '') {
  const meetings = await store.listMeetings();
  const q = query.trim().toLowerCase();
  const shown = q
    ? meetings.filter((m) => [m.title, m.client, m.notes, m.summary?.titulo, m.summary?.resumen, ...m.segments.map((s) => s.text)].join(' ').toLowerCase().includes(q))
    : meetings;

  const pending = [];
  const deadlines = [];
  for (const m of meetings) {
    for (const t of m.summary?.tareas ?? []) if (!m.tasksDone?.[t.tarea] && t.responsable === 'Despacho') pending.push({ m, t });
    for (const p of m.summary?.plazos ?? []) if (p.urgencia === 'alta') deadlines.push({ m, p });
  }

  view.innerHTML = `
    <div class="page">
      <div class="toolbar">
        <h1>Reuniones</h1>
        <div class="grow"></div>
        <label class="btn">${icon('upload')}<span>Importar audio</span><input type="file" accept="audio/*,video/webm,video/mp4" id="import" hidden></label>
        <button class="btn primary" id="new">${icon('plus')}<span>Nueva reunión</span></button>
      </div>
      ${!hasKey() ? `<div class="notice">Para generar actas con Claude añade tu clave de API en <a href="#/ajustes">Ajustes</a>. Grabar y transcribir funciona sin ella.</div>` : ''}
      ${
        pending.length || deadlines.length
          ? `<div class="grid2">
              <section class="panel"><h2>Plazos urgentes</h2>${
                deadlines.length
                  ? `<ul class="plain">${deadlines.map(({ m, p }) => `<li><a href="#/r/${m.id}"><span class="badge red">Urgente</span> ${esc(p.descripcion)} — <strong>${esc(p.fecha)}</strong><small>${esc(m.client || m.title)}</small></a></li>`).join('')}</ul>`
                  : '<p class="muted pad">Ninguno.</p>'
              }</section>
              <section class="panel"><h2>Tareas pendientes del despacho</h2>${
                pending.length
                  ? `<ul class="plain">${pending.slice(0, 12).map(({ m, t }) => `<li><a href="#/r/${m.id}">${esc(t.tarea)}${t.fecha ? ` — <strong>${esc(t.fecha)}</strong>` : ''}<small>${esc(m.client || m.title)}</small></a></li>`).join('')}</ul>`
                  : '<p class="muted pad">Ninguna.</p>'
              }</section>
            </div>`
          : ''
      }
      <section class="panel">
        <h2>Historial <input type="search" id="q" placeholder="Buscar cliente, asunto o texto…" value="${esc(query)}"></h2>
        ${
          shown.length
            ? `<table class="list"><thead><tr><th>Fecha</th><th>Cliente</th><th>Asunto</th><th>Duración</th><th>Estado</th></tr></thead><tbody>
              ${shown
                .map(
                  (m) => `<tr data-id="${m.id}">
                    <td class="nowrap">${esc(new Date(m.date).toLocaleDateString('es-ES'))} <span class="muted">${esc((m.date || '').slice(11, 16))}</span></td>
                    <td>${esc(m.client || '—')}</td>
                    <td>${esc(m.summary?.titulo || m.title || 'Sin título')}</td>
                    <td class="nowrap">${m.durationSec ? fmtClock(m.durationSec) : '—'}</td>
                    <td class="nowrap">${m.summary ? '<span class="badge green">Acta</span>' : m.segments.length ? '<span class="badge">Transcrita</span>' : m.hasAudio ? '<span class="badge">Audio</span>' : '<span class="badge grey">Borrador</span>'}</td>
                  </tr>`,
                )
                .join('')}</tbody></table>`
            : `<div class="empty">${q ? 'Sin resultados.' : 'Aún no hay reuniones. Pulsa <strong>Nueva reunión</strong> para grabar una o <strong>Importar audio</strong> si ya la grabaste con el móvil.'}</div>`
        }
      </section>
    </div>`;

  $('#new').onclick = async () => {
    const m = await store.saveMeeting(store.newMeeting());
    location.hash = `#/r/${m.id}`;
  };
  $('#import').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const m = store.newMeeting({ hasAudio: true });
    if (file.lastModified) {
      const d = new Date(file.lastModified);
      m.date = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    }
    await store.saveAudio(m.id, file);
    await store.saveMeeting(m);
    location.hash = `#/r/${m.id}`;
  };
  $$('tr[data-id]').forEach((tr) => (tr.onclick = () => (location.hash = `#/r/${tr.dataset.id}`)));
  const qi = $('#q');
  qi.oninput = () => {
    const pos = qi.selectionStart;
    showHome(qi.value).then(() => {
      const n = $('#q');
      n.focus();
      n.setSelectionRange(pos, pos);
    });
  };
}

// ---------- reunión ----------
async function showMeeting(id) {
  if (current?.id !== id) {
    current = await store.getMeeting(id);
    tab = current?.summary ? 'acta' : 'transcripcion';
    if (!current) {
      view.innerHTML = '<div class="page"><div class="empty">Esta reunión no existe. <a href="#/">Volver</a></div></div>';
      return;
    }
  }
  const m = current;
  view.innerHTML = `
    <div class="page meeting">
      <div class="toolbar">
        <a class="btn ghost" href="#/" aria-label="Volver">${icon('back')}</a>
        <input class="title-input" id="title" placeholder="Asunto de la reunión" value="${esc(m.title)}">
        <div class="grow"></div>
        <div class="menu">
          <button class="btn" id="export-btn">Exportar ▾</button>
          <div class="menu-list" id="export-menu" hidden>
            <button data-exp="word">Word (.doc)</button>
            <button data-exp="pdf">Imprimir / PDF</button>
            <button data-exp="md">Markdown (.md)</button>
            <button data-exp="copy">Copiar como texto</button>
            ${m.hasAudio ? '<button data-exp="audio">Descargar el audio</button>' : ''}
          </div>
        </div>
        <button class="btn ghost danger" id="del" aria-label="Eliminar reunión">${icon('trash')}</button>
      </div>

      <div class="meta-row">
        <label>Cliente <input id="client" value="${esc(m.client)}" placeholder="Nombre o empresa"></label>
        <label>Fecha <input type="datetime-local" id="date" value="${esc(m.date)}"></label>
        <label>Modalidad <select id="kind">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}" ${m.kind === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label class="check"><input type="checkbox" id="consent" ${m.consent ? 'checked' : ''}> Cliente informado de la grabación</label>
      </div>

      <section class="panel recbar" id="recbar"></section>

      <div class="workspace">
        <section class="panel notes">
          <h2>Mis notas <small>Apunta lo importante; Claude lo completará con la transcripción.</small></h2>
          <textarea id="notes" placeholder="- Despido el 3/10, carta entregada en mano&#10;- Antigüedad 2019, categoría oficial 1ª&#10;- Pedir nóminas y contrato">${esc(m.notes)}</textarea>
        </section>
        <section class="panel main">
          <div class="tabs" role="tablist">
            <button role="tab" data-tab="acta" class="${tab === 'acta' ? 'active' : ''}">Acta</button>
            <button role="tab" data-tab="transcripcion" class="${tab === 'transcripcion' ? 'active' : ''}">Transcripción${m.segments.length ? ` <span class="count">${m.segments.length}</span>` : ''}</button>
            <button role="tab" data-tab="preguntar" class="${tab === 'preguntar' ? 'active' : ''}">Preguntar</button>
          </div>
          <div class="tab-body" id="tab-body"></div>
        </section>
      </div>
    </div>`;

  const bindField = (sel, key, prop = 'value') => {
    const el = $(sel);
    el.addEventListener(el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input', () => {
      m[key] = el[prop];
      persistSoon();
    });
  };
  bindField('#title', 'title');
  bindField('#client', 'client');
  bindField('#date', 'date');
  bindField('#kind', 'kind');
  bindField('#consent', 'consent', 'checked');
  bindField('#notes', 'notes');

  $('#del').onclick = async () => {
    if (recorder) return toast('Detén la grabación primero', 'error');
    if (!confirmInline($('#del'), '¿Eliminar?')) return;
    await store.deleteMeeting(m.id);
    current = null;
    location.hash = '#/';
  };
  $('#export-btn').onclick = (e) => {
    e.stopPropagation();
    $('#export-menu').hidden = !$('#export-menu').hidden;
  };
  $$('#export-menu button').forEach(
    (b) =>
      (b.onclick = async () => {
        $('#export-menu').hidden = true;
        await persist();
        const kind = b.dataset.exp;
        if (kind === 'word') downloadWord(m);
        else if (kind === 'pdf') printActa(m);
        else if (kind === 'md') downloadMarkdown(m);
        else if (kind === 'copy') copy(toMarkdown(m));
        else if (kind === 'audio') {
          const blob = await store.getAudio(m.id);
          if (blob) downloadAudio(m, blob);
        }
      }),
  );
  $$('.tabs button').forEach(
    (b) =>
      (b.onclick = () => {
        tab = b.dataset.tab;
        $$('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
        renderTab();
      }),
  );

  renderRecbar();
  renderTab();
}

// Botones destructivos: primer clic pide confirmación en el propio botón (sin diálogos del navegador)
function confirmInline(btn, label) {
  if (btn.dataset.armed) return true;
  btn.dataset.armed = '1';
  const old = btn.innerHTML;
  btn.innerHTML = `<span>${label}</span>`;
  btn.classList.add('armed');
  setTimeout(() => {
    if (!btn.isConnected) return;
    delete btn.dataset.armed;
    btn.innerHTML = old;
    btn.classList.remove('armed');
  }, 3000);
  return false;
}

// ---------- barra de grabación ----------
async function renderRecbar() {
  const el = $('#recbar');
  if (!el) return;
  const m = current;

  if (recorder) {
    const paused = recorder.state === 'paused';
    el.innerHTML = `
      <div class="rec-live">
        <span class="dot ${paused ? 'paused' : ''}"></span>
        <strong id="clock">${fmtClock(recorder.elapsed)}</strong>
        <div class="meter"><div id="level"></div></div>
        <span class="muted small">${recorder.mode === 'call' ? 'Micrófono + audio de la llamada' : 'Micrófono'}${recorder.live ? ' · transcribiendo en directo' : ''}</span>
        <div class="grow"></div>
        <button class="btn" id="pause">${icon(paused ? 'play' : 'pause')}<span>${paused ? 'Continuar' : 'Pausa'}</span></button>
        <button class="btn primary stop" id="stop">${icon('stop')}<span>Terminar</span></button>
      </div>`;
    $('#pause').onclick = () => {
      paused ? recorder.resume() : recorder.pause();
      renderRecbar();
    };
    $('#stop').onclick = stopRecording;
    return;
  }

  if (myJob()?.kind === 'whisper') {
    el.innerHTML = `
      <div class="rec-live">
        <div class="spinner"></div>
        <span id="job-text">${esc(job.text)}</span>
        <div class="grow"></div>
        <button class="btn" id="cancel-job">Cancelar</button>
      </div>
      <div class="progress"><div id="job-bar" style="width:${Math.round((job.frac ?? 0) * 100)}%"></div></div>`;
    $('#cancel-job').onclick = () => job?.cancel?.();
    return;
  }

  const blob = m.hasAudio ? await store.getAudio(m.id) : null;
  if (current !== m || recorder || myJob()?.kind === 'whisper') return; // cambió mientras se leía el audio
  const s = store.settings();
  el.innerHTML = `
    <div class="rec-idle">
      <button class="btn primary" id="rec-mic">${icon('mic')}<span>${blob ? 'Grabar de nuevo' : 'Grabar reunión'}</span></button>
      ${callCaptureSupported ? `<button class="btn" id="rec-call" title="Graba tu micrófono y el audio de la pestaña de Teams, Meet o Zoom">${icon('screen')}<span>Grabar videollamada</span></button>` : ''}
      <label class="btn">${icon('upload')}<span>Subir audio</span><input type="file" accept="audio/*,video/webm,video/mp4" id="upload" hidden></label>
      ${
        blob
          ? `<div class="grow"></div>
             <audio controls preload="metadata" id="player"></audio>
             <button class="btn" id="whisper" title="Transcribe el audio en este ordenador. El audio no se envía a ningún servidor.">${icon('lock')}<span>${m.segments.length ? 'Volver a transcribir' : 'Transcribir'}</span></button>`
          : `<span class="muted small hint">${liveSupported && s.liveTranscript ? 'Al grabar verás la transcripción en directo.' : 'Al terminar, la grabación se transcribe en este ordenador.'}</span>`
      }
    </div>`;
  if (blob) {
    const url = URL.createObjectURL(blob);
    $('#player').src = url;
    $('#whisper').onclick = () => runWhisper(blob);
  }
  $('#rec-mic').onclick = () => startRecording('mic');
  $('#rec-call') && ($('#rec-call').onclick = () => startRecording('call'));
  $('#upload').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    await store.saveAudio(m.id, file);
    m.hasAudio = true;
    await persist();
    renderRecbar();
    if (!m.segments.length) runWhisper(file);
  };
}

async function startRecording(mode) {
  const m = current;
  if (!m.consent) {
    toast('Recuerda informar al cliente de que se graba la reunión y marcar la casilla.', 'warn');
  }
  if (m.segments.length && !confirmInline(mode === 'call' ? $('#rec-call') : $('#rec-mic'), 'Se reemplazará la grabación. ¿Seguir?')) return;
  const s = store.settings();
  const live = s.liveTranscript && mode === 'mic';
  if (mode === 'call') m.kind = 'videollamada';
  recorder = new Recorder({
    mode,
    live,
    onLive: (seg) => {
      m.segments.push(seg);
      m.transcriptSource = 'directo';
      persistSoon();
      if (tab === 'transcripcion') appendLiveSegment(seg);
    },
    onInterim: (t) => {
      interim = t;
      const el = $('#interim');
      if (el) el.textContent = t;
    },
    onLevel: (v) => {
      const el = $('#level');
      if (el) el.style.width = `${Math.min(100, Math.round(v * 160))}%`;
    },
    onTick: (t) => {
      const el = $('#clock');
      if (el) el.textContent = fmtClock(t);
    },
  });
  recorder.onShareEnded = stopRecording;
  try {
    await recorder.start();
  } catch (e) {
    recorder = null;
    toast(e.name === 'NotAllowedError' ? 'No hay permiso para usar el micrófono.' : e.message, 'error');
    return;
  }
  m.segments = [];
  m.summary = null;
  m.tasksDone = {};
  if (!live) m.transcriptSource = '';
  window.addEventListener('beforeunload', warnUnload);
  tab = 'transcripcion';
  showMeeting(m.id);
}

const warnUnload = (e) => {
  e.preventDefault();
  e.returnValue = '';
};

async function stopRecording() {
  if (!recorder) return;
  const r = recorder;
  const res = await r.stop();
  recorder = null;
  interim = '';
  window.removeEventListener('beforeunload', warnUnload);
  const m = current;
  if (!res?.blob.size) {
    toast('La grabación está vacía', 'error');
    return showMeeting(m.id);
  }
  await store.saveAudio(m.id, res.blob);
  m.hasAudio = true;
  m.durationSec = res.duration;
  await persist();
  toast('Grabación guardada');
  if (!m.segments.length) {
    showMeeting(m.id);
    runWhisper(res.blob);
  } else {
    tab = hasKey() ? 'acta' : 'transcripcion';
    showMeeting(m.id);
  }
}

async function runWhisper(blob) {
  if (job) return toast('Espera a que termine la tarea en curso', 'error');
  const m = current;
  const s = store.settings();
  const t = transcribe(blob, s.whisperModel, (text, frac) => {
    if (!job) return;
    job.text = text;
    job.frac = frac;
    const tx = $('#job-text');
    if (tx) tx.textContent = text;
    const bar = $('#job-bar');
    if (bar && frac != null) bar.style.width = `${Math.round(frac * 100)}%`;
  });
  job = { id: m.id, kind: 'whisper', text: 'Preparando…', frac: 0, cancel: t.cancel };
  renderRecbar();
  try {
    const segments = await t.promise;
    if (!segments.length) throw new Error('No se ha reconocido voz en el audio.');
    m.segments = segments;
    m.transcriptSource = 'whisper';
    if (!m.durationSec) m.durationSec = segments.at(-1).t + 5;
    await persist();
    toast('Transcripción terminada');
    tab = 'transcripcion';
  } catch (e) {
    if (e.message !== 'Cancelado') toast(e.message, 'error');
  } finally {
    job = null;
    if (current === m) showMeeting(m.id);
  }
}

// ---------- pestañas ----------
function renderTab() {
  const body = $('#tab-body');
  if (!body) return;
  if (tab === 'acta') return renderActa(body);
  if (tab === 'transcripcion') return renderTranscript(body);
  return renderAsk(body);
}

function segHtml(s, i) {
  return `<p class="seg" data-i="${i}">${s.t != null ? `<button class="ts" data-t="${s.t}">${fmtClock(s.t)}</button>` : ''}${s.who ? `<strong class="who who-${s.who === 'Cliente' ? 'c' : s.who === 'Asesor' ? 'a' : 'o'}">${esc(s.who)}</strong>` : ''}<span>${esc(s.text)}</span></p>`;
}

function appendLiveSegment(seg) {
  const list = $('#segs');
  if (!list) return;
  $('.empty', list)?.remove();
  list.insertAdjacentHTML('beforeend', segHtml(seg, current.segments.length - 1));
  list.scrollTop = list.scrollHeight;
}

function renderTranscript(body) {
  const m = current;
  const busy = !!job;
  body.innerHTML = `
    ${
      m.segments.length && !recorder
        ? `<div class="tab-actions">
            <span class="muted small">${m.transcriptSource === 'whisper' ? 'Transcrita en este ordenador (Whisper)' : m.transcriptSource === 'directo' ? 'Transcrita en directo por el navegador' : ''}</span>
            <div class="grow"></div>
            <button class="btn small" id="speakers" ${busy ? 'disabled' : ''} title="Claude atribuye cada intervención al asesor o al cliente">Separar interlocutores</button>
            <button class="btn small" id="copy-tr">${icon('copy')}<span>Copiar</span></button>
          </div>`
        : ''
    }
    ${myJob()?.kind === 'speakers' ? `<div class="working"><div class="spinner"></div>${esc(myJob().text)}</div>` : ''}
    <div class="segs" id="segs">
      ${
        m.segments.length
          ? m.segments.map(segHtml).join('')
          : `<div class="empty">${recorder ? (recorder.live ? 'Escuchando… la transcripción aparecerá aquí.' : 'Grabando. Al terminar se transcribirá el audio en este ordenador.') : 'Sin transcripción todavía. Graba la reunión o sube un audio.'}</div>`
      }
    </div>
    ${recorder?.live ? `<p class="interim" id="interim">${esc(interim)}</p>` : ''}
    ${
      !recorder
        ? `<details class="paste"><summary>¿Ya tienes la transcripción? Pégala aquí</summary>
            <textarea id="paste-text" placeholder="Pega el texto de Teams, Zoom, Meet u otra aplicación"></textarea>
            <button class="btn small" id="paste-save">Usar este texto</button></details>`
        : ''
    }`;

  const segs = $('#segs');
  if (recorder) segs.scrollTop = segs.scrollHeight;
  segs.onclick = async (e) => {
    const ts = e.target.closest('.ts');
    if (!ts) return;
    const player = $('#player');
    if (player) {
      player.currentTime = Number(ts.dataset.t);
      player.play();
    }
  };
  $('#copy-tr') && ($('#copy-tr').onclick = () => copy(m.segments.map((s) => `${s.t != null ? `[${fmtClock(s.t)}] ` : ''}${s.who ? `${s.who}: ` : ''}${s.text}`).join('\n')));
  $('#speakers') && ($('#speakers').onclick = () => runClaude('speakers', 'Claude está separando las intervenciones…', async () => {
    m.segments = await separateSpeakers(m);
    toast('Interlocutores separados');
  }));
  $('#paste-save') &&
    ($('#paste-save').onclick = async () => {
      const text = $('#paste-text').value.trim();
      if (!text) return;
      m.segments = text.split(/\n+/).map((l) => l.trim()).filter(Boolean).map((l) => ({ t: null, text: l }));
      m.transcriptSource = 'pegada';
      await persist();
      renderTab();
    });
}

async function runClaude(kind, text, fn) {
  if (!hasKey()) {
    toast('Añade tu clave de Anthropic en Ajustes', 'error');
    return;
  }
  if (job) return toast('Espera a que termine la tarea en curso', 'error');
  const m = current;
  job = { id: m.id, kind, text };
  renderTab();
  try {
    await persist();
    await fn();
    await persist();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    job = null;
    if (current === m) showMeeting(m.id);
  }
}

function renderActa(body) {
  const m = current;
  const s = m.summary;
  if (myJob()?.kind === 'summary') {
    body.innerHTML = `<div class="working big"><div class="spinner"></div><div><strong>Claude está redactando el acta…</strong><br><span class="muted">Suele tardar entre 20 segundos y 2 minutos según la duración.</span></div></div>`;
    return;
  }
  if (!s) {
    const can = m.segments.length || m.notes.trim();
    body.innerHTML = `
      <div class="empty">
        <p>${recorder ? 'Cuando termines la reunión, genera el acta desde aquí.' : can ? 'Claude preparará el acta con tus notas y la transcripción: resumen, datos del expediente, plazos, tareas, documentación que pedir y un email para el cliente.' : 'Graba o sube la reunión, o escribe tus notas, para poder generar el acta.'}</p>
        <button class="btn primary" id="gen" ${can && !recorder && !job ? '' : 'disabled'}>${icon('spark')}<span>Generar acta con Claude</span></button>
        ${!hasKey() ? '<p class="muted small">Necesitas tu clave de API en <a href="#/ajustes">Ajustes</a>.</p>' : ''}
      </div>`;
    $('#gen').onclick = generate;
    return;
  }

  const list = (title, items, fn = (x) => esc(x), cls = '') => (items?.length ? `<div class="acta-sec ${cls}"><h3>${title}</h3><ul>${items.map((x) => `<li>${fn(x)}</li>`).join('')}</ul></div>` : '');
  body.innerHTML = `
    <div class="tab-actions">
      <span class="muted small">Revisa el acta: es un borrador generado por IA.</span>
      <div class="grow"></div>
      <button class="btn small" id="regen" ${recorder || job ? 'disabled' : ''}>${icon('spark')}<span>Regenerar</span></button>
    </div>
    <article class="acta">
      <h2 class="acta-title">${esc(s.titulo)}</h2>
      <p class="lead">${esc(s.resumen).replace(/\n+/g, '</p><p class="lead">')}</p>
      ${s.plazos.length ? `<div class="acta-sec alerts"><h3>Plazos</h3><ul>${s.plazos.map((p) => `<li><span class="badge ${p.urgencia === 'alta' ? 'red' : p.urgencia === 'media' ? 'amber' : 'grey'}">${esc(p.urgencia)}</span> ${esc(p.descripcion)} — <strong>${esc(p.fecha)}</strong></li>`).join('')}</ul></div>` : ''}
      ${
        s.tareas.length
          ? `<div class="acta-sec"><h3>Tareas</h3><ul class="tasks">${s.tareas
              .map(
                (t, i) => `<li><label><input type="checkbox" data-task="${i}" ${m.tasksDone?.[t.tarea] ? 'checked' : ''}> <span>${esc(t.tarea)}</span></label> <span class="badge ${t.responsable === 'Cliente' ? 'amber' : t.responsable === 'Despacho' ? 'blue' : 'grey'}">${esc(t.responsable)}</span>${t.fecha ? ` <span class="muted small">${esc(t.fecha)}</span>` : ''}</li>`,
              )
              .join('')}</ul></div>`
          : ''
      }
      ${list('Puntos clave', s.puntos_clave)}
      ${s.datos_relevantes.length ? `<div class="acta-sec"><h3>Datos relevantes</h3><table class="kv">${s.datos_relevantes.map((d) => `<tr><th>${esc(d.dato)}</th><td>${esc(d.valor)}</td></tr>`).join('')}</table></div>` : ''}
      ${list('Cuestiones jurídicas', s.cuestiones_juridicas, (x) => `<strong>${esc(x.cuestion)}.</strong> ${esc(x.comentario)}`)}
      ${list('Documentación a pedir al cliente', s.documentacion_pedir)}
      ${list('Decisiones', s.decisiones)}
      ${list('Dudas pendientes', s.dudas_pendientes)}
      ${s.notas_mejoradas ? `<div class="acta-sec"><h3>Notas completadas <button class="btn small ghost" id="use-notes" title="Sustituye tus notas por esta versión">Usar como mis notas</button></h3><div class="md">${mdToHtml(s.notas_mejoradas)}</div></div>` : ''}
      ${
        s.email_cliente?.cuerpo
          ? `<div class="acta-sec email"><h3>Email para el cliente</h3>
              <input id="mail-subj" value="${esc(s.email_cliente.asunto)}">
              <textarea id="mail-body">${esc(s.email_cliente.cuerpo)}</textarea>
              <div class="row"><button class="btn small" id="mail-copy">${icon('copy')}<span>Copiar</span></button><a class="btn small" id="mail-open" href="${esc(mailtoHref(m))}">${icon('mail')}<span>Abrir en el correo</span></a></div>
            </div>`
          : ''
      }
    </article>`;

  $('#regen').onclick = () => {
    if (confirmInline($('#regen'), 'Se perderán los cambios. ¿Regenerar?')) generate();
  };
  $$('[data-task]').forEach(
    (cb) =>
      (cb.onchange = () => {
        m.tasksDone = { ...m.tasksDone, [s.tareas[cb.dataset.task].tarea]: cb.checked };
        persistSoon();
      }),
  );
  $('#use-notes') &&
    ($('#use-notes').onclick = () => {
      if (!confirmInline($('#use-notes'), '¿Sustituir tus notas?')) return;
      m.notes = s.notas_mejoradas;
      $('#notes').value = m.notes;
      persistSoon();
      toast('Notas actualizadas');
    });
  if ($('#mail-body')) {
    const sync = () => {
      s.email_cliente = { asunto: $('#mail-subj').value, cuerpo: $('#mail-body').value };
      $('#mail-open').href = mailtoHref(m);
      persistSoon();
    };
    $('#mail-subj').oninput = sync;
    $('#mail-body').oninput = sync;
    $('#mail-copy').onclick = () => copy(`${s.email_cliente.asunto}\n\n${s.email_cliente.cuerpo}`);
  }
}

function generate() {
  const m = current;
  tab = 'acta';
  runClaude('summary', 'Redactando el acta…', async () => {
    m.summary = await generateSummary(m);
    m.tasksDone = {};
    if (!m.title.trim()) m.title = m.summary.titulo;
    toast('Acta generada');
  });
}

function renderAsk(body) {
  const m = current;
  const can = m.segments.length || m.notes.trim();
  body.innerHTML = `
    <div class="chat" id="chat">
      ${
        m.chat.length
          ? m.chat.map((x) => `<div class="msg ${x.role}">${x.role === 'assistant' ? mdToHtml(x.text) : esc(x.text)}</div>`).join('')
          : `<div class="empty small">Pregunta lo que quieras sobre esta reunión.<div class="chips">${['¿Qué fechas se mencionaron?', '¿Qué importes salieron?', '¿Qué me pidió el cliente exactamente?', '¿Qué quedó sin aclarar?'].map((q) => `<button class="chip">${q}</button>`).join('')}</div></div>`
      }
      ${myJob()?.kind === 'ask' ? '<div class="msg assistant"><div class="spinner"></div></div>' : ''}
    </div>
    <form class="ask" id="ask">
      <input id="ask-input" placeholder="${can ? 'Escribe tu pregunta…' : 'Primero graba o transcribe la reunión'}" ${can && !job ? '' : 'disabled'} autocomplete="off">
      <button class="btn primary" ${can && !job ? '' : 'disabled'}>Preguntar</button>
      ${m.chat.length ? '<button type="button" class="btn ghost small" id="clear-chat">Borrar</button>' : ''}
    </form>`;
  const chat = $('#chat');
  chat.scrollTop = chat.scrollHeight;
  const ask = (q) => {
    q = q.trim();
    if (!q) return;
    if (!hasKey()) return toast('Añade tu clave de Anthropic en Ajustes', 'error');
    m.chat = [...m.chat, { role: 'user', text: q }];
    runClaude('ask', 'Pensando…', async () => {
      try {
        const answer = await askMeeting(m, m.chat);
        m.chat = [...m.chat, { role: 'assistant', text: answer }];
      } catch (e) {
        m.chat = m.chat.slice(0, -1);
        throw e;
      }
    });
  };
  $('#ask').onsubmit = (e) => {
    e.preventDefault();
    ask($('#ask-input').value);
  };
  $$('.chip', chat).forEach((c) => (c.onclick = () => can && !job && ask(c.textContent)));
  $('#clear-chat') &&
    ($('#clear-chat').onclick = () => {
      m.chat = [];
      persistSoon();
      renderTab();
    });
  if (can && !job) $('#ask-input').focus();
}

// ---------- ajustes ----------
function showSettings() {
  const s = store.settings();
  view.innerHTML = `
    <div class="page narrow">
      <div class="toolbar"><h1>Ajustes</h1></div>
      <section class="panel">
        <h2>Claude</h2>
        <div class="form">
          <label>Clave de API de Anthropic
            <input type="password" id="apiKey" value="${esc(s.apiKey)}" placeholder="sk-ant-…" autocomplete="off">
            <small>Se guarda solo en este navegador. Consíguela en <a href="https://platform.claude.com/settings/keys" target="_blank" rel="noopener">platform.claude.com</a>. Pagas solo lo que uses: un acta de una reunión de 1 hora cuesta unos céntimos.</small>
          </label>
          <label>Modelo
            <select id="model">${MODELS.map((x) => `<option value="${x.id}" ${s.model === x.id ? 'selected' : ''}>${x.name}</option>`).join('')}</select>
          </label>
        </div>
      </section>
      <section class="panel">
        <h2>Transcripción</h2>
        <div class="form">
          <label>Modelo de transcripción local
            <select id="whisperModel">${WHISPER_MODELS.map((x) => `<option value="${x.id}" ${s.whisperModel === x.id ? 'selected' : ''}>${x.name}</option>`).join('')}</select>
            <small>Se descarga una sola vez. La transcripción se hace en este ordenador: el audio no sale de él.</small>
          </label>
          <label class="check"><input type="checkbox" id="liveTranscript" ${s.liveTranscript ? 'checked' : ''} ${liveSupported ? '' : 'disabled'}> Transcripción en directo al grabar con el micrófono
            <small>${liveSupported ? 'Usa el reconocimiento de voz del navegador, que envía el audio a los servidores de Google o Microsoft. Desactívalo si prefieres que todo se procese en local; al terminar se transcribirá con el modelo local.' : 'Este navegador no la permite. Usa Chrome o Edge.'}</small>
          </label>
        </div>
      </section>
      <section class="panel">
        <h2>Despacho</h2>
        <div class="form">
          <label>Nombre del despacho <input id="office" value="${esc(s.office)}" placeholder="Ej.: Asesoría Laboral Pérez"></label>
          <label>Firma para los emails <textarea id="signature" rows="3" placeholder="Nombre y apellidos&#10;Graduado Social colegiado nº …&#10;Teléfono">${esc(s.signature)}</textarea></label>
        </div>
      </section>
      <section class="panel">
        <h2>Datos</h2>
        <div class="form">
          <p class="muted small">Las reuniones y el audio se guardan solo en este navegador. Haz copias de seguridad de vez en cuando (el archivo no incluye el audio).</p>
          <div class="row">
            <button class="btn" id="backup">Descargar copia de seguridad</button>
            <label class="btn">Restaurar copia<input type="file" id="restore" accept="application/json,.json" hidden></label>
            <div class="grow"></div>
            <button class="btn danger" id="wipe">Borrar todo</button>
          </div>
        </div>
      </section>
      <section class="panel">
        <h2>Protección de datos</h2>
        <div class="form small">
          <p>Antes de grabar, informa al cliente de la grabación y de su finalidad, y recoge su consentimiento o la base jurídica que corresponda (RGPD y LOPDGDD). La casilla "Cliente informado" de cada reunión sirve como recordatorio.</p>
          <p>Para generar el acta, la transcripción y tus notas se envían a la API de Anthropic. Según sus condiciones comerciales, no se usan para entrenar modelos. Valora incluirla como encargado del tratamiento en tu registro de actividades.</p>
        </div>
      </section>
    </div>`;

  for (const key of ['apiKey', 'model', 'whisperModel', 'office', 'signature']) {
    $(`#${key}`).addEventListener('change', (e) => {
      store.saveSettings({ [key]: e.target.value.trim() });
      toast('Guardado');
    });
  }
  $('#liveTranscript').onchange = (e) => store.saveSettings({ liveTranscript: e.target.checked });
  $('#backup').onclick = async () => {
    const data = await store.exportAll();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
    a.download = `actas-copia-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  };
  $('#restore').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const n = await store.importAll(JSON.parse(await file.text()));
      toast(`${n} reuniones restauradas`);
    } catch (err) {
      toast(err.message || 'Archivo no válido', 'error');
    }
  };
  $('#wipe').onclick = async () => {
    if (!confirmInline($('#wipe'), 'Pulsa otra vez para borrarlo todo')) return;
    await store.wipeAll();
    toast('Datos borrados');
  };
}

// ---------- arranque ----------
document.addEventListener('click', () => {
  const menu = $('#export-menu');
  if (menu) menu.hidden = true;
});
window.addEventListener('hashchange', route);
route();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
