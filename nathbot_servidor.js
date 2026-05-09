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
const NATH_WHATSAPP = getEnv('NATH_WHATSAPP_NUMBER'); // ej: whatsapp:+59177777777

// ── Google Sheets auth ────────────────────────────────────────────────────
async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: './google_service_account.json',
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

// ── Construir contexto del día para Claude ────────────────────────────────
async function construirContexto(sheets) {
  const [bodas, proyectos, tareas, finanzas, meDeben, metas, contenido, leads] = await Promise.all([
    leerHoja(sheets, 'BODAS'),
    leerHoja(sheets, 'PROYECTOS'),
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
async function procesarAcciones(sheets, respuesta, mensajeOriginal) {
  const msg = mensajeOriginal.toLowerCase();

  // Detectar nuevo registro financiero
  if ((msg.includes('cobré') || msg.includes('pagué') || msg.includes('gasté') || msg.includes('recibí')) && /\d+/.test(msg)) {
    const monto = msg.match(/\d+/)?.[0];
    const tipo = (msg.includes('cobré') || msg.includes('recibí')) ? 'Ingreso' : 'Gasto';
    const hoy = new Date().toISOString().split('T')[0];
    await agregarFila(sheets, 'FINANZAS', [mensajeOriginal.slice(0, 40), tipo, 'Trabajo/Ingreso', hoy, monto]);
  }

  // Detectar tarea completada
  if (msg.includes('completé') || msg.includes('terminé') || msg.includes('listo')) {
    // Se podría actualizar TAREAS DIA aquí - por ahora solo log
    console.log('📝 Acción detectada: tarea completada');
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

    // Construir contexto de Sheets
    const sheets = await getSheetsClient();
    const contexto = await construirContexto(sheets);

    // Llamar a Claude como Nathbot
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: `Eres Nathbot, el asistente personal de Nath Rivas. Ella dirige NR FILMS, una productora de video y fotografía en Santa Cruz, Bolivia.

Tu rol es ser su socio estratégico y asistente de confianza. Respondes en español, tono cercano y directo, como un amigo que conoce su negocio.

Cuando Nath te cuente algo de su día (cobros, tareas, bodas, clientes), lo registras mentalmente y lo mencionas si es relevante.

CONTEXTO ACTUAL DEL SISTEMA:
${contexto}

REGLAS:
- Respuestas cortas y directas (máximo 3 párrafos)
- Sin listas largas a menos que las pida
- Si menciona un monto o pago, confirma que lo anotaste en finanzas
- Si pregunta "qué tengo hoy", resume solo lo urgente
- Usa emojis con moderación`,
      messages: [{ role: 'user', content: mensaje }],
    });

    const respuesta = response.content[0].text;

    // Procesar acciones automáticas
    await procesarAcciones(sheets, respuesta, mensaje);

    twiml.message(respuesta);
    console.log(`🤖 Respuesta: ${respuesta.slice(0, 80)}...`);

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
