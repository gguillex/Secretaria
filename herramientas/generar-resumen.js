// Genera flujos/resumen-diario.json (el mensaje de WhatsApp de cada mañana con todo lo pendiente) a partir de:
//   - herramientas/flujo-resumen/*.js   código de los nodos Code
// Uso: node herramientas/generar-resumen.js
// Solo escribe el flujo de salida; no modifica ningún otro archivo.
//
// Los secretos no van en el JSON: las credenciales se eligen a mano al importar.

const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
const ruta = (...p) => path.join(RAIZ, ...p);
const SALIDA = ruta('flujos', 'resumen-diario.json');
const { prepararImportacion } = require('./comun/importacion');
const NOMBRE_FLUJO = 'Secretaria · Resumen diario';

const fallar = (msg) => {
  throw new Error(`generar-resumen: ${msg}`);
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

const id = (n) => `5ec7e7a3-${String(n).padStart(4, '0')}-4000-8000-${String(n).padStart(12, '0')}`;
const CFG = "$('Configuración').first().json.config";
const PASO = 240;

function nodoCode(n, nombre, posicion, archivo) {
  const codigo = leer(ruta('herramientas', 'flujo-resumen', archivo));
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
// Con la tabla vacía el GET devuelve cero items y el flujo se pararía: Always Output Data lo evita. Si la lectura FALLA el flujo
// se detiene con error (no se usa continueRegularOutput): un resumen "vacío" por un fallo sería un mensaje falso.
const lectura = { executeOnce: true, alwaysOutputData: true };

function construirFlujoBase() {
  const nodos = [
    {
      // 7:00 de la zona del flujo (Europe/Madrid), todos los días. n8n ajusta solo el cambio de hora de octubre y marzo.
      parameters: { rule: { interval: [{ field: 'days', daysInterval: 1, triggerAtHour: 7, triggerAtMinute: 0 }] } },
      id: id(1),
      name: 'Cada día a las 7:00',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.4,
      position: [0, -120],
    },
    { parameters: {}, id: id(2), name: 'Disparador manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 120] },
    nodoCode(3, 'Configuración', [PASO, 0], 'configuracion.js'),
    nodoHttp(4, 'Leer pendientes', [PASO * 2, 0], { method: 'GET', url: `={{ ${CFG}.supabase_url }}/rest/v1/items?select=id,tipo,titulo,contenido,lista,estado,fecha_inicio,fecha_fin,fecha_limite,recordar_en,zona_alarma,lugar_alarma,proyecto&estado=eq.pendiente&order=created_at.desc&limit=200`, ...supabase }, lectura),
    nodoHttp(5, 'Leer archivos', [PASO * 3, 0], { method: 'GET', url: `={{ ${CFG}.supabase_url }}/rest/v1/archivos?select=id,nombre,drive_url,created_at&estado=eq.pendiente&eliminado_at=is.null&order=created_at.asc&limit=100`, ...supabase }, lectura),
    // Último mensaje que has ESCRITO tú (los ids de WhatsApp empiezan por "wamid."): decide si la ventana de 24 h sigue abierta
    nodoHttp(6, 'Leer último mensaje', [PASO * 4, 0], { method: 'GET', url: `={{ ${CFG}.supabase_url }}/rest/v1/mensajes?select=created_at&wa_message_id=like.wamid.*&order=created_at.desc&limit=1`, ...supabase }, lectura),
    // Los viajes, el actual y los próximos (función viajes_vigentes). Es lo único que puede fallar sin parar el
    // resumen: sin la base de datos al día no hay viaje
    nodoHttp(9, 'Leer viaje', [PASO * 5, 160], { method: 'POST', url: `={{ ${CFG}.supabase_url }}/rest/v1/rpc/viajes_vigentes`, ...supabase, sendBody: true, specifyBody: 'json', jsonBody: '{}' }, { ...lectura, onError: 'continueRegularOutput' }),
    nodoCode(7, 'Redactar resumen', [PASO * 6, 0], 'redactar.js'),
    // Sin onError: si Meta rechaza el envío (token caducado, número mal puesto) la ejecución queda en rojo y se ve.
    nodoHttp(
      8,
      'Enviar WhatsApp',
      [PASO * 7, 0],
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

    nota(101, -40, -420, PASO * 2, 220, 4, '## ① Disparo y configuración\nSe ejecuta **cada día a las 7:00** (zona Europe/Madrid del flujo) o a mano (Disparador manual).\n**Configuración**: URL de Supabase, Phone number ID y la ventana de 24 h.'),
    nota(102, PASO * 2 - 40, -420, PASO * 4, 220, 5, '## ② Lecturas\nLee los items pendientes, los archivos sin clasificar (los que esperan en `Entrada`), la fecha de tu último mensaje y el viaje activo (base de datos al día). Si una de las tres primeras falla, el flujo se detiene con error: no se envía un resumen vacío por un fallo. `Leer viaje` no lo para (sin la base de datos al día, no hay viaje).'),
    nota(103, PASO * 6 - 40, -420, PASO * 2, 220, 6, '## ③ Mensaje y envío\n**Redactar resumen** manda el resumen completo como texto libre si escribiste hace menos de 23 h, aunque no haya nada (Meta solo admite plantillas fuera de la ventana de 24 h y no se usan: ese día no se manda). «Qué tengo pendiente» devuelve lo mismo cuando quieras.'),
    nota(
      104,
      -40,
      300,
      PASO * 3,
      300,
      2,
      '## Antes de publicar\n1. Credencial **Supabase API** en las cuatro lecturas y la **Header Auth de WhatsApp** (la misma del flujo de WhatsApp) en *Enviar WhatsApp*.\n2. Identificadores: `SUPABASE_URL` y `WHATSAPP_PHONE_NUMBER_ID` en el `.env` del servidor (no hace falta tocar **Configuración**).\n3. Pruébalo con *Disparador manual* y publica el flujo.',
    ),
  ];

  const a = (nombre) => ({ node: nombre, type: 'main', index: 0 });
  const conexiones = {
    'Cada día a las 7:00': { main: [[a('Configuración')]] },
    'Disparador manual': { main: [[a('Configuración')]] },
    Configuración: { main: [[a('Leer pendientes')]] },
    'Leer pendientes': { main: [[a('Leer archivos')]] },
    'Leer archivos': { main: [[a('Leer último mensaje')]] },
    'Leer último mensaje': { main: [[a('Leer viaje')]] },
    'Leer viaje': { main: [[a('Redactar resumen')]] },
    'Redactar resumen': { main: [[a('Enviar WhatsApp')]] },
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
