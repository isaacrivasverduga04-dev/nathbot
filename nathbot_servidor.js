// ╔══════════════════════════════════════════════════════╗
// ║          NATHBOT v4 — Sistema sólido                 ║
// ║  Bodas ✓  Cobros ✓  Metas ✓  Leads ✓  Finanzas ✓   ║
// ╚══════════════════════════════════════════════════════╝
const env = require('dotenv').config().parsed || {};
const getEnv = (k) => process.env[k] || env[k];

const express = require('express');
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');
const twilio = require('twilio');
const https = require('https');
const http = require('http');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const anthropic = new Anthropic({ apiKey: getEnv('ANTHROPIC_API_KEY') });
const SHEETS_ID = getEnv('SHEETS_ID');
const TWILIO_SID = getEnv('TWILIO_ACCOUNT_SID');
const TWILIO_TOKEN = getEnv('TWILIO_AUTH_TOKEN');
const NATH_NUM = getEnv('NATH_WHATSAPP_NUMBER');

// ── Cache de historial en memoria ─────────────────────────────────────────────
const historialCache = {};
const MAX_MENSAJES = 20;

// ── Keep-alive: ping cada 10 min para no dormir en Render free tier ───────────
const SELF_URL = getEnv('RENDER_EXTERNAL_URL') || 'https://nathbot-0gxu.onrender.com';
setInterval(() => {
  const lib = SELF_URL.startsWith('https') ? https : http;
  lib.get(SELF_URL + '/ping', () => {}).on('error', () => {});
}, 10 * 60 * 1000);

// ── Google Sheets ─────────────────────────────────────────────────────────────
async function getSheetsClient() {
  const credsJson = getEnv('GOOGLE_CREDENTIALS');
  const credentials = credsJson ? JSON.parse(credsJson) : require('./google_service_account.json');
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function leerHoja(sheets, hoja, rango = 'A1:Z200') {
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEETS_ID, range: `${hoja}!${rango}` });
    const filas = res.data.values || [];
    if (filas.length < 2) return [];
    const headers = filas[0];
    return filas.slice(1).map(fila => Object.fromEntries(headers.map((h, i) => [h, fila[i] || ''])));
  } catch { return []; }
}

async function leerFilasBrutas(sheets, hoja, rango = 'A1:Z200') {
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEETS_ID, range: `${hoja}!${rango}` });
    return res.data.values || [];
  } catch { return []; }
}

async function agregarFila(sheets, hoja, valores) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEETS_ID, range: `${hoja}!A1`,
    valueInputOption: 'USER_ENTERED', requestBody: { values: [valores] },
  });
}

async function actualizarCelda(sheets, hoja, rango, valor) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEETS_ID, range: `${hoja}!${rango}`,
    valueInputOption: 'USER_ENTERED', requestBody: { values: [[valor]] },
  });
}

// Convierte número serial de Excel/Sheets a fecha legible
function serialAFecha(serial) {
  if (!serial || isNaN(serial)) return serial || '';
  const d = new Date((parseFloat(serial) - 25569) * 86400000);
  return d.toISOString().split('T')[0];
}

// ── Descargar imagen de Twilio como base64 ────────────────────────────────────
function descargarImagenBase64(url) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { Authorization: `Basic ${auth}` } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return descargarImagenBase64(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('base64')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout descargando imagen')); });
  });
}

// ── Transcribir audio con Whisper (OpenAI) ────────────────────────────────────
async function descargarBuffer(url) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { Authorization: `Basic ${auth}` } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return descargarBuffer(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ buffer: Buffer.concat(chunks), contentType: res.headers['content-type'] }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function transcribirAudio(mediaUrl) {
  try {
    const OPENAI_KEY = getEnv('OPENAI_API_KEY');
    if (!OPENAI_KEY) return null;
    const { buffer, contentType } = await descargarBuffer(mediaUrl);
    const ext = contentType?.includes('ogg') ? 'ogg' : contentType?.includes('mp4') ? 'mp4' : 'mp3';
    const FormData = require('form-data');
    const form = new FormData();
    form.append('file', buffer, { filename: `audio.${ext}`, contentType: contentType || 'audio/ogg' });
    form.append('model', 'whisper-1');
    form.append('language', 'es');
    const response = await new Promise((resolve, reject) => {
      const postData = form.getBuffer();
      const options = {
        hostname: 'api.openai.com', path: '/v1/audio/transcriptions', method: 'POST',
        headers: { ...form.getHeaders(), Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Length': postData.length },
      };
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(JSON.parse(data)));
      });
      req.on('error', reject);
      req.write(postData);
      req.end();
    });
    return response.text || null;
  } catch (e) {
    console.log('⚠️ Error transcribiendo audio:', e.message);
    return null;
  }
}

// ── Contexto del negocio desde Sheets ────────────────────────────────────────
async function construirContexto(sheets) {
  const [bodas, tareas, finanzas, meDeben, debo, metas, contenido, leads, proyectos, marketing, proyectosNuevos, canciones] = await Promise.all([
    leerHoja(sheets, 'BODAS'),
    leerHoja(sheets, 'TAREAS DIA', 'A1:G100'),
    leerHoja(sheets, 'FINANZAS', 'A1:E100'),
    leerHoja(sheets, 'ME DEBEN', 'A1:E100'),
    leerHoja(sheets, 'DEBO', 'A1:E100'),
    leerHoja(sheets, 'METAS', 'A1:F50'),
    leerHoja(sheets, 'CONTENIDO', 'A1:H50'),
    leerHoja(sheets, 'LEADS', 'A1:F50'),
    leerHoja(sheets, 'PROYECTOS', 'A1:J50'),
    leerHoja(sheets, 'MARKETING', 'A1:L50'),
    leerHoja(sheets, 'PROYECTOS NUEVOS', 'A1:H30'),
    leerHoja(sheets, 'MÚSICA', 'A10:K15'),
  ]);

  const hoy = new Date().toLocaleDateString('es-BO');

  // Cobros: ME DEBEN + saldos de BODAS no duplicados
  const cobrosDirectos = meDeben.filter(d => d['Estado'] === 'Pendiente').map(c =>
    `- ${c['Quien'] || '?'}: ${c['Monto (BOB)']} BOB — ${c['Concepto'] || ''}`
  );
  const parejasMeDeben = new Set(meDeben.map(d => (d['Quien'] || '').toLowerCase()));
  const saldosTotalesMeDeben = meDeben.filter(d => d['Estado'] === 'Pendiente')
    .reduce((s, d) => s + parseFloat(d['Monto (BOB)'] || 0), 0);
  const saldosTotalesDebo = debo.filter(d => d['Estado'] === 'Pendiente')
    .reduce((s, d) => s + parseFloat(d['Monto (BOB)'] || 0), 0);

  // Calcular ingresos y gastos del mes actual
  const mesActual = new Date().toISOString().slice(0, 7);
  const ingresosMes = finanzas.filter(f => f['Tipo'] === 'Ingreso' && (f['Fecha'] || '').startsWith(mesActual))
    .reduce((s, f) => s + parseFloat(f['Monto (BOB)'] || 0), 0);
  const gastosMes = finanzas.filter(f => f['Tipo'] === 'Gasto' && (f['Fecha'] || '').startsWith(mesActual))
    .reduce((s, f) => s + parseFloat(f['Monto (BOB)'] || 0), 0);

  return `HOY: ${hoy}

BODAS ACTIVAS:
${bodas.filter(b => b['Estado'] && !b['Estado'].match(/completad/i)).map(b => {
  const fecha = serialAFecha(b['Fecha de boda']);
  return `- ${b['Pareja'] || '?'} | ${b['Estado']} | Saldo: ${b['Saldo pendiente'] || 0} BOB | Boda: ${fecha || '?'} | Pendiente: ${b['Entregas pendientes'] || 'nada'}`;
}).join('\n') || 'Ninguna'}

PROYECTOS BODAS (seguimiento):
${proyectos.filter(p => p['Estado'] && !p['Estado'].match(/completad/i)).slice(0, 6).map(p => {
  return `- ${p['Pareja'] || '?'} | ${p['Estado'] || '?'} | Saldo: ${p['Saldo pendiente (BOB)'] || 0} BOB | Boda: ${p['Fecha de boda'] || '?'} | Pendiente: ${p['Entregas pendientes'] || 'nada'}`;
}).join('\n') || 'Ninguno'}

PROYECTOS NUEVOS (pipeline):
${proyectosNuevos.filter(p => p['Estado'] && !p['Estado'].match(/completad/i)).slice(0, 5).map(p =>
  `- ${p['Proyecto'] || '?'} | ${p['Estado']} | ${p['Fecha objetivo'] || '?'}`
).join('\n') || 'Ninguno'}

MARKETING — CAMPAÑAS ACTIVAS:
${marketing.filter(m => m['Estado'] === 'Activa').map(m =>
  `- ${m['Campaña']} | Plataforma: ${m['Plataforma']} | Presupuesto: ${m['Presupuesto (BOB)']} BOB | Gastado: ${m['Gastado (BOB)']} BOB | Leads: ${m['Leads']} | Conv: ${m['Conversiones']}`
).join('\n') || 'Ninguna activa'}

TAREAS PENDIENTES HOY:
${tareas.filter(t => t['Completada'] !== 'Sí').slice(0, 12).map(t =>
  `- [${t['Prioridad'] || 'Normal'}] ${t['Tarea'] || '?'} | ${t['Categoria'] || ''}`
).join('\n') || 'Ninguna'}

COBROS QUE ME DEBEN (total: ${saldosTotalesMeDeben} BOB):
${cobrosDirectos.join('\n') || 'Ninguno registrado'}

LO QUE DEBO (total: ${saldosTotalesDebo} BOB):
${debo.filter(d => d['Estado'] === 'Pendiente').map(d =>
  `- A ${d['Quien'] || '?'}: ${d['Monto (BOB)']} BOB — ${d['Concepto'] || ''}`
).join('\n') || 'Nada'}

FINANZAS MES ACTUAL:
- Ingresos: ${ingresosMes} BOB
- Gastos: ${gastosMes} BOB
- Balance: ${ingresosMes - gastosMes} BOB

LEADS NUEVOS:
${leads.filter(l => l['Estado'] === 'Nuevo').map(l =>
  `- ${l['Nombre']}: ${l['Tipo de consulta']} via ${l['Fuente']}`
).join('\n') || 'Ninguno nuevo'}

CONTENIDO EN PROCESO:
${contenido.filter(c => c['Estado'] && c['Estado'] !== 'Publicado').slice(0, 5).map(c =>
  `- ${c['Nombre / Hook'] || '?'} | ${c['Estado']} | ${c['Fecha publicacion'] || 'sin fecha'}`
).join('\n') || 'Ninguno'}

METAS ACTIVAS:
${metas.filter(m => m['Estado'] === 'En proceso').slice(0, 5).map(m =>
  `- ${m['Meta']}: ${m['Progreso (%)'] || 0}% | Fecha: ${m['Fecha limite'] || '?'}`
).join('\n') || 'Ninguna'}

ECO INTERNO (banda musical de Nath — reuniones Lunes y Viernes 5pm):
${canciones.filter(c => c['Cancion'] && c['Cancion'] !== 'Cancion').map(c =>
  `- ${c['Cancion']} | ${c['Estado']} | Maqueta: ${c['Maqueta lista'] || 'No'} | Bloqueada: ${c['Bloqueada?'] || 'No'} | ${c['Notas'] || ''}`
).join('\n') || 'Sin canciones cargadas aun'}

SEGUIMIENTO REELS (producción de contenido):
${reels.slice(0, 12).map(r =>
  `- Reel ${r['Reel'] || '?'}: ${r['Tema'] || '?'} | Grabé: ${r['Grabé'] || '⬜'} | Publicado: ${r['Publicado'] || '⬜'}`
).join('\n') || 'Sin datos'}

DE CERO A MARCA — WORKSHOP:
${workshop.filter(w => w['SECCIÓN'] && w['DETALLE']).slice(0, 10).map(w =>
  `- ${w['SECCIÓN']}: ${w['DETALLE']}`
).join('\n') || 'Sin datos'}`.trim();
}

// ── Historial persistente desde Sheets ───────────────────────────────────────
async function cargarHistorialDesdeSheets(sheets, from) {
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEETS_ID, range: 'HISTORIAL!A1:D500' });
    const filas = res.data.values || [];
    if (filas.length < 2) return [];
    return filas.slice(1)
      .filter(f => f[1] === from && f[2] && f[3])
      .slice(-MAX_MENSAJES)
      .map(f => ({ role: f[2], content: f[3] }))
      .filter(m => m.role === 'user' || m.role === 'assistant');
  } catch (e) {
    console.log('⚠️ Error cargando historial:', e.message);
    return [];
  }
}

async function obtenerHistorial(sheets, from) {
  if (!historialCache[from]) {
    historialCache[from] = await cargarHistorialDesdeSheets(sheets, from);
    console.log(`📚 Historial: ${historialCache[from].length} msgs`);
  }
  return historialCache[from];
}

function agregarAlHistorial(from, role, content) {
  if (!historialCache[from]) historialCache[from] = [];
  historialCache[from].push({ role, content: String(content) });
  if (historialCache[from].length > MAX_MENSAJES) {
    historialCache[from] = historialCache[from].slice(-MAX_MENSAJES);
  }
}

async function guardarHistorial(sheets, from, role, content) {
  try {
    await agregarFila(sheets, 'HISTORIAL', [new Date().toISOString(), from, role, String(content).slice(0, 800)]);
  } catch (e) { console.log('⚠️ Historial no guardado:', e.message); }
}

// ── Herramientas de Claude ────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'agregar_tarea',
    description: 'Agrega una tarea a TAREAS DIA',
    input_schema: { type: 'object', properties: {
      tarea: { type: 'string' },
      prioridad: { type: 'string', enum: ['Urgente', 'Alta', 'Media', 'Baja'] },
      categoria: { type: 'string' },
      notas: { type: 'string' },
    }, required: ['tarea'] },
  },
  {
    name: 'registrar_finanza',
    description: 'Registra ingreso o gasto en FINANZAS',
    input_schema: { type: 'object', properties: {
      descripcion: { type: 'string' },
      tipo: { type: 'string', enum: ['Ingreso', 'Gasto'] },
      monto: { type: 'number' },
      categoria: { type: 'string' },
    }, required: ['descripcion', 'tipo', 'monto'] },
  },
  {
    name: 'agregar_lead',
    description: 'Registra un nuevo lead o consulta en LEADS',
    input_schema: { type: 'object', properties: {
      nombre: { type: 'string' },
      tipo_consulta: { type: 'string' },
      fuente: { type: 'string' },
      notas: { type: 'string' },
    }, required: ['nombre', 'tipo_consulta'] },
  },
  {
    name: 'registrar_cobro',
    description: 'Registra cobro pendiente en ME DEBEN (alguien le debe a Nath)',
    input_schema: { type: 'object', properties: {
      quien: { type: 'string' },
      monto: { type: 'number' },
      concepto: { type: 'string' },
      fecha_limite: { type: 'string' },
    }, required: ['quien', 'monto', 'concepto'] },
  },
  {
    name: 'registrar_deuda',
    description: 'Registra una deuda de Nath en DEBO (lo que Nath debe a otros)',
    input_schema: { type: 'object', properties: {
      quien: { type: 'string' },
      monto: { type: 'number' },
      concepto: { type: 'string' },
      fecha_limite: { type: 'string' },
    }, required: ['quien', 'monto', 'concepto'] },
  },
  {
    name: 'marcar_tarea_completada',
    description: 'Marca una tarea como completada en TAREAS DIA',
    input_schema: { type: 'object', properties: {
      tarea: { type: 'string', description: 'Nombre o parte del nombre de la tarea' },
    }, required: ['tarea'] },
  },
  {
    name: 'actualizar_boda',
    description: 'Actualiza estado, saldo o notas de una boda existente en BODAS',
    input_schema: { type: 'object', properties: {
      pareja: { type: 'string', description: 'Nombre de la pareja' },
      estado: { type: 'string', description: 'Nuevo estado (ej: CONFIRMADA, En entrega, Completada)' },
      saldo_pendiente: { type: 'number', description: 'Nuevo saldo pendiente en BOB' },
      nota: { type: 'string', description: 'Nota para agregar' },
    }, required: ['pareja'] },
  },
  {
    name: 'registrar_pago_boda',
    description: 'Cuando un cliente paga su boda: actualiza saldo en BODAS, marca cobro pagado en ME DEBEN y registra ingreso en FINANZAS',
    input_schema: { type: 'object', properties: {
      pareja: { type: 'string' },
      monto_pagado: { type: 'number' },
    }, required: ['pareja', 'monto_pagado'] },
  },
  {
    name: 'agregar_meta',
    description: 'Agrega o actualiza una meta en METAS',
    input_schema: { type: 'object', properties: {
      meta: { type: 'string' },
      categoria: { type: 'string' },
      fecha_limite: { type: 'string' },
      progreso: { type: 'number' },
      notas: { type: 'string' },
    }, required: ['meta'] },
  },
  {
    name: 'actualizar_marketing',
    description: 'Actualiza métricas de una campaña de marketing (leads, gastado, conversiones)',
    input_schema: { type: 'object', properties: {
      campana: { type: 'string', description: 'Nombre o parte del nombre de la campaña' },
      leads: { type: 'number' },
      gastado: { type: 'number' },
      conversiones: { type: 'number' },
      estado: { type: 'string' },
      notas: { type: 'string' },
    }, required: ['campana'] },
  },
  {
    name: 'actualizar_cancion',
    description: 'Actualiza el estado o notas de una cancion de ECO INTERNO en la tab MUSICA',
    input_schema: { type: 'object', properties: {
      cancion: { type: 'string', description: 'Nombre de la cancion' },
      estado: { type: 'string', description: 'Nuevo estado (ej: Maqueta completa, En produccion, Lista, Lanzada)' },
      bloqueada: { type: 'string', description: 'Si/No' },
      motivo_bloqueo: { type: 'string' },
      notas: { type: 'string' },
    }, required: ['cancion'] },
  },
  {
    name: 'registrar_reunion_banda',
    description: 'Registra el resultado de una reunion de ECO INTERNO (lunes o viernes 5pm)',
    input_schema: { type: 'object', properties: {
      fecha: { type: 'string' },
      avances: { type: 'string' },
      bloqueados: { type: 'string' },
      proximos_pasos: { type: 'string' },
      asistentes: { type: 'string' },
    }, required: ['avances'] },
  },
  {
    name: 'agregar_proyecto_nuevo',
    description: 'Agrega un proyecto nuevo al pipeline en PROYECTOS NUEVOS',
    input_schema: { type: 'object', properties: {
      proyecto: { type: 'string' },
      tipo: { type: 'string' },
      cliente: { type: 'string' },
      valor_estimado: { type: 'number' },
      fecha_objetivo: { type: 'string' },
      notas: { type: 'string' },
    }, required: ['proyecto'] },
  },
];

async function ejecutarHerramienta(sheets, name, input) {
  const hoy = new Date().toISOString().split('T')[0];
  console.log(`🔧 ${name}:`, JSON.stringify(input));
  try {
    switch (name) {

      case 'agregar_tarea':
        // Columnas TAREAS DIA: Fecha, Auto generada, Notas, Categoria, Completada, Prioridad, Tarea
        await agregarFila(sheets, 'TAREAS DIA', [hoy, 'No', input.notas || '', input.categoria || '', 'No', input.prioridad || 'Media', input.tarea]);
        return `✅ Tarea agregada: "${input.tarea}"`;

      case 'registrar_finanza':
        // Columnas FINANZAS: Descripcion, Tipo, Categoria, Fecha, Monto (BOB)
        await agregarFila(sheets, 'FINANZAS', [input.descripcion, input.tipo, input.categoria || 'General', hoy, input.monto]);
        return `✅ ${input.tipo} de ${input.monto} BOB registrado`;

      case 'agregar_lead':
        // Columnas LEADS: Nombre, Tipo de consulta, Fuente, Fecha, Estado, Notas
        await agregarFila(sheets, 'LEADS', [input.nombre, input.tipo_consulta, input.fuente || 'WhatsApp', hoy, 'Nuevo', input.notas || '']);
        return `✅ Lead: ${input.nombre}`;

      case 'registrar_cobro':
        // Columnas ME DEBEN: Quien, Monto (BOB), Concepto, Fecha limite, Estado
        await agregarFila(sheets, 'ME DEBEN', [input.quien, input.monto, input.concepto, input.fecha_limite || '', 'Pendiente']);
        return `✅ Cobro registrado: ${input.quien} → ${input.monto} BOB`;

      case 'registrar_deuda':
        // Columnas DEBO: Quien, Monto (BOB), Concepto, Fecha limite, Estado
        await agregarFila(sheets, 'DEBO', [input.quien, input.monto, input.concepto, input.fecha_limite || '', 'Pendiente']);
        return `✅ Deuda registrada: le debo a ${input.quien} → ${input.monto} BOB`;

      case 'marcar_tarea_completada': {
        // Columnas TAREAS DIA: Fecha(A), Auto generada(B), Notas(C), Categoria(D), Completada(E), Prioridad(F), Tarea(G)
        const filas = await leerFilasBrutas(sheets, 'TAREAS DIA', 'A1:G150');
        for (let i = 1; i < filas.length; i++) {
          const nombreTarea = filas[i][6] || ''; // columna G = Tarea
          const completada = filas[i][4] || '';  // columna E = Completada
          if (nombreTarea.toLowerCase().includes(input.tarea.toLowerCase()) && completada !== 'Sí') {
            await actualizarCelda(sheets, 'TAREAS DIA', `E${i + 1}`, 'Sí');
            return `✅ Completada: "${nombreTarea}"`;
          }
        }
        return `⚠️ No encontré la tarea: "${input.tarea}"`;
      }

      case 'actualizar_boda': {
        // Columnas BODAS: Total contrato(A), Notas(B), Telefono(C), Entregas pendientes(D),
        //                  Contrato firmado(E), Reserva pagada(F), Estado(G), Pre boda/Civil(H),
        //                  Fecha de boda(I), Paquete(J), Saldo pendiente(K), Pareja(L)
        const filas = await leerFilasBrutas(sheets, 'BODAS', 'A1:L100');
        for (let i = 1; i < filas.length; i++) {
          const pareja = filas[i][11] || ''; // columna L = Pareja
          if (pareja.toLowerCase().includes(input.pareja.toLowerCase())) {
            const cambios = [];
            if (input.estado) {
              await actualizarCelda(sheets, 'BODAS', `G${i + 1}`, input.estado);
              cambios.push(`Estado → ${input.estado}`);
            }
            if (input.saldo_pendiente !== undefined) {
              await actualizarCelda(sheets, 'BODAS', `K${i + 1}`, input.saldo_pendiente);
              cambios.push(`Saldo → ${input.saldo_pendiente} BOB`);
            }
            if (input.nota) {
              const notaActual = filas[i][1] || '';
              const nuevaNota = notaActual ? `${notaActual} | [${hoy}] ${input.nota}` : `[${hoy}] ${input.nota}`;
              await actualizarCelda(sheets, 'BODAS', `B${i + 1}`, nuevaNota);
              cambios.push('Nota agregada');
            }
            return cambios.length > 0
              ? `✅ ${pareja} actualizada: ${cambios.join(', ')}`
              : `⚠️ No se especificó qué actualizar en ${pareja}`;
          }
        }
        return `⚠️ No encontré la pareja: "${input.pareja}"`;
      }

      case 'registrar_pago_boda': {
        const filas = await leerFilasBrutas(sheets, 'BODAS', 'A1:L100');
        let nombrePareja = input.pareja;
        for (let i = 1; i < filas.length; i++) {
          const pareja = filas[i][11] || '';
          if (pareja.toLowerCase().includes(input.pareja.toLowerCase())) {
            nombrePareja = pareja;
            const saldoActual = parseFloat(filas[i][10] || 0);
            const nuevoSaldo = Math.max(0, saldoActual - input.monto_pagado);
            await actualizarCelda(sheets, 'BODAS', `K${i + 1}`, nuevoSaldo);
            if (nuevoSaldo === 0) {
              await actualizarCelda(sheets, 'BODAS', `G${i + 1}`, 'Completada');
            }
            break;
          }
        }
        // Marcar cobro como pagado en ME DEBEN
        const filasMD = await leerFilasBrutas(sheets, 'ME DEBEN', 'A1:E100');
        for (let i = 1; i < filasMD.length; i++) {
          if ((filasMD[i][0] || '').toLowerCase().includes(input.pareja.toLowerCase()) && filasMD[i][4] === 'Pendiente') {
            await actualizarCelda(sheets, 'ME DEBEN', `E${i + 1}`, 'Pagado');
            break;
          }
        }
        // Registrar ingreso en FINANZAS
        await agregarFila(sheets, 'FINANZAS', [`Pago boda: ${nombrePareja}`, 'Ingreso', 'Bodas', hoy, input.monto_pagado]);
        return `✅ Pago registrado: ${nombrePareja} pagó ${input.monto_pagado} BOB. Ingreso en FINANZAS, cobro marcado como pagado.`;
      }

      case 'agregar_meta':
        // Columnas METAS: Meta, Estado, Progreso (%), Fecha limite, Categoria, Notas
        await agregarFila(sheets, 'METAS', [
          input.meta, 'En proceso', input.progreso || 0,
          input.fecha_limite || '', input.categoria || '', input.notas || '',
        ]);
        return `✅ Meta agregada: "${input.meta}"`;

      case 'actualizar_cancion': {
        // Canciones en MÚSICA filas 10-15 (headers en fila 10: Cancion, Estado, Maqueta lista, Con productor, Fecha lanzamiento, CTA ManyChat, Pre-saves, Streams, Bloqueada?, Motivo bloqueo, Notas)
        const filas = await leerFilasBrutas(sheets, 'MÚSICA', 'A10:K20');
        const headers = filas[0] || [];
        const estadoCol = headers.indexOf('Estado'); // B
        const bloqCol = headers.indexOf('Bloqueada?'); // I
        const motivoCol = headers.indexOf('Motivo bloqueo'); // J
        const notasCol = headers.indexOf('Notas'); // K
        for (let i = 1; i < filas.length; i++) {
          if ((filas[i][0] || '').toLowerCase().includes(input.cancion.toLowerCase())) {
            const rowNum = 10 + i;
            const cambios = [];
            if (input.estado) { await actualizarCelda(sheets, 'MÚSICA', `B${rowNum}`, input.estado); cambios.push(`Estado: ${input.estado}`); }
            if (input.bloqueada) { await actualizarCelda(sheets, 'MÚSICA', `I${rowNum}`, input.bloqueada); cambios.push(`Bloqueada: ${input.bloqueada}`); }
            if (input.motivo_bloqueo) { await actualizarCelda(sheets, 'MÚSICA', `J${rowNum}`, input.motivo_bloqueo); cambios.push('Motivo actualizado'); }
            if (input.notas) {
              const notaActual = filas[i][notasCol] || '';
              const nuevaNota = notaActual ? `${notaActual} | [${hoy}] ${input.notas}` : input.notas;
              await actualizarCelda(sheets, 'MÚSICA', `K${rowNum}`, nuevaNota); cambios.push('Nota agregada');
            }
            return `✅ Cancion "${filas[i][0]}" actualizada: ${cambios.join(', ')}`;
          }
        }
        return `⚠️ No encontre la cancion: "${input.cancion}"`;
      }

      case 'registrar_reunion_banda': {
        // Reuniones en MÚSICA desde fila 26 aprox: Fecha, Dia, Avances clave, Bloqueados, Proximos pasos, Asistentes
        const fecha = input.fecha || hoy;
        const dia = new Date().toLocaleDateString('es-BO', { weekday: 'long' });
        await agregarFila(sheets, 'MÚSICA', [fecha, dia + ' 5pm', input.avances || '', input.bloqueados || '', input.proximos_pasos || '', input.asistentes || 'Nath']);
        return `✅ Reunion banda registrada: ${fecha}`;
      }

      case 'actualizar_marketing': {
        // Columnas MARKETING: Campaña(A), Plataforma(B), Objetivo(C), Presupuesto(D), Gastado(E), Leads(F), Conversiones(G), CPL(H), Estado(I), Fecha inicio(J), Fecha fin(K), Notas(L)
        const filas = await leerFilasBrutas(sheets, 'MARKETING', 'A1:L50');
        for (let i = 1; i < filas.length; i++) {
          if ((filas[i][0] || '').toLowerCase().includes(input.campana.toLowerCase())) {
            const cambios = [];
            if (input.leads !== undefined) { await actualizarCelda(sheets, 'MARKETING', `F${i+1}`, input.leads); cambios.push(`Leads: ${input.leads}`); }
            if (input.gastado !== undefined) { await actualizarCelda(sheets, 'MARKETING', `E${i+1}`, input.gastado); cambios.push(`Gastado: ${input.gastado} BOB`); }
            if (input.conversiones !== undefined) { await actualizarCelda(sheets, 'MARKETING', `G${i+1}`, input.conversiones); cambios.push(`Conv: ${input.conversiones}`); }
            if (input.estado) { await actualizarCelda(sheets, 'MARKETING', `I${i+1}`, input.estado); cambios.push(`Estado: ${input.estado}`); }
            if (input.notas) { await actualizarCelda(sheets, 'MARKETING', `L${i+1}`, input.notas); cambios.push('Nota actualizada'); }
            return `✅ Campaña "${filas[i][0]}" actualizada: ${cambios.join(', ')}`;
          }
        }
        return `⚠️ No encontré campaña: "${input.campana}"`;
      }

      case 'agregar_proyecto_nuevo':
        // Columnas PROYECTOS NUEVOS: Proyecto, Tipo, Cliente, Estado, Valor estimado, Fecha objetivo, Responsable, Notas
        await agregarFila(sheets, 'PROYECTOS NUEVOS', [
          input.proyecto, input.tipo || '', input.cliente || '', 'En planificacion',
          input.valor_estimado || 0, input.fecha_objetivo || '', 'Nath', input.notas || '',
        ]);
        return `✅ Proyecto nuevo agregado: "${input.proyecto}"`;

      default:
        return `⚠️ Herramienta desconocida: ${name}`;
    }
  } catch (e) {
    return `❌ Error en ${name}: ${e.message}`;
  }
}

// ── Generar tareas automáticas del día ────────────────────────────────────────
async function generarTareasDelDia(sheets) {
  try {
    const hoy = new Date().toISOString().split('T')[0];
    const tareasRaw = await leerFilasBrutas(sheets, 'TAREAS DIA', 'A1:G100');
    // Si ya hay tareas auto-generadas hoy, no duplicar
    // Columnas: Fecha(A=0), Auto generada(B=1), ..., Tarea(G=6)
    const yaGeneradas = tareasRaw.slice(1).some(f => f[0] === hoy && f[1] === 'Sí');
    if (yaGeneradas) return;

    const [bodas, meDeben, contenido] = await Promise.all([
      leerHoja(sheets, 'BODAS'),
      leerHoja(sheets, 'ME DEBEN', 'A1:E100'),
      leerHoja(sheets, 'CONTENIDO', 'A1:H50'),
    ]);

    const nuevas = [];

    bodas.filter(b => b['Estado']?.match(/bloqueada/i)).forEach(b => {
      nuevas.push([hoy, 'Sí', '', 'Administracion', 'No', 'Urgente',
        `URGENTE cobrar ${b['Saldo pendiente'] || ''} BOB — ${b['Pareja'] || '?'}`]);
    });
    bodas.filter(b => b['Estado']?.match(/entrega/i) && !b['Estado']?.match(/bloqueada/i)).forEach(b => {
      nuevas.push([hoy, 'Sí', `Pareja: ${b['Pareja']}`, 'Edicion', 'No', 'Alta',
        `Entregar: ${b['Pareja'] || '?'} — ${b['Entregas pendientes'] || 'ver sheet'}`]);
    });
    meDeben.filter(d => d['Estado'] === 'Pendiente').slice(0, 3).forEach(d => {
      nuevas.push([hoy, 'Sí', d['Concepto'] || '', 'Administracion', 'No', 'Alta',
        `Cobrar a ${d['Quien'] || '?'}: ${d['Monto (BOB)']} BOB`]);
    });
    contenido.filter(c => c['Fecha publicacion'] === hoy && c['Estado'] !== 'Publicado').forEach(c => {
      nuevas.push([hoy, 'Sí', '', 'Marketing', 'No', 'Alta',
        `Publicar hoy: ${c['Nombre / Hook'] || '?'}`]);
    });

    for (const t of nuevas) await agregarFila(sheets, 'TAREAS DIA', t);
    if (nuevas.length > 0) console.log(`📋 ${nuevas.length} tareas auto-generadas`);
  } catch (e) { console.log('⚠️ Error generando tareas:', e.message); }
}

// ── Actualizar pestaña RESUMEN con datos reales ───────────────────────────────
async function actualizarResumen(sheets) {
  try {
    const [bodas, finanzas, meDeben, debo, tareas, metas, leads, reels] = await Promise.all([
      leerHoja(sheets, 'BODAS'),
      leerHoja(sheets, 'FINANZAS', 'A1:E200'),
      leerHoja(sheets, 'ME DEBEN', 'A1:E100'),
      leerHoja(sheets, 'DEBO', 'A1:E100'),
      leerHoja(sheets, 'TAREAS DIA', 'A1:G200'),
      leerHoja(sheets, 'METAS', 'A1:F50'),
      leerHoja(sheets, 'LEADS', 'A1:F100'),
      leerHoja(sheets, 'SEGUIMIENTO REELS'),
    ]);
    const mesActual = new Date().toISOString().slice(0, 7);
    const hoy = new Date().toISOString().split('T')[0];

    const ingresos = finanzas.filter(f => f['Tipo'] === 'Ingreso' && (f['Fecha'] || '').startsWith(mesActual))
      .reduce((s, f) => s + parseFloat(f['Monto (BOB)'] || 0), 0);
    const gastos = finanzas.filter(f => f['Tipo'] === 'Gasto' && (f['Fecha'] || '').startsWith(mesActual))
      .reduce((s, f) => s + parseFloat(f['Monto (BOB)'] || 0), 0);
    const totalMeDeben = meDeben.filter(d => d['Estado'] === 'Pendiente')
      .reduce((s, d) => s + parseFloat(d['Monto (BOB)'] || 0), 0);
    const totalDebo = debo.filter(d => d['Estado'] === 'Pendiente')
      .reduce((s, d) => s + parseFloat(d['Monto (BOB)'] || 0), 0);
    const bodasActivas = bodas.filter(b => b['Estado'] && !b['Estado'].match(/completad|cancelad/i)).length;
    const bodasEntrega = bodas.filter(b => b['Estado'] && b['Estado'].match(/entrega/i)).length;
    const bodasBloqueadas = bodas.filter(b => b['Estado'] && b['Estado'].match(/bloqueada/i)).length;
    const tareasPendientes = tareas.filter(t => t['Completada'] !== 'Sí').length;
    const tareasHoy = tareas.filter(t => t['Completada'] !== 'Sí' && (t['Fecha'] || '') === hoy).length;

    // Total facturado / cobrado / pendiente desde contratos de bodas
    const totalFacturado = bodas
      .filter(b => b['Estado'] && !b['Estado'].match(/cancelad/i))
      .reduce((s, b) => s + parseFloat(b['Total contrato'] || 0), 0);
    const totalSaldoPend = bodas
      .filter(b => b['Estado'] && !b['Estado'].match(/cancelad/i))
      .reduce((s, b) => s + parseFloat(b['Saldo pendiente'] || 0), 0);
    const totalCobrado = totalFacturado - totalSaldoPend;

    // Leads últimos 7 días
    const haceSiete = new Date(); haceSiete.setDate(haceSiete.getDate() - 7);
    const leadsUlt7 = leads.filter(l => new Date(l['Fecha'] || '') >= haceSiete).length;

    // Reels
    const reelsFilas = reels.length > 1 ? reels.slice(1) : [];
    const reelsGrabados = reelsFilas.filter(r => r[2] === '✅').length;
    const reelsPublicados = reelsFilas.filter(r => r[5] === '✅').length;

    const valores = [
      ['🤖 NATHBOT — RESUMEN NR FILMS', new Date().toLocaleString('es-BO')],
      [],
      ['=== 💰 CONTRATOS BODAS ==='],
      ['Total facturado (BOB)', totalFacturado],
      ['Total cobrado (BOB)', totalCobrado],
      ['Saldo pendiente cobro (BOB)', totalSaldoPend],
      [],
      ['=== 📊 FINANZAS MES ' + mesActual + ' ==='],
      ['Ingresos registrados (BOB)', ingresos],
      ['Gastos registrados (BOB)', gastos],
      ['Balance (BOB)', ingresos - gastos],
      [],
      ['=== 💸 COBROS Y DEUDAS ==='],
      ['Me deben pendiente (BOB)', totalMeDeben],
      ['Yo debo pendiente (BOB)', totalDebo],
      ['Balance cobros/deudas (BOB)', totalMeDeben - totalDebo],
      [],
      ['=== 📸 BODAS ==='],
      ['Bodas activas', bodasActivas],
      ['En proceso de entrega', bodasEntrega],
      ['Entrega bloqueada (cobro pendiente)', bodasBloqueadas],
      [],
      ['=== ✅ TAREAS ==='],
      ['Tareas pendientes totales', tareasPendientes],
      ['Tareas con fecha hoy', tareasHoy],
      [],
      ['=== 🎯 LEADS ==='],
      ['Leads últimos 7 días', leadsUlt7],
      [],
      ['=== 📹 REELS ==='],
      ['Reels grabados', reelsGrabados],
      ['Reels publicados', reelsPublicados],
      [],
      ['=== 🎓 DE CERO A MARCA ==='],
      ['Workshop', '19-20-21 mayo 2026 | 19:00 Bolivia'],
      ['Precio completo', '$35 USD | Precio 1 día: $20 USD'],
      ['Metas en proceso', metas.filter(m => m['Estado'] === 'En proceso').length],
    ];

    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEETS_ID, range: 'RESUMEN!A1',
      valueInputOption: 'USER_ENTERED', requestBody: { values: valores },
    });
    console.log('✅ RESUMEN actualizado');
  } catch (e) { console.log('⚠️ No se pudo actualizar RESUMEN:', e.message); }
}

// ── Resumen diario ────────────────────────────────────────────────────────────
async function enviarResumenDia() {
  const sheets = await getSheetsClient();
  await generarTareasDelDia(sheets);
  await actualizarResumen(sheets);
  const contexto = await construirContexto(sheets);

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6', max_tokens: 800,
    system: 'Sos Nathbot, asistente de Nath Rivas (NR FILMS, Santa Cruz, Bolivia). Generás resúmenes diarios para WhatsApp. Formato compacto con emojis, máximo 10 líneas, solo lo urgente e importante.',
    messages: [{ role: 'user', content: `Resumen del día para Nath. Solo lo urgente e importante. Una acción prioritaria al final.\n\n${contexto}` }],
  });

  const resumen = response.content[0].text;
  const client = twilio(TWILIO_SID, TWILIO_TOKEN);
  await client.messages.create({ from: 'whatsapp:+14155238886', to: NATH_NUM, body: `🤖 *Nathbot — Resumen del día*\n\n${resumen}` });
  console.log('📤 Resumen enviado');
  return resumen;
}

// ── WEBHOOK PRINCIPAL ─────────────────────────────────────────────────────────
app.post('/whatsapp', async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();

  try {
    const from = req.body.From;
    const texto = req.body.Body?.trim() || '';
    const numMedia = parseInt(req.body.NumMedia || '0');

    console.log(`📱 ${from}: "${texto.slice(0, 60)}" | media: ${numMedia}`);

    const sheets = await getSheetsClient();
    const [contexto, historial] = await Promise.all([
      construirContexto(sheets),
      obtenerHistorial(sheets, from),
    ]);

    let contenidoUsuario = [];
    let tieneAudio = false;
    let audioTranscrito = null;

    for (let i = 0; i < numMedia; i++) {
      const mediaUrl = req.body[`MediaUrl${i}`];
      const mediaType = req.body[`MediaContentType${i}`] || '';

      if (mediaType.startsWith('image/')) {
        try {
          const base64 = await descargarImagenBase64(mediaUrl);
          const mt = mediaType.includes('png') ? 'image/png' : mediaType.includes('gif') ? 'image/gif' : mediaType.includes('webp') ? 'image/webp' : 'image/jpeg';
          contenidoUsuario.push({ type: 'image', source: { type: 'base64', media_type: mt, data: base64 } });
          console.log(`🖼️ Imagen (${mt})`);
        } catch (e) {
          contenidoUsuario.push({ type: 'text', text: '[Nath mandó una imagen pero no pude cargarla]' });
        }
      } else if (mediaType.startsWith('audio/') || mediaType.includes('ogg') || mediaType.includes('mp4')) {
        tieneAudio = true;
        audioTranscrito = await transcribirAudio(mediaUrl);
        if (audioTranscrito) {
          console.log(`🎙️ Audio: "${audioTranscrito.slice(0, 60)}"`);
          contenidoUsuario.push({ type: 'text', text: `[Audio de Nath]: ${audioTranscrito}` });
        } else {
          contenidoUsuario.push({ type: 'text', text: '[Nath mandó un audio — escribime lo que necesitás y te respondo!]' });
        }
      } else {
        contenidoUsuario.push({ type: 'text', text: `[Nath mandó un archivo: ${mediaType}]` });
      }
    }

    if (texto) contenidoUsuario.push({ type: 'text', text: texto });
    if (contenidoUsuario.length === 0) contenidoUsuario.push({ type: 'text', text: '(sin contenido)' });

    const mensajes = [
      ...historial.map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: contenidoUsuario },
    ];

    const SYSTEM = `Sos Nathbot, el asistente personal e inteligente de Nath Rivas. Ella dirige NR FILMS, productora de video y fotografía en Santa Cruz, Bolivia.

Tenés acceso completo a su base de datos (Google Sheets). Cuando Nath mencione algo que deba registrarse, usá las herramientas automáticamente SIN pedirle permiso. Actuá, no preguntes.

Herramientas disponibles:
- agregar_tarea: registrar tarea nueva
- registrar_finanza: ingreso o gasto
- agregar_lead: lead o consulta nueva
- registrar_cobro: alguien le debe a Nath (ME DEBEN)
- registrar_deuda: Nath le debe a alguien (DEBO)
- marcar_tarea_completada: cuando Nath dice que hizo algo
- actualizar_boda: cambiar estado, saldo o agregar nota a una boda
- registrar_pago_boda: cuando un cliente paga su boda (actualiza BODAS + ME DEBEN + FINANZAS en un solo paso)
- agregar_meta: registrar o actualizar una meta

Si recibís imagen de conversación → identificá si hay lead y registralo.
Si recibís imagen de presupuesto/contrato → leélo y resumilo.
Cuando Nath dice "me pagó X de Y pareja" → usá registrar_pago_boda.

ESTADO ACTUAL DEL NEGOCIO:
${contexto}

REGLAS:
- Español, tono directo y cálido, como socio de confianza
- Respuestas cortas (máximo 3 párrafos)
- Recordás todo lo de la conversación
- Emojis con moderación
- Actualizás Sheets proactivamente sin preguntar`;

    let response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 1024,
      system: SYSTEM, tools: TOOLS, messages: mensajes,
    });

    while (response.stop_reason === 'tool_use') {
      const toolUses = response.content.filter(b => b.type === 'tool_use');
      const toolResults = [];
      for (const t of toolUses) {
        const resultado = await ejecutarHerramienta(sheets, t.name, t.input);
        toolResults.push({ type: 'tool_result', tool_use_id: t.id, content: resultado });
      }
      mensajes.push({ role: 'assistant', content: response.content });
      mensajes.push({ role: 'user', content: toolResults });
      response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6', max_tokens: 1024,
        system: SYSTEM, tools: TOOLS, messages: mensajes,
      });
    }

    const respuestaFinal = response.content.find(b => b.type === 'text')?.text || 'Listo Nath 👍';

    const textoUsuario = audioTranscrito || texto || '[imagen]';
    agregarAlHistorial(from, 'user', textoUsuario);
    agregarAlHistorial(from, 'assistant', respuestaFinal);
    Promise.all([
      guardarHistorial(sheets, from, 'user', textoUsuario),
      guardarHistorial(sheets, from, 'assistant', respuestaFinal),
    ]).catch(() => {});

    console.log(`🤖 → ${respuestaFinal.slice(0, 80)}`);
    twiml.message(respuestaFinal.trim());

  } catch (err) {
    console.error('❌ Error general:', err.message);
    twiml.message('Hubo un error interno. Intentá de nuevo Nath 🙏');
  }

  res.type('text/xml').send(twiml.toString());
});

// ── Endpoints de administración ───────────────────────────────────────────────
app.get('/resumen-dia', async (req, res) => {
  if (req.query.secret !== (getEnv('CRON_SECRET') || 'nathbot2026')) return res.status(401).send('No autorizado');
  try {
    const resumen = await enviarResumenDia();
    res.json({ ok: true, resumen });
  } catch (e) {
    console.error('❌ Resumen:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/actualizar-resumen', async (req, res) => {
  if (req.query.secret !== (getEnv('CRON_SECRET') || 'nathbot2026')) return res.status(401).send('No autorizado');
  try {
    const sheets = await getSheetsClient();
    await actualizarResumen(sheets);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/ping', (req, res) => res.send('pong'));
app.get('/', (req, res) => res.send('🤖 Nathbot v4 activo — Sistema sólido'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🤖 Nathbot v4 en puerto ${PORT}`));
