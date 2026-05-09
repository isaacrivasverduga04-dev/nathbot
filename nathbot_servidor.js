// ╔══════════════════════════════════════════════════════╗
// ║          NATHBOT v3 — Sistema completo               ║
// ║  Imágenes ✓  Audio ✓  Memoria persistente ✓         ║
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

// ── Keep-alive: se hace ping a sí mismo cada 10 min para no dormir ────────────
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

// ── Descargar imagen de Twilio como base64 ────────────────────────────────────
function descargarImagenBase64(url) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { Authorization: `Basic ${auth}` } }, (res) => {
      // Seguir redirects
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
    if (!OPENAI_KEY) return null; // Sin key de OpenAI, no transcribimos

    const { buffer, contentType } = await descargarBuffer(mediaUrl);
    const ext = contentType?.includes('ogg') ? 'ogg' : contentType?.includes('mp4') ? 'mp4' : 'mp3';

    // Llamar a Whisper via fetch (no depende de SDK de OpenAI)
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
  const [bodas, tareas, finanzas, meDeben, metas, contenido, leads, proyectos] = await Promise.all([
    leerHoja(sheets, 'BODAS'),
    leerHoja(sheets, 'TAREAS DIA', 'A1:G100'),
    leerHoja(sheets, 'FINANZAS', 'A1:E100'),
    leerHoja(sheets, 'ME DEBEN', 'A1:E50'),
    leerHoja(sheets, 'METAS', 'A1:F50'),
    leerHoja(sheets, 'CONTENIDO', 'A1:H50'),
    leerHoja(sheets, 'LEADS', 'A1:H50'),
    leerHoja(sheets, 'PROYECTOS', 'A1:H50'),
  ]);

  const hoy = new Date().toLocaleDateString('es-BO');

  return `HOY: ${hoy}

BODAS ACTIVAS:
${bodas.filter(b => b['Estado'] !== 'Completado').map(b =>
    `- ${b['Pareja'] || b['Nombre'] || '?'} | ${b['Estado']} | Saldo: ${b['Saldo pendiente'] || b['Saldo pendiente (BOB)'] || 0} BOB | Boda: ${b['Fecha de boda'] || '?'}`
  ).join('\n') || 'Ninguna'}

PROYECTOS ACTIVOS:
${proyectos.filter(p => p['Estado'] !== 'Completado').slice(0, 8).map(p =>
    `- ${p['Nombre'] || p['Proyecto'] || '?'} | ${p['Estado'] || '?'} | ${p['Cliente'] || ''}`
  ).join('\n') || 'Ninguno'}

TAREAS PENDIENTES:
${tareas.filter(t => t['Completada'] !== 'Sí').slice(0, 10).map(t =>
    `- [${t['Prioridad'] || 'Normal'}] ${t['Tarea'] || '?'} | ${t['Categoria'] || ''}`
  ).join('\n') || 'Ninguna'}

COBROS PENDIENTES:
${meDeben.filter(d => d['Estado'] === 'Pendiente').map(c =>
    `- ${c['Quien'] || '?'}: ${c['Monto (BOB)']} BOB — ${c['Concepto'] || ''}`
  ).join('\n') || 'Ninguno'}

LEADS:
${leads.filter(l => l['Estado'] === 'Nuevo').map(l =>
    `- ${l['Nombre']}: ${l['Tipo de consulta']} via ${l['Fuente']}`
  ).join('\n') || 'Ninguno nuevo'}

CONTENIDO EN PROCESO:
${contenido.filter(c => c['Estado'] && c['Estado'] !== 'Publicado').slice(0, 5).map(c =>
    `- ${c['Nombre / Hook'] || '?'} | ${c['Estado']} | ${c['Fecha publicacion'] || 'sin fecha'}`
  ).join('\n') || 'Ninguno'}

METAS ACTIVAS:
${metas.filter(m => m['Estado'] === 'En proceso').slice(0, 4).map(m =>
    `- ${m['Meta']}: ${m['Progreso (%)'] || 0}%`
  ).join('\n') || 'Ninguna'}`.trim();
}

// ── Historial persistente desde Sheets ───────────────────────────────────────
async function cargarHistorialDesdeSheets(sheets, from) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEETS_ID, range: 'HISTORIAL!A1:D500',
    });
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
    console.log(`📚 Historial cargado: ${historialCache[from].length} mensajes`);
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
    await agregarFila(sheets, 'HISTORIAL', [
      new Date().toISOString(), from, role, String(content).slice(0, 800)
    ]);
  } catch (e) { console.log('⚠️ Historial no guardado:', e.message); }
}

// ── Herramientas de Claude ────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'agregar_tarea',
    description: 'Agrega una tarea a TAREAS DIA',
    input_schema: { type: 'object', properties: {
      tarea: { type: 'string' }, prioridad: { type: 'string', enum: ['Urgente', 'Alta', 'Media', 'Baja'] },
      categoria: { type: 'string' },
    }, required: ['tarea'] },
  },
  {
    name: 'registrar_finanza',
    description: 'Registra ingreso o gasto en FINANZAS',
    input_schema: { type: 'object', properties: {
      descripcion: { type: 'string' }, tipo: { type: 'string', enum: ['Ingreso', 'Gasto'] },
      monto: { type: 'number' }, categoria: { type: 'string' },
    }, required: ['descripcion', 'tipo', 'monto'] },
  },
  {
    name: 'agregar_lead',
    description: 'Registra un nuevo lead o consulta en LEADS',
    input_schema: { type: 'object', properties: {
      nombre: { type: 'string' }, tipo_consulta: { type: 'string' },
      fuente: { type: 'string' }, notas: { type: 'string' },
    }, required: ['nombre', 'tipo_consulta'] },
  },
  {
    name: 'registrar_cobro',
    description: 'Registra cobro pendiente en ME DEBEN',
    input_schema: { type: 'object', properties: {
      quien: { type: 'string' }, monto: { type: 'number' },
      concepto: { type: 'string' }, fecha_limite: { type: 'string' },
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
    name: 'agregar_nota_boda',
    description: 'Agrega nota o actualización a una boda',
    input_schema: { type: 'object', properties: {
      pareja: { type: 'string' }, nota: { type: 'string' },
    }, required: ['pareja', 'nota'] },
  },
];

async function ejecutarHerramienta(sheets, name, input) {
  const hoy = new Date().toISOString().split('T')[0];
  console.log(`🔧 ${name}:`, JSON.stringify(input));
  try {
    switch (name) {
      case 'agregar_tarea':
        await agregarFila(sheets, 'TAREAS DIA', [input.tarea, input.prioridad || 'Media', input.categoria || '', hoy, 'No', '', '']);
        return `✅ Tarea agregada: "${input.tarea}"`;
      case 'registrar_finanza':
        await agregarFila(sheets, 'FINANZAS', [input.descripcion, input.tipo, input.categoria || 'General', hoy, input.monto]);
        return `✅ ${input.tipo} de ${input.monto} BOB registrado`;
      case 'agregar_lead':
        await agregarFila(sheets, 'LEADS', [input.nombre, input.tipo_consulta, input.fuente || 'WhatsApp', hoy, 'Nuevo', input.notas || '', '', '']);
        return `✅ Lead: ${input.nombre}`;
      case 'registrar_cobro':
        await agregarFila(sheets, 'ME DEBEN', [input.quien, input.monto, input.concepto, input.fecha_limite || '', 'Pendiente']);
        return `✅ Cobro registrado: ${input.quien} → ${input.monto} BOB`;
      case 'marcar_tarea_completada': {
        const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEETS_ID, range: 'TAREAS DIA!A1:G100' });
        const filas = res.data.values || [];
        for (let i = 1; i < filas.length; i++) {
          if (filas[i][0]?.toLowerCase().includes(input.tarea.toLowerCase()) && filas[i][4] !== 'Sí') {
            await actualizarCelda(sheets, 'TAREAS DIA', `E${i + 1}`, 'Sí');
            return `✅ Completada: "${filas[i][0]}"`;
          }
        }
        return `⚠️ No encontré: "${input.tarea}"`;
      }
      case 'agregar_nota_boda':
        await agregarFila(sheets, 'BODAS', [`[NOTA ${hoy}] ${input.pareja}: ${input.nota}`, '', '', '', '', '', '', '']);
        return `✅ Nota agregada a ${input.pareja}`;
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
    const tareas = await leerHoja(sheets, 'TAREAS DIA', 'A1:G100');
    if (tareas.some(t => t['Fecha'] === hoy && t['Auto generada'] === 'Sí')) return;

    const [bodas, meDeben, contenido] = await Promise.all([
      leerHoja(sheets, 'BODAS'), leerHoja(sheets, 'ME DEBEN', 'A1:E50'), leerHoja(sheets, 'CONTENIDO', 'A1:H50'),
    ]);

    const nuevas = [];
    bodas.filter(b => b['Estado']?.match(/entrega/i)).forEach(b => {
      nuevas.push([`Entregar: ${b['Pareja'] || b['Nombre'] || '?'}`, b['Estado']?.match(/bloqueada/i) ? 'Urgente' : 'Alta', 'Edicion', hoy, 'No', '', 'Sí']);
    });
    bodas.filter(b => b['Estado']?.match(/bloqueada/i)).forEach(b => {
      nuevas.push([`URGENTE cobrar ${b['Saldo pendiente'] || b['Saldo pendiente (BOB)'] || ''} BOB — ${b['Pareja'] || '?'}`, 'Urgente', 'Administracion', hoy, 'No', '', 'Sí']);
    });
    meDeben.filter(d => d['Estado'] === 'Pendiente').slice(0, 3).forEach(d => {
      nuevas.push([`Cobrar a ${d['Quien'] || '?'}: ${d['Monto (BOB)']} BOB`, 'Alta', 'Administracion', hoy, 'No', d['Concepto'] || '', 'Sí']);
    });
    contenido.filter(c => c['Fecha publicacion'] === hoy && c['Estado'] !== 'Publicado').forEach(c => {
      nuevas.push([`Publicar hoy: ${c['Nombre / Hook'] || '?'}`, 'Alta', 'Marketing', hoy, 'No', '', 'Sí']);
    });

    for (const t of nuevas) await agregarFila(sheets, 'TAREAS DIA', t);
    if (nuevas.length > 0) console.log(`📋 ${nuevas.length} tareas auto-generadas`);
  } catch (e) { console.log('⚠️ Error generando tareas:', e.message); }
}

// ── Resumen diario ────────────────────────────────────────────────────────────
async function enviarResumenDia() {
  const sheets = await getSheetsClient();
  const contexto = await construirContexto(sheets);
  await generarTareasDelDia(sheets);

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6', max_tokens: 800,
    system: 'Sos Nathbot, asistente de Nath Rivas (NR FILMS, Santa Cruz, Bolivia). Generás resúmenes diarios para WhatsApp. Formato compacto con emojis, máximo 10 líneas, solo lo urgente.',
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

    // ── Construir contenido del mensaje ──────────────────────────────────────
    let contenidoUsuario = [];
    let tieneAudio = false;
    let audioTranscrito = null;

    for (let i = 0; i < numMedia; i++) {
      const mediaUrl = req.body[`MediaUrl${i}`];
      const mediaType = req.body[`MediaContentType${i}`] || '';

      if (mediaType.startsWith('image/')) {
        // Imagen → pasarla a Claude directamente
        try {
          const base64 = await descargarImagenBase64(mediaUrl);
          const mt = mediaType.includes('png') ? 'image/png' : mediaType.includes('gif') ? 'image/gif' : mediaType.includes('webp') ? 'image/webp' : 'image/jpeg';
          contenidoUsuario.push({ type: 'image', source: { type: 'base64', media_type: mt, data: base64 } });
          console.log(`🖼️ Imagen procesada (${mt})`);
        } catch (e) {
          console.log('⚠️ Error imagen:', e.message);
          contenidoUsuario.push({ type: 'text', text: '[Nath mandó una imagen pero no pude cargarla]' });
        }
      } else if (mediaType.startsWith('audio/') || mediaType.includes('ogg') || mediaType.includes('mp4')) {
        // Audio → transcribir con Whisper si hay key, si no aviso amigable
        tieneAudio = true;
        audioTranscrito = await transcribirAudio(mediaUrl);
        if (audioTranscrito) {
          console.log(`🎙️ Audio transcrito: "${audioTranscrito.slice(0, 80)}"`);
          contenidoUsuario.push({ type: 'text', text: `[Audio de Nath transcrito]: ${audioTranscrito}` });
        } else {
          contenidoUsuario.push({ type: 'text', text: '[Nath mandó un audio — aún no tengo transcripción de voz. Escribime lo que necesitás y te respondo!]' });
        }
      } else {
        contenidoUsuario.push({ type: 'text', text: `[Nath mandó un archivo: ${mediaType}]` });
      }
    }

    if (texto) contenidoUsuario.push({ type: 'text', text: texto });
    if (contenidoUsuario.length === 0) contenidoUsuario.push({ type: 'text', text: '(sin contenido)' });

    // ── Mensajes con historial ────────────────────────────────────────────────
    const mensajes = [
      ...historial.map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: contenidoUsuario },
    ];

    // ── Llamar a Claude ───────────────────────────────────────────────────────
    const SYSTEM = `Sos Nathbot, el asistente personal e inteligente de Nath Rivas. Ella dirige NR FILMS, productora de video y fotografía en Santa Cruz, Bolivia.

Tenés acceso completo a su base de datos (Google Sheets). Cuando Nath mencione algo que deba registrarse, usá las herramientas automáticamente SIN pedirle permiso. Actuá, no preguntes.

Si recibís una imagen de captura de conversación → identificá si hay lead nuevo y registralo.
Si recibís imagen de presupuesto o contrato → leélo y resumilo.
Si recibís audio transcrito → respondé al contenido del audio naturalmente.

ESTADO ACTUAL DEL NEGOCIO:
${contexto}

REGLAS:
- Español, tono directo y cálido, como socio de confianza
- Respuestas cortas (máximo 3 párrafos)
- Recordás TODO lo que Nath dijo antes en esta conversación
- Usás emojis con moderación
- Actualizás Sheets proactivamente`;

    let respuestaFinal = '';
    let response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 1024,
      system: SYSTEM, tools: TOOLS, messages: mensajes,
    });

    // ── Agentic loop ──────────────────────────────────────────────────────────
    while (response.stop_reason === 'tool_use') {
      const toolUses = response.content.filter(b => b.type === 'tool_use');
      const toolResults = [];
      const acciones = [];

      for (const t of toolUses) {
        const resultado = await ejecutarHerramienta(sheets, t.name, t.input);
        toolResults.push({ type: 'tool_result', tool_use_id: t.id, content: resultado });
        acciones.push(resultado);
      }

      mensajes.push({ role: 'assistant', content: response.content });
      mensajes.push({ role: 'user', content: toolResults });

      response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6', max_tokens: 1024,
        system: SYSTEM, tools: TOOLS, messages: mensajes,
      });
    }

    const textoFinal = response.content.find(b => b.type === 'text')?.text || 'Listo Nath 👍';
    respuestaFinal = textoFinal;

    // ── Guardar en historial ──────────────────────────────────────────────────
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

// ── Resumen diario (cron externo) ─────────────────────────────────────────────
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

app.get('/ping', (req, res) => res.send('pong'));
app.get('/', (req, res) => res.send('🤖 Nathbot v3 activo'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🤖 Nathbot v3 en puerto ${PORT}`));
