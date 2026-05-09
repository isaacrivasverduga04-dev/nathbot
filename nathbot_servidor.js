// ╔══════════════════════════════════════════════════════╗
// ║          NATHBOT v2 — Claude completo en WhatsApp    ║
// ║  Ve imágenes, razona, actualiza Sheets en tiempo real║
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

// ── Historial en memoria ──────────────────────────────────────────────────────
const historialCache = {};
const MAX_MENSAJES = 30;

// ── Google Sheets auth ────────────────────────────────────────────────────────
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

async function agregarFila(sheets, hoja, valores) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEETS_ID,
    range: `${hoja}!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [valores] },
  });
}

async function actualizarCelda(sheets, hoja, rango, valor) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEETS_ID,
    range: `${hoja}!${rango}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[valor]] },
  });
}

// ── Descargar imagen de Twilio como base64 ────────────────────────────────────
function descargarImagenBase64(url) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { headers: { Authorization: `Basic ${auth}` } }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('base64')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ── Contexto del sistema Nathbot ──────────────────────────────────────────────
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

  return `
HOY: ${hoy}

BODAS ACTIVAS:
${bodas.filter(b => b['Estado'] !== 'Completado').map(b =>
    `- ${b['Pareja'] || b['Nombre'] || '?'} | ${b['Estado']} | Saldo: ${b['Saldo pendiente'] || b['Saldo pendiente (BOB)'] || 0} BOB | Fecha: ${b['Fecha de boda'] || '?'}`
  ).join('\n') || 'Ninguna'}

PROYECTOS ACTIVOS:
${proyectos.filter(p => p['Estado'] !== 'Completado').slice(0, 8).map(p =>
    `- ${p['Nombre'] || p['Proyecto'] || '?'} | ${p['Estado'] || '?'} | ${p['Cliente'] || ''}`
  ).join('\n') || 'Ninguno'}

TAREAS PENDIENTES:
${tareas.filter(t => t['Completada'] !== 'Sí').slice(0, 10).map(t =>
    `- [${t['Prioridad'] || 'Normal'}] ${t['Tarea'] || t['Nombre'] || '?'} | ${t['Categoria'] || ''}`
  ).join('\n') || 'Ninguna'}

COBROS PENDIENTES:
${meDeben.filter(d => d['Estado'] === 'Pendiente').map(c =>
    `- ${c['Quien'] || '?'}: ${c['Monto (BOB)']} BOB`
  ).join('\n') || 'Ninguno'}

LEADS NUEVOS:
${leads.filter(l => l['Estado'] === 'Nuevo').map(l =>
    `- ${l['Nombre']}: ${l['Tipo de consulta']} via ${l['Fuente']}`
  ).join('\n') || 'Ninguno'}

CONTENIDO EN PROCESO:
${contenido.filter(c => c['Estado'] && c['Estado'] !== 'Publicado').slice(0, 5).map(c =>
    `- ${c['Nombre / Hook'] || '?'} | ${c['Estado']} | ${c['Fecha publicacion'] || 'sin fecha'}`
  ).join('\n') || 'Ninguno'}

METAS ACTIVAS:
${metas.filter(m => m['Estado'] === 'En proceso').slice(0, 4).map(m =>
    `- ${m['Meta']}: ${m['Progreso (%)'] || 0}%`
  ).join('\n') || 'Ninguna'}
`.trim();
}

// ── Herramientas de Claude para actualizar Sheets ─────────────────────────────
const TOOLS = [
  {
    name: 'agregar_tarea',
    description: 'Agrega una nueva tarea a TAREAS DIA en Google Sheets',
    input_schema: {
      type: 'object',
      properties: {
        tarea: { type: 'string', description: 'Descripción de la tarea' },
        prioridad: { type: 'string', enum: ['Alta', 'Media', 'Baja'], description: 'Prioridad de la tarea' },
        categoria: { type: 'string', description: 'Categoría (ej: Edición, Marketing, Admin)' },
      },
      required: ['tarea'],
    },
  },
  {
    name: 'registrar_finanza',
    description: 'Registra un ingreso o gasto en FINANZAS',
    input_schema: {
      type: 'object',
      properties: {
        descripcion: { type: 'string', description: 'Descripción del movimiento' },
        tipo: { type: 'string', enum: ['Ingreso', 'Gasto'], description: 'Tipo de movimiento' },
        monto: { type: 'number', description: 'Monto en BOB' },
        categoria: { type: 'string', description: 'Categoría (ej: Boda, Servicio, Insumo)' },
      },
      required: ['descripcion', 'tipo', 'monto'],
    },
  },
  {
    name: 'agregar_lead',
    description: 'Registra un nuevo lead o consulta de cliente potencial en LEADS',
    input_schema: {
      type: 'object',
      properties: {
        nombre: { type: 'string', description: 'Nombre del lead' },
        tipo_consulta: { type: 'string', description: 'Tipo de servicio que busca (boda, foto, video, etc)' },
        fuente: { type: 'string', description: 'De dónde llegó (Instagram, WhatsApp, referido, etc)' },
        notas: { type: 'string', description: 'Notas adicionales' },
      },
      required: ['nombre', 'tipo_consulta'],
    },
  },
  {
    name: 'agregar_nota_boda',
    description: 'Agrega una nota o actualización a una boda existente en BODAS',
    input_schema: {
      type: 'object',
      properties: {
        pareja: { type: 'string', description: 'Nombre de la pareja o boda' },
        nota: { type: 'string', description: 'Nota o actualización a registrar' },
      },
      required: ['pareja', 'nota'],
    },
  },
  {
    name: 'registrar_cobro',
    description: 'Registra un cobro pendiente en ME DEBEN',
    input_schema: {
      type: 'object',
      properties: {
        quien: { type: 'string', description: 'Nombre del cliente o persona' },
        monto: { type: 'number', description: 'Monto en BOB' },
        concepto: { type: 'string', description: 'Por qué concepto' },
        fecha_limite: { type: 'string', description: 'Fecha límite de pago (DD/MM/YYYY)' },
      },
      required: ['quien', 'monto', 'concepto'],
    },
  },
  {
    name: 'marcar_tarea_completada',
    description: 'Marca una tarea como completada en TAREAS DIA',
    input_schema: {
      type: 'object',
      properties: {
        tarea: { type: 'string', description: 'Nombre o descripción de la tarea a marcar como completada' },
      },
      required: ['tarea'],
    },
  },
];

// ── Ejecutar herramienta de Claude ────────────────────────────────────────────
async function ejecutarHerramienta(sheets, toolName, toolInput) {
  const hoy = new Date().toISOString().split('T')[0];
  console.log(`🔧 Ejecutando herramienta: ${toolName}`, toolInput);

  switch (toolName) {
    case 'agregar_tarea':
      await agregarFila(sheets, 'TAREAS DIA', [
        toolInput.tarea, toolInput.prioridad || 'Media', toolInput.categoria || '', hoy, 'No', '', ''
      ]);
      return `✅ Tarea agregada: "${toolInput.tarea}"`;

    case 'registrar_finanza':
      await agregarFila(sheets, 'FINANZAS', [
        toolInput.descripcion, toolInput.tipo, toolInput.categoria || 'General', hoy, toolInput.monto
      ]);
      return `✅ ${toolInput.tipo} de ${toolInput.monto} BOB registrado`;

    case 'agregar_lead':
      await agregarFila(sheets, 'LEADS', [
        toolInput.nombre, toolInput.tipo_consulta, toolInput.fuente || 'WhatsApp', hoy, 'Nuevo', toolInput.notas || '', '', ''
      ]);
      return `✅ Lead registrado: ${toolInput.nombre}`;

    case 'agregar_nota_boda':
      await agregarFila(sheets, 'BODAS', [
        `[NOTA ${hoy}] ${toolInput.pareja}: ${toolInput.nota}`, '', '', '', '', '', '', ''
      ]);
      return `✅ Nota agregada a ${toolInput.pareja}`;

    case 'registrar_cobro':
      await agregarFila(sheets, 'ME DEBEN', [
        toolInput.quien, toolInput.monto, toolInput.concepto, toolInput.fecha_limite || '', 'Pendiente'
      ]);
      return `✅ Cobro registrado: ${toolInput.quien} debe ${toolInput.monto} BOB`;

    case 'marcar_tarea_completada': {
      // Buscar la tarea y marcarla
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEETS_ID,
        range: 'TAREAS DIA!A1:G100',
      });
      const filas = res.data.values || [];
      for (let i = 1; i < filas.length; i++) {
        if (filas[i][0] && filas[i][0].toLowerCase().includes(toolInput.tarea.toLowerCase())) {
          await actualizarCelda(sheets, 'TAREAS DIA', `E${i + 1}`, 'Sí');
          return `✅ Tarea marcada como completada: "${filas[i][0]}"`;
        }
      }
      return `⚠️ No encontré la tarea "${toolInput.tarea}" para marcarla`;
    }

    default:
      return `⚠️ Herramienta desconocida: ${toolName}`;
  }
}

// ── Historial ─────────────────────────────────────────────────────────────────
async function obtenerHistorial(sheets, from) {
  if (historialCache[from]?.length > 0) return historialCache[from];
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEETS_ID,
      range: 'HISTORIAL!A1:D500',
    });
    const filas = res.data.values || [];
    const mensajes = filas.slice(1)
      .filter(f => f[1] === from)
      .slice(-MAX_MENSAJES)
      .map(f => ({ role: f[2], content: f[3] }));
    historialCache[from] = mensajes;
    return mensajes;
  } catch { return []; }
}

function agregarAlHistorial(from, role, content) {
  if (!historialCache[from]) historialCache[from] = [];
  const contentStr = typeof content === 'string' ? content : JSON.stringify(content);
  historialCache[from].push({ role, content: contentStr });
  if (historialCache[from].length > MAX_MENSAJES) {
    historialCache[from] = historialCache[from].slice(-MAX_MENSAJES);
  }
}

async function guardarHistorial(sheets, from, role, content) {
  const ts = new Date().toISOString();
  const contentStr = typeof content === 'string' ? content : JSON.stringify(content);
  try {
    await agregarFila(sheets, 'HISTORIAL', [ts, from, role, contentStr.slice(0, 500)]);
  } catch (e) {
    console.log('⚠️ Error guardando historial:', e.message);
  }
}

// ── Webhook principal ─────────────────────────────────────────────────────────
app.post('/whatsapp', async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();

  try {
    const from = req.body.From;
    const texto = req.body.Body?.trim() || '';
    const numMedia = parseInt(req.body.NumMedia || '0');

    console.log(`📱 ${from}: "${texto}" | ${numMedia} imagen(es)`);

    const sheets = await getSheetsClient();
    const [contexto, historialPrevio] = await Promise.all([
      construirContexto(sheets),
      obtenerHistorial(sheets, from),
    ]);

    // ── Construir contenido del mensaje (texto + imágenes) ──────────────────
    let contenidoUsuario = [];

    // Agregar imágenes si las hay
    for (let i = 0; i < numMedia; i++) {
      const mediaUrl = req.body[`MediaUrl${i}`];
      const mediaType = req.body[`MediaContentType${i}`] || 'image/jpeg';
      if (mediaUrl && mediaType.startsWith('image/')) {
        try {
          const base64 = await descargarImagenBase64(mediaUrl);
          contenidoUsuario.push({
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: base64 },
          });
          console.log(`🖼️ Imagen procesada: ${mediaUrl}`);
        } catch (e) {
          console.log('⚠️ Error descargando imagen:', e.message);
        }
      }
    }

    // Agregar texto
    if (texto) {
      contenidoUsuario.push({ type: 'text', text: texto });
    } else if (contenidoUsuario.length === 0) {
      contenidoUsuario.push({ type: 'text', text: '(mensaje vacío)' });
    }

    // ── Construir mensajes con historial ────────────────────────────────────
    const mensajes = [
      ...historialPrevio.map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: contenidoUsuario },
    ];

    // ── Llamar a Claude con herramientas ────────────────────────────────────
    const SYSTEM = `Eres Nathbot, el asistente personal e inteligente de Nath Rivas. Ella dirige NR FILMS, productora de video y fotografía en Santa Cruz, Bolivia.

Tenés acceso completo a su base de datos en Google Sheets. Cuando Nath te mencione algo que deba registrarse (tarea, cobro, lead, gasto, ingreso, nota), usá las herramientas automáticamente SIN pedirle permiso. Actúa, no preguntes.

ESTADO ACTUAL DEL NEGOCIO:
${contexto}

PERSONALIDAD Y REGLAS:
- Respondés en español, tono directo y cálido como un socio de confianza
- Respuestas cortas y al punto (máximo 3 párrafos)
- Si ves una imagen o captura, la analizás y actuás según lo que ves
- Si Nath te manda una captura de conversación con un cliente, identificás si hay un lead nuevo y lo registrás
- Si ves un presupuesto o cotización en imagen, lo leés y resumís
- Actualizás Sheets proactivamente sin que te lo pidan
- Usás emojis con moderación
- Recordás todo lo que Nath te dijo en mensajes anteriores`;

    let respuestaFinal = '';
    let response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: SYSTEM,
      tools: TOOLS,
      messages: mensajes,
    });

    // ── Agentic loop: ejecutar herramientas hasta obtener respuesta final ───
    while (response.stop_reason === 'tool_use') {
      const toolUses = response.content.filter(b => b.type === 'tool_use');
      const toolResults = [];

      for (const toolUse of toolUses) {
        const resultado = await ejecutarHerramienta(sheets, toolUse.name, toolUse.input);
        toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: resultado });
        respuestaFinal += resultado + '\n';
      }

      // Continuar la conversación con los resultados
      mensajes.push({ role: 'assistant', content: response.content });
      mensajes.push({ role: 'user', content: toolResults });

      response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: SYSTEM,
        tools: TOOLS,
        messages: mensajes,
      });
    }

    // Texto final de Claude
    const textoFinal = response.content.find(b => b.type === 'text')?.text || '';
    if (textoFinal) respuestaFinal = textoFinal;

    // ── Guardar en historial ────────────────────────────────────────────────
    agregarAlHistorial(from, 'user', texto || '[imagen]');
    agregarAlHistorial(from, 'assistant', respuestaFinal);
    Promise.all([
      guardarHistorial(sheets, from, 'user', texto || '[imagen]'),
      guardarHistorial(sheets, from, 'assistant', respuestaFinal),
    ]).catch(e => console.log('⚠️ Error historial:', e.message));

    console.log(`🤖 Respuesta: ${respuestaFinal.slice(0, 100)}...`);
    twiml.message(respuestaFinal.trim());

  } catch (err) {
    console.error('❌ Error:', err.message);
    twiml.message('Hubo un error. Intenta de nuevo Nath.');
  }

  res.type('text/xml').send(twiml.toString());
});

// ── Generar y enviar resumen diario por WhatsApp ──────────────────────────────
async function enviarResumenDia() {
  const sheets = await getSheetsClient();
  const contexto = await construirContexto(sheets);

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: `Sos Nathbot, asistente de Nath Rivas (NR FILMS, Santa Cruz, Bolivia).
Generás el resumen diario para WhatsApp. Formato compacto, directo, en español.
Usá emojis para separar secciones. Máximo 10 líneas en total. Solo lo urgente e importante.`,
    messages: [{
      role: 'user',
      content: `Con este contexto del negocio, generá el resumen del día para enviar por WhatsApp a Nath.
Incluí: qué tiene pendiente hoy, cobros urgentes, próximas fechas importantes, y UNA sugerencia de acción prioritaria.
No incluyas secciones vacías.

${contexto}`,
    }],
  });

  const resumen = response.content[0].text;

  // Generar tareas del día en Sheets automáticamente
  await generarTareasDelDia(sheets);

  // Enviar por WhatsApp via Twilio
  const client = twilio(TWILIO_SID, TWILIO_TOKEN);
  const NATH_NUM = getEnv('NATH_WHATSAPP_NUMBER');
  await client.messages.create({
    from: 'whatsapp:+14155238886',
    to: NATH_NUM,
    body: `🤖 *Nathbot — Resumen del día*\n\n${resumen}`,
  });

  console.log('📤 Resumen diario enviado a Nath');
  return resumen;
}

// ── Generar tareas automáticas del día en Sheets ──────────────────────────────
async function generarTareasDelDia(sheets) {
  try {
    const hoy = new Date().toISOString().split('T')[0];
    const [bodas, tareas, contenido, meDeben] = await Promise.all([
      leerHoja(sheets, 'BODAS'),
      leerHoja(sheets, 'TAREAS DIA', 'A1:G100'),
      leerHoja(sheets, 'CONTENIDO', 'A1:H50'),
      leerHoja(sheets, 'ME DEBEN', 'A1:E50'),
    ]);

    // Evitar duplicar tareas auto-generadas de hoy
    const tareasHoy = tareas.filter(t => t['Fecha'] === hoy && t['Auto generada'] === 'Sí');
    if (tareasHoy.length > 0) return; // Ya generadas hoy

    const nuevasTareas = [];

    // Bodas en entrega → tarea de edición
    bodas.filter(b => b['Estado']?.match(/entrega/i)).forEach(b => {
      const pareja = b['Pareja'] || b['Nombre'] || '?';
      const saldo = b['Saldo pendiente'] || b['Saldo pendiente (BOB)'] || 0;
      const bloqueada = b['Estado']?.match(/bloqueada/i);
      nuevasTareas.push([
        `${bloqueada ? 'URGENTE cobrar y entregar' : 'Editar y entregar'}: ${pareja}`,
        bloqueada ? 'Urgente' : 'Alta', 'Edicion', hoy, 'No',
        bloqueada ? `Cobrar ${saldo} BOB primero` : '', 'Sí'
      ]);
    });

    // Cobros bloqueados → tarea urgente
    bodas.filter(b => b['Estado']?.match(/bloqueada/i)).forEach(b => {
      const pareja = b['Pareja'] || b['Nombre'] || '?';
      const saldo = b['Saldo pendiente'] || b['Saldo pendiente (BOB)'] || 0;
      nuevasTareas.push([`URGENTE cobrar ${saldo} BOB — ${pareja}`, 'Urgente', 'Administracion', hoy, 'No', '', 'Sí']);
    });

    // Cobros pendientes de ME DEBEN
    meDeben.filter(d => d['Estado'] === 'Pendiente').slice(0, 3).forEach(d => {
      nuevasTareas.push([`Cobrar a ${d['Quien'] || '?'}: ${d['Monto (BOB)']} BOB`, 'Alta', 'Administracion', hoy, 'No', d['Concepto'] || '', 'Sí']);
    });

    // Contenido programado hoy
    contenido.filter(c => c['Fecha publicacion'] === hoy && c['Estado'] !== 'Publicado').forEach(c => {
      nuevasTareas.push([`Publicar hoy: ${c['Nombre / Hook'] || '?'}`, 'Alta', 'Marketing', hoy, 'No', '', 'Sí']);
    });

    for (const tarea of nuevasTareas) {
      await agregarFila(sheets, 'TAREAS DIA', tarea);
    }
    console.log(`📋 ${nuevasTareas.length} tareas auto-generadas para hoy`);
  } catch (e) {
    console.log('⚠️ Error generando tareas:', e.message);
  }
}

// ── Endpoint para cron externo (cada 4 horas) ─────────────────────────────────
app.get('/resumen-dia', async (req, res) => {
  const secret = req.query.secret;
  if (secret !== (getEnv('CRON_SECRET') || 'nathbot2026')) {
    return res.status(401).send('No autorizado');
  }
  try {
    const resumen = await enviarResumenDia();
    res.json({ ok: true, resumen });
  } catch (e) {
    console.error('❌ Error resumen:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/', (req, res) => res.send('🤖 Nathbot v2 activo'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🤖 Nathbot v2 en puerto ${PORT}`));
