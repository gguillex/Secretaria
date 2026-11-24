// Genera flujos/recordatorios.json (los recordatorios cortos: avisos por WhatsApp 1 hora antes, 30 minutos antes y a la hora) a partir de:
//   - herramientas/flujo-recordatorios/*.js   código de los nodos Code
// Uso: node herramientas/generar-recordatorios.js
// Solo escribe el flujo de salida; no modifica ningún otro archivo.
//
// Los secretos no van en el JSON: las credenciales se eligen a mano al importar.

const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
const ruta = (...p) => path.join(RAIZ, ...p);
const SALIDA = ruta('flujos', 'recordatorios.json');
const { prepararImportacion } = require('./comun/importacion');
const NOMBRE_FLUJO = 'Secretaria · Recordatorios';

const fallar = (msg) => {
  throw new Error(`generar-recordatorios: ${msg}`);
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

const id = (n) => `5ec7e7a7-${String(n).padStart(4, '0')}-4000-8000-${String(n).padStart(12, '0')}`;
const CFG = "$('Configuración').first().json.config";
const PASO = 240;

function nodoCode(n, nombre, posicion, archivo) {
  const codigo = leer(ruta('herramientas', 'flujo-recordatorios', archivo));
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
      // Cada minuto: los avisos se mandan a su hora exacta; un minuto de retraso es aceptable
      parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: 1 }] } },
      id: id(1),
      name: 'Cada minuto',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.4,
      position: [0, -120],
    },
    { parameters: {}, id: id(2), name: 'Disparador manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 120] },
    nodoCode(3, 'Configuración', [PASO, 0], 'configuracion.js'),
    // Tareas pendientes con hora de aviso que ya está dentro de la antelación máxima (la más temprana de AVISOS_MIN) o ya pasó. Con cero
    // resultados no se pararía el flujo (Always Output Data) y "Filtrar recordatorios" decide. Si la lectura FALLA el flujo se detiene con error.
    nodoHttp(
      4,
      'Leer recordatorios',
      [PASO * 2, 0],
      {
        method: 'GET',
        url: `={{ ${CFG}.supabase_url }}/rest/v1/items?select=id,titulo,estado,recordar_en,zona_alarma,lugar_alarma,recordatorio_avisos,updated_at&tipo=eq.tarea&estado=eq.pendiente&recordar_en=lte.{{ new Date(Date.now() + Math.max(...${CFG}.avisos_min) * 60000).toISOString() }}&order=recordar_en.asc&limit=50`,
        ...supabase,
      },
      { executeOnce: true, alwaysOutputData: true },
    ),
    nodoCode(5, 'Filtrar recordatorios', [PASO * 3, 0], 'filtrar.js'),
    // Último mensaje que has ESCRITO tú (los ids de WhatsApp empiezan por "wamid."): decide si la ventana de 24 h sigue abierta
    nodoHttp(6, 'Leer último mensaje', [PASO * 4, 0], { method: 'GET', url: `={{ ${CFG}.supabase_url }}/rest/v1/mensajes?select=created_at&wa_message_id=like.wamid.*&order=created_at.desc&limit=1`, ...supabase }, { executeOnce: true, alwaysOutputData: true }),
    nodoCode(7, 'Redactar recordatorio', [PASO * 5, 0], 'redactar.js'),
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
    nodoCode(9, 'Preparar marcas', [PASO * 7, 0], 'preparar-marcas.js'),
    // Una petición por recordatorio. Tres intentos: si falla el marcado el aviso se repetiría cada minuto.
    nodoHttp(
      10,
      'Marcar avisados',
      [PASO * 8, 0],
      {
        method: 'PATCH',
        url: '={{ $json.url }}',
        ...supabase,
        sendHeaders: true,
        specifyHeaders: 'keypair',
        headerParameters: { parameters: [{ name: 'Prefer', value: 'return=minimal' }] },
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify($json.cuerpo) }}',
      },
      { retryOnFail: true, maxTries: 3, waitBetweenTries: 2000 },
    ),
    // Rama paralela al marcado: anota qué recordatorios iban en este aviso para poder responderle. Si la anotación falla, el
    // aviso ya está enviado y marcado: solo se pierde poder responderle («10 minutos más»), así que no detiene el flujo.
    nodoCode(11, 'Preparar registro del aviso', [PASO * 7, 220], 'registrar-aviso.js'),
    nodoHttp(
      12,
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

    nota(101, -40, -420, PASO * 2, 220, 4, '## ① Disparo y configuración\nSe ejecuta **cada minuto** o a mano (Disparador manual).\n**Configuración**: URL de Supabase, Phone number ID, los avisos (`AVISOS_MIN`: 1 hora antes, 30 minutos antes y a la hora) y la ventana de 24 h.'),
    nota(102, PASO * 2 - 40, -420, PASO * 2, 220, 5, '## ② Qué avisar\nUn recordatorio es una **tarea con hora de aviso** (`recordar_en`): no va a Calendar y no choca con las citas. Aquí se leen los que están a punto, se revalida cada fila y se decide qué aviso toca (el más cercano a la hora; los avisos que ya no tienen sentido no se mandan).'),
    nota(103, PASO * 4 - 40, -420, PASO * 5, 220, 6, '## ③ Envío y marcado\nSolo se envía si escribiste hace menos de 23 h (texto libre). Si Meta acepta el envío, **Marcar avisados** anota los avisos enviados (y, tras el aviso «a la hora», da el recordatorio por hecho); si lo rechaza, la ejecución queda en rojo y se reintenta el minuto siguiente. Con la ventana cerrada no se manda nada y el aviso espera: sale en cuanto vuelvas a escribir.'),
    nota(
      104,
      -40,
      300,
      PASO * 3,
      320,
      2,
      '## Antes de publicar\n1. Base de datos instalada y al día en Supabase (`supabase/instalar.sql`; la zona de cada alarma la lee *Leer recordatorios*: sin ella falla).\n2. Credencial **Supabase API** en *Leer recordatorios*, *Leer último mensaje*, *Marcar avisados* y *Guardar aviso enviado*, y la **Header Auth de WhatsApp** (la misma del flujo de WhatsApp) en *Enviar WhatsApp*.\n3. Identificadores: `SUPABASE_URL` y `WHATSAPP_PHONE_NUMBER_ID` en el `.env` del servidor (no hace falta tocar **Configuración**).\n4. Pruébalo con *Disparador manual* (sin recordatorios a punto termina sin hacer nada) y publica el flujo.\n5. Elige «Secretaria · Aviso de fallos» como Error workflow.',
    ),
  ];

  const a = (nombre) => ({ node: nombre, type: 'main', index: 0 });
  const conexiones = {
    'Cada minuto': { main: [[a('Configuración')]] },
    'Disparador manual': { main: [[a('Configuración')]] },
    Configuración: { main: [[a('Leer recordatorios')]] },
    'Leer recordatorios': { main: [[a('Filtrar recordatorios')]] },
    'Filtrar recordatorios': { main: [[a('Leer último mensaje')]] },
    'Leer último mensaje': { main: [[a('Redactar recordatorio')]] },
    'Redactar recordatorio': { main: [[a('Enviar WhatsApp')]] },
    'Enviar WhatsApp': { main: [[a('Preparar marcas'), a('Preparar registro del aviso')]] },
    'Preparar marcas': { main: [[a('Marcar avisados')]] },
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
