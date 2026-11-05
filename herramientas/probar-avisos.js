// Pruebas sin red ni coste del flujo "Aviso de fallos" (flujos/aviso-fallos.json).
// Ejecuta el código real de herramientas/flujo-avisos/*.js con entradas simuladas y un reloj fijo.
// Uso: node herramientas/probar-avisos.js

const fs = require('fs');
const path = require('path');
const { construirFlujo } = require('./generar-avisos.js');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const leer = (...p) => fs.readFileSync(path.join(__dirname, ...p), 'utf8').replace(/\r\n/g, '\n');
const CODIGO_CONFIG = leer('flujo-avisos', 'configuracion.js');
const CODIGO_REDACTAR = leer('flujo-avisos', 'redactar.js');

let pasan = 0;
const fallan = [];
function afirmar(nombre, condicion, detalle) {
  if (condicion) pasan += 1;
  else {
    fallan.push(nombre);
    console.log(`  FALLA: ${nombre}${detalle ? `\n         ${detalle}` : ''}`);
  }
}
async function lanza(nombre, promesa, trozo) {
  try {
    await promesa;
    afirmar(nombre, false, 'debía lanzar un error y no lo hizo');
  } catch (e) {
    afirmar(nombre, String(e.message).includes(trozo), `error recibido: ${e.message}`);
  }
}

// Reloj fijo: solo cambia "new Date()" sin argumentos y Date.now()
const RealDate = Date;
let ahoraMs = new RealDate('2026-10-12T10:00:00.000Z').getTime();
class Fija extends RealDate {
  constructor(...a) {
    if (a.length === 0) super(ahoraMs);
    else super(...a);
  }
  static now() {
    return ahoraMs;
  }
}
globalThis.Date = Fija;
const avanzar = (min) => {
  ahoraMs += min * 60000;
};

const CONFIG = {
  phone_number_id: '123456789012345',
  graph_version: 'v26.0',
  enfriamiento_min: 60,
  max_avisos_dia: 10,
  tolerancia_red_min: 30,
  flujos_periodicos: ['Secretaria · Latido', 'Secretaria · Sincronizar Calendar'],
};
const ENV = { WHATSAPP_NUMERO_PERMITIDO: '34600111222' };

function simular(nodos) {
  return (nombre) => {
    if (nombre === 'Configuración') return { first: () => ({ json: { config: nodos.config ?? CONFIG } }) };
    if (!(nombre in nodos)) throw new Error(`Node "${nombre}" hasn't been executed`);
    const items = nodos[nombre].map((json) => ({ json }));
    return { all: () => items, first: () => items[0] };
  };
}
async function correr(codigo, { input = [], nodos = {}, env = ENV, almacen = {} } = {}) {
  const items = input.map((json) => ({ json }));
  const fn = new AsyncFunction('$input', '$', '$env', '$getWorkflowStaticData', codigo);
  const salida = await fn({ all: () => items, first: () => items[0] }, simular(nodos), env, () => almacen);
  return salida.map((x) => x.json);
}

// Lo que entrega el Error Trigger (documentación de n8n)
const fallo = (extra = {}) => ({
  execution: { id: '231', url: 'https://n8n.local/execution/231', error: { message: 'Google Calendar: HTTP 403 forbidden', stack: 'Error: x\n at y' }, lastNodeExecuted: 'Google Calendar', mode: 'trigger' },
  workflow: { id: '7', name: 'Secretaria · Sincronizar Calendar' },
  ...extra,
});
// Como en el flujo real: lo que llega a "Redactar aviso" es la salida de "Configuración" (la configuración, NO el fallo); el fallo se lee del Error Trigger
const aviso = (datos, almacen, opciones = {}) =>
  correr(CODIGO_REDACTAR, { input: [{ config: opciones.nodos?.config ?? CONFIG }], almacen, ...opciones, nodos: { ...(opciones.nodos ?? {}), 'Error Trigger': [datos] } });

async function main() {
  console.log('Redactar aviso');
  {
    const [r] = await aviso(fallo(), {});
    afirmar('el aviso nombra el flujo, el nodo, el error y la ejecución', r.texto === '⚠️ Fallo en «Secretaria · Sincronizar Calendar» (nodo «Google Calendar»): Google Calendar: HTTP 403 forbidden. Ejecución 231.', r.texto);
    afirmar('texto libre dirigido al número permitido, solo dígitos', r.cuerpo_texto.type === 'text' && r.cuerpo_texto.to === '34600111222' && r.cuerpo_texto.text.body === r.texto && r.cuerpo_texto.messaging_product === 'whatsapp');
    afirmar('no hay plantilla de reserva: solo el cuerpo de texto libre', !('cuerpo_plantilla' in r) && !JSON.stringify(r).includes('template'), Object.keys(r).join());

    const [sinStack] = await aviso(fallo({ execution: { id: '5', error: { message: 'Linea 1\nlinea 2\n\ttabulada' }, lastNodeExecuted: 'Nodo' } }), {});
    afirmar('los saltos de línea del error se aplanan', !sinStack.texto.includes('\n') && sinStack.texto.includes('Linea 1 linea 2 tabulada'), sinStack.texto);

    const [largo] = await aviso(fallo({ execution: { id: '5', error: { message: 'x '.repeat(500) }, lastNodeExecuted: 'N' } }), {});
    afirmar('un error larguísimo se recorta', largo.texto.length < 400 && largo.texto.includes('…'), String(largo.texto.length));

    const [secreto] = await aviso(fallo({ execution: { id: '6', error: { message: 'Fallo en https://graph.facebook.com/v26.0/123/messages?access_token=EAAGm0PX4ZCpsBAKZAwesomeTokenQWERTYUIOP1234567890 con 401' }, lastNodeExecuted: 'Enviar WhatsApp' } }), {});
    afirmar('una URL o un token largo no viaja por WhatsApp', !secreto.texto.includes('EAAG') && !secreto.texto.includes('access_token') && secreto.texto.includes('con 401'), secreto.texto);
    const [claveLarga] = await aviso(fallo({ execution: { id: '7', error: { message: `clave ${'A1b2'.repeat(15)} fin` }, lastNodeExecuted: 'N' } }), {});
    afirmar('una cadena larga sin espacios se sustituye por puntos suspensivos', !claveLarga.texto.includes('A1b2A1b2') && claveLarga.texto.includes('clave … fin'), claveLarga.texto);

    const [triggerFalla] = await aviso({ trigger: { error: { message: 'Credenciales caducadas', node: { name: 'Programación' } }, mode: 'trigger' }, workflow: { id: '2', name: 'Secretaria · Resumen diario' } }, {});
    afirmar('si falla el disparador del propio flujo, usa trigger.error y no incluye ejecución', triggerFalla.texto === '⚠️ Fallo en «Secretaria · Resumen diario» (nodo «Programación»): Credenciales caducadas.', triggerFalla.texto);
    const [triggerTexto] = await aviso({ trigger: { error: { message: 'x', node: 'Webhook' } }, workflow: { name: 'W' } }, {});
    afirmar('el nodo del disparador puede venir como texto', triggerTexto.texto.includes('(nodo «Webhook»)'));
    const [vacio] = await aviso({}, {});
    afirmar('sin ningún dato avisa igualmente con un texto genérico', vacio.texto === '⚠️ Fallo en «un flujo»: sin detalle.', vacio.texto);
    const [idRaro] = await aviso(fallo({ execution: { id: '1; drop table', error: { message: 'm' }, lastNodeExecuted: 'N' } }), {});
    afirmar('un id de ejecución raro no se incluye', !idRaro.texto.includes('Ejecución'), idRaro.texto);
    const [sinNodo] = await aviso(fallo({ execution: { id: '9', error: { message: 'm' } } }), {});
    afirmar('sin nodo no pone paréntesis vacíos', !sinNodo.texto.includes('()') && !sinNodo.texto.includes('(nodo'), sinNodo.texto);

    await lanza('sin número permitido falla con un mensaje claro', aviso(fallo(), {}, { env: {} }), 'WHATSAPP_NUMERO_PERMITIDO');
  }

  console.log('Límites: enfriamiento y tope diario');
  {
    const almacen = {};
    const f1 = fallo();
    const f2 = fallo({ workflow: { id: '8', name: 'Secretaria · Sincronizar Drive' } });
    afirmar('el primer fallo avisa', (await aviso(f1, almacen)).length === 1);
    avanzar(1);
    afirmar('el mismo flujo, un minuto después: se calla (no un mensaje por minuto)', (await aviso(f1, almacen)).length === 0);
    avanzar(1);
    afirmar('y dos minutos después, también', (await aviso(f1, almacen)).length === 0);
    afirmar('otro flujo no queda callado por el primero', (await aviso(f2, almacen)).length === 1);
    avanzar(30);
    afirmar('media hora después, sigue callado', (await aviso(f1, almacen)).length === 0);
    avanzar(30);
    const [otraVez] = await aviso(f1, almacen);
    afirmar('pasada la hora vuelve a avisar y cuenta cuántas veces se calló', otraVez && otraVez.texto.endsWith('Se repitió 3 veces desde el último aviso.'), otraVez?.texto);
    avanzar(61);
    const [limpio] = await aviso(f1, almacen);
    afirmar('si no hubo repeticiones entre avisos, no dice nada de repeticiones', limpio && !limpio.texto.includes('repitió'), limpio?.texto);

    // Tope diario
    const alm2 = {};
    const cfgTope = { ...CONFIG, max_avisos_dia: 3 };
    const wf = (n) => fallo({ workflow: { id: String(n), name: `Flujo ${n}` } });
    const enviados = [];
    for (let n = 1; n <= 5; n++) enviados.push((await aviso(wf(n), alm2, { nodos: { config: cfgTope } })).length);
    afirmar('con tope de 3 al día, el cuarto y el quinto aviso se callan', enviados.join() === '1,1,1,0,0', enviados.join());
    avanzar(24 * 60);
    afirmar('al día siguiente el contador se reinicia', (await aviso(wf(9), alm2, { nodos: { config: cfgTope } })).length === 1);
    afirmar('el contador guarda la fecha de Madrid y los enviados', alm2.dia.enviados === 1 && /^\d{4}-\d{2}-\d{2}$/.test(alm2.dia.fecha), JSON.stringify(alm2.dia));
    const dañado = { ultimos: 'no soy un objeto', dia: null };
    afirmar('un almacén dañado no rompe el aviso', (await aviso(fallo(), dañado)).length === 1);
  }

  console.log('Errores de red en flujos periódicos');
  {
    const red = (nombre, mensaje) => fallo({ workflow: { id: '1', name: nombre }, execution: { id: '77', error: { message: mensaje }, lastNodeExecuted: 'Leer pendientes' } });
    const timeout = red('Secretaria · Sincronizar Calendar', 'The connection timed out, consider setting the Retry on Fail option');
    const almacen = {};
    afirmar('un timeout de un flujo periódico no avisa a la primera', (await aviso(timeout, almacen)).length === 0);
    avanzar(5);
    afirmar('ni cinco minutos después', (await aviso(timeout, almacen)).length === 0);
    for (let m = 10; m <= 25; m += 5) {
      avanzar(5);
      await aviso(timeout, almacen);
    }
    afirmar('ni a los 25 minutos seguidos', (await aviso(timeout, almacen)).length === 0);
    avanzar(5);
    const [largo] = await aviso(timeout, almacen);
    afirmar('a los 30 minutos seguidos avisa y dice cuánto lleva', largo && largo.texto.includes('Lleva 30 min fallando por la red.'), largo?.texto);

    const alm2 = {};
    { const alm500 = {}; afirmar('un 500 de Google («The service was not able to process your request», visto en Vigilar Drive) también se tolera', (await aviso(red('Secretaria · Latido', 'The service was not able to process your request'), alm500)).length === 0); }
    afirmar('un error de verdad (un 404) sigue avisando enseguida', (await aviso(red('Secretaria · Latido', 'The resource you are requesting could not be found (404)'), {})).length === 1);
    afirmar('un Bad gateway también se tolera', (await aviso(red('Secretaria · Latido', 'Bad gateway - the server returned an invalid response'), alm2)).length === 0);
    avanzar(20);
    afirmar('pero un hueco de más de 15 min sin fallos abre un episodio nuevo', (await aviso(red('Secretaria · Latido', 'Bad gateway'), alm2)).length === 0);

    afirmar('un error que no es de red avisa enseguida en un flujo periódico', (await aviso(red('Secretaria · Sincronizar Calendar', 'Google Calendar: HTTP 403 forbidden'), {})).length === 1);
    afirmar('un timeout en un flujo que no es periódico avisa enseguida', (await aviso(red('Secretaria · Resumen diario', 'The connection timed out'), {})).length === 1);
    const sinTolerancia = { nodos: { config: { ...CONFIG, tolerancia_red_min: 0 } } };
    afirmar('con tolerancia 0 avisa siempre, como antes', (await aviso(timeout, {}, sinTolerancia)).length === 1);
    afirmar('una configuración sin las claves nuevas no rompe el aviso', (await aviso(timeout, {}, { nodos: { config: { phone_number_id: '1', graph_version: 'v26.0', enfriamiento_min: 60, max_avisos_dia: 10 } } })).length === 1);
    const dañado = { red: 'no soy un objeto' };
    afirmar('un almacén dañado no rompe la tolerancia', (await aviso(timeout, dañado)).length === 0 && typeof dañado.red === 'object');
  }

  console.log('Configuración');
  {
    await lanza('con el marcador de ejemplo avisa de qué falta', correr(CODIGO_CONFIG), 'PHONE_NUMBER_ID');
    const buena = CODIGO_CONFIG.replace('TU-PHONE-NUMBER-ID', '123456789012345');
    const [c] = await correr(buena);
    afirmar('con valores válidos devuelve la configuración por defecto', !('nombre_plantilla' in c.config) && !('max_parametro' in c.config) && c.config.enfriamiento_min === 60 && c.config.max_avisos_dia === 10 && c.config.graph_version === 'v26.0', JSON.stringify(c));
    await lanza('rechaza un enfriamiento de 0 minutos', correr(buena.replace('ENFRIAMIENTO_MIN = 60', 'ENFRIAMIENTO_MIN = 0')), 'ENFRIAMIENTO_MIN');
    await lanza('rechaza un tope diario absurdo', correr(buena.replace('MAX_AVISOS_DIA = 10', 'MAX_AVISOS_DIA = 5000')), 'MAX_AVISOS_DIA');
    await lanza('rechaza una versión de la API mal escrita', correr(buena.replace("'v26.0'", "'26'")), 'GRAPH_VERSION');
  }

  console.log('Estructura del flujo');
  {
    const f = construirFlujo();
    const por = Object.fromEntries(f.nodes.map((x) => [x.name, x]));
    const trabajo = f.nodes.filter((x) => !x.type.endsWith('stickyNote'));
    afirmar('4 nodos de trabajo', trabajo.length === 4, String(trabajo.length));
    afirmar('zona Europe/Madrid', f.settings.timezone === 'Europe/Madrid');
    afirmar('el disparador es el Error Trigger', por['Error Trigger'].type === 'n8n-nodes-base.errorTrigger');
    afirmar('ids únicos', new Set(f.nodes.map((x) => x.id)).size === f.nodes.length);
    const cadena = ['Error Trigger', 'Configuración', 'Redactar aviso', 'Enviar texto'];
    afirmar('la cadena está completa y en orden', cadena.slice(0, -1).every((n, i) => f.connections[n]?.main[0][0].node === cadena[i + 1]));
    const t = por['Enviar texto'];
    afirmar('Enviar texto: POST a Graph con Header Auth, dos intentos y SIN ocultar el fallo (la ejecución queda en rojo si Meta lo rechaza)', t.parameters.method === 'POST' && t.parameters.url.includes('graph.facebook.com') && t.parameters.authentication === 'genericCredentialType' && t.parameters.genericAuthType === 'httpHeaderAuth' && t.parameters.jsonBody === '={{ JSON.stringify($json.cuerpo_texto) }}' && t.retryOnFail === true && t.maxTries === 2 && t.onError === undefined && !JSON.stringify(t.parameters).includes('neverError'));
    afirmar('no queda ninguna plantilla en el flujo: ni nodos de plantilla, ni mensajes de tipo template, ni el nombre aviso_fallo', !f.nodes.some((x) => /plantilla/i.test(x.name)) && !JSON.stringify(f).includes('template') && !JSON.stringify(f).includes('aviso_fallo') && !JSON.stringify(f).includes('nombre_plantilla'));
    afirmar('ningún nodo contiene una clave', !/EAA[A-Za-z0-9]{20,}|sb_secret_|AIza/.test(JSON.stringify(f)));
    const actual = JSON.stringify(f, null, 2) + '\n';
    const enDisco = fs.existsSync(path.join(__dirname, '..', 'flujos', 'aviso-fallos.json')) ? leer('..', 'flujos', 'aviso-fallos.json') : null;
    afirmar('flujos/aviso-fallos.json está al día (si no, ejecuta node herramientas/generar-avisos.js)', enDisco === actual);
  }

  globalThis.Date = RealDate;
  console.log(`\n${pasan} pruebas correctas, ${fallan.length} fallos.`);
  if (fallan.length) {
    console.log(fallan.map((x) => ` - ${x}`).join('\n'));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  globalThis.Date = RealDate;
  console.error(e);
  process.exit(1);
});
