// Datos locales: reuniones y audio en IndexedDB, ajustes en localStorage.
const DB_NAME = 'actas';
const DB_VERSION = 1;

let dbPromise = null;
function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('meetings', { keyPath: 'id' });
      d.createObjectStore('audio');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run(store, mode, fn) {
  const d = await openDb();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error('Operación cancelada'));
  });
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export async function listMeetings() {
  const all = (await run('meetings', 'readonly', (s) => s.getAll())) ?? [];
  return all.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

export const getMeeting = (id) => run('meetings', 'readonly', (s) => s.get(id));

export async function saveMeeting(m) {
  m.updated = Date.now();
  await run('meetings', 'readwrite', (s) => s.put(m));
  return m;
}

export async function deleteMeeting(id) {
  await run('meetings', 'readwrite', (s) => s.delete(id));
  await run('audio', 'readwrite', (s) => s.delete(id));
}

export const getAudio = (id) => run('audio', 'readonly', (s) => s.get(id));
export const saveAudio = (id, blob) => run('audio', 'readwrite', (s) => s.put(blob, id));
export const deleteAudio = (id) => run('audio', 'readwrite', (s) => s.delete(id));

export function newMeeting(extra = {}) {
  const now = new Date();
  now.setSeconds(0, 0);
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  return {
    id: uid(),
    title: '',
    client: '',
    date: local, // fecha y hora local, formato yyyy-mm-ddThh:mm
    kind: 'presencial',
    consent: false,
    durationSec: 0,
    hasAudio: false,
    notes: '',
    segments: [], // [{ t: segundos | null, text, who? }]
    transcriptSource: '',
    summary: null,
    tasksDone: {},
    chat: [],
    created: Date.now(),
    updated: Date.now(),
    ...extra,
  };
}

// Ajustes
const DEFAULTS = {
  apiKey: '',
  model: 'claude-opus-5-5',
  whisperModel: 'onnx-community/whisper-small',
  liveTranscript: true,
  office: '',
  signature: '',
};
const SETTINGS_KEY = 'actas.settings';

export function settings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(patch) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...settings(), ...patch }));
  } catch {
    /* almacenamiento bloqueado: los ajustes duran solo esta sesión */
  }
}

// Copia de seguridad (sin audio)
export async function exportAll() {
  return { app: 'actas', version: 1, exported: new Date().toISOString(), meetings: await listMeetings() };
}

export async function importAll(data) {
  if (data?.app !== 'actas' || !Array.isArray(data.meetings)) throw new Error('El archivo no es una copia de Actas.');
  for (const m of data.meetings) {
    const hasAudio = !!(await getAudio(m.id));
    await run('meetings', 'readwrite', (s) => s.put({ ...m, hasAudio }));
  }
  return data.meetings.length;
}

export async function wipeAll() {
  await run('meetings', 'readwrite', (s) => s.clear());
  await run('audio', 'readwrite', (s) => s.clear());
}
