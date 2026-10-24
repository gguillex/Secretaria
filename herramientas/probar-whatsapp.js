// Pruebas sin red ni coste del flujo "Secretaria · WhatsApp" (flujos/whatsapp.json).
// Ejecuta el código real de herramientas/flujo-whatsapp/*.js con entradas simuladas.
// Uso: node herramientas/probar-whatsapp.js

const fs = require('fs');
const { credencialesSoloPorNombre, IDS } = require('./comun/importacion');
const path = require('path');
const crypto = require('crypto');
const { construirFlujo } = require('./generar-whatsapp.js');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const flujoEco = construirFlujo();
const COMUN = fs.readFileSync(path.join(__dirname, 'flujo-whatsapp', 'comun.js'), 'utf8').replace(/\r\n/g, '\n').trimEnd();
const nodo = (f, conComun = false) => {
  const codigo = fs.readFileSync(path.join(__dirname, 'flujo-whatsapp', f), 'utf8').replace(/\r\n/g, '\n');
  return conComun ? codigo.split('/*__COMUN__*/').join(COMUN) : codigo;
};

// Las funciones puras de comun.js, para probarlas directamente. Se ejecuta el contenido de ese archivo del
// propio repositorio, leído del disco: nunca texto externo ni datos del usuario (por eso new Function es seguro aquí).
const comun = new Function('require', `${COMUN}\nreturn { firmaValida, resolverSaludo, extraerMensajes, resolverNotificacion, soloDigitos, MENSAJE_NO_SOPORTADO, MAX_MENSAJES_DE_GOLPE, MAX_ADJUNTOS_DE_GOLPE, MENSAJE_FALLO_CANAL, urlAdjuntoValida, nombreSeguro, planificarAdjunto, registroDeSubida, EXTENSION_POR_MIME, MENSAJE_ADJUNTO_FALLO, MENSAJE_ADJUNTO_TIPO, MENSAJE_ADJUNTO_GRANDE, MENSAJE_ARCHIVO_FALLO, MENSAJE_ARCHIVO_SIN_REGISTRO, MENSAJE_ARCHIVO_GUARDADO, MENSAJE_ARCHIVOS_GUARDADOS, planificarAudio, cuerpoTranscripcion, leerTranscripcion, AUDIO_ADMITIDO, INSTRUCCION_TRANSCRIPCION, MENSAJE_AUDIO_FALLO, MENSAJE_AUDIO_TIPO, MENSAJE_AUDIO_GRANDE, MENSAJE_AUDIO_INAUDIBLE, MENSAJE_AUDIO_TRANSCRIPCION_FALLO, MENSAJE_AUDIO_LARGO, planificarEnvioArchivo, cuerpoEnlaceArchivo, cuerpoArchivoSubido, MENSAJE_ENLACE_ARCHIVO, MAX_ENVIOS_ARCHIVOS, cuerpoCabeceraCarpeta, cabecerasDeEnvio, cuerpoAvisoArchivo };`)(require);

const SECRETO = 'secreto-de-prueba-no-real';
const TOKEN = 'verify-token-de-prueba-no-real';
const NUMERO = '34600111222';
const ENV = { WHATSAPP_APP_SECRET: SECRETO, WHATSAPP_VERIFY_TOKEN: TOKEN, WHATSAPP_NUMERO_PERMITIDO: NUMERO };
const CONFIG = { supabase_url: 'https://abc.supabase.co', phone_number_id: '123456789012345', graph_version: 'v25.0' };

function simular(nodos) {
  return (nombre) => {
    if (!(nombre in nodos)) throw new Error(`Node "${nombre}" hasn't been executed`);
    const items = nodos[nombre].map((json) => ({ json }));
    return { all: () => items, first: () => items[0] };
  };
}
// "nodos" admite items con binario: { json, binary }
function simularConBinario(nodos) {
  return (nombre) => {
    if (!(nombre in nodos)) throw new Error(`Node "${nombre}" hasn't been executed`);
    const items = nodos[nombre].map((x) => (x && x.json ? x : { json: x }));
    // itemMatching(i): el item de ese nodo que corresponde al item i del nodo actual (aquí, el mismo índice)
    return { all: () => items, first: () => items[0], itemMatching: (i) => items[i] };
  };
}
// Luxon simulado: los nodos solo piden la fecha de Madrid con formato; fija el valor para poder comprobar los nombres
const FECHA_NOMBRE = '2026-10-12 1830';
const DateTimeFalso = { now: () => ({ setZone: () => ({ toFormat: () => FECHA_NOMBRE }) }) };
async function correr(codigo, { input = [], nodos = {}, env = ENV } = {}) {
  const items = input.map((json) => ({ json }));
  const fn = new AsyncFunction('$input', '$', '$env', 'DateTime', 'require', codigo);
  const salida = await fn.call({ helpers: {} }, { all: () => items, first: () => items[0] }, simularConBinario(nodos), env, DateTimeFalso, require);
  return salida.map((x) => x.json);
}

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

const firmar = (bytes, secreto = SECRETO) => `sha256=${crypto.createHmac('sha256', secreto).update(bytes).digest('hex')}`;

// Payloads con la estructura de la documentación de Meta (webhooks de WhatsApp Cloud API)
const payloadTexto = (cuerpo, { id = 'wamid.HBgMNTU1AAA=', from = NUMERO } = {}) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: 'PNID' }, contacts: [{ wa_id: from }], messages: [{ from, id, timestamp: '1760000000', type: 'text', text: { body: cuerpo } }] } }] }],
});
const payloadEstado = { object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', statuses: [{ id: 'wamid.X', status: 'delivered', recipient_id: NUMERO }] } }] }] };
const payloadTipo = (tipo, extra = {}) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { messages: [{ from: NUMERO, id: `wamid.${tipo}`, type: tipo, ...extra }] } }] }] });
const bytesDe = (obj) => Buffer.from(JSON.stringify(obj), 'utf8');

async function main() {
  console.log('Firma X-Hub-Signature-256');
  {
    // Vector público conocido de HMAC-SHA256 (clave "key"): comprueba la implementación contra algo que no escribí yo
    const msg = Buffer.from('The quick brown fox jumps over the lazy dog');
    const conocido = 'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8';
    afirmar('coincide con el vector de prueba público de HMAC-SHA256', comun.firmaValida(msg, `sha256=${conocido}`, 'key'));
    afirmar('acepta la firma en mayúsculas', comun.firmaValida(msg, `sha256=${conocido.toUpperCase()}`, 'key'));
    afirmar('rechaza una clave distinta', !comun.firmaValida(msg, `sha256=${conocido}`, 'otra'));
    afirmar('rechaza un cuerpo alterado en un byte', !comun.firmaValida(Buffer.from('The quick brown fox jumps over the lazy cog'), `sha256=${conocido}`, 'key'));
    afirmar('rechaza una firma sin el prefijo sha256=', !comun.firmaValida(msg, conocido, 'key'));
    afirmar('rechaza una firma truncada', !comun.firmaValida(msg, `sha256=${conocido.slice(0, 60)}`, 'key'));
    afirmar('rechaza una firma con caracteres no hexadecimales', !comun.firmaValida(msg, `sha256=${'z'.repeat(64)}`, 'key'));
    afirmar('rechaza si falta la cabecera', !comun.firmaValida(msg, undefined, 'key'));
    afirmar('rechaza si no hay secreto configurado', !comun.firmaValida(msg, `sha256=${conocido}`, ''));
    afirmar('rechaza un cuerpo que no es Buffer', !comun.firmaValida('texto', `sha256=${conocido}`, 'key'));
    const b = bytesDe(payloadTexto('hola'));
    afirmar('acepta su propia firma', comun.firmaValida(b, firmar(b), SECRETO));
    afirmar('rechaza si se re-serializa el JSON con otros espacios (por eso se usa el cuerpo en bruto)', !comun.firmaValida(Buffer.from(JSON.stringify(payloadTexto('hola'), null, 2)), firmar(b), SECRETO));
  }

  console.log('Saludo de verificación (GET)');
  {
    const ok = comun.resolverSaludo({ 'hub.mode': 'subscribe', 'hub.verify_token': TOKEN, 'hub.challenge': '1158201444' }, TOKEN);
    afirmar('token correcto: devuelve el challenge con 200', ok.accion === 'saludo' && ok.codigo === 200 && ok.cuerpo === '1158201444');
    afirmar('token incorrecto: 403 sin devolver nada', comun.resolverSaludo({ 'hub.mode': 'subscribe', 'hub.verify_token': 'otro', 'hub.challenge': '1' }, TOKEN).codigo === 403);
    afirmar('modo distinto de subscribe: 403', comun.resolverSaludo({ 'hub.mode': 'unsubscribe', 'hub.verify_token': TOKEN, 'hub.challenge': '1' }, TOKEN).codigo === 403);
    afirmar('sin challenge: error 400', comun.resolverSaludo({ 'hub.mode': 'subscribe', 'hub.verify_token': TOKEN }, TOKEN).codigo === 400);
    afirmar('sin token en el entorno: 403 aunque la petición traiga uno vacío', comun.resolverSaludo({ 'hub.mode': 'subscribe', 'hub.verify_token': '', 'hub.challenge': '1' }, '').codigo === 403);
    afirmar('sin token en el entorno ni en la petición: 403', comun.resolverSaludo({ 'hub.mode': 'subscribe', 'hub.challenge': '1' }, undefined).codigo === 403);
    afirmar('petición sin query: 403', comun.resolverSaludo(undefined, TOKEN).codigo === 403);
    afirmar('un token con la misma longitud pero distinto se rechaza', comun.resolverSaludo({ 'hub.mode': 'subscribe', 'hub.verify_token': TOKEN.replace(/.$/, 'X'), 'hub.challenge': '1' }, TOKEN).codigo === 403);
  }

  console.log('Extraer mensajes');
  {
    const ext = (p, num = NUMERO) => comun.extraerMensajes(p, num);
    const t = ext(payloadTexto('Dentista el jueves'));
    afirmar('un texto del número permitido', t.length === 1 && t[0].tipo_entrada === 'texto' && t[0].mensaje === 'Dentista el jueves' && t[0].wa_message_id === 'wamid.HBgMNTU1AAA=');
    afirmar('otro remitente se descarta', ext(payloadTexto('hola', { from: '34699999999' })).length === 0);
    afirmar('el número permitido puede llevar + y espacios', ext(payloadTexto('hola'), '+34 600 111 222').length === 1);
    afirmar('sin número permitido configurado no pasa nada', comun.extraerMensajes(payloadTexto('hola'), '').length === 0 && comun.extraerMensajes(payloadTexto('hola'), undefined).length === 0 && comun.extraerMensajes(payloadTexto('hola'), null).length === 0);
    afirmar('un estado de entrega no produce mensajes', ext(payloadEstado).length === 0);
    afirmar('un texto vacío o de espacios se ignora', ext(payloadTexto('   ')).length === 0);
    afirmar('una imagen sin id utilizable se marca como no soportada', JSON.stringify(ext(payloadTipo('image', { image: {} }))) === JSON.stringify([{ wa_message_id: 'wamid.image', tipo_entrada: 'no_soportado', tipo: 'image', ts: '' }]) && ext(payloadTipo('image', { image: { id: 'a b/c' } }))[0].tipo_entrada === 'no_soportado');
    afirmar('un audio, un vídeo y un documento sin id también', ext(payloadTipo('audio'))[0].tipo === 'audio' && ext(payloadTipo('video'))[0].tipo === 'video' && ext(payloadTipo('document'))[0].tipo === 'document');
    afirmar('una reacción se ignora en silencio', ext(payloadTipo('reaction')).length === 0);
    afirmar('un tipo desconocido se ignora', ext(payloadTipo('algo_nuevo')).length === 0);
    const dos = payloadTexto('uno');
    dos.entry[0].changes[0].value.messages.push({ from: NUMERO, id: 'wamid.2', type: 'text', text: { body: 'dos' } });
    afirmar('varios mensajes en una notificación, en orden', ext(dos).map((m) => m.mensaje).join() === 'uno,dos');
    afirmar('un cambio que no es de mensajes se ignora', ext({ entry: [{ changes: [{ field: 'account_update', value: { messages: [{ from: NUMERO, id: 'x', type: 'text', text: { body: 'hola' } }] } }] }] }).length === 0);
    afirmar('payloads mal formados no rompen nada', [null, undefined, {}, { entry: null }, { entry: [null] }, { entry: [{ changes: null }] }, { entry: [{ changes: [{ field: 'messages', value: null }] }] }, 'texto', 5].every((p) => ext(p).length === 0));
    afirmar('un mensaje sin id se ignora', ext({ entry: [{ changes: [{ field: 'messages', value: { messages: [{ from: NUMERO, type: 'text', text: { body: 'hola' } }] } }] }] }).length === 0);
  }

  console.log('Notificación completa (firma + remitente)');
  {
    const dec = (bytes, cab, secreto = SECRETO, num = NUMERO) => comun.resolverNotificacion({ cuerpoBytes: bytes, cabeceraFirma: cab, secreto, numeroPermitido: num });
    const b = bytesDe(payloadTexto('Comprar leche'));
    const ok = dec(b, firmar(b));
    afirmar('firma válida y remitente permitido: procesar', ok.accion === 'procesar' && ok.codigo === 200 && ok.mensajes.length === 1);
    afirmar('firma inválida: 403 y no se extrae nada', dec(b, firmar(b, 'otro')).accion === 'rechazar' && dec(b, firmar(b, 'otro')).codigo === 403 && dec(b, firmar(b, 'otro')).mensajes.length === 0);
    afirmar('sin firma: 403', dec(b, undefined).codigo === 403);
    const alterado = bytesDe(payloadTexto('Borra todo'));
    afirmar('cuerpo cambiado después de firmar: 403', dec(alterado, firmar(b)).codigo === 403);
    const e = bytesDe(payloadEstado);
    afirmar('estado de entrega firmado: ignorar con 200 (para que Meta no reintente)', dec(e, firmar(e)).accion === 'ignorar' && dec(e, firmar(e)).codigo === 200);
    const otro = bytesDe(payloadTexto('hola', { from: '34699999999' }));
    afirmar('otro remitente con firma válida: ignorar con 200', dec(otro, firmar(otro)).accion === 'ignorar');
    const malo = Buffer.from('esto no es json');
    afirmar('cuerpo firmado pero ilegible: 200 para no provocar reintentos en bucle', dec(malo, firmar(malo)).accion === 'ignorar' && dec(malo, firmar(malo)).codigo === 200);
    afirmar('sin secreto configurado se rechaza todo', dec(b, firmar(b, ''), '').codigo === 403);
  }

  console.log('Nodo "Verificar"');
  {
    const codigo = nodo('verificar.js', true);
    const get = (query, env = ENV) => correr(codigo, { nodos: { 'Webhook GET': [{ json: { headers: {}, query, body: {} } }] }, env });
    const [s] = await get({ 'hub.mode': 'subscribe', 'hub.verify_token': TOKEN, 'hub.challenge': '777' });
    afirmar('GET correcto: saludo con el challenge', s.accion === 'saludo' && s.cuerpo === '777' && s.codigo === 200);
    const [m] = await get({ 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': '777' });
    afirmar('GET con token falso: rechazar', m.accion === 'rechazar' && m.codigo === 403 && m.cuerpo === '');
    const [sinEnv] = await get({ 'hub.mode': 'subscribe', 'hub.verify_token': TOKEN, 'hub.challenge': '777' }, {});
    afirmar('GET sin WHATSAPP_VERIFY_TOKEN en el entorno: rechazar', sinEnv.accion === 'rechazar');

    const b = bytesDe(payloadTexto('Llamar a mamá'));
    const post = (bytes, cab, env = ENV) =>
      correr(codigo, { nodos: { 'Webhook POST': [{ json: { headers: cab ? { 'x-hub-signature-256': cab } : {}, query: {}, body: JSON.parse(bytes.toString()) }, binary: { data: { data: bytes.toString('base64'), mimeType: 'application/json' } } }] }, env });
    const [p] = await post(b, firmar(b));
    afirmar('POST firmado: procesar con el mensaje', p.accion === 'procesar' && p.mensajes[0].mensaje === 'Llamar a mamá', JSON.stringify(p));
    const [pm] = await post(b, firmar(b, 'otro'));
    afirmar('POST con firma de otra clave: rechazar', pm.accion === 'rechazar' && pm.codigo === 403);
    const [ps] = await post(b, undefined);
    afirmar('POST sin firma: rechazar', ps.accion === 'rechazar');
    const [pe] = await post(b, firmar(b), {});
    afirmar('POST sin secreto en el entorno: rechazar', pe.accion === 'rechazar');
    const [pn] = await post(b, firmar(b), { WHATSAPP_APP_SECRET: SECRETO, WHATSAPP_VERIFY_TOKEN: TOKEN });
    afirmar('POST sin número permitido en el entorno: nada que atender', pn.accion === 'ignorar');
    const [sb] = await correr(codigo, { nodos: { 'Webhook POST': [{ json: { headers: { 'x-hub-signature-256': firmar(b) }, query: {}, body: {} } }] } });
    afirmar('POST sin cuerpo en bruto (Raw Body desactivado): rechazar en vez de fallar', sb.accion === 'rechazar' || sb.accion === 'ignorar');
    afirmar('la decisión no devuelve ni el secreto ni el token', !JSON.stringify([s, m, p, pm]).includes(SECRETO) && !JSON.stringify([m, p, pm]).includes(TOKEN));
    afirmar('una sola decisión por petición', Array.isArray(await post(b, firmar(b))) && (await post(b, firmar(b))).length === 1);
  }

  console.log('Nodo "Separar mensajes"');
  {
    const codigo = nodo('separar.js');
    const sep = (decision) => correr(codigo, { nodos: { Verificar: [decision] } });
    const msgs = [{ wa_message_id: 'wamid.AAA=', tipo_entrada: 'texto', mensaje: 'uno' }, { wa_message_id: 'wamid.BBB', tipo_entrada: 'texto', mensaje: 'dos' }];
    const r = await sep({ accion: 'procesar', mensajes: msgs });
    afirmar('un item por mensaje, en orden', r.length === 2 && r[0].mensaje === 'uno' && r[1].mensaje === 'dos');
    afirmar('solo el primero lleva la consulta de duplicados', typeof r[0].consulta_url === 'string' && r[1].consulta_url === undefined);
    afirmar('la consulta incluye los dos ids, codificados y entre comillas', r[0].consulta_url === '/rest/v1/mensajes?select=wa_message_id&wa_message_id=in.(%22wamid.AAA%3D%22,%22wamid.BBB%22)', r[0].consulta_url);
    afirmar('saludo, rechazo o ignorar: no sigue nada', (await sep({ accion: 'saludo', mensajes: [] })).length === 0 && (await sep({ accion: 'rechazar', mensajes: [] })).length === 0 && (await sep({ accion: 'ignorar', mensajes: [] })).length === 0);
    await lanza('un id con caracteres no esperados no llega a la URL', sep({ accion: 'procesar', mensajes: [{ wa_message_id: 'x") or (1=1', tipo_entrada: 'texto', mensaje: 'a' }] }), 'caracteres no esperados');
  }

  console.log('Nodo "Quitar duplicados"');
  {
    const codigo = nodo('quitar-duplicados.js');
    const recibidos = [{ wa_message_id: 'wamid.A', tipo_entrada: 'texto', mensaje: 'a', consulta_url: '/x' }, { wa_message_id: 'wamid.B', tipo_entrada: 'texto', mensaje: 'b' }, { wa_message_id: 'wamid.B', tipo_entrada: 'texto', mensaje: 'b' }];
    const q = (respuesta, rec = recibidos) => correr(codigo, { input: respuesta, nodos: { 'Separar mensajes': rec } });
    const r = await q([{ wa_message_id: 'wamid.A' }]);
    afirmar('descarta el que ya está en Supabase y el repetido dentro de la petición', r.length === 1 && r[0].wa_message_id === 'wamid.B');
    afirmar('no arrastra la consulta_url', !('consulta_url' in (await q([{}]))[0]));
    afirmar('sin nada guardado pasan todos (sin repetidos)', (await q([{}])).length === 2);
    afirmar('si la lectura falla no se descarta nada', (await q([{ error: { message: 'timeout' } }])).length === 2);
  }

  console.log('Nodo "Preparar envío"');
  {
    const codigo = nodo('preparar-envio.js', true);
    const p = (input, env = ENV) => correr(codigo, { input, env });
    const r = await p([{ ok: true, mensajes: ['Hecho.', 'Segundo'] }]);
    afirmar('un item por mensaje, dirigido al número permitido', r.length === 2 && r.every((x) => x.para === NUMERO) && r[0].texto === 'Hecho.' && r[1].texto === 'Segundo');
    afirmar('un número con + y espacios se normaliza a dígitos', (await p([{ mensajes: ['a'] }], { WHATSAPP_NUMERO_PERMITIDO: '+34 600 111 222' }))[0].para === NUMERO);
    const ns = await p([{ wa_message_id: 'w', tipo_entrada: 'no_soportado', tipo: 'image' }]);
    afirmar('tipo no soportado: respuesta honesta sin pasar por el modelo', ns.length === 1 && ns[0].texto.includes('todavía no lo entiendo') && ns[0].texto.includes('una imagen'));
    afirmar('un audio se nombra como audio', (await p([{ tipo_entrada: 'no_soportado', tipo: 'audio' }]))[0].texto.includes('un audio'));
    const f = await p([{ error: { message: 'el subflujo falló' } }]);
    afirmar('si el flujo principal falló: aviso honesto, nunca silencio', f.length === 1 && f[0].texto === comun.MENSAJE_FALLO_CANAL);
    afirmar('mensajes vacíos o sin texto cuentan como fallo', (await p([{ mensajes: ['  ', ''] }]))[0].texto === comun.MENSAJE_FALLO_CANAL && (await p([{ mensajes: [] }]))[0].texto === comun.MENSAJE_FALLO_CANAL);
    afirmar('un texto se recorta al límite de WhatsApp', (await p([{ mensajes: ['x'.repeat(5000)] }]))[0].texto.length === 4096);
    afirmar('el fallo de un mensaje no tapa los de los demás', (await p([{ mensajes: ['uno'] }, { error: 'x' }, { mensajes: ['tres'] }])).map((x) => x.texto).join('|') === `uno|${comun.MENSAJE_FALLO_CANAL}|tres`);
    await lanza('sin número permitido en el entorno es un error', p([{ mensajes: ['a'] }], {}), 'WHATSAPP_NUMERO_PERMITIDO');
    // Las respuestas citan el mensaje del usuario al que contestan (context.message_id); solo el primer mensaje de cada respuesta
    const pj = (input, juntar) => correr(codigo, { input, env: ENV, nodos: { 'Juntar mensajes': juntar } });
    const citada = await pj([{ ok: true, mensajes: ['Hecho.', 'Segundo'] }], [{ accion: 'procesar', responde_a: 'wamid.1', wa_message_id: 'wamid.3' }]);
    afirmar('cita: la respuesta del flujo principal cita el mensaje (el primero del grupo) y solo en su primer mensaje', citada[0].responde_a === 'wamid.1' && !('responde_a' in citada[1]), JSON.stringify(citada));
    afirmar('cita: cada rama cita su mensaje (audio o archivo rechazado, archivo guardado, tipo no soportado)', (await p([{ ok: false, mensajes: ['No.'], responde_a: 'wamid.aud' }]))[0].responde_a === 'wamid.aud' && (await p([{ tipo_entrada: 'no_soportado', tipo: 'sticker', wa_message_id: 'wamid.st' }]))[0].responde_a === 'wamid.st');
    afirmar('cita: sin id, o con uno raro, la respuesta sale igual pero sin cita', !('responde_a' in (await p([{ mensajes: ['a'] }]))[0]) && !('responde_a' in (await p([{ mensajes: ['a'], responde_a: 'x/../<y>' }]))[0]));
    const dos = await pj([{ mensajes: ['uno'] }, { mensajes: ['dos'] }], [{ accion: 'procesar', responde_a: 'wamid.A' }, { accion: 'procesar', responde_a: 'wamid.B' }]);
    afirmar('cita: con dos respuestas en la misma ejecución, cada una lleva la suya', dos[0].responde_a === 'wamid.A' && dos[1].responde_a === 'wamid.B', JSON.stringify(dos));
    const varios = async (j) => (await pj([{ mensajes: ['a'] }], [{ accion: 'procesar', responde_a: 'wamid.1', ...j }]))[0].varios_mensajes;
    afirmar('cita: «varios mensajes» si se juntaron varios o si tuvo que esperar a que se contestara otro; uno solo, no', (await varios({ juntados: 2 })) === true && (await varios({ juntados: 1, espero_turno: true })) === true && (await varios({ juntados: 1, espero_turno: false })) === false);

    afirmar('Preparar envío: el primer mensaje de cada respuesta dice qué mensajes contesta (todos los del grupo) y si viene de la cola', citada[0].contesta.join() === 'wamid.3' && citada[0].de_cola === true && !('contesta' in citada[1]), JSON.stringify(citada));
    const grupo = await pj([{ mensajes: ['a'] }], [{ accion: 'procesar', responde_a: 'wamid.1', wa_ids: ['wamid.1', 'wamid.2', 'x y'] }]);
    afirmar('Preparar envío: con varios juntados, «contesta» los lleva todos (y descarta los ids raros)', grupo[0].contesta.join() === 'wamid.1,wamid.2');
    const foto = await p([{ mensajes: ['Guardado'], responde_a: 'wamid.f1' }, { tipo_entrada: 'no_soportado', tipo: 'sticker', wa_message_id: 'wamid.st' }]);
    afirmar('Preparar envío: una foto o un aviso contesta su propio mensaje y no viene de la cola', foto[0].contesta.join() === 'wamid.f1' && foto[0].de_cola === false && foto[1].contesta.join() === 'wamid.st');
    const sinId = await pj([{ mensajes: ['Guardado'], responde_a: null }], [{ accion: 'procesar', responde_a: 'wamid.1', wa_ids: ['wamid.1'] }]);
    afirmar('Preparar envío: una rama de archivos sin id (responde_a nulo) no toma los mensajes de la cola', sinId[0].contesta.length === 0 && sinId[0].de_cola === false && !('responde_a' in sinId[0]));
    afirmar('Preparar envío: el primer mensaje lleva cuándo empezó a esperar y los archivos pedidos (si los hay)', Number.isFinite(citada[0].desde) && !('envios_archivos' in citada[0]) && (await pj([{ mensajes: ['Te los mando'], envios_archivos: [{ drive_file_id: 'x' }] }], [{ accion: 'procesar', responde_a: 'wamid.1' }]))[0].envios_archivos.length === 1);

    // Turno de respuesta: espera si queda algo anterior sin contestar; cita solo si el usuario ha mandado varios mensajes
    const turnoR = nodo('turno-respuesta.js');
    const CONFT = { config: { turno_min: 10 } };
    const tr = (envios, turno) => correr(turnoR, { input: [turno], nodos: { 'Preparar envío': envios, Configuración: [CONFT] } });
    const uno = [{ para: NUMERO, texto: 'Hecho.', responde_a: 'wamid.1', varios_mensajes: false, contesta: ['wamid.1'], de_cola: false, desde: Date.now() }, { para: NUMERO, texto: 'Segundo' }];
    const sinNada = await tr(uno, { accion: 'enviar', despues: false });
    afirmar('Turno de respuesta: un solo mensaje y nada después → sin cita, sin campos internos, conserva «contesta»', sinNada.length === 2 && sinNada.every((x) => !('responde_a' in x) && !('varios_mensajes' in x) && !('de_cola' in x) && !('desde' in x)) && sinNada[0].contesta.join() === 'wamid.1' && sinNada[0].texto === 'Hecho.', JSON.stringify(sinNada));
    afirmar('Turno de respuesta: si quedan mensajes posteriores sin contestar → cita, solo el primero', (await tr(uno, { accion: 'enviar', despues: true }))[0].responde_a === 'wamid.1' && !('responde_a' in (await tr(uno, { accion: 'enviar', despues: true }))[1]));
    afirmar('Turno de respuesta: varios mensajes juntos o llegados mientras contestaba otro → cita', (await tr([{ ...uno[0], varios_mensajes: true }], { accion: 'enviar', despues: false }))[0].responde_a === 'wamid.1');
    afirmar('Turno de respuesta: varias respuestas a la vez (varias fotos de golpe) → cada una cita la suya', (await tr([{ texto: 'a', responde_a: 'w.A' }, { texto: 'b', responde_a: 'w.B' }], { accion: 'enviar', despues: false })).map((x) => x.responde_a).join() === 'w.A,w.B');
    afirmar('Turno de respuesta: si la lectura falla, contesta sin esperar y sin cita', (await tr(uno, { error: { message: '500' } })).length === 2 && !('responde_a' in (await tr(uno, { error: { message: '500' } }))[0]));
    const espera = await tr(uno, { accion: 'esperar', despues: true });
    afirmar('Turno de respuesta: queda algo anterior sin contestar → espera (un solo item)', espera.length === 1 && espera[0].esperar === true, JSON.stringify(espera));
    afirmar('Turno de respuesta: tras esperar TURNO_MIN (contado desde Preparar envío), contesta igualmente', (await tr([{ ...uno[0], desde: Date.now() - 11 * 60000 }, uno[1]], { accion: 'esperar', despues: false })).length === 2);
    afirmar('Turno de respuesta: una respuesta de la cola de texto nunca espera aquí (ya salió en orden)', (await tr([{ ...uno[0], de_cola: true }], { accion: 'esperar', despues: false })).every((x) => !x.esperar));
  }

  console.log('Archivos adjuntos: leer del webhook');
  {
    const ext = (p) => comun.extraerMensajes(p, NUMERO);
    const img = ext(payloadTipo('image', { image: { id: '1234567890', mime_type: 'image/jpeg', sha256: 'x', caption: 'factura de la luz' } }));
    afirmar('una imagen con id: se lee como imagen con su id, tipo y pie', JSON.stringify(img) === JSON.stringify([{ wa_message_id: 'wamid.image', tipo_entrada: 'imagen', media_id: '1234567890', mime_type: 'image/jpeg', filename: '', caption: 'factura de la luz', contexto_id: '', ts: '' }]), JSON.stringify(img));
    const doc = ext(payloadTipo('document', { document: { id: 'abc_DEF-9', mime_type: 'application/pdf', filename: 'Contrato.pdf', caption: 'ojo' } }));
    afirmar('un documento: se lee con nombre de archivo y pie', doc.length === 1 && doc[0].tipo_entrada === 'documento' && doc[0].filename === 'Contrato.pdf' && doc[0].caption === 'ojo' && doc[0].media_id === 'abc_DEF-9');
    afirmar('sin pie ni tipo: cadenas vacías, nunca undefined', (() => { const m = ext(payloadTipo('image', { image: { id: '55' } }))[0]; return m.caption === '' && m.mime_type === '' && m.filename === ''; })());
    afirmar('un id con caracteres peligrosos no pasa a la URL de Meta', ext(payloadTipo('image', { image: { id: '1/../../x' } }))[0].tipo_entrada === 'no_soportado' && ext(payloadTipo('image', { image: { id: 123 } }))[0].tipo_entrada === 'no_soportado');
    afirmar('una imagen de otro remitente se descarta', comun.extraerMensajes(payloadTipo('image', { image: { id: '1' } }), '34699999999').length === 0);
  }

  console.log('Archivos adjuntos: URL, nombre y decisión');
  {
    const v = comun.urlAdjuntoValida;
    afirmar('acepta las URL de descarga de Meta', v('https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1&ext=2&hash=3') && v('https://mmg.whatsapp.net/x') && v('https://scontent.xx.fbcdn.net/v/a.jpg') && v('https://graph.facebook.com/v25.0/1'));
    afirmar('rechaza http, otros dominios y parecidos', !v('http://lookaside.fbsbx.com/x') && !v('https://evil.com/x') && !v('https://fbsbx.com.evil.com/x') && !v('https://notfbsbx.com/x') && !v('https://evil.com/fbsbx.com'));
    afirmar('rechaza credenciales en la URL y otras trampas', !v('https://lookaside.fbsbx.com@evil.com/x') && !v('https://user:pass@lookaside.fbsbx.com/x') && !v('https://lookaside.fbsbx.com:8080/x') && !v('//lookaside.fbsbx.com/x') && !v('javascript:alert(1)'));
    afirmar('rechaza vacío, números y objetos', !v('') && !v(undefined) && !v(null) && !v(12) && !v({}));

    const n = comun.nombreSeguro;
    afirmar('nombre: quita barras, dos puntos y caracteres de control', n('a/b\\c:d*e?f"g<h>i|j\u0001k.pdf') === 'a_b_c_d_e_f_g_h_i_j_k.pdf');
    afirmar('nombre: espacios sobrantes y puntos iniciales', n('  ..oculto   doc .pdf ') === 'oculto doc .pdf' && n('...') === '');
    afirmar('nombre: recorta a 120 caracteres conservando la extensión', (() => { const r = n(`${'a'.repeat(300)}.pdf`); return r.length === 120 && r.endsWith('.pdf'); })());
    afirmar('nombre: vacío o no texto da cadena vacía', n('') === '' && n(undefined) === '' && n(null) === '');

    const p = (entrada, metadatos, extra = {}) => comun.planificarAdjunto({ entrada, metadatos, ahora: FECHA_NOMBRE, limiteMb: 25, ...extra });
    const foto = p({ tipo_entrada: 'imagen' }, { url: 'https://lookaside.fbsbx.com/x?mid=1', mime_type: 'image/jpeg', file_size: 120000 });
    afirmar('una foto sin nombre: fecha y hora de recepción, extensión del tipo', foto.ok && foto.nombre === '2026-10-12 1830 · WhatsApp.jpg' && foto.mime_type === 'image/jpeg' && foto.tamano === 120000 && foto.media_url.startsWith('https://lookaside'), JSON.stringify(foto));
    // Dos fotos del mismo minuto ya no se llaman igual : sufijo de 4 caracteres sacado del id del mensaje, siempre el mismo
    const f1 = p({ tipo_entrada: 'imagen', wa_message_id: 'wamid.HBgLMzQ2MDAwMDAwMDAVAgASGBQzQUFBMUIyQzNEND' }, { url: 'https://lookaside.fbsbx.com/x', mime_type: 'image/jpeg' });
    const f2 = p({ tipo_entrada: 'imagen', wa_message_id: 'wamid.HBgLMzQ2MDAwMDAwMDAVAgASGBQzQUFBMUIyQzNEND2' }, { url: 'https://lookaside.fbsbx.com/x', mime_type: 'image/jpeg' });
    const f1b = p({ tipo_entrada: 'imagen', wa_message_id: 'wamid.HBgLMzQ2MDAwMDAwMDAVAgASGBQzQUFBMUIyQzNEND' }, { url: 'https://lookaside.fbsbx.com/x', mime_type: 'image/jpeg' });
    afirmar('dos fotos del mismo minuto: nombres distintos («… · WhatsApp xxxx.jpg»); el mismo mensaje, el mismo nombre', /^2026-10-12 1830 · WhatsApp [0-9a-z]{4}\.jpg$/.test(f1.nombre) && f1.nombre !== f2.nombre && f1.nombre === f1b.nombre, `${f1.nombre} / ${f2.nombre}`);
    const png = p({ tipo_entrada: 'imagen' }, { url: 'https://lookaside.fbsbx.com/x', mime_type: 'image/png' });
    afirmar('una foto PNG sin tamaño conocido se acepta', png.ok && png.nombre.endsWith('.png') && png.tamano === null);
    const doc = p({ tipo_entrada: 'documento', filename: 'Contrato: piso.pdf' }, { url: 'https://lookaside.fbsbx.com/x', mime_type: 'application/pdf', file_size: '2048' });
    afirmar('un documento conserva su nombre limpiado y acepta el tamaño como texto', doc.ok && doc.nombre === 'Contrato_ piso.pdf' && doc.tamano === 2048);
    afirmar('un documento sin extensión en el nombre la recibe del tipo', p({ tipo_entrada: 'documento', filename: 'Presupuesto' }, { url: 'https://lookaside.fbsbx.com/x', mime_type: 'application/pdf' }).nombre === 'Presupuesto.pdf');
    afirmar('un documento sin nombre se llama como una foto', p({ tipo_entrada: 'documento', filename: '' }, { url: 'https://lookaside.fbsbx.com/x', mime_type: 'application/pdf' }).nombre === '2026-10-12 1830 · WhatsApp.pdf');
    afirmar('el tipo de la API manda sobre el del webhook, y se ignora "; charset"', p({ tipo_entrada: 'imagen', mime_type: 'image/png' }, { url: 'https://lookaside.fbsbx.com/x', mime_type: 'Image/JPEG; q=1' }).mime_type === 'image/jpeg');
    afirmar('sin tipo en la API se usa el del webhook', p({ tipo_entrada: 'imagen', mime_type: 'image/png' }, { url: 'https://lookaside.fbsbx.com/x' }).ok === true);

    const meta = { url: 'https://lookaside.fbsbx.com/x', mime_type: 'application/pdf' };
    afirmar('en el límite exacto (25 MB) se acepta y un byte más se rechaza', p({ tipo_entrada: 'documento' }, { ...meta, file_size: 25 * 1048576 }).ok === true && p({ tipo_entrada: 'documento' }, { ...meta, file_size: 25 * 1048576 + 1 }).ok === false);
    const grande = p({ tipo_entrada: 'documento' }, { ...meta, file_size: 40 * 1048576 });
    afirmar('demasiado grande: mensaje honesto con tamaño y límite', !grande.ok && grande.texto === 'Ese archivo pesa 40,0 MB y el máximo es 25 MB.', grande.texto);
    const zip = p({ tipo_entrada: 'documento' }, { url: 'https://lookaside.fbsbx.com/x', mime_type: 'application/zip' });
    afirmar('tipo no admitido: lo dice con el tipo', !zip.ok && zip.texto.includes('application/zip') && zip.texto.includes('PDF'));
    afirmar('sin tipo alguno: tipo desconocido', p({ tipo_entrada: 'documento' }, { url: 'https://lookaside.fbsbx.com/x' }).texto.includes('desconocido'));
    afirmar('error de Meta o sin URL: aviso de fallo, sin detalles técnicos', [{ error: { message: 'x' } }, {}, { url: '' }, null, undefined].every((m) => { const r = p({ tipo_entrada: 'imagen' }, m); return !r.ok && r.texto === comun.MENSAJE_ADJUNTO_FALLO; }));
    const mala = p({ tipo_entrada: 'imagen' }, { url: 'https://evil.com/x', mime_type: 'image/jpeg' });
    afirmar('URL de otro dominio: se rechaza antes de enviar el token', !mala.ok && mala.texto === comun.MENSAJE_ADJUNTO_FALLO && mala.motivo.includes('dominio'));
    afirmar('todos los tipos admitidos tienen extensión', Object.values(comun.EXTENSION_POR_MIME).every((e) => /^[a-z]{2,4}$/.test(e)) && Object.keys(comun.EXTENSION_POR_MIME).length === 10);

    const plan = { ok: true, wa_message_id: 'wamid.F1', tipo_entrada: 'imagen', caption: '  factura de la luz  ', nombre: '2026-10-12 1830 · WhatsApp.jpg', mime_type: 'image/jpeg' };
    const r = comun.registroDeSubida({ plan, subida: { id: '1AbCdEfGhIjKlMn', name: 'x' } });
    afirmar('registro: fila de mensaje (con el pie, procesado) y fila de archivo (pendiente por defecto, enlace de Drive)', r.ok && r.mensaje.wa_message_id === 'wamid.F1' && r.mensaje.tipo_entrada === 'imagen' && r.mensaje.texto_original === 'factura de la luz' && r.mensaje.procesado === true && r.archivo.drive_file_id === '1AbCdEfGhIjKlMn' && r.archivo.drive_url === 'https://drive.google.com/file/d/1AbCdEfGhIjKlMn/view' && r.archivo.nombre === plan.nombre && r.archivo.tipo_mime === 'image/jpeg' && r.tiene_pie === true, JSON.stringify(r));
    afirmar('registro: la fila del archivo no fuerza estado ni item (queda pendiente por el valor por defecto)', !('estado' in r.archivo) && !('item_id' in r.archivo));
    const sinPie = comun.registroDeSubida({ plan: { ...plan, caption: '   ' }, subida: { id: '1AbCdEfGhIjKlMn' } });
    afirmar('registro: sin pie, texto_original es null', sinPie.mensaje.texto_original === null && sinPie.tiene_pie === false);
    afirmar('registro: si Drive no devolvió un id válido, aviso y nada que escribir', [null, undefined, {}, { error: 'x' }, { id: 'corto' }, { id: 'con espacios y / raros' }, { id: 12345678901234 }].every((s) => { const x = comun.registroDeSubida({ plan, subida: s }); return !x.ok && x.texto === comun.MENSAJE_ARCHIVO_FALLO && !x.mensaje && !x.archivo; }));
    afirmar('textos de respuesta: guardado, corto y con la misma pregunta con o sin pie', comun.MENSAJE_ARCHIVO_GUARDADO('a.jpg', false) === 'Guardado: «a.jpg». ¿Qué es o en qué carpeta lo guardo?' && comun.MENSAJE_ARCHIVO_GUARDADO('a.jpg', true) === comun.MENSAJE_ARCHIVO_GUARDADO('a.jpg', false));
  }

  console.log('Nodos de la rama de archivos');
  {
    const cfg = { ...CONFIG, entrada_id: '1AbCdEfGhIjKlMn', limite_adjunto_mb: 25 };
    const comprobar = nodo('comprobar-adjunto.js', true);
    const entradas = [
      { wa_message_id: 'wamid.1', tipo_entrada: 'imagen', media_id: '111', mime_type: 'image/jpeg', filename: '', caption: 'luz' },
      { wa_message_id: 'wamid.2', tipo_entrada: 'documento', media_id: '222', mime_type: 'application/pdf', filename: 'Contrato.pdf', caption: '' },
      { wa_message_id: 'wamid.3', tipo_entrada: 'documento', media_id: '333', mime_type: 'application/zip', filename: 'a.zip', caption: '' },
    ];
    const respuestas = [
      { url: 'https://lookaside.fbsbx.com/a', mime_type: 'image/jpeg', file_size: 5000, id: '111' },
      { url: 'https://lookaside.fbsbx.com/b', mime_type: 'application/pdf', file_size: 9000, id: '222' },
      { url: 'https://lookaside.fbsbx.com/c', mime_type: 'application/zip', file_size: 100, id: '333' },
    ];
    const salida = await correr(comprobar, { input: respuestas, nodos: { Configuración: [{ config: cfg }], '¿Es archivo?': entradas } });
    afirmar('Comprobar adjunto: un item por adjunto, cada uno con SU entrada (no se mezclan)', salida.length === 3 && salida[0].wa_message_id === 'wamid.1' && salida[1].wa_message_id === 'wamid.2' && salida[0].caption === 'luz' && salida[1].nombre === 'Contrato.pdf', JSON.stringify(salida));
    afirmar('Comprobar adjunto: la foto lleva el nombre con la fecha simulada de Madrid y el sufijo de su mensaje', salida[0].ok && new RegExp(`^${FECHA_NOMBRE} · WhatsApp [0-9a-z]{4}\\.jpg$`).test(salida[0].nombre), salida[0].nombre);
    afirmar('Comprobar adjunto: un tipo no admitido no tapa a los demás y se avisa', salida[2].ok === false && salida[2].mensajes[0].includes('application/zip') && salida[0].ok && salida[1].ok);
    const conError = await correr(comprobar, { input: [{ error: { message: '401' } }], nodos: { Configuración: [{ config: cfg }], '¿Es archivo?': [entradas[0]] } });
    afirmar('Comprobar adjunto: si Meta falló, aviso honesto', conError[0].ok === false && conError[0].mensajes[0] === comun.MENSAJE_ADJUNTO_FALLO);
    const pequeno = await correr(comprobar, { input: [respuestas[0]], nodos: { Configuración: [{ config: { ...cfg, limite_adjunto_mb: 1 } }], '¿Es archivo?': [entradas[0]] } });
    afirmar('Comprobar adjunto: el límite sale de Configuración', pequeno[0].ok === true && (await correr(comprobar, { input: [{ ...respuestas[0], file_size: 2 * 1048576 }], nodos: { Configuración: [{ config: { ...cfg, limite_adjunto_mb: 1 } }], '¿Es archivo?': [entradas[0]] } }))[0].ok === false);

    const preparar = nodo('preparar-registro.js', true);
    const aceptados = salida.filter((x) => x.ok);
    const subidas = [{ id: '1AbCdEfGhIjKlMn', name: 'x' }, { error: { message: 'Drive 403' } }];
    const reg = await correr(preparar, { input: subidas, nodos: { 'Comprobar adjunto': aceptados } });
    afirmar('Preparar registro: la subida correcta da las dos filas con los datos de SU adjunto', reg[0].ok && reg[0].mensaje.wa_message_id === 'wamid.1' && reg[0].mensaje.texto_original === 'luz' && reg[0].archivo.drive_file_id === '1AbCdEfGhIjKlMn' && reg[0].archivo.nombre === aceptados[0].nombre, JSON.stringify(reg[0]));
    afirmar('Preparar registro: la subida fallida no registra nada y avisa; no afecta a la otra', reg[1].ok === false && reg[1].mensajes[0] === comun.MENSAJE_ARCHIVO_FALLO && !reg[1].archivo);

    const resultado = nodo('resultado-archivo.js', true);
    const hechos = [{ ok: true, nombre: 'Foto.jpg', tiene_pie: false }, { ok: true, nombre: 'Doc.pdf', tiene_pie: true }, { ok: true, nombre: 'Otro.pdf', tiene_pie: false }];
    const fin = await correr(resultado, { input: [{ drive_file_id: 'x', nombre: 'Foto.jpg' }, { drive_file_id: 'y' }, { error: { message: '409' } }], nodos: { '¿Subido?': hechos } });
    afirmar('Resultado archivo: confirma el guardado con el nombre', fin[0].mensajes[0] === comun.MENSAJE_ARCHIVO_GUARDADO('Foto.jpg', false) && fin[1].mensajes[0].includes('«Doc.pdf»'));
    afirmar('Resultado archivo: si Supabase no registró el archivo, lo dice', fin[2].mensajes[0] === comun.MENSAJE_ARCHIVO_SIN_REGISTRO);
    const citaArchivo = await correr(resultado, { input: [{ drive_file_id: 'x' }], nodos: { '¿Subido?': [{ ok: true, nombre: 'F.jpg', tiene_pie: false, mensaje: { wa_message_id: 'wamid.foto1' } }] } });
    afirmar('Resultado archivo: la confirmación citará la foto o el documento que se guardó', citaArchivo[0].responde_a === 'wamid.foto1');
    afirmar('los mensajes de la rama de archivos los entiende Preparar envío', await (async () => { const e = await correr(nodo('preparar-envio.js', true), { input: [{ mensajes: [fin[0].mensajes[0]] }, { ok: false, mensajes: [comun.MENSAJE_ADJUNTO_FALLO] }] }); return e.length === 2 && e.every((x) => x.para === NUMERO) && e[1].texto === comun.MENSAJE_ADJUNTO_FALLO; })());
  }

  console.log('Un solo aviso al guardar varios archivos (base de datos 1.4)');
  {
    const IDS = ['1AbCdEfGhIjKlMn', '2AbCdEfGhIjKlMn', '3AbCdEfGhIjKlMn'];
    const cfgA = { ...CONFIG, espera_archivos_s: 4, quieto_archivos_s: 3 };
    const propio = (n, extra = {}) => ({ mensajes: [comun.MENSAJE_ARCHIVO_GUARDADO(`F${n}.jpg`, false)], responde_a: `wamid.${n}`, registrado: true, nombre: `F${n}.jpg`, archivo_drive_id: IDS[n - 1], ...extra });
    const reclamado = (n) => ({ drive_file_id: IDS[n - 1], nombre: `F${n}.jpg`, wa_message_id: `wamid.${n}` });
    const agrupar = (propios, respuesta, config = cfgA) => correr(nodo('agrupar-confirmaciones.js', true), { input: respuesta, nodos: { Configuración: [{ config }], 'Resultado archivo': propios } });

    // El texto del aviso
    afirmar('un solo nombre: el aviso de siempre', comun.MENSAJE_ARCHIVOS_GUARDADOS(['A.jpg']) === comun.MENSAJE_ARCHIVO_GUARDADO('A.jpg', false));
    afirmar('varios nombres: un solo mensaje con la lista y una pregunta en plural', comun.MENSAJE_ARCHIVOS_GUARDADOS(['A.jpg', 'B.pdf', 'C.png']) === 'Guardados 3 archivos:\n• A.jpg\n• B.pdf\n• C.png\n¿Qué son o en qué carpeta los guardo?');
    const treinta = comun.MENSAJE_ARCHIVOS_GUARDADOS(Array.from({ length: 30 }, (_, i) => `f${i + 1}.jpg`));
    afirmar('más de 15: se enseñan 15 y «… y N más»', treinta.startsWith('Guardados 30 archivos:\n• f1.jpg') && treinta.includes('• f15.jpg') && !treinta.includes('• f16.jpg') && treinta.includes('… y 15 más'));
    afirmar('sin nombres válidos: el aviso de «no he podido registrarlo»', comun.MENSAJE_ARCHIVOS_GUARDADOS([]) === comun.MENSAJE_ARCHIVO_SIN_REGISTRO && comun.MENSAJE_ARCHIVOS_GUARDADOS(['', 5, null]) === comun.MENSAJE_ARCHIVO_SIN_REGISTRO);

    // La ejecución que se lleva los archivos manda UN mensaje con todos y declara suyos los mensajes de todos
    const t = await agrupar([propio(3)], [reclamado(1), reclamado(2), reclamado(3)]);
    afirmar('tres archivos reclamados: un solo item con la lista de los tres y el id de todos', t.length === 1 && t[0].mensajes[0] === 'Guardados 3 archivos:\n• F1.jpg\n• F2.jpg\n• F3.jpg\n¿Qué son o en qué carpeta los guardo?' && JSON.stringify(t[0].archivo_drive_ids) === JSON.stringify(IDS) && !('archivo_drive_id' in t[0]), JSON.stringify(t));
    afirmar('… y declara suyos los mensajes de los tres (se marcan contestados y su turno no espera a los otros)', JSON.stringify(t[0].contesta_todos) === JSON.stringify(['wamid.1', 'wamid.2', 'wamid.3']) && t[0].responde_a === 'wamid.3');
    const uno = await agrupar([propio(1)], [reclamado(1)]);
    afirmar('un solo archivo reclamado: el aviso y el id de siempre, sin lista', uno.length === 1 && uno[0].mensajes[0] === comun.MENSAJE_ARCHIVO_GUARDADO('F1.jpg', false) && uno[0].archivo_drive_id === IDS[0] && !('archivo_drive_ids' in uno[0]));
    // Las demás ejecuciones de la tanda se callan
    const callada = await agrupar([propio(1)], [{}]);
    afirmar('si no reclamó nada (otra ejecución se llevó los archivos, o aún llegan más): se calla — «agrupado», que Preparar envío ignora', callada.length === 1 && callada[0].agrupado === true && callada[0].ok === true && !('mensajes' in callada[0]));
    afirmar('… y Preparar envío no manda nada de lo callado', (await correr(nodo('preparar-envio.js', true), { input: callada, env: ENV })).length === 0);
    // Varios archivos en la misma ejecución: solo uno lleva el mensaje
    const dos = await agrupar([propio(1), propio(2)], [reclamado(1), reclamado(2), reclamado(3)]);
    afirmar('dos archivos en la misma ejecución y tres reclamados: solo el primero lleva el mensaje; el otro se calla', dos.length === 2 && dos[0].mensajes[0].startsWith('Guardados 3 archivos') && dos[1].agrupado === true && !('mensajes' in dos[1]));
    // Un archivo que no se registró sigue teniendo su aviso
    const sinReg = await agrupar([propio(1), { mensajes: [comun.MENSAJE_ARCHIVO_SIN_REGISTRO], responde_a: 'wamid.2', registrado: false, nombre: 'F2.jpg' }, propio(3)], [reclamado(1), reclamado(3)]);
    afirmar('un archivo sin registrar conserva su aviso propio y los demás se juntan', sinReg.length === 3 && sinReg[0].mensajes[0].startsWith('Guardados 2 archivos') && sinReg[1].mensajes[0] === comun.MENSAJE_ARCHIVO_SIN_REGISTRO && sinReg[2].agrupado === true);
    // Fallos y desactivación
    const fallo = await agrupar([propio(1), propio(2)], [{ error: { message: 'function does not exist' } }]);
    afirmar('si la llamada falla (p. ej. sin actualizar la base de datos a la 1.4): cada archivo se confirma por su cuenta, como antes', fallo.length === 2 && fallo[0].mensajes[0] === comun.MENSAJE_ARCHIVO_GUARDADO('F1.jpg', false) && fallo[1].mensajes[0] === comun.MENSAJE_ARCHIVO_GUARDADO('F2.jpg', false) && fallo[0].archivo_drive_id === IDS[0]);
    const apagado = await agrupar([propio(1), propio(2)], [reclamado(1), reclamado(2)], { ...CONFIG, espera_archivos_s: 0, quieto_archivos_s: 0 });
    afirmar('con ESPERA_ARCHIVOS_S = 0: un aviso por archivo, como antes (aunque haya algo reclamado)', apagado.length === 2 && apagado.every((x) => x.mensajes.length === 1 && !x.agrupado) && apagado[0].mensajes[0] === comun.MENSAJE_ARCHIVO_GUARDADO('F1.jpg', false));
    // Datos raros de la base de datos
    const raros = await agrupar([propio(1)], [reclamado(1), reclamado(1), { drive_file_id: 'a b/c', nombre: 'raro', wa_message_id: 'x' }, { drive_file_id: IDS[1], nombre: 'F2.jpg', wa_message_id: null }]);
    afirmar('ids repetidos o raros se descartan y un mensaje sin id no rompe nada', raros.length === 1 && JSON.stringify(raros[0].archivo_drive_ids) === JSON.stringify([IDS[0], IDS[1]]) && JSON.stringify(raros[0].contesta_todos) === JSON.stringify(['wamid.1']), JSON.stringify(raros));

    // Preparar envío: el mensaje agrupado lleva el id de todos y contesta a todos
    const env = await correr(nodo('preparar-envio.js', true), { input: t, env: ENV });
    afirmar('Preparar envío: el aviso agrupado lleva los tres ids de Drive y contesta a los tres mensajes', env.length === 1 && JSON.stringify(env[0].archivo_drive_ids) === JSON.stringify(IDS) && JSON.stringify(env[0].contesta) === JSON.stringify(['wamid.3', 'wamid.1', 'wamid.2']) && env[0].varios_mensajes === true && !('archivo_drive_id' in env[0]), JSON.stringify(env));
    const envUno = await correr(nodo('preparar-envio.js', true), { input: uno, env: ENV });
    afirmar('Preparar envío: con un solo archivo todo sigue como antes', envUno.length === 1 && envUno[0].archivo_drive_id === IDS[0] && !('archivo_drive_ids' in envUno[0]) && JSON.stringify(envUno[0].contesta) === JSON.stringify(['wamid.1']) && envUno[0].varios_mensajes === false, JSON.stringify(envUno));
    const envMal = await correr(nodo('preparar-envio.js', true), { input: [{ mensajes: ['x'], responde_a: 'wamid.9', archivo_drive_ids: ['bien_BIEN_123', 'a b/c', 7, ''], contesta_todos: ['wamid.9', 'con espacios', null] }], env: ENV });
    afirmar('Preparar envío: ids de archivo o de mensaje inválidos se descartan', JSON.stringify(envMal[0].archivo_drive_ids) === JSON.stringify(['bien_BIEN_123']) && JSON.stringify(envMal[0].contesta) === JSON.stringify(['wamid.9']), JSON.stringify(envMal[0]));

    // Anotar confirmación: el id del mensaje enviado se anota en todos los archivos
    const anotarG = await correr(nodo('anotar-confirmacion.js'), { input: [{ messages: [{ id: 'wamid.SALIDA9=' }] }], nodos: { Configuración: [{ config: CONFIG }], 'Recorrer mensajes': [{ para: NUMERO, texto: 'Guardados 3', archivo_drive_ids: IDS }] } });
    afirmar('Anotar confirmación: un PATCH para todos los archivos del aviso (in.(…)) con el id del mensaje enviado', anotarG[0].guardar === true && anotarG[0].url === `https://abc.supabase.co/rest/v1/archivos?drive_file_id=in.(${IDS.join(',')})` && JSON.stringify(anotarG[0].cuerpo) === '{"respuesta_wa_id":"wamid.SALIDA9="}', JSON.stringify(anotarG[0]));

  }

  console.log('Respuestas a un mensaje y confirmación de archivos');
  {
    const ext = (p) => comun.extraerMensajes(p, NUMERO);
    const conContexto = (m, ctx) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { messages: [{ from: NUMERO, id: 'wamid.R1', ...m, context: ctx }] } }] }] });
    const t = ext(conContexto({ type: 'text', text: { body: 'guárdala en Fotos' } }, { from: '1555', id: 'wamid.HBgMCONFIRMA=' }));
    afirmar('una respuesta de texto trae el id del mensaje citado', t.length === 1 && t[0].contexto_id === 'wamid.HBgMCONFIRMA=' && t[0].mensaje === 'guárdala en Fotos', JSON.stringify(t));
    afirmar('un texto sin respuesta lleva contexto_id vacío (nunca undefined)', ext(payloadTexto('hola'))[0].contexto_id === '');
    afirmar('cada mensaje lleva la hora de Meta (ts) para ordenar las respuestas; sin hora válida, vacía', ext(payloadTexto('hola'))[0].ts === '1760000000' && ext(payloadTipo('image', { image: { id: '9' }, timestamp: '17600x' }))[0].ts === '' && ext(payloadTipo('audio', { audio: { id: '9' }, timestamp: '1760000001' }))[0].ts === '1760000001');
    afirmar('un contexto sin id (reenviado) o con un id raro se ignora', [{ forwarded: true }, { id: 'con espacios' }, { id: 12 }, { id: '' }, { id: 'a"b' }, null, 'texto'].every((c) => ext(conContexto({ type: 'text', text: { body: 'x' } }, c))[0].contexto_id === ''));
    afirmar('una imagen también puede ser una respuesta', ext(conContexto({ type: 'image', image: { id: '99' } }, { id: 'wamid.X' }))[0].contexto_id === 'wamid.X');

    const preparar = nodo('preparar-envio.js', true);
    const pe = async (input) => correr(preparar, { input });
    const conf = await pe([{ mensajes: ['Guardado en Entrada: «a.jpg».'], archivo_drive_id: 'DRIVE_1' }, { mensajes: ['uno', 'dos'], archivo_drive_id: 'DRIVE_2' }, { mensajes: ['Hecho.'] }]);
    afirmar('Preparar envío: la confirmación de un archivo lleva el id del archivo', conf[0].archivo_drive_id === 'DRIVE_1' && conf[0].texto.startsWith('Guardado'));
    const agrupado = await correr(nodo('preparar-envio.js', true), { input: [{ ok: true, agrupado: true, mensajes: [] }] });
    afirmar('Preparar envío: un mensaje agrupado en otro (cola) no contesta nada, ni el aviso de fallo', agrupado.length === 0);
    const agrupadoMal = await correr(nodo('preparar-envio.js', true), { input: [{ ok: false, agrupado: true, mensajes: [] }] });
    afirmar('Preparar envío: «agrupado» con ok falso no se calla (aviso de fallo)', agrupadoMal.length === 1 && agrupadoMal[0].texto === comun.MENSAJE_FALLO_CANAL);
    afirmar('solo el primer texto de varios lleva el id, y un mensaje normal no lo lleva', conf[1].archivo_drive_id === 'DRIVE_2' && !('archivo_drive_id' in conf[2]) && !('archivo_drive_id' in conf[3]) && conf.length === 4);
    const sinId = await pe([{ mensajes: ['a'], archivo_drive_id: '' }, { mensajes: ['b'], archivo_drive_id: 5 }]);
    afirmar('un id de archivo vacío o que no es texto no se propaga (comprobado)', sinId.length === 2 && sinId.every((x) => !('archivo_drive_id' in x)));

    const res = await correr(nodo('resultado-archivo.js', true), { input: [{ drive_file_id: 'DRV9' }, { error: { message: '409' } }], nodos: { '¿Subido?': [{ ok: true, nombre: 'a.jpg', tiene_pie: false }, { ok: true, nombre: 'b.jpg', tiene_pie: false }] } });
    afirmar('Resultado archivo: el id del archivo viaja solo si se registró', res[0].archivo_drive_id === 'DRV9' && !('archivo_drive_id' in res[1]) && res[1].mensajes[0] === comun.MENSAJE_ARCHIVO_SIN_REGISTRO);

    const anotar = nodo('anotar-confirmacion.js');
    const envios = [{ para: NUMERO, texto: 'Guardado', archivo_drive_id: 'DRIVE_A/b?c' }, { para: NUMERO, texto: 'Hecho.' }, { para: NUMERO, texto: 'Guardado 2', archivo_drive_id: 'DRIVE_C' }, { para: NUMERO, texto: 'Guardado 3', archivo_drive_id: 'DRIVE_D' }];
    const respuestasMeta = [{ messages: [{ id: 'wamid.SALIDA1=' }] }, { messages: [{ id: 'wamid.SALIDA2' }] }, { error: { message: '401' } }, { messages: [{ id: 'con espacios raros' }] }];
    const an = await correr(anotar, { input: respuestasMeta, nodos: { Configuración: [{ config: CONFIG }], 'Recorrer mensajes': envios } });
    afirmar('Anotar confirmación: devuelve SIEMPRE un item por mensaje (dentro de un bucle un hueco lo cortaría)', an.length === 4, JSON.stringify(an));
    afirmar('Anotar confirmación: solo el mensaje de archivo cuyo envío devolvió un id válido manda guardar', an.map((x) => x.guardar).join() === 'true,false,false,false', JSON.stringify(an));
    afirmar('Anotar confirmación: PATCH a la fila de ese archivo (id codificado) con el id del mensaje enviado', an[0].url === 'https://abc.supabase.co/rest/v1/archivos?drive_file_id=eq.DRIVE_A%2Fb%3Fc' && JSON.stringify(an[0].cuerpo) === '{"respuesta_wa_id":"wamid.SALIDA1="}' && an[0].envio_error === null, JSON.stringify(an[0]));
    afirmar('Anotar confirmación: un envío con error lo deja dicho (envio_error), sin guardar nada', an[2].guardar === false && an[2].envio_error === '401' && !('url' in an[2]));
    afirmar('Anotar confirmación: un id con caracteres raros no se guarda', an[3].guardar === false && an[3].envio_error === null);
    afirmar('Anotar confirmación: devuelve también el id enviado y el texto (para poder citar la respuesta); sin id válido o con error, id nulo', an[0].wamid === 'wamid.SALIDA1=' && an[0].texto === 'Guardado' && an[1].wamid === 'wamid.SALIDA2' && an[1].texto === 'Hecho.' && an[2].wamid === null && an[3].wamid === null && an[2].texto === 'Guardado 2', JSON.stringify(an.map((x) => [x.wamid, x.texto])));
    const nada = await correr(anotar, { input: [{ messages: [{ id: 'wamid.Z' }] }], nodos: { Configuración: [{ config: CONFIG }], 'Recorrer mensajes': [{ para: NUMERO, texto: 'Hecho.' }] } });
    afirmar('Anotar confirmación: una respuesta normal no guarda nada, pero sigue habiendo item', nada.length === 1 && nada[0].guardar === false && nada[0].envio_error === null);
    const largoErr = await correr(anotar, { input: [{ error: { message: `${'x '.repeat(300)}fin\nsalto` } }], nodos: { Configuración: [{ config: CONFIG }], 'Recorrer mensajes': [{ para: NUMERO, texto: 'Hecho.' }] } });
    afirmar('Anotar confirmación: el detalle del error se recorta y se aplana', largoErr[0].envio_error.length <= 200 && !largoErr[0].envio_error.includes('\n'));

    // Cerrar envío: recoge el resultado de cada vuelta
    const cerrar = nodo('cerrar-envio.js');
    const conGuardar = await correr(cerrar, { input: [{}], nodos: { 'Anotar confirmación': [{ guardar: true, envio_error: null, url: 'u', cuerpo: {} }] } });
    afirmar('Cerrar envío: todo bien -> sin errores', conGuardar.length === 1 && conGuardar[0].envio_error === null && conGuardar[0].id_error === null, JSON.stringify(conGuardar));
    afirmar('Cerrar envío: arrastra el id enviado y el texto', (await correr(cerrar, { input: [{}], nodos: { 'Anotar confirmación': [{ guardar: false, envio_error: null, wamid: 'wamid.X1', texto: 'Hola' }] } }))[0].wamid === 'wamid.X1');
    afirmar('… y sin ellos, id nulo y texto vacío (un Anotar confirmación antiguo)', (await correr(cerrar, { input: [{}], nodos: { 'Anotar confirmación': [{ guardar: false, envio_error: null }] } })).every((x) => x.wamid === null && x.texto === ''));
    const guardarFalla = await correr(cerrar, { input: [{ error: { message: 'Supabase 500' } }], nodos: { 'Anotar confirmación': [{ guardar: true, envio_error: null, url: 'u', cuerpo: {} }] } });
    afirmar('Cerrar envío: si falló guardar el id de la confirmación, lo dice', guardarFalla[0].id_error === 'Supabase 500' && guardarFalla[0].envio_error === null);
    const sinGuardar = await correr(cerrar, { input: [{ guardar: false, envio_error: 'HTTP 401' }], nodos: { 'Anotar confirmación': [{ guardar: false, envio_error: 'HTTP 401' }] } });
    afirmar('Cerrar envío: si el envío falló, lo arrastra; sin guardar no hay error de guardado aunque llegue un error ajeno', sinGuardar[0].envio_error === 'HTTP 401' && sinGuardar[0].id_error === null);
  }

  console.log('Audio: leer del webhook');
  {
    const ext = (p) => comun.extraerMensajes(p, NUMERO);
    const a = ext(payloadTipo('audio', { audio: { id: 'MEDIA-77', mime_type: 'audio/ogg; codecs=opus', voice: true }, context: { id: 'wamid.CITADO' } }));
    afirmar('una nota de voz con id se lee como audio, con su media_id, tipo y contexto', a.length === 1 && a[0].tipo_entrada === 'audio' && a[0].media_id === 'MEDIA-77' && a[0].mime_type === 'audio/ogg; codecs=opus' && a[0].wa_message_id === 'wamid.audio' && a[0].contexto_id === 'wamid.CITADO', JSON.stringify(a));
    afirmar('un audio sin id utilizable sigue siendo «no soportado»', ext(payloadTipo('audio'))[0].tipo_entrada === 'no_soportado' && ext(payloadTipo('audio', { audio: { id: 'a b/c' } }))[0].tipo_entrada === 'no_soportado');
    afirmar('un audio de otro remitente se descarta', ext(payloadTipo('audio', { audio: { id: 'X1' }, from: '34699999999' })).length === 0);
  }

  console.log('Audio: decisión, petición y transcripción');
  {
    const meta = { url: 'https://lookaside.fbsbx.com/a', mime_type: 'audio/ogg; codecs=opus', file_size: 80000, id: 'M1' };
    const ok = comun.planificarAudio({ entrada: { tipo_entrada: 'audio' }, metadatos: meta, limiteMb: 10 });
    afirmar('una nota de voz normal se acepta y el tipo se limpia (sin codecs)', ok.ok === true && ok.mime_type === 'audio/ogg' && ok.media_url === meta.url && ok.tamano === 80000, JSON.stringify(ok));
    afirmar('si Meta no devuelve el tipo se usa el del webhook', comun.planificarAudio({ entrada: { mime_type: 'audio/mpeg' }, metadatos: { ...meta, mime_type: '' }, limiteMb: 10 }).mime_type === 'audio/mpeg');
    afirmar('audio/mp3 y audio/x-wav se normalizan a los tipos de Gemini', comun.planificarAudio({ entrada: {}, metadatos: { ...meta, mime_type: 'audio/mp3' }, limiteMb: 10 }).mime_type === 'audio/mpeg' && comun.planificarAudio({ entrada: {}, metadatos: { ...meta, mime_type: 'audio/x-wav' }, limiteMb: 10 }).mime_type === 'audio/wav');
    const mal = (m, extra = {}) => comun.planificarAudio({ entrada: {}, metadatos: m, limiteMb: 10, ...extra });
    afirmar('sin URL o con error de Meta: aviso honesto', [mal({ error: { message: 'x' } }), mal({}), mal(null)].every((r) => !r.ok && r.texto === comun.MENSAJE_AUDIO_FALLO));
    afirmar('una URL que no es de Meta se rechaza (el token no sale de Meta)', !mal({ ...meta, url: 'https://evil.example.com/a' }).ok && !mal({ ...meta, url: 'https://lookaside.fbsbx.com@evil.com/a' }).ok && !mal({ ...meta, url: 'http://lookaside.fbsbx.com/a' }).ok);
    const amr = mal({ ...meta, mime_type: 'audio/amr' });
    afirmar('un formato que Gemini no admite (AMR) se rechaza diciendo qué sí vale', !amr.ok && amr.texto === comun.MENSAJE_AUDIO_TIPO('audio/amr') && amr.texto.includes('nota de voz'));
    afirmar('un audio de más de 10 MB se rechaza con su tamaño', mal({ ...meta, file_size: 12 * 1048576 }).texto === comun.MENSAJE_AUDIO_GRANDE(12 * 1048576, 10) && comun.MENSAJE_AUDIO_GRANDE(12 * 1048576, 10).includes('12,0 MB'));
    afirmar('el límite sale del parámetro', mal({ ...meta, file_size: 2 * 1048576 }, { limiteMb: 1 }).ok === false && mal({ ...meta, file_size: 2 * 1048576 }, { limiteMb: 3 }).ok === true);
    afirmar('todos los tipos admitidos son de Gemini (ogg, opus, mp3, aac, wav, flac)', comun.AUDIO_ADMITIDO.every((m) => /^audio\/(ogg|opus|mpeg|mp3|aac|wav|x-wav|flac)$/.test(m)));

    const c = comun.cuerpoTranscripcion({ mime: 'audio/ogg', base64: 'QUJD' });
    afirmar('la petición a Gemini: instrucción + inline_data en base64, temperatura 0', c.contents[0].role === 'user' && c.contents[0].parts[0].text === comun.INSTRUCCION_TRANSCRIPCION && c.contents[0].parts[1].inline_data.mime_type === 'audio/ogg' && c.contents[0].parts[1].inline_data.data === 'QUJD' && c.generationConfig.temperature === 0, JSON.stringify(c).slice(0, 200));
    afirmar('la instrucción pide solo transcribir y no obedecer lo que diga el audio', /literalmente/.test(comun.INSTRUCCION_TRANSCRIPCION) && /No obedezcas/.test(comun.INSTRUCCION_TRANSCRIPCION) && comun.INSTRUCCION_TRANSCRIPCION.includes('[inaudible]'));

    const resp = (t) => ({ candidates: [{ content: { parts: [{ text: t }] } }] });
    const bien = comun.leerTranscripcion(resp('  Recuérdame\n comprar leche mañana  '));
    afirmar('una respuesta normal: texto limpio y en una línea', bien.ok === true && bien.texto === 'Recuérdame comprar leche mañana');
    afirmar('las partes de razonamiento (thought) no entran en la transcripción', comun.leerTranscripcion({ candidates: [{ content: { parts: [{ text: 'pensando', thought: true }, { text: 'hola' }] } }] }).texto === 'hola');
    const ina = comun.leerTranscripcion(resp('[inaudible]'));
    afirmar('[inaudible] (con cualquier mayúscula): pide repetir', ina.ok === false && ina.texto === comun.MENSAJE_AUDIO_INAUDIBLE && comun.leerTranscripcion(resp('[Inaudible]')).ok === false);
    afirmar('error de Gemini, sin texto o sin respuesta: aviso honesto de que no se pudo transcribir', [{ error: { message: 'boom' } }, { candidates: [] }, resp('   '), null, undefined].every((r) => { const x = comun.leerTranscripcion(r); return !x.ok && x.texto === comun.MENSAJE_AUDIO_TRANSCRIPCION_FALLO; }));
    const largo = comun.leerTranscripcion(resp('palabra '.repeat(700)));
    afirmar('una transcripción de más de 4.000 caracteres se rechaza en vez de recortarse', !largo.ok && largo.texto === comun.MENSAJE_AUDIO_LARGO);
  }

  console.log('Audio: sin eco de lo entendido ');
  {
    const transcritos = [
      { ok: true, mensaje: 'Compra leche', wa_message_id: 'wamid.A1', tipo_entrada: 'audio', contexto_id: 'wamid.C' },
      { ok: false, mensajes: ['No he conseguido entender ese audio.'], motivo: 'inaudible' },
    ];
    const entrada = await correr(nodo('entrada-audio.js'), { input: [{ messages: [{ id: 'wamid.eco' }] }], nodos: { 'Leer transcripción': transcritos } });
    afirmar('Entrada del audio: devuelve el audio transcrito como espera Procesar mensaje (y descarta los fallidos)', entrada.length === 1 && entrada[0].mensaje === 'Compra leche' && entrada[0].wa_message_id === 'wamid.A1' && entrada[0].tipo_entrada === 'audio' && entrada[0].contexto_id === 'wamid.C' && !('messages' in entrada[0]), JSON.stringify(entrada));
    afirmar('lo transcrito entra en la cola: ¿Transcrito? -> Entrada del audio -> Preparar cola', flujoEco.connections['¿Transcrito?'].main[0][0].node === 'Entrada del audio' && flujoEco.connections['Entrada del audio'].main[0][0].node === 'Preparar cola');
    afirmar('no hay nodos de eco: ni «Mensaje de eco» ni «Enviar lo entendido»', !flujoEco.nodes.some((x) => ['Mensaje de eco', 'Enviar lo entendido'].includes(x.name)) && !('Mensaje de eco' in flujoEco.connections));
    afirmar('¿Procesar? llama solo a Procesar mensaje en su primera salida; En cola solo espera', JSON.stringify(flujoEco.connections['¿Procesar?'].main[0].map((d) => d.node)) === JSON.stringify(['Procesar mensaje']));
    afirmar('Comprobar envío ya no mira el eco', !nodo('comprobar-envio.js').includes('Enviar lo entendido'));
  }

  console.log('Nodos de la rama de audio');
  {
    const cfg = { ...CONFIG, limite_audio_mb: 10 };
    const entrada = { wa_message_id: 'wamid.A1', tipo_entrada: 'audio', media_id: 'M1', mime_type: 'audio/ogg; codecs=opus', contexto_id: 'wamid.C' };
    const comprobar = nodo('comprobar-audio.js', true);
    const bien = await correr(comprobar, { input: [{ url: 'https://lookaside.fbsbx.com/a', mime_type: 'audio/ogg; codecs=opus', file_size: 5000 }], nodos: { Configuración: [{ config: cfg }], '¿Es audio?': [entrada] } });
    afirmar('Comprobar audio: un audio válido sigue con su wa_message_id, tipo y contexto', bien[0].ok === true && bien[0].wa_message_id === 'wamid.A1' && bien[0].mime_type === 'audio/ogg' && bien[0].contexto_id === 'wamid.C', JSON.stringify(bien[0]));
    const malo = await correr(comprobar, { input: [{ error: { message: '401' } }], nodos: { Configuración: [{ config: cfg }], '¿Es audio?': [entrada] } });
    afirmar('Comprobar audio: si Meta falla, un mensaje honesto y nada más', malo[0].ok === false && malo[0].mensajes[0] === comun.MENSAJE_AUDIO_FALLO);
    afirmar('Comprobar audio: el aviso citará el audio rechazado', malo[0].responde_a === 'wamid.A1');

    // Preparar transcripción: lee el binario con el ayudante de n8n y arma el cuerpo
    const preparar = nodo('preparar-transcripcion.js', true);
    const correrConBinario = async (codigo, { input, nodos, buffer, falla = false }) => {
      const items = input.map((json) => ({ json }));
      const fn = new AsyncFunction('$input', '$', '$env', 'DateTime', 'require', codigo);
      const helpers = { getBinaryDataBuffer: async (i, prop) => { if (falla) throw new Error('sin binario'); if (prop !== 'data') throw new Error('propiedad inesperada ' + prop); return buffer; } };
      const salida = await fn.call({ helpers }, { all: () => items, first: () => items[0] }, simularConBinario(nodos), ENV, DateTimeFalso, require);
      return salida.map((x) => x.json);
    };
    const prep = await correrConBinario(preparar, { input: [{}], nodos: { 'Comprobar audio': [bien[0]] }, buffer: Buffer.from('ABC') });
    afirmar('Preparar transcripción: el binario pasa a base64 en el cuerpo de Gemini, con el tipo comprobado', prep[0].cuerpo.contents[0].parts[1].inline_data.data === 'QUJD' && prep[0].cuerpo.contents[0].parts[1].inline_data.mime_type === 'audio/ogg', JSON.stringify(prep[0]).slice(0, 200));
    let lanzo = false;
    try { await correrConBinario(preparar, { input: [{}], nodos: { 'Comprobar audio': [bien[0]] }, buffer: Buffer.alloc(0) }); } catch (e) { lanzo = /vacío/.test(e.message); }
    afirmar('Preparar transcripción: un audio vacío lanza un error (el flujo contesta con aviso honesto)', lanzo);
    lanzo = false;
    try { await correrConBinario(preparar, { input: [{}], nodos: { 'Comprobar audio': [bien[0]] }, falla: true }); } catch (e) { lanzo = /sin binario/.test(e.message); }
    afirmar('Preparar transcripción: si n8n no puede leer el binario, el error se propaga', lanzo);

    const leer = nodo('leer-transcripcion.js', true);
    const resp = { candidates: [{ content: { parts: [{ text: 'Mañana a las diez dentista' }] } }] };
    const ok = await correrConBinario(leer, { input: [resp], nodos: { 'Comprobar audio': [bien[0]] } });
    afirmar('Leer transcripción: lo entendido entra como un mensaje de tipo audio, con su id y su contexto', ok[0].ok === true && ok[0].mensaje === 'Mañana a las diez dentista' && ok[0].tipo_entrada === 'audio' && ok[0].wa_message_id === 'wamid.A1' && ok[0].contexto_id === 'wamid.C', JSON.stringify(ok[0]));
    const fallo = await correrConBinario(leer, { input: [{ error: { message: '500' } }], nodos: { 'Comprobar audio': [bien[0]] } });
    afirmar('Leer transcripción: si Gemini falla, aviso honesto y no pasa al flujo principal', fallo[0].ok === false && fallo[0].mensajes[0] === comun.MENSAJE_AUDIO_TRANSCRIPCION_FALLO && !('mensaje' in fallo[0]));
    afirmar('Leer transcripción: el aviso de fallo citará el audio', fallo[0].responde_a === 'wamid.A1');
    const vacio = await correrConBinario(leer, { input: [{ candidates: [{ content: { parts: [{ text: '[inaudible]' }] } }] }], nodos: { 'Comprobar audio': [bien[0]] } });
    afirmar('Leer transcripción: un audio inaudible pide repetirlo', vacio[0].ok === false && vacio[0].mensajes[0] === comun.MENSAJE_AUDIO_INAUDIBLE);

    // Un audio fallido llega a Preparar envío con "mensajes" y se contesta con ese texto
    const envio = await correr(nodo('preparar-envio.js', true), { input: [fallo[0]] });
    afirmar('un audio fallido se contesta con su aviso (Preparar envío)', envio.length === 1 && envio[0].texto === comun.MENSAJE_AUDIO_TRANSCRIPCION_FALLO);
  }

  console.log('Enviar archivos: decisión y mensajes');
  {
    const idOk = 'ID_DRIVE_0001';
    const drive = (o = {}) => ({ id: idOk, name: 'foto.jpg', mimeType: 'image/jpeg', size: '200000', ...o });
    const plan = (metadatos, archivo = {}, limiteMb = 25) => comun.planificarEnvioArchivo({ archivo: { drive_file_id: idOk, nombre: 'foto.jpg', tipo_mime: 'image/jpeg', ...archivo }, metadatos, limiteMb });
    const ok = plan(drive());
    afirmar('una foto JPEG pequeña se manda como imagen', ok.accion === 'mandar' && ok.categoria === 'image' && ok.mime === 'image/jpeg' && ok.id === idOk && ok.nombre === 'foto.jpg', JSON.stringify(ok));
    afirmar('un PNG también es imagen', plan(drive({ mimeType: 'image/png' }), { nombre: 'a.png' }).categoria === 'image');
    const pdf = plan(drive({ mimeType: 'application/pdf', size: '3000000' }), { nombre: 'Contrato.pdf' });
    afirmar('un PDF se manda como documento, con su nombre', pdf.accion === 'mandar' && pdf.categoria === 'document' && pdf.nombre === 'Contrato.pdf');
    afirmar('un nombre sin extensión la recibe del tipo', plan(drive({ mimeType: 'application/pdf' }), { nombre: 'Presupuesto' }).nombre === 'Presupuesto.pdf');
    afirmar('el tipo sale de Drive y no de lo que dijera la base de datos', plan(drive({ mimeType: 'application/pdf' }), { tipo_mime: 'image/jpeg', nombre: 'x.pdf' }).categoria === 'document');
    afirmar('el tipo con parámetros (; charset) se limpia', plan(drive({ mimeType: 'text/plain; charset=utf-8' }), { nombre: 'n.txt' }).accion === 'mandar');
    const grande = plan(drive({ size: String(6 * 1048576) }));
    afirmar('una imagen de más de 5 MB se manda como enlace explicando por qué', grande.accion === 'enlace' && grande.razon.includes('6,0 MB') && grande.razon.includes('máximo es 5 MB'), JSON.stringify(grande));
    afirmar('un documento de 30 MB con límite de 25 se manda como enlace', plan(drive({ mimeType: 'application/pdf', size: String(30 * 1048576) }), {}, 25).accion === 'enlace' && plan(drive({ mimeType: 'application/pdf', size: String(30 * 1048576) }), {}, 50).accion === 'mandar');
    afirmar('nunca se supera el máximo de Meta para documentos (100 MB) aunque el límite sea mayor', plan(drive({ mimeType: 'application/pdf', size: String(101 * 1048576) }), {}, 500).accion === 'enlace');
    afirmar('un tipo que Meta no admite (zip, documento de Google) se manda como enlace', plan(drive({ mimeType: 'application/zip' })).accion === 'enlace' && plan(drive({ mimeType: 'application/vnd.google-apps.document', size: undefined })).accion === 'enlace');
    afirmar('si Drive falla o no devuelve el tipo, enlace', plan({ error: { message: '404' } }).accion === 'enlace' && plan({}).accion === 'enlace' && plan(null).accion === 'enlace');
    afirmar('sin tamaño o con tamaño 0, enlace (no se adivina)', plan(drive({ size: undefined })).accion === 'enlace' && plan(drive({ size: '0' })).accion === 'enlace');
    afirmar('un id de Drive que no es un id se omite sin más (ni siquiera el enlace)', ['a b/c', '', null, '../../x', 'corto'].every((id) => plan(drive(), { drive_file_id: id }).accion === 'omitir'));
    afirmar('el nombre se limpia de caracteres peligrosos', plan(drive({ mimeType: 'application/pdf' }), { nombre: 'a/b:c?.pdf' }).nombre === 'a_b_c_.pdf');

    const e = comun.cuerpoEnlaceArchivo({ para: NUMERO, id: idOk, nombre: 'foto.jpg', razon: 'pesa mucho' });
    afirmar('el mensaje de enlace: texto al número, con el nombre, el motivo y el enlace de Drive', e.type === 'text' && e.to === NUMERO && e.messaging_product === 'whatsapp' && e.text.body === comun.MENSAJE_ENLACE_ARCHIVO('foto.jpg', 'pesa mucho', idOk) && e.text.body.includes('https://drive.google.com/file/d/ID_DRIVE_0001/view'), JSON.stringify(e));
    const im = comun.cuerpoArchivoSubido({ para: NUMERO, categoria: 'image', mediaId: '555', nombre: 'foto.jpg' });
    afirmar('el mensaje de imagen: type image con el id de Meta y sin pie', im.type === 'image' && im.image.id === '555' && im.to === NUMERO && im.messaging_product === 'whatsapp' && im.recipient_type === 'individual' && !('caption' in im.image) && !('document' in im));
    const doc = comun.cuerpoArchivoSubido({ para: NUMERO, categoria: 'document', mediaId: '556', nombre: 'Contrato.pdf' });
    afirmar('el mensaje de documento: type document con el id de Meta y el nombre de archivo', doc.type === 'document' && doc.document.id === '556' && doc.document.filename === 'Contrato.pdf' && !('image' in doc));
    afirmar('el tope de archivos por petición es 20', comun.MAX_ENVIOS_ARCHIVOS === 20);
    const cab = comun.cuerpoCabeceraCarpeta({ para: NUMERO, ruta: 'Fotos/Viajes', total: 3 });
    afirmar('la cabecera de carpeta: texto al número con el nombre en negrita y el número de archivos', cab.type === 'text' && cab.to === NUMERO && cab.messaging_product === 'whatsapp' && cab.text.body === '*Fotos/Viajes* (3)', JSON.stringify(cab));
    afirmar('la cabecera limpia los caracteres de formato del nombre y nunca queda vacía', comun.cuerpoCabeceraCarpeta({ para: NUMERO, ruta: 'Trabajo/*Informes* _1_', total: 2 }).text.body === '*Trabajo/Informes 1* (2)' && comun.cuerpoCabeceraCarpeta({ para: NUMERO, ruta: '', total: 1 }).text.body === '*Sin carpeta* (1)');
    const hs = comun.cabecerasDeEnvio(['Fotos', 'Fotos', 'Notas', 'Trabajo/Informes', 'Trabajo/Informes', 'Trabajo/Informes']);
    afirmar('cabeceras: una antes del primer archivo de cada carpeta, con el recuento de esa carpeta', hs.map((h) => (h ? h.ruta + ':' + h.total : '-')).join() === 'Fotos:2,-,Notas:1,Trabajo/Informes:3,-,-', JSON.stringify(hs));
    afirmar('cabeceras: sin archivos no hay cabeceras', comun.cabecerasDeEnvio([]).length === 0);
  }

  console.log('Nodos de la rama de envío de archivos');
  {
    const cfg = { ...CONFIG, limite_adjunto_mb: 25 };
    const idA = 'ID_DRIVE_0001';
    const idB = 'ID_DRIVE_0002';
    const idC = 'ID_DRIVE_0003';
    const av = comun.cuerpoAvisoArchivo({ para: NUMERO, nombre: 'a/b.jpg' });
    afirmar('aviso de archivo sin id válido: texto al número con el nombre limpio', av.type === 'text' && av.to === NUMERO && av.text.body === 'No he podido mandarte «a_b.jpg»: no encuentro el archivo en Drive.', JSON.stringify(av));

    // ---- Preparar archivos a enviar: la secuencia ordenada (cabecera, sus archivos, siguiente cabecera…) ----
    const preparar = nodo('preparar-archivos-envio.js', true);
    const principal = (envios) => [{ ok: true, mensajes: ['Te mando archivos:'], envios_archivos: envios }];
    const sec = await correr(preparar, { input: [{}], nodos: { 'Turno de respuesta': principal([
      { drive_file_id: idA, nombre: 'a.jpg', tipo_mime: 'image/jpeg', ruta: 'Fotos' },
      { drive_file_id: idB, nombre: 'b.jpg', tipo_mime: 'image/jpeg', ruta: 'Fotos' },
      { drive_file_id: idC, nombre: 'Contrato.pdf', tipo_mime: 'application/pdf', ruta: 'Trabajo/Informes' },
    ]) } });
    afirmar('Preparar archivos a enviar: la secuencia es cabecera, sus archivos, cabecera, sus archivos (así llegan en ese orden)', sec.map((x) => (x.tipo === 'cabecera' ? 'C:' + x.ruta + ':' + x.total : 'A:' + x.nombre)).join('|') === 'C:Fotos:2|A:a.jpg|A:b.jpg|C:Trabajo/Informes:1|A:Contrato.pdf', JSON.stringify(sec));
    afirmar('cada archivo de la secuencia lleva id, nombre, tipo y carpeta', sec[1].drive_file_id === idA && sec[1].tipo_mime === 'image/jpeg' && sec[1].ruta === 'Fotos' && sec[4].tipo_mime === 'application/pdf');
    afirmar('sin archivos que mandar (lo normal) la rama termina', (await correr(preparar, { input: [{}], nodos: { 'Turno de respuesta': [{ ok: true, mensajes: ['hola'], envios_archivos: [] }, { ok: true, mensajes: ['hola'] }, {}] } })).length === 0);
    const raros = await correr(preparar, { input: [{}], nodos: { 'Turno de respuesta': principal([{ drive_file_id: 'a b/c', nombre: 'x', ruta: 'Fotos' }, null, { nombre: 'sin id' }, { drive_file_id: idA, ruta: 'Fotos' }]) } });
    afirmar('ids no válidos y elementos raros se descartan, y no dejan una cabecera huérfana', raros.length === 2 && raros[0].tipo === 'cabecera' && raros[0].total === 1 && raros[1].drive_file_id === idA && raros[1].nombre === '');
    afirmar('solo ids no válidos: no queda nada (ni cabecera)', (await correr(preparar, { input: [{}], nodos: { 'Turno de respuesta': principal([{ drive_file_id: 'a b/c', ruta: 'Fotos' }]) } })).length === 0);
    const muchos = await correr(preparar, { input: [{}], nodos: { 'Turno de respuesta': principal(Array.from({ length: 25 }, (_, i) => ({ drive_file_id: 'ID_DRIVE_' + String(i).padStart(4, '0'), nombre: 'f' + i, ruta: 'Fotos' }))) } });
    afirmar('nunca se mandan más de 20 archivos aunque el flujo principal devolviera más (21 items: 20 archivos y una cabecera)', muchos.filter((x) => x.tipo === 'archivo').length === 20 && muchos.length === 21);

    // ---- Mensaje de cabecera ----
    const cab = await correr(nodo('mensaje-cabecera.js', true), { input: [{ tipo: 'cabecera', ruta: 'Fotos/Viajes', total: 3 }] });
    afirmar('Mensaje de cabecera: el nombre en negrita con el número de archivos, al número permitido', cab.length === 1 && cab[0].cuerpo.text.body === '*Fotos/Viajes* (3)' && cab[0].cuerpo.to === NUMERO && cab[0].cuerpo.type === 'text', JSON.stringify(cab));
    let lanzoCab = false;
    try { await correr(nodo('mensaje-cabecera.js', true), { input: [{ tipo: 'cabecera', ruta: 'Fotos', total: 1 }], env: {} }); } catch (e) { lanzoCab = /WHATSAPP_NUMERO_PERMITIDO/.test(e.message); }
    afirmar('Mensaje de cabecera: sin el número permitido en el entorno, lanza un error', lanzoCab);

    // ---- Decidir envío de archivo: un item de salida por cada uno de entrada, SIEMPRE (si no, el bucle se corta) ----
    const decidir = nodo('decidir-envio-archivo.js', true);
    const delBucle = [
      { tipo: 'archivo', drive_file_id: idA, nombre: 'foto.jpg', tipo_mime: 'image/jpeg', ruta: 'Fotos' },
    ];
    const drive = [{ id: idA, name: 'foto.jpg', mimeType: 'image/jpeg', size: '200000' }];
    const dec = await correr(decidir, { input: drive, nodos: { Configuración: [{ config: cfg }], 'Recorrer envíos': delBucle } });
    afirmar('Decidir envío: una foto pequeña se manda (imagen)', dec.length === 1 && dec[0].mandar === true && dec[0].categoria === 'image' && dec[0].id === idA && dec[0].mime === 'image/jpeg', JSON.stringify(dec));
    const pdfGrande = await correr(decidir, { input: [{ id: idB, name: 'Contrato.pdf', mimeType: 'application/pdf', size: String(40 * 1048576) }], nodos: { Configuración: [{ config: cfg }], 'Recorrer envíos': [{ tipo: 'archivo', drive_file_id: idB, nombre: 'Contrato.pdf', tipo_mime: 'application/pdf', ruta: 'Trabajo/Informes' }] } });
    afirmar('Decidir envío: un PDF de 40 MB (límite 25) va como enlace al número permitido', pdfGrande.length === 1 && pdfGrande[0].mandar === false && pdfGrande[0].cuerpo.to === NUMERO && pdfGrande[0].cuerpo.text.body.includes('Contrato.pdf') && pdfGrande[0].cuerpo.text.body.includes('drive.google.com/file/d/' + idB), JSON.stringify(pdfGrande));
    const errDrive = await correr(decidir, { input: [{ error: { message: '403' } }], nodos: { Configuración: [{ config: cfg }], 'Recorrer envíos': delBucle } });
    afirmar('Decidir envío: si Drive falla con el archivo, va como enlace (sigue habiendo salida)', errDrive.length === 1 && errDrive[0].mandar === false && errDrive[0].cuerpo.text.body.includes('no he podido leerlo en Drive'));
    const sinId = await correr(decidir, { input: drive, nodos: { Configuración: [{ config: cfg }], 'Recorrer envíos': [{ tipo: 'archivo', drive_file_id: 'a b/c', nombre: 'raro.jpg', ruta: 'Fotos' }] } });
    afirmar('Decidir envío: un id no válido (no debería llegar) produce un aviso, no un hueco que corte el bucle', sinId.length === 1 && sinId[0].mandar === false && sinId[0].cuerpo.text.body.includes('raro.jpg'), JSON.stringify(sinId));
    let lanzo = false;
    try { await correr(decidir, { input: drive, nodos: { Configuración: [{ config: cfg }], 'Recorrer envíos': delBucle }, env: {} }); } catch (e) { lanzo = /WHATSAPP_NUMERO_PERMITIDO/.test(e.message); }
    afirmar('Decidir envío: sin el número permitido en el entorno, lanza un error', lanzo);

    // ---- Preparar mensaje de archivo ----
    const prep = nodo('preparar-mensaje-archivo.js', true);
    const nodosDecidir = { 'Decidir envío de archivo': [dec[0]] };
    const imagen = await correr(prep, { input: [{ id: '777' }], nodos: nodosDecidir });
    afirmar('Preparar mensaje de archivo: con el id de Meta, una imagen', imagen.length === 1 && imagen[0].cuerpo.type === 'image' && imagen[0].cuerpo.image.id === '777', JSON.stringify(imagen));
    const documento = await correr(prep, { input: [{ id: '778' }], nodos: { 'Decidir envío de archivo': [{ mandar: true, id: idB, nombre: 'Contrato.pdf', mime: 'application/pdf', categoria: 'document' }] } });
    afirmar('Preparar mensaje de archivo: un documento lleva su nombre de archivo', documento[0].cuerpo.type === 'document' && documento[0].cuerpo.document.id === '778' && documento[0].cuerpo.document.filename === 'Contrato.pdf');
    const fallos = await correr(prep, { input: [{ error: { message: '400' } }], nodos: nodosDecidir });
    afirmar('Preparar mensaje de archivo: si Meta no devuelve id (subida fallida), se manda el enlace (sigue habiendo salida)', fallos.length === 1 && fallos[0].cuerpo.type === 'text' && fallos[0].cuerpo.text.body.includes('WhatsApp no ha aceptado el archivo') && fallos[0].cuerpo.text.body.includes('drive.google.com/file/d/'), JSON.stringify(fallos));
    afirmar('un id de Meta con caracteres raros no se usa', (await correr(prep, { input: [{ id: 'x y/../z' }], nodos: nodosDecidir })).every((m) => m.cuerpo.type === 'text') && (await correr(prep, { input: [{ id: 5 }], nodos: nodosDecidir })).every((m) => m.cuerpo.type === 'text'));
  }

  console.log('Configuración');
  {
    await lanza('rechaza el marcador de la URL de Supabase', correr(nodo('configuracion.js')), 'SUPABASE_URL');
    const base = nodo('configuracion.js').replace('https://TU-PROYECTO.supabase.co', 'https://abc.supabase.co/');
    await lanza('rechaza el marcador del Phone number ID', correr(base), 'PHONE_NUMBER_ID');
    const conPhone = base.replace('TU-PHONE-NUMBER-ID', '123456789012345');
    await lanza('rechaza el marcador del ID de la carpeta Entrada', correr(conPhone), 'ENTRADA_FOLDER_ID');
    const valida = conPhone.replace('TU-ID-DE-ENTRADA', '1AbCdEfGhIjKlMnOpQrStUvWxYz_-12');
    const [c] = await correr(valida);
    afirmar('acepta valores válidos y quita la barra final', c.config.supabase_url === 'https://abc.supabase.co' && c.config.phone_number_id === '123456789012345' && c.config.graph_version === 'v26.0');
    afirmar('la configuración incluye el modelo de transcripción y el límite de audio (10 MB)', c.config.modelo_transcripcion === 'gemini-3.8-flash' && c.config.limite_audio_mb === 10);
    await lanza('rechaza un límite de audio absurdo', correr(valida.replace('LIMITE_AUDIO_MB = 10', 'LIMITE_AUDIO_MB = 50')), 'LIMITE_AUDIO_MB');
    await lanza('rechaza un nombre de modelo raro', correr(valida.replace("MODELO_TRANSCRIPCION = 'gemini-3.8-flash'", "MODELO_TRANSCRIPCION = 'a b/c'")), 'MODELO_TRANSCRIPCION');
    afirmar('la configuración incluye la carpeta Entrada y el límite de adjuntos (25 MB)', c.config.entrada_id === '1AbCdEfGhIjKlMnOpQrStUvWxYz_-12' && c.config.limite_adjunto_mb === 25);
    await lanza('rechaza un Phone number ID que no son dígitos', correr(base.replace('TU-PHONE-NUMBER-ID', '12ab')), 'PHONE_NUMBER_ID');
    await lanza('rechaza una versión de la API mal escrita', correr(valida.replace("'v26.0'", "'26'")), 'GRAPH_VERSION');
    await lanza('rechaza un ID de carpeta con caracteres raros', correr(conPhone.replace('TU-ID-DE-ENTRADA', 'abc def ghi/jkl')), 'ENTRADA_FOLDER_ID');
    await lanza('rechaza un límite de adjuntos fuera de rango', correr(valida.replace('LIMITE_ADJUNTO_MB = 25', 'LIMITE_ADJUNTO_MB = 500')), 'LIMITE_ADJUNTO_MB');
    const ENV_IDS = { ...ENV, SUPABASE_URL: 'https://xyz.supabase.co', WHATSAPP_PHONE_NUMBER_ID: '987654321098', DRIVE_ENTRADA_ID: '1ZyXwVuTsRqPoNmLkJiH' };
    const [e] = await correr(nodo('configuracion.js'), { env: ENV_IDS });
    afirmar('con el .env relleno, el nodo sin editar funciona', e.config.supabase_url === 'https://xyz.supabase.co' && e.config.phone_number_id === '987654321098' && e.config.entrada_id === '1ZyXwVuTsRqPoNmLkJiH');
    const [m] = await correr(valida, { env: { ...ENV, WHATSAPP_PHONE_NUMBER_ID: '987654321098' } });
    afirmar('el .env manda sobre lo escrito en el nodo y lo que falta sale del nodo', m.config.phone_number_id === '987654321098' && m.config.supabase_url === 'https://abc.supabase.co');
    await lanza('un ID de Entrada inválido en el .env se rechaza igual', correr(nodo('configuracion.js'), { env: { ...ENV_IDS, DRIVE_ENTRADA_ID: 'abc def' } }), 'ENTRADA_FOLDER_ID');
  }

  console.log('Nodo "Comprobar envío"');
  {
    const codigo = nodo('comprobar-envio.js');
    // Los envíos de texto llegan por la salida «done» del bucle a «Soltar turno», que los pasa tal cual: un item por mensaje con su resultado
    const comprobar = (nodos, input = [{ envio_error: null, id_error: null }]) => correr(codigo, { nodos: { 'Soltar turno': input, ...nodos }, input: [{}] });
    const bien = { 'Procesar mensaje': [{ ok: true, error: null, mensajes: ['Hecho.'] }] };
    afirmar('todo bien: no devuelve nada y no falla', (await comprobar(bien)).length === 0);
    afirmar('rama de archivos (no pasó por Procesar mensaje): no falla por eso', (await comprobar({})).length === 0);
    await lanza('si no se pudo anotar lo contestado, lo avisa', comprobar({ 'Marcar contestados': [{ error: { message: '404 función no existe' } }] }), 'no se pudo anotar como contestado');
    afirmar('Marcar contestados sin error no avisa', (await comprobar({ 'Marcar contestados': [{}] })).length === 0);
    await lanza('un envío rechazado por Meta hace fallar la ejecución con el error', comprobar(bien, [{ envio_error: 'The access token has expired', id_error: null }]), '1 de 1 mensajes no se enviaron (The access token has expired');
    await lanza('si solo falla uno de varios lo cuenta', comprobar(bien, [{ envio_error: null }, { envio_error: 'x' }, { envio_error: null }]), '1 de 3 mensajes no se enviaron');
    await lanza('el flujo principal con ok = false hace fallar la ejecución', comprobar({ 'Procesar mensaje': [{ ok: false, error: 'Error del modelo: HTTP 401' }] }), 'el flujo principal no pudo procesar el mensaje (Error del modelo: HTTP 401)');
    await lanza('el flujo principal con un fallo de ejecución (item con error) también', comprobar({ 'Procesar mensaje': [{ error: { message: 'Workflow could not be started' } }] }), 'Workflow could not be started');
    await lanza('si fallan las dos cosas, las cuenta las dos', comprobar({ 'Procesar mensaje': [{ ok: false, error: 'e2' }] }, [{ envio_error: 'e1' }]), 'no se enviaron (e1); el flujo principal');
    await lanza('el mensaje de error lleva el nombre del flujo (lo usa el aviso)', comprobar(bien, [{ envio_error: 'x' }]), 'Secretaria · WhatsApp:');
    afirmar('«no te he entendido» (ok = false, error anotado, fallo_flujo = false) no hace saltar el aviso de fallos', (await comprobar({ 'Procesar mensaje': [{ ok: false, error: 'Respuesta no válida: x', fallo_flujo: false }] })).length === 0);
    afirmar('«no he encontrado nada que cambiar» tampoco', (await comprobar({ 'Procesar mensaje': [{ ok: false, error: 'La actualización no afectó a ningún item', fallo_flujo: false }] })).length === 0);
    await lanza('un fallo de verdad (fallo_flujo = true) sí', comprobar({ 'Procesar mensaje': [{ ok: false, error: 'Error del modelo: HTTP 503', fallo_flujo: true }] }), 'Error del modelo: HTTP 503');
    await lanza('si «Anotar fallo» no pudo guardar el error o la pregunta (anotado = false), avisa', comprobar({ 'Procesar mensaje': [{ ok: true, fallo_flujo: false, anotado: false }] }), 'Anotar fallo');
    afirmar('anotado = null (nada que anotar) o true: sin aviso', (await comprobar({ 'Procesar mensaje': [{ ok: true, anotado: null }, { ok: true, anotado: true }] })).length === 0);
    const largo = await comprobar({ 'Procesar mensaje': [{ ok: true }] });
    afirmar('un ok = true sin más no es un fallo', largo.length === 0);
    try {
      await comprobar(bien, [{ envio_error: `${'x '.repeat(400)}fin\ncon salto` }]);
      afirmar('el detalle del error se recorta y se aplana', false, 'no lanzó');
    } catch (e) {
      afirmar('el detalle del error se recorta y se aplana', e.message.length < 400 && !e.message.includes('\n'), String(e.message.length));
    }
  }

  console.log('Límite de mensajes de golpe');
  {
    const MAXM = comun.MAX_MENSAJES_DE_GOLPE;
    const MAXA = comun.MAX_ADJUNTOS_DE_GOLPE;
    const cuerpo = (mensajes) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { messages: mensajes.map((m, i) => ({ from: NUMERO, id: `wamid.r${i}`, ...m })) } }] }] });
    const texto = (i) => ({ type: 'text', text: { body: `mensaje ${i}` } });
    const imagen = (i) => ({ type: 'image', image: { id: `IMG${i}`, mime_type: 'image/jpeg' } });
    const audio = (i) => ({ type: 'audio', audio: { id: `AUD${i}`, mime_type: 'audio/ogg' } });
    const ext = (m) => comun.extraerMensajes(cuerpo(m), NUMERO);
    const lim = (m) => comun.resolverNotificacion({ cuerpoBytes: Buffer.from(JSON.stringify(cuerpo(m))), cabeceraFirma: 'sha256=' + require('crypto').createHmac('sha256', 'secreto').update(JSON.stringify(cuerpo(m))).digest('hex'), secreto: 'secreto', numeroPermitido: NUMERO });
    afirmar('los límites son 8 mensajes y 10 adjuntos', MAXM === 8 && MAXA === 10);
    const justos = lim(Array.from({ length: MAXM }, (_, i) => texto(i)));
    afirmar('exactamente el máximo de textos se procesa entero', justos.accion === 'procesar' && justos.mensajes.length === MAXM && justos.mensajes.every((m) => m.tipo_entrada === 'texto'));
    const pasados = lim(Array.from({ length: MAXM + 1 }, (_, i) => texto(i)));
    afirmar('uno más del máximo: no se procesa NINGUNO y sale un solo aviso', pasados.accion === 'procesar' && pasados.mensajes.length === 1 && pasados.mensajes[0].tipo_entrada === 'no_soportado' && pasados.mensajes[0].tipo === 'exceso_mensajes' && pasados.mensajes[0].cantidad === MAXM + 1, JSON.stringify(pasados.mensajes));
    const mezcla = lim([...Array.from({ length: 5 }, (_, i) => texto(i)), ...Array.from({ length: 4 }, (_, i) => audio(i))]);
    afirmar('los audios cuentan junto con los textos', mezcla.mensajes.length === 1 && mezcla.mensajes[0].tipo === 'exceso_mensajes' && mezcla.mensajes[0].cantidad === 9);
    const diez = lim(Array.from({ length: MAXA }, (_, i) => imagen(i)));
    afirmar('hasta 10 imágenes se procesan todas', diez.mensajes.length === MAXA && diez.mensajes.every((m) => m.tipo_entrada === 'imagen'));
    const doce = lim(Array.from({ length: MAXA + 2 }, (_, i) => imagen(i)));
    afirmar('con 12 imágenes se guardan las 10 primeras y un aviso por las 2 que sobran', doce.mensajes.length === MAXA + 1 && doce.mensajes.slice(0, MAXA).every((m, i) => m.media_id === `IMG${i}`) && doce.mensajes.at(-1).tipo === 'exceso_adjuntos' && doce.mensajes.at(-1).cantidad === 2, JSON.stringify(doce.mensajes.at(-1)));
    const juntos = lim([...Array.from({ length: MAXM + 3 }, (_, i) => texto(i)), ...Array.from({ length: 3 }, (_, i) => imagen(i))]);
    afirmar('las imágenes no cuentan para el límite de los textos: se procesan, y los textos de más se avisan', juntos.mensajes.filter((m) => m.tipo_entrada === 'imagen').length === 3 && juntos.mensajes.filter((m) => m.tipo === 'exceso_mensajes').length === 1 && juntos.mensajes.filter((m) => m.tipo_entrada === 'texto').length === 0);
    afirmar('el aviso lleva el id del primer mensaje de más (para no repetirlo)', pasados.mensajes[0].wa_message_id === 'wamid.r0');
    // El aviso llega a Preparar envío y sale como texto, sin pasar por el modelo
    const env = await correr(nodo('preparar-envio.js', true), { input: [{ ...pasados.mensajes[0] }, { ...doce.mensajes.at(-1) }, { tipo_entrada: 'no_soportado', tipo: 'sticker' }] });
    afirmar('Preparar envío: textos de aviso para el exceso de mensajes y de adjuntos', env.length === 3 && env[0].texto === comun.MENSAJE_NO_SOPORTADO('exceso_mensajes', MAXM + 1) && env[0].texto.includes(`${MAXM + 1} mensajes de golpe`) && env[0].texto.includes(`máximo ${MAXM}`) && env[1].texto.includes(`primeros ${MAXA}`) && env[1].texto.includes('los otros 2'), JSON.stringify(env.map((e) => e.texto)));
    afirmar('… y el de un tipo no soportado no cambia', env[2].texto.includes('un sticker'));
    afirmar('el aviso de un solo adjunto de más va en singular', comun.MENSAJE_NO_SOPORTADO('exceso_adjuntos', 1).includes('el otro no'));

    // Cola: la ejecución que junta más de MAXM mensajes lo marca para que el flujo principal los avise sin procesar
    const CONF2 = { config: { max_esperas_turno: 206 } };
    const juntar2 = (n) => correr(nodo('juntar-mensajes.js', true), { input: [{ accion: 'procesar', mensajes: Array.from({ length: n }, (_, i) => ({ id: `c${i}`, wa_message_id: `wamid.c${i}`, tipo_entrada: 'texto', texto: `t${i}`, contexto_wa_id: null })) }], nodos: { Configuración: [CONF2], 'En cola': [{ id: 'c0' }] } });
    const [ok8] = await juntar2(MAXM);
    afirmar('cola: con el máximo exacto de mensajes seguidos se procesan', ok8.accion === 'procesar' && ok8.demasiados === false && ok8.aviso_demasiados === '' && ok8.juntados === MAXM);
    const [mal9] = await juntar2(MAXM + 1);
    afirmar('cola: con uno más se marca «demasiados» y lleva el texto del aviso', mal9.demasiados === true && mal9.aviso_demasiados.includes(`${MAXM + 1} mensajes seguidos`) && mal9.juntados === MAXM + 1, JSON.stringify(mal9));
  }

  console.log('Cola de mensajes');
  {
    const CONF = { config: { max_esperas_turno: 206 } };
    const juntar = (respuestas, nodos = {}, runIndex) =>
      correr((runIndex === undefined ? '' : `const $runIndex = ${runIndex};\n`) + nodo('juntar-mensajes.js', true), { input: respuestas, nodos: { Configuración: [CONF], ...nodos } });
    const tres = { accion: 'procesar', mensajes: [
      { id: 'm1', wa_message_id: 'wamid.1', tipo_entrada: 'texto', texto: 'Mañana dentista', contexto_wa_id: 'wamid.foto' },
      { id: 'm2', wa_message_id: 'wamid.2', tipo_entrada: 'texto', texto: '  ', contexto_wa_id: null },
      { id: 'm3', wa_message_id: 'wamid.3', tipo_entrada: 'texto', texto: 'a las 11', contexto_wa_id: null },
    ] };
    const [j1] = await juntar([tres], { 'En cola': [{ id: 'm3' }] });
    afirmar('procesar: junta los textos en orden, uno por línea, sin los vacíos; el mensaje propio es el último', j1.accion === 'procesar' && j1.mensaje === 'Mañana dentista\na las 11' && j1.wa_message_id === 'wamid.3' && j1.mensaje_id === 'm3' && j1.juntados === 3 && j1.tipo_entrada === 'texto');
    afirmar('procesar: conserva la cita a una foto de un mensaje anterior', j1.contexto_id === 'wamid.foto');
    afirmar('procesar: la respuesta citará el PRIMER mensaje del grupo', j1.responde_a === 'wamid.1');
    afirmar('procesar: a la primera no ha esperado turno', j1.espero_turno === false);
    afirmar('procesar: lleva la hora de llegada del primero del grupo (para las preguntas sin contestar del flujo principal)', j1.recibido_at === null && (await juntar([{ accion: 'procesar', mensajes: [{ id: 'z1', wa_message_id: 'wamid.z', tipo_entrada: 'texto', texto: 'hola', created_at: '2026-10-20T10:00:00.000Z' }] }]))[0].recibido_at === '2026-10-20T10:00:00.000Z');
    afirmar('procesar: lleva todos los ids del grupo (para marcarlos como contestados) y ya no lleva ecos', j1.wa_ids.join() === 'wamid.1,wamid.2,wamid.3' && !('ecos' in j1));
    const [jAudio] = await juntar([{ accion: 'procesar', mensajes: [{ id: 'a1', wa_message_id: 'wamid.a', tipo_entrada: 'audio', texto: 'compra leche' }, { id: 'a2', wa_message_id: 'wamid.b', tipo_entrada: 'texto', texto: 'y pan' }] }], { 'En cola': [{ id: 'a2' }] });
    afirmar('procesar: un audio del grupo no genera eco', !('ecos' in jAudio));
    const [jEspero] = await juntar([tres], { 'Esperar turno': [{ mensaje_id: 'm3' }] }, 2);
    afirmar('procesar tras esperar el turno: lo marca (llegó mientras se contestaba otro)', jEspero.accion === 'procesar' && jEspero.espero_turno === true);
    const [j2] = await juntar([{ accion: 'procesar', mensajes: [{ id: 'a1', wa_message_id: 'wamid.a', tipo_entrada: 'audio', texto: 'hola' }] }]);
    afirmar('un audio solo: tipo audio y sin cita', j2.tipo_entrada === 'audio' && j2.contexto_id === '' && j2.mensaje === 'hola');
    afirmar('nada: no devuelve nada (lo procesa otra ejecución y esta no contesta)', (await juntar([{ accion: 'nada', motivo: 'hay_uno_posterior' }])).length === 0);
    const [e1] = await juntar([{ accion: 'esperar' }], { 'Esperar a más mensajes': [{ id: 'm9', wa_message_id: 'wamid.9' }] }, 0);
    afirmar('esperar (primera pasada): lleva el id de su fila en cola para volver a reclamar', e1.accion === 'esperar' && e1.mensaje_id === 'm9');
    const [e2] = await juntar([{ accion: 'esperar' }], { 'Esperar turno': [{ accion: 'esperar', mensaje_id: 'm9' }], 'Esperar a más mensajes': [{ id: 'otro' }] }, 4);
    afirmar('esperar (vueltas siguientes): conserva el id que venía de Esperar turno', e2.mensaje_id === 'm9');
    const [e3] = await juntar([{ accion: 'esperar' }], { 'En cola': [{ id: 'unico' }] }, 0);
    afirmar('esperar sin emparejamiento: con una sola fila en cola, esa', e3.mensaje_id === 'unico');
    await lanza('esperar sin poder saber cuál: error claro (nunca se reclama un mensaje equivocado)', juntar([{ accion: 'esperar' }], { 'En cola': [{ id: 'x' }, { id: 'y' }] }, 0), 'no se pudo saber');
    await lanza('esperar demasiadas vueltas: error', juntar([{ accion: 'esperar' }], { 'En cola': [{ id: 'x' }] }, 205), 'tiene el turno');
    await lanza('respuesta rara (sin la función en la base de datos): error claro', juntar([{ code: 'PGRST202' }]), 'está instalada la base de datos');
    const varios = await juntar([{ accion: 'nada', motivo: 'hay_uno_posterior' }, { accion: 'procesar', mensajes: [{ id: 'n1', wa_message_id: 'wamid.n1', texto: 'uno' }, { id: 'n2', wa_message_id: 'wamid.n2', texto: 'dos' }] }]);
    afirmar('dos mensajes en la misma notificación: uno no hace nada y el otro procesa los dos', varios.length === 1 && varios[0].mensaje === 'uno\ndos');

    // Pie de foto : el archivo entra en la cola citándose a sí mismo y su pie se procesa aparte, con su archivo
    const pie = (n, texto) => ({ id: `p${n}`, wa_message_id: `wamid.f${n}`, tipo_entrada: 'imagen', texto, contexto_wa_id: `wamid.f${n}` });
    const txt = (n, texto) => ({ id: `t${n}`, wa_message_id: `wamid.t${n}`, tipo_entrada: 'texto', texto, contexto_wa_id: null });
    const [soloPie] = await juntar([{ accion: 'procesar', mensajes: [pie(1, 'Fotos/Viajes')] }]);
    afirmar('pie de foto solo: se procesa su texto citando a su propio archivo', soloPie.mensaje === 'Fotos/Viajes' && soloPie.contexto_id === 'wamid.f1' && soloPie.wa_ids.join() === 'wamid.f1' && soloPie.tipo_entrada === 'texto' && soloPie.juntados === 1, JSON.stringify(soloPie));
    const tresPies = await juntar([{ accion: 'procesar', mensajes: [pie(1, 'Fotos/Viajes'), pie(2, 'Fotos/Playa'), pie(3, 'mi DNI')] }]);
    afirmar('tres fotos con pie reclamadas a la vez: tres procesos, cada uno con su archivo (no un texto mezclado citando solo el último)', tresPies.length === 3 && tresPies.map((x) => x.contexto_id).join() === 'wamid.f1,wamid.f2,wamid.f3' && tresPies.map((x) => x.mensaje).join('|') === 'Fotos/Viajes|Fotos/Playa|mi DNI', JSON.stringify(tresPies.map((x) => x.mensaje)));
    afirmar('… todos comparten el turno de la ejecución que reclamó (el último mensaje)', tresPies.every((x) => x.mensaje_id === 'p3' && x.accion === 'procesar'));
    const mezcla = await juntar([{ accion: 'procesar', mensajes: [txt(1, 'apunta pan'), txt(2, 'y leche'), pie(3, 'Fotos'), txt(4, 'gracias')] }]);
    afirmar('textos y pie mezclados: los textos seguidos se juntan, el pie va aparte y en orden', mezcla.length === 3 && mezcla[0].mensaje === 'apunta pan\ny leche' && mezcla[1].mensaje === 'Fotos' && mezcla[1].contexto_id === 'wamid.f3' && mezcla[2].mensaje === 'gracias' && mezcla[2].contexto_id === '', JSON.stringify(mezcla.map((x) => x.mensaje)));
    afirmar('… cada grupo contesta solo a sus mensajes', mezcla[0].wa_ids.join() === 'wamid.t1,wamid.t2' && mezcla[1].wa_ids.join() === 'wamid.f3' && mezcla[2].wa_ids.join() === 'wamid.t4');
    afirmar('un texto que responde a una foto ajena sigue juntándose como siempre (no es un pie)', (await juntar([{ accion: 'procesar', mensajes: [{ ...txt(1, 'guárdala en Fotos'), contexto_wa_id: 'wamid.f9' }, txt(2, 'y ya')] }])).length === 1);
    const sinPartir = await juntar([{ accion: 'procesar', mensajes: Array.from({ length: comun.MAX_MENSAJES_DE_GOLPE + 1 }, (_, n) => (n % 2 === 0 ? pie(n, `p${n}`) : txt(n, `t${n}`))) }]);
    afirmar('con demasiados mensajes no se separa nada: un solo aviso', sinPartir.length === 1 && sinPartir[0].demasiados === true);
    const cuerpoPie = await correr(nodo('juntar-mensajes.js', true), { input: [{ accion: 'procesar', mensajes: [{ ...pie(1, '   ') }] }], nodos: { Configuración: [CONF] } }).then(() => 'sin error', (e) => e.message);
    afirmar('un pie vacío no se procesa (error claro, nunca un mensaje en blanco)', String(cuerpoPie).includes('no tienen texto'), String(cuerpoPie));

    const cola = await correr(nodo('preparar-cola.js'), { input: [
      { mensaje: ' Dentista mañana ', wa_message_id: 'wamid.1', tipo_entrada: 'texto', contexto_id: 'wamid.foto' },
      { ok: true, mensaje: 'transcrito', wa_message_id: 'wamid.2', tipo_entrada: 'audio', contexto_id: '' },
      { mensaje: '', wa_message_id: 'wamid.3', tipo_entrada: 'texto' },
      { mensaje: 'x', wa_message_id: 'mal id con espacios', tipo_entrada: 'texto' },
    ] });
    afirmar('Preparar cola: una fila en cola por mensaje válido, con el texto, el tipo y la cita', cola.length === 2 && cola[0].en_cola === true && cola[0].texto_original === 'Dentista mañana' && cola[0].contexto_wa_id === 'wamid.foto' && cola[1].tipo_entrada === 'audio' && cola[1].contexto_wa_id === null);
    const enCola = await correr(nodo('en-cola.js'), { input: [{ id: 'u1', wa_message_id: 'wamid.1', tipo_entrada: 'audio', texto_original: 'x' }, { error: { message: 'duplicate key value violates unique constraint' } }] });
    afirmar('En cola: pasa solo lo que se guardó (un reenvío duplicado se descarta sin contestar), con su tipo y su texto', enCola.length === 1 && enCola[0].id === 'u1' && enCola[0].tipo_entrada === 'audio' && enCola[0].texto_original === 'x');

    const soltar = await correr(nodo('soltar-turno.js'), { input: [{ envio_error: null }, { envio_error: 'x' }], nodos: { 'Juntar mensajes': [{ accion: 'esperar', mensaje_id: 'm1' }, { accion: 'procesar', mensaje_id: 'm3' }] } });
    afirmar('Soltar turno: pasa los envíos tal cual con el turno del mensaje procesado', soltar.length === 2 && soltar.every((x) => x.soltar_turno === 'm3') && soltar[1].envio_error === 'x');
    const enviadosST = await correr(nodo('soltar-turno.js'), { input: [{ envio_error: null, wamid: 'wamid.R1', texto: 'Apuntado: Pan.' }, { envio_error: null, wamid: 'wamid.R2', texto: '¿Te aviso mañana?' }, { envio_error: 'x', wamid: null, texto: 'no llegó' }] });
    afirmar('Soltar turno: junta los ids enviados y los textos, en orden, sin lo que no llegó, para anotar la respuesta (base de datos 1.4)', enviadosST.every((x) => x.respuesta_wamids.join() === 'wamid.R1,wamid.R2' && x.respuesta_texto === 'Apuntado: Pan.\n\n¿Te aviso mañana?'), JSON.stringify(enviadosST[0]));
    afirmar('… el texto se recorta a 1.500 caracteres', (await correr(nodo('soltar-turno.js'), { input: [{ wamid: 'wamid.L', texto: 'x'.repeat(2000) }] }))[0].respuesta_texto.length === 1500);
    const sinTurno = await correr(nodo('soltar-turno.js'), { input: [{ envio_error: null }] });
    afirmar('Soltar turno: sin cola en esta ejecución (un archivo), turno vacío', sinTurno[0].soltar_turno === '');
    const conContesta = await correr(nodo('soltar-turno.js'), { input: [{ envio_error: null }], nodos: { 'Turno de respuesta': [{ texto: 'a', contesta: ['w1', 'w2'] }, { texto: 'b' }, { texto: 'c', contesta: ['w2', 'w3'] }] } });
    afirmar('Soltar turno: junta (sin repetir) los mensajes contestados para «Marcar contestados»', conContesta[0].contestados.join() === 'w1,w2,w3' && sinTurno[0].contestados.length === 0, JSON.stringify(conContesta));

    const base = nodo('configuracion.js').replace('TU-PROYECTO', 'abcdefgh').replace('TU-PHONE-NUMBER-ID', '123456789012').replace('TU-ID-DE-ENTRADA', '1AbCdEfGhIjKlMnOp');
    const [c] = await correr(base);
    afirmar('Configuración: ESPERA_ARCHIVOS_S = 4 (varios archivos seguidos, un solo aviso; sección 71) y el «quieto» un segundo menos', c.config.espera_archivos_s === 4 && c.config.quieto_archivos_s === 3);
    const [c0] = await correr(base.replace('const ESPERA_ARCHIVOS_S = 4;', 'const ESPERA_ARCHIVOS_S = 0;'));
    afirmar('Configuración: con ESPERA_ARCHIVOS_S = 0 el «quieto» nunca baja de 0', c0.config.espera_archivos_s === 0 && c0.config.quieto_archivos_s === 0);
    afirmar('Configuración: sin espera para agrupar, nueva petición de turno cada 2 s y vueltas suficientes para que caduque el turno', c.config.espera_agrupar_s === 0 && c.config.espera_turno_s === 2 && c.config.max_esperas_turno * c.config.espera_turno_s > c.config.turno_min * 60);
    await lanza('Configuración: rechaza una espera de agrupación negativa', correr(base.replace('const ESPERA_AGRUPAR_S = 0;', 'const ESPERA_AGRUPAR_S = -1;')), 'ESPERA_AGRUPAR_S');
    await lanza('Configuración: rechaza una espera de agrupación de más de 30 s', correr(base.replace('const ESPERA_AGRUPAR_S = 0;', 'const ESPERA_AGRUPAR_S = 31;')), 'ESPERA_AGRUPAR_S');
  }

  console.log('Estructura del flujo');
  {
    const flujo = construirFlujo();
    const texto = JSON.stringify(flujo);
    const por = (n) => flujo.nodes.find((x) => x.name === n);
    const trabajo = flujo.nodes.filter((x) => x.type !== 'n8n-nodes-base.stickyNote');
    afirmar('76 nodos de trabajo y 8 notas', trabajo.length === 76 && flujo.nodes.length === 84, `${trabajo.length}/${flujo.nodes.length}`);
    afirmar('nombres e ids únicos', new Set(flujo.nodes.map((x) => x.name)).size === flujo.nodes.length && new Set(flujo.nodes.map((x) => x.id)).size === flujo.nodes.length);
    afirmar('las conexiones solo nombran nodos existentes', Object.entries(flujo.connections).every(([o, c]) => por(o) && c.main.flat().every((d) => por(d.node))));
    afirmar('zona Europe/Madrid', flujo.settings.timezone === 'Europe/Madrid');

    const w = por('Webhook POST');
    const wg = por('Webhook GET');
    afirmar('dos Webhook en la misma ruta whatsapp: POST y GET', w.parameters.httpMethod === 'POST' && wg.parameters.httpMethod === 'GET' && w.parameters.path === 'whatsapp' && wg.parameters.path === 'whatsapp');
    afirmar('Webhook POST: cuerpo en bruto (necesario para la firma) y respuesta a cargo de otro nodo', w.parameters.options.rawBody === true && w.parameters.responseMode === 'responseNode' && wg.parameters.responseMode === 'responseNode');
    afirmar('los dos Webhook van a Configuración', ['Webhook POST', 'Webhook GET'].every((n) => flujo.connections[n].main.length === 1 && flujo.connections[n].main[0].length === 1 && flujo.connections[n].main[0][0].node === 'Configuración'));
    afirmar('Webhook: webhookId propio y distinto en cada uno', typeof w.webhookId === 'string' && typeof wg.webhookId === 'string' && w.webhookId !== wg.webhookId);
    const r = por('Responder');
    afirmar('Responder: código y cuerpo salen de la decisión de Verificar', r.type === 'n8n-nodes-base.respondToWebhook' && r.parameters.responseBody === '={{ $json.cuerpo }}' && r.parameters.options.responseCode === '={{ $json.codigo }}');
    afirmar('el orden es Webhook, Configuración, Verificar, Responder (Configuración antes: un error se ve al registrar el webhook)', ['Configuración', 'Verificar', 'Responder', 'Separar mensajes'].slice(0, 3).every((n, i, a) => i === a.length - 1 || flujo.connections[n].main[0][0].node === a[i + 1]));
    afirmar('Responder va antes de procesar nada', flujo.connections['Responder'].main[0][0].node === 'Separar mensajes');
    const si = por('¿Es texto?');
    afirmar('¿Es texto?: compara tipo_entrada con texto', si.type === 'n8n-nodes-base.if' && JSON.stringify(si.parameters).includes('$json.tipo_entrada') && JSON.stringify(si.parameters).includes('"texto"'));
    afirmar('texto va a la cola y lo demás a ¿Es archivo?', flujo.connections['¿Es texto?'].main[0][0].node === 'Preparar cola' && flujo.connections['¿Es texto?'].main[1][0].node === '¿Es archivo?');
    // Cola de mensajes: en este flujo, no en el principal
    const sigue = (o, n = 0) => flujo.connections[o].main[n].map((d) => d.node).join();
    afirmar('cola: Preparar cola -> Guardar en cola -> En cola -> Esperar a más mensajes -> Reclamar mensajes -> Juntar mensajes -> ¿Procesar?', sigue('Preparar cola') === 'Guardar en cola' && sigue('Guardar en cola') === 'En cola' && sigue('En cola') === 'Esperar a más mensajes' && sigue('Esperar a más mensajes') === 'Reclamar mensajes' && sigue('Reclamar mensajes') === 'Juntar mensajes' && sigue('Juntar mensajes') === '¿Procesar?');
    afirmar('cola: procesar va a Procesar mensaje (única entrada); esperar vuelve a reclamar tras Esperar turno; lo demás termina', sigue('¿Procesar?') === 'Procesar mensaje' && sigue('¿Procesar?', 1) === '¿Esperar turno?' && sigue('¿Esperar turno?') === 'Esperar turno' && sigue('¿Esperar turno?', 1) === '' && sigue('Esperar turno') === 'Reclamar mensajes' && Object.entries(flujo.connections).filter(([, c]) => c.main.flat().some((d) => d.node === 'Procesar mensaje')).map(([o]) => o).join() === '¿Procesar?');
    afirmar('cola: las dos esperas son nodos Wait en segundos, con la configuración', ['Esperar a más mensajes', 'Esperar turno'].every((n) => por(n).type === 'n8n-nodes-base.wait' && por(n).parameters.unit === 'seconds' && /espera_(agrupar|turno)_s/.test(por(n).parameters.amount) && por(n).webhookId));
    afirmar('cola: Guardar en cola inserta la fila preparada y no corta el flujo (un reenvío choca y se descarta en En cola)', por('Guardar en cola').parameters.url.endsWith('/rest/v1/mensajes') && por('Guardar en cola').parameters.jsonBody === '={{ JSON.stringify($json) }}' && por('Guardar en cola').onError === 'continueRegularOutput');
    afirmar('cola: Reclamar mensajes usa el id en cola o el de la vuelta y el turno de la configuración; si falla, la ejecución falla', por('Reclamar mensajes').parameters.url.endsWith('/rest/v1/rpc/reclamar_mensajes') && por('Reclamar mensajes').parameters.jsonBody.includes('$json.mensaje_id || $json.id') && por('Reclamar mensajes').parameters.jsonBody.includes('turno_min') && por('Reclamar mensajes').parameters.jsonBody.includes("p_mismos: $('Quitar duplicados').all()") && por('Reclamar mensajes').onError === undefined);
    afirmar('turno: se suelta DESPUÉS de mandar las respuestas y los archivos (done -> Soltar turno -> ¿Mandar archivos? -> Marcar contestados -> Guardar respuesta -> ¿Soltar turno? -> Liberar turno -> Comprobar envío)', sigue('Recorrer mensajes') === 'Soltar turno' && sigue('Soltar turno') === '¿Mandar archivos?' && sigue('¿Mandar archivos?', 1) === 'Marcar contestados' && sigue('Marcar contestados') === 'Guardar respuesta' && sigue('Guardar respuesta') === '¿Soltar turno?' && por('¿Soltar turno?').parameters.conditions.conditions[0].leftValue.includes("$('Soltar turno').first().json.soltar_turno") && sigue('¿Soltar turno?') === 'Liberar turno' && sigue('¿Soltar turno?', 1) === 'Comprobar envío' && sigue('Liberar turno') === 'Comprobar envío');
    afirmar('turno: Liberar turno una vez, sin cortar el flujo, con el id de Soltar turno', por('Liberar turno').parameters.url.endsWith('/rest/v1/rpc/liberar_turno') && por('Liberar turno').executeOnce === true && por('Liberar turno').onError === 'continueRegularOutput' && por('Liberar turno').parameters.jsonBody.includes("$('Soltar turno').first().json.soltar_turno"));
    afirmar('cola: los nodos de Supabase nuevos llevan la credencial predefinida', ['Guardar en cola', 'Reclamar mensajes', 'Liberar turno'].every((n) => por(n).parameters.nodeCredentialType === 'supabaseApi'));
    afirmar('Procesar mensaje y los tipos no soportados convergen en Preparar envío, y luego el bucle de envío', flujo.connections['Procesar mensaje'].main[0][0].node === 'Preparar envío' && flujo.connections['Preparar envío'].main[0][0].node === '¿Me toca contestar?' && flujo.connections['¿Esperar para contestar?'].main[1][0].node === 'Recorrer mensajes');
    const pm = por('Procesar mensaje');
    afirmar('Procesar mensaje: un mensaje por llamada, espera al resultado y no corta el envío si falla', pm.type === 'n8n-nodes-base.executeWorkflow' && pm.parameters.mode === 'each' && pm.parameters.options.waitForSubWorkflow === true && pm.onError === 'continueRegularOutput');
    afirmar('Procesar mensaje: apunta al id fijo del flujo principal', pm.parameters.workflowId.mode === 'id' && pm.parameters.workflowId.value === IDS['procesar-mensaje.json']);
    const dup = por('Comprobar duplicados');
    afirmar('Comprobar duplicados: una sola lectura, siempre con salida, tolera el fallo', dup.executeOnce === true && dup.alwaysOutputData === true && dup.onError === 'continueRegularOutput' && dup.parameters.nodeCredentialType === 'supabaseApi');
    const env = por('Enviar WhatsApp');
    afirmar('Enviar WhatsApp: POST a graph.facebook.com con la versión y el número de Configuración', env.parameters.method === 'POST' && env.parameters.url.includes('graph.facebook.com') && env.parameters.url.includes('graph_version') && env.parameters.url.includes('phone_number_id') && env.parameters.url.endsWith('/messages'));
    afirmar('Enviar WhatsApp: credencial Header Auth que se elige a mano, con reintento y sin cortar', env.parameters.authentication === 'genericCredentialType' && env.parameters.genericAuthType === 'httpHeaderAuth' && env.retryOnFail === true && env.onError === 'continueRegularOutput');
    const cuerpoDe = (json) => JSON.parse(new Function('$json', `return ${env.parameters.jsonBody.slice(3, -2)}`)(json));
    const conCita = cuerpoDe({ para: NUMERO, texto: 'Hecho.', responde_a: 'wamid.1' });
    const sinCita = cuerpoDe({ para: NUMERO, texto: 'Hecho.' });
    afirmar('Enviar WhatsApp: con responde_a manda context.message_id (respuesta citada); sin él, el cuerpo de siempre', conCita.context?.message_id === 'wamid.1' && conCita.text.body === 'Hecho.' && !('context' in sinCita) && sinCita.to === NUMERO, JSON.stringify([conCita, sinCita]));
    afirmar('Enviar WhatsApp: cuerpo de texto con el formato de la API de Meta', ['messaging_product', 'whatsapp', 'recipient_type', 'individual', "type: 'text'", 'preview_url', 'body'].every((k) => env.parameters.jsonBody.includes(k)));
    afirmar('los archivos pedidos se mandan DESPUÉS del texto y ANTES de soltar el turno: Soltar turno -> ¿Mandar archivos? (sí: Preparar archivos a enviar; no: Marcar contestados); Revisar envíos de archivos -> Marcar contestados', flujo.connections['Procesar mensaje'].main[0].map((d) => d.node).join() === 'Preparar envío' && flujo.connections['Soltar turno'].main[0][0].node === '¿Mandar archivos?' && flujo.connections['¿Mandar archivos?'].main[0][0].node === 'Preparar archivos a enviar' && flujo.connections['¿Mandar archivos?'].main[1][0].node === 'Marcar contestados' && flujo.connections['Revisar envíos de archivos'].main[0][0].node === 'Marcar contestados' && por('¿Mandar archivos?').parameters.conditions.conditions[0].leftValue.includes("$('Turno de respuesta').all()"));
    const bucle = por('Recorrer envíos');
    afirmar('Recorrer envíos: Loop Over Items de 1 en 1 (cada elemento se procesa entero antes del siguiente) que recibe la secuencia de Preparar archivos a enviar', bucle.type === 'n8n-nodes-base.splitInBatches' && bucle.parameters.batchSize === 1 && flujo.connections['Preparar archivos a enviar'].main[0][0].node === 'Recorrer envíos');
    afirmar('Recorrer envíos: done (índice 0) -> Revisar envíos de archivos; loop (índice 1) -> ¿Es cabecera?', flujo.connections['Recorrer envíos'].main[0][0].node === 'Revisar envíos de archivos' && flujo.connections['Recorrer envíos'].main[1][0].node === '¿Es cabecera?', JSON.stringify(flujo.connections['Recorrer envíos']));
    afirmar('¿Es cabecera?: sí al mensaje con el nombre de la carpeta, no a leer el archivo en Drive; los dos acaban en Enviar archivo', por('¿Es cabecera?').parameters.conditions.conditions[0].rightValue === 'cabecera' && flujo.connections['¿Es cabecera?'].main[0][0].node === 'Mensaje de cabecera' && flujo.connections['¿Es cabecera?'].main[1][0].node === 'Leer datos de Drive' && flujo.connections['Mensaje de cabecera'].main[0][0].node === 'Enviar archivo');
    afirmar('un archivo: lectura en Drive, decisión, IF; se manda (descarga, sube, prepara) o salta directo a Enviar archivo', flujo.connections['Leer datos de Drive'].main[0][0].node === 'Decidir envío de archivo' && flujo.connections['Decidir envío de archivo'].main[0][0].node === '¿Se manda el archivo?' && flujo.connections['¿Se manda el archivo?'].main[0][0].node === 'Descargar de Drive' && flujo.connections['¿Se manda el archivo?'].main[1][0].node === 'Enviar archivo' && flujo.connections['Descargar de Drive'].main[0][0].node === 'Subir a WhatsApp' && flujo.connections['Subir a WhatsApp'].main[0][0].node === 'Preparar mensaje de archivo' && flujo.connections['Preparar mensaje de archivo'].main[0][0].node === 'Enviar archivo');
    afirmar('Enviar archivo vuelve al bucle (y no cuelga de Comprobar envío)', flujo.connections['Enviar archivo'].main[0].length === 1 && flujo.connections['Enviar archivo'].main[0][0].node === 'Recorrer envíos');
    afirmar('ya no hay Merge ni reordenación (cada elemento se procesa solo): no existen Juntar envíos ni Ordenar envíos', !por('Juntar envíos') && !por('Ordenar envíos') && !flujo.nodes.some((x) => x.type === 'n8n-nodes-base.merge'));
    const dd = por('Leer datos de Drive');
    afirmar('Leer datos de Drive: metadatos (tipo y tamaño) con la credencial de Google Drive, sin cortar el flujo', dd.parameters.url.includes('drive/v3/files/{{ $json.drive_file_id }}') && dd.parameters.url.includes('fields=id,name,mimeType,size') && dd.parameters.nodeCredentialType === 'googleDriveOAuth2Api' && dd.onError === 'continueRegularOutput');
    const dl = por('Descargar de Drive');
    afirmar('Descargar de Drive: alt=media, binario "data" y credencial de Google Drive', dl.parameters.url.includes('alt=media') && dl.parameters.url.includes('{{ $json.id }}') && dl.parameters.nodeCredentialType === 'googleDriveOAuth2Api' && dl.parameters.options.response.response.responseFormat === 'file' && dl.parameters.options.response.response.outputPropertyName === 'data');
    const sw = por('Subir a WhatsApp');
    const camposSw = sw.parameters.bodyParameters.parameters;
    afirmar('Subir a WhatsApp: POST multipart a /media con messaging_product, type y el binario "data" como file', sw.parameters.method === 'POST' && sw.parameters.url.endsWith('/media') && sw.parameters.url.includes('phone_number_id') && sw.parameters.contentType === 'multipart-form-data' && camposSw.find((c) => c.name === 'messaging_product').value === 'whatsapp' && camposSw.find((c) => c.name === 'type').value.includes('.mime') && camposSw.find((c) => c.name === 'file').parameterType === 'formBinaryData' && camposSw.find((c) => c.name === 'file').inputDataFieldName === 'data' && sw.parameters.genericAuthType === 'httpHeaderAuth' && sw.onError === 'continueRegularOutput', JSON.stringify(sw.parameters));
    const ea = por('Enviar archivo');
    afirmar('Enviar archivo: POST a /messages con el cuerpo preparado, dos intentos y sin cortar el flujo', ea.parameters.method === 'POST' && ea.parameters.url.endsWith('/messages') && ea.parameters.jsonBody === '={{ JSON.stringify($json.cuerpo) }}' && ea.retryOnFail === true && ea.maxTries === 2 && ea.onError === 'continueRegularOutput');
    afirmar('Revisar envíos de archivos: es un Code que cierra el bucle y no lanza (lo avisa Comprobar envío, después de soltar el turno)', por('Revisar envíos de archivos').type === 'n8n-nodes-base.code' && !por('Revisar envíos de archivos').parameters.jsCode.includes('throw new Error'));
    const revisar = nodo('revisar-envios-archivos.js');
    const bienRev = await correr(revisar, { input: [{ messages: [{ id: 'wamid.1' }] }, { messages: [{ id: 'wamid.2' }] }] });
    afirmar('Revisar envíos de archivos: si todos se enviaron, un resumen sin fallos (siempre un item)', bienRev.length === 1 && bienRev[0].archivos_total === 2 && bienRev[0].archivos_fallidos === 0);
    const malRev = await correr(revisar, { input: [{ messages: [{ id: 'wamid.1' }] }, { error: { message: 'Request failed with status code 400' } }] });
    afirmar('Revisar envíos de archivos: si alguno falló, lo resume', malRev[0].archivos_fallidos === 1 && malRev[0].archivos_error.includes('status code 400'));
    let falloRevision = '';
    try { await correr(nodo('comprobar-envio.js'), { input: [{}], nodos: { 'Soltar turno': [{ envio_error: null }], 'Revisar envíos de archivos': malRev } }); } catch (e) { falloRevision = e.message; }
    afirmar('Comprobar envío: si algún archivo no se envió, lanza un error que dice cuántos y por qué (queda en rojo)', falloRevision.includes('1 de 2 mensajes de archivos no se enviaron') && falloRevision.includes('status code 400'), falloRevision);
    afirmar('Comprobar envío ya no revisa Enviar archivo (lo hace el bucle)', !por('Comprobar envío').parameters.jsCode.includes("filas('Enviar archivo')"));
    afirmar('las notas explican la rama de envío y sus credenciales', flujo.nodes.some((x) => x.type === 'n8n-nodes-base.stickyNote' && x.parameters.content.includes('Mandar archivos al usuario') && x.parameters.content.includes('Leer datos de Drive') && x.parameters.content.includes('Subir a WhatsApp')));
    const esAudio = por('¿Es audio?');
    afirmar('¿Es audio?: sí a la rama de audio, no al aviso de tipo no soportado', esAudio.parameters.conditions.conditions[0].rightValue === 'audio' && flujo.connections['¿Es audio?'].main[0][0].node === 'Leer datos del audio' && flujo.connections['¿Es audio?'].main[1][0].node === 'Preparar envío');
    const cadAudio = ['Leer datos del audio', 'Comprobar audio', '¿Audio aceptado?', 'Descargar audio', 'Preparar transcripción', 'Transcribir audio', 'Leer transcripción', '¿Transcrito?'];
    afirmar('la rama de audio encadena lectura, comprobación, descarga, preparación, transcripción y lectura', cadAudio.slice(0, -1).every((n, i) => flujo.connections[n].main[0][0].node === cadAudio[i + 1]));
    afirmar('lo rechazado y lo no transcrito van a Preparar envío', flujo.connections['¿Audio aceptado?'].main[1][0].node === 'Preparar envío' && flujo.connections['¿Transcrito?'].main[1][0].node === 'Preparar envío');
    afirmar('lo transcrito entra en la misma cola que el texto ', flujo.connections['¿Transcrito?'].main[0][0].node === 'Entrada del audio' && flujo.connections['Entrada del audio'].main[0][0].node === 'Preparar cola' && flujo.connections['¿Es texto?'].main[0][0].node === 'Preparar cola');
    afirmar('Leer datos del audio y Descargar audio usan la credencial de WhatsApp y descargan el binario "data"', ['Leer datos del audio', 'Descargar audio'].every((n) => por(n).parameters.genericAuthType === 'httpHeaderAuth') && por('Descargar audio').parameters.options.response.response.responseFormat === 'file' && por('Descargar audio').parameters.options.response.response.outputPropertyName === 'data' && por('Descargar audio').parameters.url === '={{ $json.media_url }}');
    const trans = por('Transcribir audio');
    afirmar('Transcribir audio: POST a generateContent con el modelo de Configuración, credencial de cabecera, dos intentos y sin cortar el flujo', trans.parameters.method === 'POST' && trans.parameters.url.startsWith('=https://generativelanguage.googleapis.com/v1beta/models/') && trans.parameters.url.includes('modelo_transcripcion') && trans.parameters.url.endsWith(':generateContent') && trans.parameters.genericAuthType === 'httpHeaderAuth' && trans.parameters.jsonBody === '={{ JSON.stringify($json.cuerpo) }}' && trans.retryOnFail === true && trans.maxTries === 2 && trans.onError === 'continueRegularOutput');
    afirmar('la llamada al modelo está aislada: ningún otro nodo del flujo llama a Gemini', flujo.nodes.filter((x) => JSON.stringify(x.parameters).includes('generativelanguage')).length === 1);
    afirmar('las notas mencionan la credencial de Gemini para Transcribir audio', flujo.nodes.some((x) => x.type === 'n8n-nodes-base.stickyNote' && x.parameters.content.includes('Header Auth de Gemini') && x.parameters.content.includes('Transcribir audio')));
    const archivo = por('¿Es archivo?');
    afirmar('¿Es archivo?: imagen O documento; sí a la rama de archivos, no a la comprobación de audio', archivo.parameters.conditions.combinator === 'or' && archivo.parameters.conditions.conditions.map((c) => c.rightValue).join() === 'imagen,documento' && flujo.connections['¿Es archivo?'].main[0][0].node === 'Leer datos del adjunto' && flujo.connections['¿Es archivo?'].main[1][0].node === '¿Es audio?');
    const cadenaArchivo = ['Leer datos del adjunto', 'Comprobar adjunto', '¿Adjunto aceptado?', 'Descargar adjunto', 'Subir a Drive', 'Preparar registro', '¿Subido?', 'Guardar mensaje de archivo', 'Registrar archivo', '¿Pie para procesar?', 'Resultado archivo', 'Esperar a más archivos', 'Reclamar confirmación de archivos', 'Agrupar confirmaciones', 'Preparar envío'];
    // Entre «¿Pie para procesar?» y «Resultado archivo» la conexión es la salida «no» (índice 1); el resto, la primera salida
    afirmar(
      'la rama de archivos encadena todos sus pasos hasta Preparar envío (el aviso de guardado por la salida «sin pie»)',
      cadenaArchivo.slice(0, -1).every((n, i) => flujo.connections[n].main[n === '¿Pie para procesar?' ? 1 : 0][0].node === cadenaArchivo[i + 1]),
    );
    const sipie = flujo.nodes.find((n) => n.name === '¿Pie para procesar?');
    const ponerPie = flujo.nodes.find((n) => n.name === 'Poner pie en cola');
    afirmar('con pie, el archivo no pregunta qué es: la salida «sí» pone el pie en cola y sigue por «En cola»', flujo.connections['¿Pie para procesar?'].main[0][0].node === 'Poner pie en cola' && flujo.connections['Poner pie en cola'].main[0][0].node === 'En cola');
    afirmar('¿Pie para procesar?: solo si el archivo trae pie Y se registró (drive_file_id)', sipie.parameters.conditions.conditions[0].leftValue.includes('tiene_pie === true') && sipie.parameters.conditions.conditions[0].leftValue.includes('drive_file_id'));
    afirmar(
      'Poner pie en cola: PATCH de la fila del propio archivo, en cola, sin procesar y citándose a sí misma; con reintentos',
      ponerPie.parameters.method === 'PATCH' && ponerPie.parameters.url.includes('mensajes?wa_message_id=eq.') && ponerPie.parameters.jsonBody.includes('en_cola: true') && ponerPie.parameters.jsonBody.includes('procesado: false') && ponerPie.parameters.jsonBody.includes('contexto_wa_id') && ponerPie.retryOnFail === true,
    );
    const esperaA = por('Esperar a más archivos');
    afirmar('Esperar a más archivos: nodo Wait en segundos, con espera_archivos_s de la Configuración y su propio webhookId', esperaA.type === 'n8n-nodes-base.wait' && esperaA.parameters.unit === 'seconds' && esperaA.parameters.amount.includes('espera_archivos_s') && Boolean(esperaA.webhookId) && flujo.nodes.filter((x) => x.webhookId === esperaA.webhookId).length === 1);
    const reclamarA = por('Reclamar confirmación de archivos');
    afirmar('Reclamar confirmación de archivos: POST a la función de Supabase con el «quieto» de la Configuración, una sola vez por ejecución, siempre con salida y sin cortar el flujo (sin actualizar la base de datos a la 1.4 falla)', reclamarA.parameters.method === 'POST' && reclamarA.parameters.url.endsWith('/rest/v1/rpc/reclamar_confirmacion_archivos') && reclamarA.parameters.jsonBody.includes('quieto_archivos_s') && reclamarA.parameters.jsonBody.includes('p_ventana_min: 10') && reclamarA.executeOnce === true && reclamarA.alwaysOutputData === true && reclamarA.onError === 'continueRegularOutput' && reclamarA.parameters.nodeCredentialType === 'supabaseApi');
    afirmar('las notas piden la credencial de Supabase también en Reclamar confirmación de archivos', flujo.nodes.some((x) => x.type === 'n8n-nodes-base.stickyNote' && x.parameters.content.includes('Reclamar confirmación de archivos') && x.parameters.content.includes('Supabase API')));
    afirmar('lo rechazado o fallido sale directo a Preparar envío (sin quedarse sin respuesta)', flujo.connections['¿Adjunto aceptado?'].main[1][0].node === 'Preparar envío' && flujo.connections['¿Subido?'].main[1][0].node === 'Preparar envío');
    const leer = por('Leer datos del adjunto');
    afirmar('Leer datos del adjunto: GET a la API de Meta con el id del adjunto, token en la credencial y sin cortar si falla', leer.parameters.method === 'GET' && leer.parameters.url.includes('graph.facebook.com') && leer.parameters.url.includes('graph_version') && leer.parameters.url.includes('$json.media_id') && leer.parameters.genericAuthType === 'httpHeaderAuth' && leer.onError === 'continueRegularOutput');
    const desc = por('Descargar adjunto');
    afirmar('Descargar adjunto: usa la URL ya validada, con el token, como archivo en "data"', desc.parameters.url === '={{ $json.media_url }}' && desc.parameters.genericAuthType === 'httpHeaderAuth' && desc.parameters.options.response.response.responseFormat === 'file' && desc.parameters.options.response.response.outputPropertyName === 'data' && desc.onError === 'continueRegularOutput');
    const drive = por('Subir a Drive');
    afirmar('Subir a Drive: nodo nativo, sube el binario "data" a la carpeta Entrada de Configuración con el nombre calculado', drive.type === 'n8n-nodes-base.googleDrive' && drive.typeVersion === 3 && drive.parameters.resource === 'file' && drive.parameters.operation === 'upload' && drive.parameters.inputDataFieldName === 'data' && drive.parameters.folderId.mode === 'id' && drive.parameters.folderId.value.includes('entrada_id') && drive.parameters.name.includes('Comprobar adjunto') && drive.parameters.name.includes('.nombre') && drive.onError === 'continueRegularOutput');
    const gm = por('Guardar mensaje de archivo');
    const ra = por('Registrar archivo');
    afirmar('Supabase: dos POST (mensajes y archivos) con la credencial de Supabase y devolviendo la fila', [gm, ra].every((x) => x.parameters.method === 'POST' && x.parameters.nodeCredentialType === 'supabaseApi' && x.parameters.headerParameters.parameters[0].value === 'return=representation' && x.onError === 'continueRegularOutput') && gm.parameters.url.endsWith('/rest/v1/mensajes') && ra.parameters.url.endsWith('/rest/v1/archivos'));
    afirmar('Registrar archivo: enlaza el archivo con el mensaje recién creado', ra.parameters.jsonBody.includes('mensaje_id: $json.id') && ra.parameters.jsonBody.includes('.archivo'));
    afirmar('el token de WhatsApp solo se envía a graph.facebook.com o a la URL validada por Comprobar adjunto', [leer, desc, env].every((x) => x.parameters.genericAuthType === 'httpHeaderAuth') && por('Comprobar adjunto').parameters.jsCode.includes('planificarAdjunto') && por('Comprobar adjunto').parameters.jsCode.includes('function urlAdjuntoValida'));
    const anot = por('Anotar confirmación');
    const gid = por('Guardar id de la confirmación');
    const toca = por('¿Me toca contestar?');
    afirmar('¿Me toca contestar?: RPC turno_respuesta con los mensajes que se contestan y TURNO_MIN, una vez, sin cortar el flujo', toca.parameters.method === 'POST' && toca.parameters.url.endsWith('/rest/v1/rpc/turno_respuesta') && toca.parameters.jsonBody.includes("$('Preparar envío').all()") && toca.parameters.jsonBody.includes('contesta') && toca.parameters.jsonBody.includes('turno_min') && toca.parameters.jsonBody.includes("p_mismos: $('Quitar duplicados').all()") && toca.parameters.nodeCredentialType === 'supabaseApi' && toca.executeOnce === true && toca.alwaysOutputData === true && toca.onError === 'continueRegularOutput');
    afirmar('Preparar envío -> ¿Me toca contestar? -> Turno de respuesta -> ¿Esperar para contestar? (sí: Esperar para contestar -> vuelve a preguntar; no: Recorrer mensajes) -> Enviar WhatsApp -> Anotar confirmación -> ¿Guardar id?', sigue('Preparar envío') === '¿Me toca contestar?' && sigue('¿Me toca contestar?') === 'Turno de respuesta' && sigue('Turno de respuesta') === '¿Esperar para contestar?' && sigue('¿Esperar para contestar?') === 'Esperar para contestar' && sigue('¿Esperar para contestar?', 1) === 'Recorrer mensajes' && sigue('Esperar para contestar') === '¿Me toca contestar?' && por('Esperar para contestar').type === 'n8n-nodes-base.wait' && por('Esperar para contestar').parameters.amount.includes('espera_turno_s') && por('Recorrer mensajes').type === 'n8n-nodes-base.splitInBatches' && por('Recorrer mensajes').parameters.batchSize === 1 && flujo.connections['Recorrer mensajes'].main[1][0].node === 'Enviar WhatsApp' && flujo.connections['Enviar WhatsApp'].main[0][0].node === 'Anotar confirmación' && flujo.connections['Anotar confirmación'].main[0][0].node === '¿Guardar id?');
    const reg = por('Registrar llegadas');
    afirmar('Registrar llegadas: RPC con TODOS los mensajes (de Quitar duplicados: con Execute Once el nodo solo recibe el primero), una vez, sin cortar el flujo, en la rama de ARRIBA de Quitar duplicados', reg.parameters.url.endsWith('/rest/v1/rpc/registrar_llegadas') && !reg.parameters.jsonBody.includes('$input') && ["$('Quitar duplicados').all()", 'wa_message_id', 'ts', 'tipo_entrada'].every((k) => reg.parameters.jsonBody.includes(k)) && reg.executeOnce === true && reg.onError === 'continueRegularOutput' && sigue('Quitar duplicados') === 'Registrar llegadas,¿Es texto?' && reg.position[1] < por('¿Es texto?').position[1] && !flujo.connections['Registrar llegadas']);
    const gr = por('Guardar respuesta');
    afirmar('Guardar respuesta: PATCH a mensajes por los ids de WhatsApp contestados, con los ids enviados y el texto; una vez y sin cortar el flujo (sin actualizar la base de datos a la 1.4 falla en silencio)', gr.parameters.method === 'PATCH' && gr.parameters.url.includes('/rest/v1/mensajes?wa_message_id=in.(') && gr.parameters.url.includes("$('Soltar turno').first().json.contestados") && gr.parameters.jsonBody.includes('respuesta_wa_ids') && gr.parameters.jsonBody.includes('respuesta_texto') && gr.parameters.nodeCredentialType === 'supabaseApi' && gr.executeOnce === true && gr.alwaysOutputData === true && gr.onError === 'continueRegularOutput');
    {
      const ev = (expr, soltar) => new Function('$', `return ${expr}`)((n) => ({ first: () => ({ json: soltar }) }));
      const urlExpr = gr.parameters.url.slice(gr.parameters.url.indexOf('in.({{ ') + 7, gr.parameters.url.lastIndexOf(' }})'));
      afirmar('… la URL lista los ids entre comillas y codificados; sin mensajes que anotar o sin nada enviado (no se machaca lo ya anotado), una búsqueda que no encuentra nada', ev(urlExpr, { contestados: ['wamid.A=', 'wamid.B+'], respuesta_wamids: ['wamid.R1'] }) === '%22wamid.A%3D%22,%22wamid.B%2B%22' && ev(urlExpr, { contestados: [], respuesta_wamids: ['wamid.R1'] }) === '%22sin-mensajes%22' && ev(urlExpr, { contestados: ['wamid.A='], respuesta_wamids: [] }) === '%22sin-mensajes%22', ev(urlExpr, { contestados: ['wamid.A='], respuesta_wamids: ['wamid.R1'] }));
      const cuerpo = JSON.parse(new Function('$', `return ${gr.parameters.jsonBody.slice(3, -2)}`)((n) => ({ first: () => ({ json: { respuesta_wamids: ['wamid.R1'], respuesta_texto: 'Hola' } }) })));
      afirmar('… y el cuerpo lleva los ids y el texto', JSON.stringify(cuerpo) === '{"respuesta_wa_ids":["wamid.R1"],"respuesta_texto":"Hola"}', JSON.stringify(cuerpo));
    }
    const marcar = por('Marcar contestados');
    afirmar('Marcar contestados: RPC con los contestados de Soltar turno, una vez, sin cortar el flujo', marcar.parameters.url.endsWith('/rest/v1/rpc/marcar_contestados') && marcar.parameters.jsonBody.includes("$('Soltar turno').first().json.contestados") && marcar.executeOnce === true && marcar.alwaysOutputData === true && marcar.onError === 'continueRegularOutput');
    afirmar('¿Guardar id?: sí guarda el id y cierra; no cierra directamente; Cerrar envío vuelve al bucle', por('¿Guardar id?').type === 'n8n-nodes-base.if' && flujo.connections['¿Guardar id?'].main[0][0].node === 'Guardar id de la confirmación' && flujo.connections['¿Guardar id?'].main[1][0].node === 'Cerrar envío' && flujo.connections['Guardar id de la confirmación'].main[0][0].node === 'Cerrar envío' && flujo.connections['Cerrar envío'].main[0][0].node === 'Recorrer mensajes');
    const comp = por('Comprobar envío');
    afirmar('Comprobar envío va tras la salida «done» del bucle (cuando ya se han enviado todos y soltado el turno), no del envío', flujo.connections['Recorrer mensajes'].main[0].map((d) => d.node).join() === 'Soltar turno' && flujo.connections['Enviar WhatsApp'].main[0].every((d) => d.node !== 'Comprobar envío') && comp.type === 'n8n-nodes-base.code');
    afirmar('Comprobar envío no tiene salida (solo vigila)', flujo.connections['Comprobar envío'] === undefined);
    afirmar('Cada nodo del bucle de textos conserva un item por vuelta: Anotar confirmación y Cerrar envío son Code que devuelven un map', por('Anotar confirmación').parameters.jsCode.includes('$input.all().map') && por('Cerrar envío').parameters.jsCode.includes('$input.all().map'));
    afirmar('Guardar id de la confirmación: PATCH por expresión con la credencial de Supabase, sin devolver filas ni cortar el flujo', gid.parameters.method === 'PATCH' && gid.parameters.url === '={{ $json.url }}' && gid.parameters.nodeCredentialType === 'supabaseApi' && gid.parameters.headerParameters.parameters[0].value === 'return=minimal' && gid.onError === 'continueRegularOutput' && anot.type === 'n8n-nodes-base.code');
    afirmar('Verificar y Preparar envío llevan el código común', por('Verificar').parameters.jsCode.includes('function firmaValida') && por('Preparar envío').parameters.jsCode.includes('MENSAJE_NO_SOPORTADO') && !por('Verificar').parameters.jsCode.includes('__COMUN__'));
    afirmar('el código lee los secretos del entorno', ['WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_NUMERO_PERMITIDO'].every((k) => texto.includes(k)));
    afirmar('ningún valor secreto dentro del JSON: las credenciales solo se referencian por nombre', credencialesSoloPorNombre(flujo) && !/sb_secret_|EAA[A-Za-z0-9]{20,}|Bearer [A-Za-z0-9]/.test(texto));
    afirmar('Configuración conserva los marcadores que hay que editar', ['TU-PROYECTO', 'TU-PHONE-NUMBER-ID', 'TU-ID-DE-ENTRADA'].every((k) => por('Configuración').parameters.jsCode.includes(k)));
    const notas = flujo.nodes.filter((x) => x.type === 'n8n-nodes-base.stickyNote').map((x) => x.parameters.content).join('\n');
    afirmar('las notas explican qué hacer antes de ejecutar (variables, credencial, activar, URL de Meta)', ['Antes de ejecutar', 'WHATSAPP_APP_SECRET', 'NODE_FUNCTION_ALLOW_BUILTIN', 'Activa', '/webhook/whatsapp'].every((k) => notas.includes(k)));
    afirmar('el JSON sobrevive a un ida y vuelta', JSON.stringify(JSON.parse(texto)) === texto);
    const enDisco = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'flujos', 'whatsapp.json'), 'utf8'));
    afirmar('flujos/whatsapp.json está al día con las fuentes', JSON.stringify(enDisco) === texto, 'ejecuta: node herramientas/generar-whatsapp.js');
  }

  console.log(`\n${pasan} comprobaciones correctas, ${fallan.length} fallan.`);
  if (fallan.length > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
