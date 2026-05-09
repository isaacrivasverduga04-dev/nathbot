// ╔══════════════════════════════════════════════════════╗
// ║          NATHBOT — Servidor WhatsApp                 ║
// ║  Nath escribe → Nathbot lee Sheets → responde        ║
// ╚══════════════════════════════════════════════════════╝
const env = require('dotenv').config().parsed || {};
const getEnv = (k) => process.env[k] || env[k];

const express = require('express');
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');
const twilio = require('twilio');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const anthropic = new Anthropic({ apiKey: getEnv('ANTHROPIC_API_KEY') });
const SHEETS_ID = getEnv('SHEETS_ID');
const NATH_WHATSAPP = getEnv('NATH_WHATSAPP_NUMBER');

// ── Historial en memoria (caché rápido) ───────────────────────────────────
// { "whatsapp:+591xxx": [{role:"user"|"assistant", content:"..."}] }
const historialCache = {};
const MAX_MENSAJES = 20; // 10 intercambios

// ── Google Sheets auth ────────────────────────────────────────────────────
async function getSheetsClient() {
  const credsJson = getEnv('GOOGLE_CREDENTIALS');
  const credentials = credsJson ? JSON.parse(credsJson) : require('./google_service_account.json');
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

// ── Leer una pestaña completa ─────────────────────────────────────────────
async function leerHoja(sheets, hoja, rango = 'A1:Z200') {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEETS_ID,
      range: `${hoja}!${rango}`,
    });
    const filas = res.data.values || [];
    if (filas.length < 2) return [];
    const headers = filas[0];
    return filas.slice(1).map(fila =>
      Object.fromEntries(headers.map((h, i) => [h, fila[i] || '']))
    );
  } catch { return []; }
}

// ── Agregar fila a una hoja ───────────────────────────────────────────────
async function agregarFila(sheets, hoja, valores) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEETS_ID,
    range: `${hoja}!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [valores] },
  });
}

// ── Cargar historial desde Sheets al arrancar ─────────────────────────────
async function cargarHistorialDesdeSheets(sheets, from) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEETS_ID,
      range: 'HISTORIAL!A1:D500',
    });
    const filas = res.data.values || [];
    if (filas.length < 2) return [];

    // Filtrar por número y tomar los últimos MAX_MENSAJES
    const mensajes = filas.slice(1)
      .filter(f => f[1] === from)
      .slice(-MAX_MENSAJES)
      .map(f => ({ role: f[2], content: f[3] }));

    return mensajes;
  } catch {
    return [];
  }
}

// ── Guardar mensaje en Sheets (async, no bloquea) ─────────────────────────
async function guardarMensajeEnSheets(sheets, from, role, content) {
  const ts = new Date().toISOString();
  const resumen = content.length > 500 ? content.slice(0, 500) + '...' : content;
  try {
    await agregarFila(sheets, 'HISTORIAL', [ts, from, role, resumen]);
  } catch (e) {
    console.log('⚠️ No se pudo guardar en HISTORIAL:', e.message);
  }
}

// ── Obtener historial (caché → Sheets si vacío) ───────────────────────────
async function obtenerHistorial(sheets, from) {
  if (historialCache[from] && historialCache[from].length > 0) {
    return historialCache[from];
  }
  // Si no hay caché (servidor recién arrancó), cargar de Sheets
  const historial = await cargarHistorialDesdeSheets(sheets, from);
  historialCache[from] = historial;
  console.log(`📚 Historial cargado de Sheets: ${historial.length} mensajes`);
  return historial;
}

// ── Agregar al historial local ────────────────────────────────────────────
function agregarAlHistorialLocal(from, role, content) {
  if (!historialCache[from]) historialCache[from] = [];
  historialCache[from].push({ role, content });
  // Limitar tamaño
  if (historialCache[from].length > MAX_MENSAJES) {
    historialCache[from] = historialCache[from].slice(-MAX_MENSAJES);
  }
}

// ── Construir contexto del día para Claude ────────────────────────────────
async function construirContexto(sheets) {
  const [bodas, tareas, finanzas, meDeben, metas, contenido, leads] = await Promise.all([
    leerHoja(sheets, 'BODAS'),
    leerHoja(sheets, 'TAREAS DIA', 'A1:G100'),
    leerHoja(sheets, 'FINANZAS', 'A1:E100'),
    leerHoja(sheets, 'ME DEBEN', 'A1:E50'),
    leerHoja(sheets, 'METAS', 'A1:F50'),
    leerHoja(sheets, 'CONTENIDO', 'A1:H50'),
    leerHoja(sheets, 'LEADS', 'A1:H50'),
  ]);

  const hoy = new Date().toLocaleDateString('es-BO');

  const bodasActivas = bodas.filter(b => b['Estado'] !== 'Completado');
  const tareasHoy = tareas.filter(t => t['Completada'] !== 'Sí').slice(0, 10);
  const cobros = meDeben.filter(d => d['Estado'] === 'Pendiente');
  const leadsNuevos = leads.filter(l => l['Estado'] === 'Nuevo');

  return `
HOY: ${hoy}

BODAS ACTIVAS (${bodasActivas.length}):
${bodasActivas.map(b => `- ${b['Pareja'] || b['Nombre'] || '?'} | ${b['Estado']} | Saldo: ${b['Saldo pendiente'] || b['Saldo pendiente (BOB)'] || 0} BOB | Boda: ${b['Fecha de boda'] || '?'}`).join('\n') || 'Ninguna'}

TAREAS PENDIENTES HOY (${tareasHoy.length}):
${tareasHoy.map(t => `- [${t['Prioridad'] || 'Normal'}] ${t['Tarea'] || t['Nombre'] || '?'} | ${t['Categoria'] || ''}`).join('\n') || 'Ninguna'}

COBROS PENDIENTES (${cobros.length}):
${cobros.map(c => `- ${c['Quien'] || '?'}: ${c['Monto (BOB)']} BOB`).join('\n') || 'Ninguno'}

LEADS NUEVOS (${leadsNuevos.length}):
${leadsNuevos.map(l => `- ${l['Nombre']}: ${l['Tipo de consulta']} via ${l['Fuente']}`).join('\n') || 'Ninguno'}

CONTENIDO EN PROCESO:
${contenido.filter(c => c['Estado'] && c['Estado'] !== 'Publicado').slice(0, 5).map(c => `- ${c['Nombre / Hook'] || '?'} | ${c['Estado']} | ${c['Fecha publicacion'] || 'sin fecha'}`).join('\n') || 'Ninguno'}

METAS ACTIVAS:
${metas.filter(m => m['Estado'] === 'En proceso').slice(0, 4).map(m => `- ${m['Meta']}: ${m['Progreso (%)'] || 0}%`).join('\n') || 'Ninguna'}
`.trim();
}

// ── Detectar si hay que actualizar alguna hoja ─────────────────────────────
async function procesarAcciones(sheets, mensajeOriginal) {
  const msg = mensajeOriginal.toLowerCase();

  if ((msg.includes('cobré') || msg.includes('pagué') || msg.includes('gasté') || msg.includes('recibí')) && /\d+/.test(msg)) {
    const monto = msg.match(/\d+/)?.[0];
    const tipo = (msg.includes('cobré') || msg.includes('recibí')) ? 'Ingreso' : 'Gasto';
    const hoy = new Date().toISOString().split('T')[0];
    await agregarFila(sheets, 'FINANZAS', [mensajeOriginal.slice(0, 40), tipo, 'Trabajo/Ingreso', hoy, monto]);
    console.log(`💰 Finanzas: ${tipo} ${monto} BOB`);
  }
}

// ── Webhook de Twilio WhatsApp ─────────────────────────────────────────────
app.post('/whatsapp', async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();

  try {
    const from = req.body.From;
    const mensaje = req.body.Body?.trim();

    if (!mensaje) {
      twiml.message('Hola Nath 👋');
      return res.type('text/xml').send(twiml.toString());
    }

    console.log(`📱 Mensaje de ${from}: ${mensaje}`);

    const sheets = await getSheetsClient();

    // Cargar contexto e historial en paralelo
    const [contexto, historialPrevio] = await Promise.all([
      construirContexto(sheets),
      obtenerHistorial(sheets, from),
    ]);

    // Construir array de mensajes con historial completo
    const mensajes = [
      ...historialPrevio,
      { role: 'user', content: mensaje },
    ];

    // Llamar a Claude con historial completo
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: `Eres Nathbot, el asistente personal de Nath Rivas. Ella dirige NR FILMS, una productora de video y fotografía en Santa Cruz, Bolivia.

Tu rol es ser su socio estratégico y asistente de confianza. Respondes en español, tono cercano y directo, como un amigo que conoce su negocio.

Tienes memoria de la conversación completa con Nath. Recuerda lo que ella te dijo antes y úsalo naturalmente.

CONTEXTO ACTUAL DEL SISTEMA:
${contexto}

REGLAS:
- Respuestas cortas y directas (máximo 3 párrafos)
- Sin listas largas a menos que las pida
- Si menciona un monto o pago, confirma que lo anotaste en finanzas
- Si pregunta "qué tengo hoy", resume solo lo urgente
- Usa emojis con moderación
- Recuerda lo que Nath te dijo en mensajes anteriores de esta conversación`,
      messages: mensajes,
    });

    const respuesta = response.content[0].text;

    // Actualizar caché local
    agregarAlHistorialLocal(from, 'user', mensaje);
    agregarAlHistorialLocal(from, 'assistant', respuesta);

    // Guardar en Sheets (async, no bloquea la respuesta)
    Promise.all([
      guardarMensajeEnSheets(sheets, from, 'user', mensaje),
      guardarMensajeEnSheets(sheets, from, 'assistant', respuesta),
      procesarAcciones(sheets, mensaje),
    ]).catch(e => console.log('⚠️ Error guardando:', e.message));

    twiml.message(respuesta);
    console.log(`🤖 Respuesta (${mensajes.length} msgs de historial): ${respuesta.slice(0, 80)}...`);

  } catch (err) {
    console.error('Error:', err.message);
    twiml.message('Hubo un error. Intenta de nuevo Nath.');
  }

  res.type('text/xml').send(twiml.toString());
});

// ── Health check ──────────────────────────────────────────────────────────
app.get('/', (req, res) => res.send('🤖 Nathbot activo'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🤖 Nathbot servidor en puerto ${PORT}`));
