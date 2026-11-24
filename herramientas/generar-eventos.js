// Genera flujos/avisos-eventos.json (el aviso por WhatsApp de un evento que está a punto de empezar) a partir de:
//   - herramientas/flujo-eventos/*.js   código de los nodos Code
// Uso: node herramientas/generar-eventos.js
// Solo escribe el flujo de salida; no modifica ningún otro archivo.
//
// Los secretos no van en el JSON: las credenciales se eligen a mano al importar.

const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
const ruta = (...p) => path.join(RAIZ, ...p);
const SALIDA = ruta('flujos', 'avisos-eventos.json');
const { prepararImportacion } = require('./comun/importacion');
const NOMBRE_FLUJO = 'Secretaria · Avisos de eventos';

const fallar = (msg) => {
  throw new Error(`generar-eventos: ${msg}`);
};
const leer = (p) => {
  if (!fs.existsSync(p)) fallar(`no existe ${path.relative(RAIZ, p)}`);
  return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
};

// Los nodos usan "return" al nivel superior y variables de n8n: se comprueba que compilan
function comprobarSintaxis(codigo, nodo) {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  try {
    new AsyncFunction('$input', '$', '$env', codigo);
  } catch (e) {
    fallar(`el código de "${nodo}" no compila: ${e.message}`);
  }
}

const id = (n) => `5ec7e7a5-${String(n).padStart(4, '0')}-4000-8000-${String(n).padStart(12, '0')}`;
const CFG = "$('Configuración').first().json.config";
const PASO = 240;

function nodoCode(n, nombre, posicion, archivo) {
  const codigo = leer(ruta('herramientas', 'flujo-eventos', archivo));
  comprobarSintaxis(codigo, nombre);
  return { parameters: { jsCode: codigo }, id: id(n), name: nombre, type: 'n8n-nodes-base.code', typeVersion: 2, position: posicion };
}

function nodoHttp(n, nombre, posicion, parametros, extra = {}) {
  return { parameters: { options: {}, ...parametros }, id: id(n), name: nombre, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: posicion, ...extra };
}

function nota(n, x, y, ancho, alto, color, contenido) {
  return { parameters: { content: contenido, height: alto, width: ancho, color }, id: id(n), name: `Nota ${n - 100}`, type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [x, y] };
}

const supabase = { authentication: 'predefinedCredentialType', nodeCredentialType: 'supabaseApi' };

function construirFlujoBase() {
  const nodos = [
    {
      // Cada minuto: el aviso se calcula con la hora exacta (30 min antes del evento) y un minuto de retraso es aceptable
      parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: 1 }] } },
      id: id(1),
      name: 'Cada minuto',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.4,
      position: [0, -120],
    },
    { parameters: {}, id: id(2), name: 'Disparador manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 120] },
    nodoCode(3, 'Configuración', [PASO, 0], 'configuracion.js'),
    // Eventos pendientes con el aviso ya vencido, sin enviar y que aún no han empezado. Con cero resultados no se pararía el flujo
    // (Always Output Data) y "Filtrar avisos" decide. Si la lectura FALLA el flujo se detiene con error.
    nodoHttp(
      4,
      'Leer avisos vencidos',
      [PASO * 2, 0],
      {
        method: 'GET',
        url: `={{ ${CFG}.supabase_url }}/rest/v1/items?select=id,tipo,titulo,estado,fecha_inicio,zona_alarma,lugar_alarma,aviso_whatsapp_en,aviso_whatsapp_enviado_at&tipo=eq.evento&estado=eq.pendiente&aviso_whatsapp_en=lte.{{ new Date().toISOString() }}&aviso_whatsapp_enviado_at=is.null&fecha_inicio=gt.{{ new Date().toISOString() }}&order=fecha_inicio.asc&limit=50`,
        ...supabase,
      },
      { executeOnce: true, alwaysOutputData: true },
    ),
    nodoCode(5, 'Filtrar avisos', [PASO * 3, 0], 'filtrar.js'),
    // Último mensaje que has ESCRITO tú (los ids de WhatsApp empiezan por "wamid."): decide si la ventana de 24 h sigue abierta
    nodoHttp(6, 'Leer último mensaje', [PASO * 4, 0], { method: 'GET', url: `={{ ${CFG}.supabase_url }}/rest/v1/mensajes?select=created_at&wa_message_id=like.wamid.*&order=created_at.desc&limit=1`, ...supabase }, { executeOnce: true, alwaysOutputData: true }),
    nodoCode(7, 'Redactar aviso', [PASO * 5, 0], 'redactar.js'),
    // Sin onError: si Meta rechaza el envío la ejecución queda en rojo y "Marcar avisados" NO se ejecuta (el aviso se reintenta).
    nodoHttp(
      8,
      'Enviar WhatsApp',
      [PASO * 6, 0],
      {
        method: 'POST',
        url: `=https://graph.facebook.com/{{ ${CFG}.graph_version }}/{{ ${CFG}.phone_number_id }}/messages`,
        authentication: 'genericCredentialType',
        genericAuthType: 'httpHeaderAuth',
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify($json.cuerpo) }}',
      },
      { retryOnFail: true, maxTries: 2, waitBetweenTries: 3000 },
    ),
    // Solo marca los que siguen teniendo aviso y no estaban enviados: si el evento se movió entre la lectura y ahora, el trigger de
    // la base de datos ya anuló su aviso y no se toca. Tres intentos: si falla el marcado el aviso se repetiría cada minuto.
    nodoHttp(
      9,
      'Marcar avisados',
      [PASO * 7, 0],
      {
        method: 'PATCH',
        url: `={{ ${CFG}.supabase_url }}/rest/v1/items?id=in.({{ $('Redactar aviso').first().json.ids.join(',') }})&tipo=eq.evento&aviso_whatsapp_en=not.is.null&aviso_whatsapp_enviado_at=is.null`,
        ...supabase,
        sendHeaders: true,
        specifyHeaders: 'keypair',
        headerParameters: { parameters: [{ name: 'Prefer', value: 'return=minimal' }] },
        sendBody: true,
        specifyBody: 'json',
        jsonBody: "={{ JSON.stringify($('Redactar aviso').first().json.marca) }}",
      },
      { retryOnFail: true, maxTries: 3, waitBetweenTries: 2000 },
    ),

    // Rama paralela al marcado: anota qué citas iban en este aviso para poder responderle. Si la anotación falla, el
    // aviso ya está enviado y marcado: solo se pierde poder responderle («10 minutos más»), así que no detiene el flujo.
    nodoCode(10, 'Preparar registro del aviso', [PASO * 7, 220], 'registrar-aviso.js'),
    nodoHttp(
      11,
      'Guardar aviso enviado',
      [PASO * 8, 220],
      {
        method: 'POST',
        url: '={{ $json.url }}',
        ...supabase,
        sendHeaders: true,
        specifyHeaders: 'keypair',
        headerParameters: { parameters: [{ name: 'Prefer', value: 'resolution=ignore-duplicates,return=minimal' }] },
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify($json.cuerpo) }}',
      },
      { retryOnFail: true, maxTries: 3, waitBetweenTries: 2000, onError: 'continueRegularOutput' },
    ),

    nota(101, -40, -420, PASO * 2, 220, 4, '## ① Disparo y configuración\nSe ejecuta **cada minuto** o a mano (Disparador manual).\n**Configuración**: URL de Supabase, Phone number ID y la ventana de 24 h.'),
    nota(102, PASO * 2 - 40, -420, PASO * 2, 220, 5, '## ② Qué avisar\nEl flujo de **Sincronizar Calendar** calcula `aviso_whatsapp_en` (eventos del mismo día o con poco margen). Aquí se leen los vencidos, sin enviar y que aún no han empezado, y se revalida cada fila.'),
    nota(103, PASO * 4 - 40, -420, PASO * 4, 220, 6, '## ③ Envío\nSolo se envía si escribiste hace menos de 23 h (texto libre; no hay plantilla para este aviso). Si Meta acepta el envío, **Marcar avisados** anota `aviso_whatsapp_enviado_at`; si lo rechaza, la ejecución queda en rojo y se reintenta el minuto siguiente.'),
    nota(
      104,
      -40,
      300,
      PASO * 3,
      300,
      2,
      '## Antes de publicar\n0. Necesita la base de datos al día (zona de cada cita: *Leer avisos vencidos* la lee; sin ella falla).\n1. Credencial **Supabase API** en *Leer avisos vencidos*, *Leer último mensaje*, *Marcar avisados* y *Guardar aviso enviado*, y la **Header Auth de WhatsApp** (la misma del flujo de WhatsApp) en *Enviar WhatsApp*.\n2. Identificadores: `SUPABASE_URL` y `WHATSAPP_PHONE_NUMBER_ID` en el `.env` del servidor (no hace falta tocar **Configuración**).\n3. Pruébalo con *Disparador manual* (sin avisos vencidos termina sin hacer nada) y publica el flujo.\n4. Elige «Secretaria · Aviso de fallos» como Error workflow.',
    ),
  ];

  const a = (nombre) => ({ node: nombre, type: 'main', index: 0 });
  const conexiones = {
    'Cada minuto': { main: [[a('Configuración')]] },
    'Disparador manual': { main: [[a('Configuración')]] },
    Configuración: { main: [[a('Leer avisos vencidos')]] },
    'Leer avisos vencidos': { main: [[a('Filtrar avisos')]] },
    'Filtrar avisos': { main: [[a('Leer último mensaje')]] },
    'Leer último mensaje': { main: [[a('Redactar aviso')]] },
    'Redactar aviso': { main: [[a('Enviar WhatsApp')]] },
    'Enviar WhatsApp': { main: [[a('Marcar avisados'), a('Preparar registro del aviso')]] },
    'Preparar registro del aviso': { main: [[a('Guardar aviso enviado')]] },
  };

  return { name: NOMBRE_FLUJO, nodes: nodos, connections: conexiones, pinData: {}, settings: { executionOrder: 'v1', timezone: 'Europe/Madrid' } };
}

function generar() {
  const flujo = construirFlujo();
  fs.writeFileSync(SALIDA, JSON.stringify(flujo, null, 2) + '\n', 'utf8');
  console.log(`Escrito ${path.relative(RAIZ, SALIDA)}: ${flujo.nodes.length} nodos.`);
}

// Ids fijos, credenciales por nombre, subflujo y Error workflow ya elegidos (herramientas/comun/importacion.js)
function construirFlujo() {
  return prepararImportacion(construirFlujoBase(), SALIDA);
}

module.exports = { construirFlujo, generar };

if (require.main === module) generar();
