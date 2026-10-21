// Conexión con Claude (API de Anthropic): acta, interlocutores y preguntas.
import { settings } from './store.js';

const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.127.0/+esm';

export const MODELS = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5 (máxima calidad)' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5 (equilibrado)' },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5 (rápido y barato)' },
];

export const hasKey = () => !!settings().apiKey;

let sdk = null;
async function client() {
  sdk ??= (await import(SDK_URL)).default;
  return new sdk({ apiKey: settings().apiKey, dangerouslyAllowBrowser: true });
}

function friendly(e) {
  const A = sdk;
  if (!A) return new Error('No se pudo cargar la conexión con Claude. ¿Tienes internet?');
  if (e instanceof A.AuthenticationError) return new Error('La clave de API no es válida. Revísala en Ajustes.');
  if (e instanceof A.PermissionDeniedError) return new Error('Tu clave no tiene permiso para usar este modelo.');
  if (e instanceof A.RateLimitError) return new Error('Demasiadas peticiones seguidas; espera un momento.');
  if (e instanceof A.APIConnectionError) return new Error('Sin conexión con Claude. ¿Tienes internet?');
  if (e instanceof A.APIError) return new Error(`Error de la API (${e.status}): ${e.message}`);
  return e;
}

// Llamada base en streaming (las transcripciones pueden ser largas). Devuelve el mensaje final.
async function call({ system, messages, maxTokens = 32000, effort = 'medium', schema }) {
  if (!hasKey()) throw new Error('Añade tu clave de Anthropic en Ajustes para usar Claude.');
  const c = await client();
  const model = settings().model;
  const output_config = { effort };
  if (schema) output_config.format = { type: 'json_schema', schema };
  const params = { model, max_tokens: maxTokens, system, messages, output_config };
  let resp;
  try {
    // Opus y Sonnet: si la petición se rechaza por seguridad, la API la repite con otro modelo
    resp =
      model === 'claude-haiku-5-5'
        ? await c.messages.stream(params).finalMessage()
        : await c.beta.messages
            .stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
            .finalMessage();
  } catch (e) {
    throw friendly(e);
  }
  if (resp.stop_reason === 'refusal') throw new Error('Claude no ha podido procesar esta petición.');
  if (resp.stop_reason === 'max_tokens') throw new Error('La respuesta salió demasiado larga; prueba con una reunión más corta.');
  return resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

async function callJSON(opts) {
  const text = await call(opts);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('No se pudo leer la respuesta de Claude; inténtalo de nuevo.');
  }
}

// Esquemas: todos los campos obligatorios y sin propiedades extra
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const str = { type: 'string' };
const list = (items) => ({ type: 'array', items });

const fmtTime = (t) => (t == null ? '' : `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`);

export function transcriptText(m, withIndex = false) {
  return m.segments
    .map((s, i) => {
      const pre = [withIndex ? `#${i}` : '', s.t != null ? `[${fmtTime(s.t)}]` : '', s.who ? `${s.who}:` : ''].filter(Boolean).join(' ');
      return pre ? `${pre} ${s.text}` : s.text;
    })
    .join('\n');
}

function meetingContext(m) {
  const s = settings();
  return [
    `Despacho: ${s.office || '(sin indicar)'}`,
    `Fecha de la reunión: ${m.date ? m.date.replace('T', ' ') : '(sin indicar)'}`,
    `Cliente: ${m.client || '(sin indicar)'}`,
    `Asunto: ${m.title || '(sin indicar)'}`,
    `Modalidad: ${m.kind}`,
  ].join('\n');
}

const BASE_SYSTEM = `Eres el asistente de un despacho de graduado social en España (asesoría laboral, Seguridad Social y procedimiento laboral). Trabajas con reuniones entre el profesional del despacho y sus clientes (trabajadores o empresas).

Reglas:
- Usa solo lo que consta en la transcripción y en las notas del profesional. No inventes datos, cifras, fechas ni nombres. Si algo no se dijo o se entendió mal, indícalo como dato pendiente de confirmar.
- La transcripción es automática y puede tener errores de reconocimiento; corrige erratas evidentes por el contexto, pero no cambies cifras dudosas: márcalas "(confirmar)".
- Las notas del profesional tienen prioridad sobre la transcripción cuando se contradicen.
- Cuando menciones normativa (Estatuto de los Trabajadores, LRJS, LGSS, convenio…) cita el artículo solo si estás seguro y añade "(verificar)". Nunca presentes una conclusión jurídica como definitiva.
- Si hay un posible plazo de caducidad o prescripción relevante (por ejemplo, impugnación de un despido o de una sanción), señálalo como alerta y calcula la fecha solo si consta la fecha de inicio; en otro caso indica qué dato falta.
- Convierte fechas relativas ("el lunes pasado", "hace dos semanas") en fechas absolutas a partir de la fecha de la reunión cuando sea posible, indicando que es una estimación.
- Escribe en español de España, con tono profesional y claro.`;

const SUMMARY_SCHEMA = obj({
  titulo: str,
  resumen: str,
  puntos_clave: list(str),
  datos_relevantes: list(obj({ dato: str, valor: str })),
  cuestiones_juridicas: list(obj({ cuestion: str, comentario: str })),
  plazos: list(obj({ descripcion: str, fecha: str, urgencia: { type: 'string', enum: ['alta', 'media', 'baja'] } })),
  tareas: list(obj({ tarea: str, responsable: { type: 'string', enum: ['Despacho', 'Cliente', 'Otro'] }, fecha: str })),
  documentacion_pedir: list(str),
  decisiones: list(str),
  dudas_pendientes: list(str),
  notas_mejoradas: str,
  email_cliente: obj({ asunto: str, cuerpo: str }),
});

export async function generateSummary(m) {
  const s = settings();
  const transcript = transcriptText(m);
  const content = `${meetingContext(m)}

<notas_del_profesional>
${m.notes.trim() || '(sin notas)'}
</notas_del_profesional>

<transcripcion>
${transcript || '(sin transcripción)'}
</transcripcion>

Prepara el acta de esta reunión:
- titulo: título breve y descriptivo (si el asunto ya está indicado, respétalo).
- resumen: 1-2 párrafos con lo esencial.
- puntos_clave: lo más importante en frases cortas.
- datos_relevantes: datos concretos para el expediente (fechas de alta y baja, categoría, salario, jornada, convenio, empresa, antigüedad, importes, números de expediente…). Solo los que consten.
- cuestiones_juridicas: cuestiones laborales o de Seguridad Social que plantea el caso y un comentario prudente.
- plazos: plazos y fechas límite. En "fecha" pon la fecha o el plazo ("antes del 14/11/2026", "20 días hábiles desde la notificación", "pendiente de fecha de notificación").
- tareas: acciones acordadas o necesarias, con responsable y fecha si consta ("" si no).
- documentacion_pedir: documentos que el cliente debe aportar.
- decisiones: lo que se ha decidido en la reunión.
- dudas_pendientes: lo que quedó sin aclarar o hay que confirmar.
- notas_mejoradas: las notas del profesional completadas y ordenadas con la transcripción, en Markdown (encabezados "## " y viñetas "- "). Mantén su estructura y su forma de expresarse; añade lo que falte.
- email_cliente: borrador de email al cliente resumiendo la reunión, los próximos pasos y la documentación que debe enviar, en tono cercano y profesional, sin conclusiones jurídicas definitivas${s.signature ? `, terminando con esta firma:\n${s.signature}` : ''}.
Las listas sin contenido van vacías.`;
  return callJSON({ system: BASE_SYSTEM, messages: [{ role: 'user', content }], schema: SUMMARY_SCHEMA, effort: 'medium' });
}

// Atribuye cada intervención a un interlocutor. Devuelve segmentos nuevos conservando los tiempos.
export async function separateSpeakers(m) {
  const schema = obj({
    intervenciones: list(obj({ desde: { type: 'integer' }, hablante: str, texto: str })),
  });
  const content = `${meetingContext(m)}

<transcripcion>
${transcriptText(m, true)}
</transcripcion>

Esta transcripción automática no distingue quién habla. Reorganízala en intervenciones atribuyendo cada una a un interlocutor: "Asesor" para el profesional del despacho, "Cliente" para el cliente y otro nombre o rol si interviene alguien más (usa su nombre si se menciona). Para cada intervención indica en "desde" el número (#) del primer fragmento en el que empieza. Conserva todo el contenido en el mismo orden: no resumas ni omitas nada; solo corrige puntuación y erratas evidentes.`;
  const r = await callJSON({ system: BASE_SYSTEM, messages: [{ role: 'user', content }], schema, effort: 'low', maxTokens: 64000 });
  return r.intervenciones.map((x) => ({ t: m.segments[x.desde]?.t ?? null, who: x.hablante, text: x.texto }));
}

// Preguntas sobre la reunión. history: [{ role: 'user'|'assistant', text }]
export async function askMeeting(m, history) {
  const system = [
    { type: 'text', text: BASE_SYSTEM + '\n\nResponde a las preguntas del profesional sobre la reunión de forma breve y directa. Si la respuesta no está en la reunión, dilo.' },
    {
      type: 'text',
      text: `${meetingContext(m)}\n\n<notas_del_profesional>\n${m.notes.trim() || '(sin notas)'}\n</notas_del_profesional>\n\n<transcripcion>\n${transcriptText(m) || '(sin transcripción)'}\n</transcripcion>`,
      cache_control: { type: 'ephemeral' },
    },
  ];
  const messages = history.map((x) => ({ role: x.role, content: x.text }));
  return call({ system, messages, effort: 'low', maxTokens: 8000 });
}
