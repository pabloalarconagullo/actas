// Exportar el acta: Markdown, Word (.doc), impresión/PDF y email.
import { transcriptText } from './ai.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function fmtDate(d) {
  if (!d) return '';
  const x = new Date(d);
  if (isNaN(x)) return d;
  return x.toLocaleString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export const fmtClock = (t) => {
  t = Math.max(0, Math.floor(t || 0));
  const h = Math.floor(t / 3600);
  const mm = String(Math.floor((t % 3600) / 60)).padStart(2, '0');
  const ss = String(t % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

// Markdown mínimo (encabezados, viñetas, negrita) para las notas mejoradas
export function mdToHtml(md) {
  const out = [];
  let inList = false;
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  for (const raw of String(md || '').split('\n')) {
    const line = raw.trimEnd();
    const li = line.match(/^\s*[-*•]\s+(.*)/);
    if (li) {
      if (!inList) out.push('<ul>');
      inList = true;
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    if (inList) out.push('</ul>');
    inList = false;
    const hd = line.match(/^(#{1,4})\s+(.*)/);
    if (hd) out.push(`<h4>${inline(hd[2])}</h4>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (inList) out.push('</ul>');
  return out.join('');
}

export function toMarkdown(m) {
  const s = m.summary;
  const L = [];
  L.push(`# ${s?.titulo || m.title || 'Reunión'}`);
  L.push('');
  L.push(`- **Cliente:** ${m.client || '—'}`);
  L.push(`- **Fecha:** ${fmtDate(m.date)}`);
  L.push(`- **Modalidad:** ${m.kind}${m.durationSec ? ` · ${fmtClock(m.durationSec)}` : ''}`);
  L.push('');
  if (s) {
    const sec = (title, items, fn = (x) => x) => {
      if (!items?.length) return;
      L.push(`## ${title}`, '', ...items.map((x) => `- ${fn(x)}`), '');
    };
    L.push('## Resumen', '', s.resumen, '');
    sec('Puntos clave', s.puntos_clave);
    sec('Datos relevantes', s.datos_relevantes, (x) => `**${x.dato}:** ${x.valor}`);
    sec('Cuestiones jurídicas', s.cuestiones_juridicas, (x) => `**${x.cuestion}.** ${x.comentario}`);
    sec('Plazos', s.plazos, (x) => `${x.urgencia === 'alta' ? '⚠ ' : ''}${x.descripcion} — ${x.fecha}`);
    sec('Tareas', s.tareas, (x) => `[${m.tasksDone?.[x.tarea] ? 'x' : ' '}] ${x.tarea} (${x.responsable}${x.fecha ? `, ${x.fecha}` : ''})`);
    sec('Documentación a pedir', s.documentacion_pedir);
    sec('Decisiones', s.decisiones);
    sec('Dudas pendientes', s.dudas_pendientes);
    if (s.notas_mejoradas) L.push('## Notas', '', s.notas_mejoradas, '');
  } else if (m.notes.trim()) {
    L.push('## Notas', '', m.notes.trim(), '');
  }
  if (m.segments.length) L.push('## Transcripción', '', transcriptText(m), '');
  return L.join('\n');
}

export function actaHtml(m) {
  const s = m.summary;
  const block = (title, items, fn = (x) => esc(x)) =>
    items?.length ? `<h3>${title}</h3><ul>${items.map((x) => `<li>${fn(x)}</li>`).join('')}</ul>` : '';
  return `
    <h1>${esc(s?.titulo || m.title || 'Reunión')}</h1>
    <table class="meta">
      <tr><th>Cliente</th><td>${esc(m.client || '—')}</td></tr>
      <tr><th>Fecha</th><td>${esc(fmtDate(m.date))}</td></tr>
      <tr><th>Modalidad</th><td>${esc(m.kind)}${m.durationSec ? ` · ${fmtClock(m.durationSec)}` : ''}</td></tr>
    </table>
    ${s ? `<h3>Resumen</h3><p>${esc(s.resumen).replace(/\n+/g, '</p><p>')}</p>` : ''}
    ${block('Puntos clave', s?.puntos_clave)}
    ${block('Datos relevantes', s?.datos_relevantes, (x) => `<strong>${esc(x.dato)}:</strong> ${esc(x.valor)}`)}
    ${block('Cuestiones jurídicas', s?.cuestiones_juridicas, (x) => `<strong>${esc(x.cuestion)}.</strong> ${esc(x.comentario)}`)}
    ${block('Plazos', s?.plazos, (x) => `${x.urgencia === 'alta' ? '<strong>URGENTE</strong> · ' : ''}${esc(x.descripcion)} — ${esc(x.fecha)}`)}
    ${block('Tareas', s?.tareas, (x) => `${m.tasksDone?.[x.tarea] ? '☑' : '☐'} ${esc(x.tarea)} <em>(${esc(x.responsable)}${x.fecha ? `, ${esc(x.fecha)}` : ''})</em>`)}
    ${block('Documentación a pedir', s?.documentacion_pedir)}
    ${block('Decisiones', s?.decisiones)}
    ${block('Dudas pendientes', s?.dudas_pendientes)}
    ${s?.notas_mejoradas ? `<h3>Notas</h3>${mdToHtml(s.notas_mejoradas)}` : m.notes.trim() ? `<h3>Notas</h3>${mdToHtml(m.notes)}` : ''}`;
}

const slug = (m) => `${(m.date || '').slice(0, 10)} ${m.client || ''} ${m.summary?.titulo || m.title || 'reunion'}`.trim().replace(/[\\/:*?"<>|]+/g, '').slice(0, 90);

function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export const downloadMarkdown = (m) => download(`${slug(m)}.md`, new Blob([toMarkdown(m)], { type: 'text/markdown;charset=utf-8' }));

export function downloadWord(m) {
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><title>${esc(slug(m))}</title>
    <style>body{font-family:Calibri,Arial,sans-serif;font-size:11pt;line-height:1.4}h1{font-size:16pt;color:#1d4f7a}h3{font-size:12pt;color:#1d4f7a;border-bottom:1px solid #ccc;margin-top:14pt}table.meta th{text-align:left;padding-right:12pt;color:#555}</style></head>
    <body>${actaHtml(m)}</body></html>`;
  download(`${slug(m)}.doc`, new Blob(['﻿', html], { type: 'application/msword' }));
}

export function downloadAudio(m, blob) {
  const ext = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mpeg') ? 'mp3' : blob.type.includes('wav') ? 'wav' : 'webm';
  download(`${slug(m)}.${ext}`, blob);
}

export function mailtoHref(m) {
  const e = m.summary?.email_cliente;
  if (!e) return '';
  return `mailto:?subject=${encodeURIComponent(e.asunto)}&body=${encodeURIComponent(e.cuerpo)}`;
}

export function printActa(m) {
  const el = document.getElementById('print-area');
  el.innerHTML = actaHtml(m);
  window.print();
}
