// Genera flujos/whatsapp.json (el adaptador del canal WhatsApp: recibe el webhook de Meta, llama al flujo principal y
// envía las respuestas) a partir de:
//   - herramientas/flujo-whatsapp/*.js   código de los nodos Code (y comun.js, que se inserta donde aparece /*__COMUN__*/)
// Uso: node herramientas/generar-whatsapp.js
// Solo escribe el flujo de salida; no modifica ningún otro archivo.
//
// Los secretos no van en el JSON: las credenciales se eligen a mano al importar y los secretos de Meta se leen del
// entorno de n8n (.env).

const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
const ruta = (...p) => path.join(RAIZ, ...p);
const SALIDA = ruta('flujos', 'whatsapp.json');
const { prepararImportacion } = require('./comun/importacion');
const NOMBRE_FLUJO = 'Secretaria · WhatsApp';
const MARCADOR_COMUN = '/*__COMUN__*/';

const fallar = (msg) => {
  throw new Error(`generar-whatsapp: ${msg}`);
};
const leer = (p) => {
  if (!fs.existsSync(p)) fallar(`no existe ${path.relative(RAIZ, p)}`);
  return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
};

// split/join y no String.replace: el texto sustituido puede contener "$&" o "$1"
function sustituir(codigo, marcador, valor, nodo) {
  const trozos = codigo.split(marcador);
  if (trozos.length !== 2) fallar(`el marcador ${marcador} debe aparecer exactamente una vez en ${nodo} (aparece ${trozos.length - 1})`);
  return trozos.join(valor);
}

// Los nodos usan "return" y "await" al nivel superior y variables de n8n: se comprueba que compilan
function comprobarSintaxis(codigo, nodo) {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  try {
    new AsyncFunction('$input', '$', '$env', 'DateTime', 'require', codigo);
  } catch (e) {
    fallar(`el código de "${nodo}" no compila: ${e.message}`);
  }
}

const id = (n) => `5ec7e7a3-${String(n).padStart(4, '0')}-4000-8000-${String(n).padStart(12, '0')}`;
const CFG = "$('Configuración').first().json.config";
const PASO = 260;
const supabase = { authentication: 'predefinedCredentialType', nodeCredentialType: 'supabaseApi' };
// Cabecera Authorization con el token de acceso de WhatsApp (credencial Header Auth, a elegir a mano al importar)
const whatsappAuth = { authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth' };
// Lectura de Drive con la credencial Google Drive OAuth2 (la misma de "Subir a Drive" y de "Sincronizar Drive")
const driveAuth = { authentication: 'predefinedCredentialType', nodeCredentialType: 'googleDriveOAuth2Api' };

function nodoCode(n, nombre, posicion, archivo, { conComun = false } = {}) {
  let codigo = leer(ruta('herramientas', 'flujo-whatsapp', archivo));
  if (conComun) codigo = sustituir(codigo, MARCADOR_COMUN, leer(ruta('herramientas', 'flujo-whatsapp', 'comun.js')).trimEnd(), nombre);
  comprobarSintaxis(codigo, nombre);
  return { parameters: { jsCode: codigo }, id: id(n), name: nombre, type: 'n8n-nodes-base.code', typeVersion: 2, position: posicion };
}

function nodoHttp(n, nombre, posicion, parametros, extra = {}) {
  return { parameters: { options: {}, ...parametros }, id: id(n), name: nombre, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: posicion, ...extra };
}

// Nodo IF con condiciones de igualdad de texto (izq, der). 'and' por defecto; 'or' cuando basta con una.
function nodoSi(n, nombre, posicion, condiciones, combinador = 'and') {
  return {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: condiciones.map((c, i) => ({
          id: `a1b2c3d4-${String(n).padStart(4, '0')}-4000-8000-${String(i + 1).padStart(12, '0')}`,
          leftValue: c.izq,
          rightValue: c.der,
          operator: { type: 'string', operation: 'equals' },
        })),
        combinator: combinador,
      },
      options: {},
    },
    id: id(n),
    name: nombre,
    type: 'n8n-nodes-base.if',
    typeVersion: 2.2,
    position: posicion,
  };
}

function nota(n, x, y, ancho, alto, color, contenido) {
  return { parameters: { content: contenido, height: alto, width: ancho, color }, id: id(n), name: `Nota ${n - 100}`, type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [x, y] };
}

function construirFlujoBase() {
  // Distribución (las notas quedaban debajo de los nodos y algunas filas casi se tocaban). De arriba abajo, una banda
  // por rama, cada una con su nota ENCIMA y sin nodos dentro. Un nodo ocupa unos 100 px y su nombre, otros 40 por debajo: entre filas se dejan
  // al menos 200 px y, entre una fila y la nota siguiente, 40. «probar-distribucion.js» comprueba que ninguna nota tape un nodo.
  const Y = 0; // entrada, mensajes y proceso
  const NOTA = 160; // alto de las notas de las ramas
  const FILA_COLA = -840; // la cola de mensajes, arriba del todo; su segunda fila (esperar turno) va 180 más abajo
  // Fila donde va la nota de la cola, encima de ella
  const FILA_ECO = FILA_COLA - 200;
  const FILA_RESP = Y + 140; // respuestas de texto, a continuación de «Procesar mensaje»
  const FILA_TURNO = FILA_RESP + 200; // soltar el turno y comprobar el envío, debajo de las respuestas
  const FILA_ARCHIVO = FILA_TURNO + 200 + 40 + NOTA + 60; // la rama de archivos, con su nota encima
  const FILA_AUDIO = FILA_ARCHIVO + 160 + 40 + NOTA + 60; // la de audios
  const FILA_ENVIO = FILA_AUDIO + 160 + 40 + NOTA + 60 + 160; // la de envío de archivos al usuario (con «Mensaje de cabecera» una fila más arriba)

  const nodos = [
    // Dos disparadores en la misma ruta: POST para las notificaciones y GET para el saludo de Meta (n8n admite el mismo path
    // con métodos distintos). En el POST el cuerpo exacto queda como binario ("Raw Body"): la firma se calcula sobre esos bytes.
    // Responde otro nodo, no estos.
    {
      parameters: { httpMethod: 'POST', path: 'whatsapp', responseMode: 'responseNode', options: { rawBody: true } },
      id: id(1),
      name: 'Webhook POST',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2.2,
      webhookId: '5ec7e7a3-0000-4000-8000-0000000000aa',
      position: [0, Y],
    },
    {
      parameters: { httpMethod: 'GET', path: 'whatsapp', responseMode: 'responseNode', options: {} },
      id: id(12),
      name: 'Webhook GET',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2.2,
      webhookId: '5ec7e7a3-0000-4000-8000-0000000000ab',
      position: [0, Y + 200],
    },
    // Primero la configuración: si está mal, el saludo de Meta falla al registrar el webhook y se ve en el acto
    nodoCode(2, 'Configuración', [PASO, Y], 'configuracion.js'),
    nodoCode(3, 'Verificar', [PASO * 2, Y], 'verificar.js', { conComun: true }),
    // Una sola respuesta por petición; el código y el cuerpo salen de la decisión de "Verificar".
    // El flujo sigue después de responder: Meta recibe su 200 de inmediato y el procesamiento (varios segundos) continúa.
    {
      parameters: { respondWith: 'text', responseBody: '={{ $json.cuerpo }}', options: { responseCode: '={{ $json.codigo }}' } },
      id: id(4),
      name: 'Responder',
      type: 'n8n-nodes-base.respondToWebhook',
      typeVersion: 1.5,
      position: [PASO * 3, Y],
    },
    nodoCode(5, 'Separar mensajes', [PASO * 4, Y], 'separar.js'),
    // Una sola lectura de los wa_message_id ya guardados; si nada coincide devuelve [] y Always Output Data evita parar el flujo
    nodoHttp(
      6,
      'Comprobar duplicados',
      [PASO * 5, Y],
      { method: 'GET', url: `={{ ${CFG}.supabase_url }}{{ $('Separar mensajes').first().json.consulta_url }}`, ...supabase },
      { executeOnce: true, alwaysOutputData: true, onError: 'continueRegularOutput' },
    ),
    nodoCode(7, 'Quitar duplicados', [PASO * 6, Y], 'quitar-duplicados.js'),
    // Anota TODOS los mensajes que llegan (de cualquier tipo, ya sin duplicados) con su hora según Meta, antes de descargar o transcribir
    // nada: así todo se contesta en el orden en que llegó. Va en una rama aparte, ENCIMA de «¿Es texto?»
    // (n8n ejecuta primero la de arriba). Si falla, todo sigue sin ordenar lo que no es texto.
    nodoHttp(
      71,
      'Registrar llegadas',
      [PASO * 7, Y - 180],
      {
        method: 'POST',
        url: `={{ ${CFG}.supabase_url }}/rest/v1/rpc/registrar_llegadas`,
        ...supabase,
        sendBody: true,
        specifyBody: 'json',
        // Con Execute Once n8n solo pasa el primer item: los mensajes se leen de «Quitar duplicados» (todos)
        jsonBody: "={{ JSON.stringify({ p_llegadas: $('Quitar duplicados').all().map((i) => ({ wa_message_id: i.json.wa_message_id, ts: i.json.ts, tipo: i.json.tipo_entrada })) }) }}",
      },
      { executeOnce: true, onError: 'continueRegularOutput' },
    ),
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [{ id: 'a1b2c3d4-0001-4000-8000-000000000001', leftValue: '={{ $json.tipo_entrada }}', rightValue: 'texto', operator: { type: 'string', operation: 'equals' } }],
          combinator: 'and',
        },
        options: {},
      },
      id: id(8),
      name: '¿Es texto?',
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: [PASO * 7, Y],
    },
    // --- Cola de mensajes. Los mensajes de texto y los audios transcritos entran en la cola; se espera ESPERA_AGRUPAR_S por
    // si llegan más seguidos; "Reclamar mensajes" decide: si llegó otro después, esta ejecución no hace nada (la del último los junta);
    // si otra tiene el turno, se espera ESPERA_TURNO_S y se vuelve a reclamar; si no, se procesan todos juntos. El turno se suelta
    // DESPUÉS de mandar la respuesta ("Liberar turno"), así las respuestas nunca llegan desordenadas. Las esperas van en este flujo (el que
    // recibe el webhook) y no en el principal: un nodo Wait dentro de un subflujo no es fiable en n8n. ---
    nodoCode(56, 'Preparar cola', [PASO * 7, FILA_COLA], 'preparar-cola.js'),
    nodoHttp(
      57,
      'Guardar en cola',
      [PASO * 8, FILA_COLA],
      {
        method: 'POST',
        url: `={{ ${CFG}.supabase_url }}/rest/v1/mensajes`,
        ...supabase,
        sendHeaders: true,
        specifyHeaders: 'keypair',
        headerParameters: { parameters: [{ name: 'Prefer', value: 'return=representation' }] },
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify($json) }}',
      },
      { onError: 'continueRegularOutput' },
    ),
    nodoCode(58, 'En cola', [PASO * 9, FILA_COLA], 'en-cola.js'),
    {
      parameters: { amount: `={{ ${CFG}.espera_agrupar_s }}`, unit: 'seconds' },
      id: id(59),
      name: 'Esperar a más mensajes',
      type: 'n8n-nodes-base.wait',
      typeVersion: 1.1,
      webhookId: '5ec7e7a3-0059-4000-8000-0000000000aa',
      position: [PASO * 10, FILA_COLA],
    },
    // En la primera pasada el id es el de la fila en cola ($json.id); al volver de "Esperar turno", mensaje_id
    nodoHttp(60, 'Reclamar mensajes', [PASO * 11, FILA_COLA], {
      method: 'POST',
      url: `={{ ${CFG}.supabase_url }}/rest/v1/rpc/reclamar_mensajes`,
      ...supabase,
      sendBody: true,
      specifyBody: 'json',
      // p_mismos: los mensajes de esta misma notificación, que no se esperan entre sí (van uno detrás de otro en esta ejecución)
      jsonBody: `={{ JSON.stringify({ p_mensaje_id: $json.mensaje_id || $json.id, p_turno_min: ${CFG}.turno_min, p_mismos: $('Quitar duplicados').all().map((i) => i.json.wa_message_id) }) }}`,
    }),
    nodoCode(61, 'Juntar mensajes', [PASO * 12, FILA_COLA], 'juntar-mensajes.js', { conComun: true }),
    nodoSi(62, '¿Procesar?', [PASO * 13, FILA_COLA], [{ izq: '={{ $json.accion }}', der: 'procesar' }]),
    nodoSi(63, '¿Esperar turno?', [PASO * 14, FILA_COLA + 180], [{ izq: '={{ $json.accion }}', der: 'esperar' }]),
    {
      parameters: { amount: `={{ ${CFG}.espera_turno_s }}`, unit: 'seconds' },
      id: id(64),
      name: 'Esperar turno',
      type: 'n8n-nodes-base.wait',
      typeVersion: 1.1,
      webhookId: '5ec7e7a3-0064-4000-8000-0000000000aa',
      position: [PASO * 11, FILA_COLA + 180],
    },
    // Tras mandar todas las respuestas: se suelta el turno y después se comprueba el envío
    nodoCode(65, 'Soltar turno', [PASO * 11, FILA_TURNO], 'soltar-turno.js'),
    // ¿Pidió el usuario archivos («mándame las fotos de…»)? Se mandan ahora, antes de anotar lo contestado y soltar el turno
    nodoSi(
      75,
      '¿Mandar archivos?',
      [PASO * 12, FILA_TURNO],
      [{ izq: "={{ $('Turno de respuesta').all().some((i) => Array.isArray(i.json.envios_archivos) && i.json.envios_archivos.length > 0) ? 'si' : 'no' }}", der: 'si' }],
    ),
    // Anota como contestados los mensajes de esta respuesta: los que llegaron después ya pueden contestarse
    nodoHttp(
      74,
      'Marcar contestados',
      [PASO * 13, FILA_TURNO],
      {
        method: 'POST',
        url: `={{ ${CFG}.supabase_url }}/rest/v1/rpc/marcar_contestados`,
        ...supabase,
        sendBody: true,
        specifyBody: 'json',
        jsonBody: "={{ JSON.stringify({ p_ids: $('Soltar turno').first().json.contestados || [] }) }}",
      },
      // Si falla, lo que llegó después espera hasta que caduque (TURNO_MIN): se avisa en «Comprobar envío»
      { executeOnce: true, alwaysOutputData: true, onError: 'continueRegularOutput' },
    ),
    // Anota en los mensajes del usuario que se han contestado los ids de WhatsApp de la respuesta y su texto (base de datos 1.4): así,
    // cuando cita cualquiera de esos mensajes, el flujo principal sabe a qué se refiere. Si falla (sin actualizar la base de datos a la 1.4), no pasa nada: sin cita.
    nodoHttp(
      76,
      'Guardar respuesta',
      [PASO * 14, FILA_TURNO],
      {
        method: 'PATCH',
        // Si no se envió nada (todos fallaron), no se toca ninguna fila: la URL busca un id que no existe (así no se borra lo ya anotado)
        url: `={{ ${CFG}.supabase_url }}/rest/v1/mensajes?wa_message_id=in.({{ (($('Soltar turno').first().json.respuesta_wamids || []).length > 0 ? ($('Soltar turno').first().json.contestados || []) : []).map((w) => '%22' + encodeURIComponent(w) + '%22').join(',') || '%22sin-mensajes%22' }})`,
        ...supabase,
        sendHeaders: true,
        specifyHeaders: 'keypair',
        headerParameters: { parameters: [{ name: 'Prefer', value: 'return=minimal' }] },
        sendBody: true,
        specifyBody: 'json',
        jsonBody: "={{ JSON.stringify({ respuesta_wa_ids: $('Soltar turno').first().json.respuesta_wamids || [], respuesta_texto: $('Soltar turno').first().json.respuesta_texto || null }) }}",
      },
      { executeOnce: true, alwaysOutputData: true, onError: 'continueRegularOutput' },
    ),
    nodoSi(66, '¿Soltar turno?', [PASO * 15, FILA_TURNO], [{ izq: "={{ $('Soltar turno').first().json.soltar_turno ? 'si' : 'no' }}", der: 'si' }]),
    nodoHttp(
      67,
      'Liberar turno',
      [PASO * 16, FILA_TURNO],
      {
        method: 'POST',
        url: `={{ ${CFG}.supabase_url }}/rest/v1/rpc/liberar_turno`,
        ...supabase,
        sendBody: true,
        specifyBody: 'json',
        jsonBody: "={{ JSON.stringify({ p_mensaje_id: $('Soltar turno').first().json.soltar_turno }) }}",
      },
      // Un fallo aquí no importa: el turno caduca solo (TURNO_MIN)
      { executeOnce: true, alwaysOutputData: true, onError: 'continueRegularOutput' },
    ),

    // Llama al flujo principal una vez por mensaje. El flujo se elige a mano al importar. Un fallo no corta el envío:
    // "Preparar envío" contesta con un aviso honesto.
    {
      parameters: { source: 'database', workflowId: { __rl: true, mode: 'list', value: '' }, mode: 'each', options: { waitForSubWorkflow: true } },
      id: id(9),
      name: 'Procesar mensaje',
      type: 'n8n-nodes-base.executeWorkflow',
      typeVersion: 1.2,
      position: [PASO * 8, Y],
      onError: 'continueRegularOutput',
    },
    nodoCode(10, 'Preparar envío', [PASO * 9, FILA_RESP], 'preparar-envio.js', { conComun: true }),
    // ¿Le toca ya a esta respuesta?. Una foto, un documento o un aviso espera a que se conteste todo lo que llegó
    // antes; dice también si llegó algo después sin contestar (para citar). Si falla, se contesta sin esperar y sin cita.
    nodoHttp(
      69,
      '¿Me toca contestar?',
      [PASO * 10, FILA_RESP],
      {
        method: 'POST',
        url: `={{ ${CFG}.supabase_url }}/rest/v1/rpc/turno_respuesta`,
        ...supabase,
        sendBody: true,
        specifyBody: 'json',
        jsonBody: `={{ JSON.stringify({ p_ids: [...new Set($('Preparar envío').all().flatMap((i) => i.json.contesta || []))], p_turno_min: ${CFG}.turno_min, p_mismos: $('Quitar duplicados').all().map((i) => i.json.wa_message_id) }) }}`,
      },
      { executeOnce: true, alwaysOutputData: true, onError: 'continueRegularOutput' },
    ),
    // Espera (vuelta a «¿Me toca contestar?») o deja pasar los mensajes, con la cita solo si el usuario mandó varios
    nodoCode(70, 'Turno de respuesta', [PASO * 11, FILA_RESP], 'turno-respuesta.js'),
    nodoSi(72, '¿Esperar para contestar?', [PASO * 12, FILA_RESP], [{ izq: "={{ $json.esperar ? 'si' : 'no' }}", der: 'si' }]),
    {
      parameters: { amount: `={{ ${CFG}.espera_turno_s }}`, unit: 'seconds' },
      id: id(73),
      name: 'Esperar para contestar',
      type: 'n8n-nodes-base.wait',
      typeVersion: 1.1,
      webhookId: '5ec7e7a3-0073-4000-8000-0000000000aa',
      position: [PASO * 11, Y - 160],
    },
    // Los mensajes salen de uno en uno y EN ORDEN: n8n lanza todas las peticiones de un nodo HTTP a la vez y, sin este bucle, una respuesta
    // partida en varios mensajes (una lista larga, una confirmación y una pregunta) podía llegar desordenada. Loop Over Items con lotes de 1
    // espera a que termine cada vuelta (enviar, anotar el id de la confirmación, cerrar) antes de la siguiente. Cada nodo de la vuelta
    // devuelve SIEMPRE un item (si no, el bucle se corta). Sale por "loop" (índice 1) hacia "Enviar WhatsApp" y por "done" (índice 0) a
    // "Comprobar envío" cuando ya no quedan.
    { parameters: { batchSize: 1, options: {} }, id: id(53), name: 'Recorrer mensajes', type: 'n8n-nodes-base.splitInBatches', typeVersion: 3, position: [PASO * 13, FILA_RESP] },
    // Un POST por mensaje. Dos intentos ante un fallo de red o un 5xx.
    nodoHttp(
      11,
      'Enviar WhatsApp',
      [PASO * 14, FILA_RESP],
      {
        method: 'POST',
        url: `=https://graph.facebook.com/{{ ${CFG}.graph_version }}/{{ ${CFG}.phone_number_id }}/messages`,
        authentication: 'genericCredentialType',
        genericAuthType: 'httpHeaderAuth',
        sendBody: true,
        specifyBody: 'json',
        // Con "responde_a", la respuesta sale citando el mensaje del usuario (context.message_id, API de Meta)
        jsonBody: "={{ JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: $json.para, type: 'text', text: { preview_url: false, body: $json.texto }, ...($json.responde_a ? { context: { message_id: $json.responde_a } } : {}) }) }}",
      },
      { retryOnFail: true, maxTries: 2, waitBetweenTries: 3000, onError: 'continueRegularOutput' },
    ),

    // Si el mensaje enviado era la confirmación de un archivo, guarda su id en la fila del archivo: así el usuario puede
    // clasificarlo respondiendo a ese mensaje (el webhook traerá ese id en context.id). Para el resto de mensajes no hace nada.
    nodoCode(24, 'Anotar confirmación', [PASO * 15, FILA_RESP], 'anotar-confirmacion.js'),
    nodoSi(54, '¿Guardar id?', [PASO * 16, FILA_RESP], [{ izq: "={{ $json.guardar ? 'si' : 'no' }}", der: 'si' }]),
    nodoHttp(
      25,
      'Guardar id de la confirmación',
      [PASO * 17, FILA_RESP],
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
      { onError: 'continueRegularOutput' },
    ),

    nodoCode(53 + 2, 'Cerrar envío', [PASO * 18, FILA_RESP], 'cerrar-envio.js'),

    // Cuando ya se han enviado todos los mensajes (salida "done" del bucle), hace fallar la ejecución si un envío o el flujo principal
    // fallaron. Así el fallo se ve y activa el "Aviso de fallos".
    nodoCode(26, 'Comprobar envío', [PASO * 17, FILA_TURNO], 'comprobar-envio.js'),

    // --- Archivos (archivos): imágenes y documentos se guardan en Drive, en Entrada/, como pendientes ---
    nodoSi(13, '¿Es archivo?', [PASO * 8, FILA_ARCHIVO], [
      { izq: '={{ $json.tipo_entrada }}', der: 'imagen' },
      { izq: '={{ $json.tipo_entrada }}', der: 'documento' },
    ], 'or'),
    // GET /{media_id}: devuelve la URL de descarga (caduca a los 5 minutos), el tipo y el tamaño
    nodoHttp(
      14,
      'Leer datos del adjunto',
      [PASO * 9, FILA_ARCHIVO],
      { method: 'GET', url: `=https://graph.facebook.com/{{ ${CFG}.graph_version }}/{{ $json.media_id }}`, ...whatsappAuth },
      { onError: 'continueRegularOutput' },
    ),
    nodoCode(15, 'Comprobar adjunto', [PASO * 10, FILA_ARCHIVO], 'comprobar-adjunto.js', { conComun: true }),
    nodoSi(16, '¿Adjunto aceptado?', [PASO * 11, FILA_ARCHIVO], [{ izq: "={{ $json.ok ? 'si' : 'no' }}", der: 'si' }]),
    // Descarga el archivo con el token: la URL ya se comprobó (solo dominios de Meta) en "Comprobar adjunto"
    nodoHttp(
      17,
      'Descargar adjunto',
      [PASO * 12, FILA_ARCHIVO],
      { method: 'GET', url: '={{ $json.media_url }}', ...whatsappAuth, options: { response: { response: { responseFormat: 'file', outputPropertyName: 'data' } } } },
      { onError: 'continueRegularOutput' },
    ),
    // Nodo nativo de Google Drive (credencial Google Drive OAuth2 del flujo "Sincronizar Drive"): sube el binario "data" a Entrada/
    {
      parameters: {
        resource: 'file',
        operation: 'upload',
        inputDataFieldName: 'data',
        name: "={{ $('Comprobar adjunto').item.json.nombre }}",
        driveId: { __rl: true, mode: 'list', value: 'My Drive' },
        folderId: { __rl: true, mode: 'id', value: `={{ ${CFG}.entrada_id }}` },
        options: {},
      },
      id: id(18),
      name: 'Subir a Drive',
      type: 'n8n-nodes-base.googleDrive',
      typeVersion: 3,
      position: [PASO * 13, FILA_ARCHIVO],
      onError: 'continueRegularOutput',
    },
    nodoCode(19, 'Preparar registro', [PASO * 14, FILA_ARCHIVO], 'preparar-registro.js', { conComun: true }),
    nodoSi(20, '¿Subido?', [PASO * 15, FILA_ARCHIVO], [{ izq: "={{ $json.ok ? 'si' : 'no' }}", der: 'si' }]),
    // Dos inserciones: la fila del mensaje (también sirve para descartar los reenvíos de Meta) y la del archivo, pendiente
    nodoHttp(
      21,
      'Guardar mensaje de archivo',
      [PASO * 16, FILA_ARCHIVO],
      {
        method: 'POST',
        url: `={{ ${CFG}.supabase_url }}/rest/v1/mensajes`,
        ...supabase,
        sendHeaders: true,
        specifyHeaders: 'keypair',
        headerParameters: { parameters: [{ name: 'Prefer', value: 'return=representation' }] },
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify($json.mensaje) }}',
      },
      { onError: 'continueRegularOutput' },
    ),
    nodoHttp(
      22,
      'Registrar archivo',
      [PASO * 17, FILA_ARCHIVO],
      {
        method: 'POST',
        url: `={{ ${CFG}.supabase_url }}/rest/v1/archivos`,
        ...supabase,
        sendHeaders: true,
        specifyHeaders: 'keypair',
        headerParameters: { parameters: [{ name: 'Prefer', value: 'return=representation' }] },
        sendBody: true,
        specifyBody: 'json',
        jsonBody: "={{ JSON.stringify({ ...$('¿Subido?').item.json.archivo, mensaje_id: $json.id }) }}",
      },
      { onError: 'continueRegularOutput' },
    ),
    // Un archivo con pie de texto («Fotos/Viajes», «apuntes de redes tema 3») no pregunta qué es: su pie entra en la cola de texto citando al
    // propio archivo, como si el usuario hubiera respondido a la foto. Solo si el archivo se registró (sin registro no hay a qué citar).
    nodoSi(80, '¿Pie para procesar?', [PASO * 19, FILA_ARCHIVO - 170], [
      { izq: "={{ $('¿Subido?').item.json.tiene_pie === true && typeof $json.drive_file_id === 'string' ? 'si' : 'no' }}", der: 'si' },
    ]),
    // Reutiliza la fila que ya guardó «Guardar mensaje de archivo» (mismo wa_message_id): la pone en cola, sin procesar y citándose a sí misma.
    // Devuelve la fila, con la misma forma que «Guardar en cola», y sigue por «En cola».
    nodoHttp(
      81,
      'Poner pie en cola',
      [PASO * 20, FILA_ARCHIVO - 170],
      {
        method: 'PATCH',
        url: `={{ ${CFG}.supabase_url }}/rest/v1/mensajes?wa_message_id=eq.{{ encodeURIComponent($('¿Subido?').item.json.mensaje.wa_message_id) }}`,
        ...supabase,
        sendHeaders: true,
        specifyHeaders: 'keypair',
        headerParameters: { parameters: [{ name: 'Prefer', value: 'return=representation' }] },
        sendBody: true,
        specifyBody: 'json',
        jsonBody: "={{ JSON.stringify({ en_cola: true, procesado: false, contexto_wa_id: $('¿Subido?').item.json.mensaje.wa_message_id }) }}",
      },
      { retryOnFail: true, maxTries: 3, waitBetweenTries: 2000 },
    ),
    nodoCode(23, 'Resultado archivo', [PASO * 18, FILA_ARCHIVO], 'resultado-archivo.js', { conComun: true }),
    // Un solo mensaje de guardado al mandar varios archivos (base de datos 1.4): cada ejecución espera unos segundos, reclama en
    // Supabase todos los archivos aún sin confirmar (solo si no se guardó otro hace un instante) y la que se los lleva manda UN mensaje con
    // todos los nombres. Con ESPERA_ARCHIVOS_S = 0 nada cambia: un aviso por archivo.
    {
      parameters: { amount: `={{ ${CFG}.espera_archivos_s }}`, unit: 'seconds' },
      id: id(77),
      name: 'Esperar a más archivos',
      type: 'n8n-nodes-base.wait',
      typeVersion: 1.1,
      webhookId: '5ec7e7a3-0077-4000-8000-0000000000aa',
      position: [PASO * 19, FILA_ARCHIVO],
    },
    // Una sola llamada por ejecución (aunque lleguen varios archivos a la vez). Si falla (sin actualizar la base de datos a la 1.4), «Agrupar confirmaciones» avisa archivo a archivo.
    nodoHttp(
      78,
      'Reclamar confirmación de archivos',
      [PASO * 20, FILA_ARCHIVO],
      {
        method: 'POST',
        url: `={{ ${CFG}.supabase_url }}/rest/v1/rpc/reclamar_confirmacion_archivos`,
        ...supabase,
        sendBody: true,
        specifyBody: 'json',
        jsonBody: `={{ JSON.stringify({ p_quieto_s: ${CFG}.quieto_archivos_s, p_ventana_min: 10 }) }}`,
      },
      { executeOnce: true, alwaysOutputData: true, onError: 'continueRegularOutput' },
    ),
    nodoCode(79, 'Agrupar confirmaciones', [PASO * 21, FILA_ARCHIVO], 'agrupar-confirmaciones.js', { conComun: true }),

    // --- Audio (audio): se descarga, se transcribe con Gemini y el texto entra a "Procesar mensaje" como un mensaje más ---
    nodoSi(27, '¿Es audio?', [PASO * 8, FILA_AUDIO], [{ izq: '={{ $json.tipo_entrada }}', der: 'audio' }]),
    nodoHttp(
      28,
      'Leer datos del audio',
      [PASO * 9, FILA_AUDIO],
      { method: 'GET', url: `=https://graph.facebook.com/{{ ${CFG}.graph_version }}/{{ $json.media_id }}`, ...whatsappAuth },
      { onError: 'continueRegularOutput' },
    ),
    nodoCode(29, 'Comprobar audio', [PASO * 10, FILA_AUDIO], 'comprobar-audio.js', { conComun: true }),
    nodoSi(30, '¿Audio aceptado?', [PASO * 11, FILA_AUDIO], [{ izq: "={{ $json.ok ? 'si' : 'no' }}", der: 'si' }]),
    nodoHttp(
      31,
      'Descargar audio',
      [PASO * 12, FILA_AUDIO],
      { method: 'GET', url: '={{ $json.media_url }}', ...whatsappAuth, options: { response: { response: { responseFormat: 'file', outputPropertyName: 'data' } } } },
      { onError: 'continueRegularOutput' },
    ),
    nodoCode(32, 'Preparar transcripción', [PASO * 13, FILA_AUDIO], 'preparar-transcripcion.js', { conComun: true }),
    // Única llamada al modelo de este flujo, aislada en un nodo (regla del proyecto). Credencial Header Auth de GEMINI (la del nodo
    // "Modelo" del flujo principal, no la de WhatsApp). Un fallo no corta el flujo: "Leer transcripción" contesta con un aviso honesto.
    nodoHttp(
      33,
      'Transcribir audio',
      [PASO * 14, FILA_AUDIO],
      {
        method: 'POST',
        url: `=https://generativelanguage.googleapis.com/v1beta/models/{{ ${CFG}.modelo_transcripcion }}:generateContent`,
        authentication: 'genericCredentialType',
        genericAuthType: 'httpHeaderAuth',
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify($json.cuerpo) }}',
        options: { timeout: 120000 },
      },
      { retryOnFail: true, maxTries: 2, waitBetweenTries: 3000, onError: 'continueRegularOutput' },
    ),
    nodoCode(34, 'Leer transcripción', [PASO * 15, FILA_AUDIO], 'leer-transcripcion.js', { conComun: true }),
    nodoSi(35, '¿Transcrito?', [PASO * 16, FILA_AUDIO], [{ izq: "={{ $json.ok ? 'si' : 'no' }}", der: 'si' }]),
    nodoCode(52, 'Entrada del audio', [PASO * 17, FILA_AUDIO], 'entrada-audio.js'),

    // --- Enviar archivos al usuario ("dame todas las fotos"): el flujo principal decide cuáles (hasta 20, agrupados por carpeta) y los
    // devuelve en "envios_archivos". "Preparar archivos a enviar" arma la SECUENCIA (cabecera de carpeta, sus archivos, siguiente carpeta…)
    // y "Recorrer envíos" (Loop Over Items, lotes de 1) procesa un elemento cada vez, de principio a fin, antes de pasar al siguiente:
    // n8n lanza todas las peticiones de un nodo HTTP a la vez y, sin el bucle, los mensajes cortos llegaban antes que las fotos.
    // Cada iteración devuelve SIEMPRE un item (si no, el bucle se corta). Lo que Meta no admite o falla se manda como enlace de Drive.
    // Esta rama cuelga de "Procesar mensaje" por debajo de la que contesta, así el texto ("Te mando 5 archivos") llega antes. ---
    nodoCode(36, 'Preparar archivos a enviar', [PASO * 9, FILA_ENVIO], 'preparar-archivos-envio.js', { conComun: true }),
    // Sale por "loop" (índice 1) hacia "¿Es cabecera?"; "Enviar archivo" vuelve a este nodo; por "done" (índice 0) cuando ya no quedan.
    { parameters: { batchSize: 1, options: {} }, id: id(46), name: 'Recorrer envíos', type: 'n8n-nodes-base.splitInBatches', typeVersion: 3, position: [PASO * 10, FILA_ENVIO] },
    nodoSi(48, '¿Es cabecera?', [PASO * 11, FILA_ENVIO], [{ izq: '={{ $json.tipo }}', der: 'cabecera' }]),
    nodoCode(49, 'Mensaje de cabecera', [PASO * 12, FILA_ENVIO - 160], 'mensaje-cabecera.js', { conComun: true }),
    nodoHttp(
      37,
      'Leer datos de Drive',
      [PASO * 12, FILA_ENVIO],
      { method: 'GET', url: "=https://www.googleapis.com/drive/v3/files/{{ $json.drive_file_id }}?supportsAllDrives=true&fields=id,name,mimeType,size", ...driveAuth },
      { onError: 'continueRegularOutput' },
    ),
    nodoCode(38, 'Decidir envío de archivo', [PASO * 13, FILA_ENVIO], 'decidir-envio-archivo.js', { conComun: true }),
    nodoSi(39, '¿Se manda el archivo?', [PASO * 14, FILA_ENVIO], [{ izq: "={{ $json.mandar ? 'si' : 'no' }}", der: 'si' }]),
    nodoHttp(
      40,
      'Descargar de Drive',
      [PASO * 15, FILA_ENVIO],
      { method: 'GET', url: '=https://www.googleapis.com/drive/v3/files/{{ $json.id }}?alt=media&supportsAllDrives=true', ...driveAuth, options: { response: { response: { responseFormat: 'file', outputPropertyName: 'data' } } } },
      { onError: 'continueRegularOutput' },
    ),
    // POST /{PHONE_NUMBER_ID}/media: formulario multipart con messaging_product, type (el tipo del archivo) y file (el binario "data")
    nodoHttp(
      41,
      'Subir a WhatsApp',
      [PASO * 16, FILA_ENVIO],
      {
        method: 'POST',
        url: `=https://graph.facebook.com/{{ ${CFG}.graph_version }}/{{ ${CFG}.phone_number_id }}/media`,
        ...whatsappAuth,
        sendBody: true,
        contentType: 'multipart-form-data',
        bodyParameters: {
          parameters: [
            { name: 'messaging_product', value: 'whatsapp' },
            { name: 'type', value: "={{ $('Decidir envío de archivo').item.json.mime }}" },
            { parameterType: 'formBinaryData', name: 'file', inputDataFieldName: 'data' },
          ],
        },
      },
      { onError: 'continueRegularOutput' },
    ),
    nodoCode(42, 'Preparar mensaje de archivo', [PASO * 17, FILA_ENVIO], 'preparar-mensaje-archivo.js', { conComun: true }),
    // Un POST por elemento (cabecera, archivo o enlace). Un fallo no corta el bucle; "Revisar envíos de archivos" lo hace visible al final.
    nodoHttp(
      43,
      'Enviar archivo',
      [PASO * 18, FILA_ENVIO],
      {
        method: 'POST',
        url: `=https://graph.facebook.com/{{ ${CFG}.graph_version }}/{{ ${CFG}.phone_number_id }}/messages`,
        authentication: 'genericCredentialType',
        genericAuthType: 'httpHeaderAuth',
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify($json.cuerpo) }}',
      },
      { retryOnFail: true, maxTries: 2, waitBetweenTries: 3000, onError: 'continueRegularOutput' },
    ),
    nodoCode(47, 'Revisar envíos de archivos', [PASO * 11, FILA_ENVIO + 200], 'revisar-envios-archivos.js'),

    nota(101, -40, -420, PASO * 4, 200, 4, '## ① Entrada y seguridad\n**Webhook** recibe el saludo de Meta (GET) y las notificaciones (POST) con el cuerpo en bruto.\n**Configuración** va primero para que un error de configuración se vea al registrar el webhook.\n**Verificar** comprueba el verify token, la firma `X-Hub-Signature-256` (con el App Secret) y que el remitente sea el número permitido. Los secretos se leen del `.env`.\n**Responder** contesta 200 enseguida (o 403) y el flujo sigue.'),
    nota(102, PASO * 4 - 40, -420, PASO * 4, 200, 5, '## ② Mensajes y duplicados\n**Separar mensajes** deja un item por mensaje. **Comprobar duplicados** y **Quitar duplicados** descartan los reenvíos de Meta (el `wa_message_id` ya está en Supabase). **Registrar llegadas** anota cada mensaje con su hora: todo se contesta en ese orden.\n**¿Es texto?**: el texto va al flujo principal. Imágenes y documentos van a la rama de archivos (abajo); los audios van a la rama de audio (abajo); vídeos, stickers… reciben una respuesta honesta de que aún no se entienden.'),
    nota(105, PASO * 8 - 40, FILA_ARCHIVO - 60 - NOTA, PASO * 11, NOTA, 3, '## ④ Archivos (imágenes y documentos)\n**Leer datos del adjunto** pide a Meta la URL de descarga (caduca a los 5 minutos). **Comprobar adjunto** acepta solo URLs de Meta, tipos admitidos y el tamaño máximo (`LIMITE_ADJUNTO_MB`) y calcula el nombre. **Descargar adjunto** → **Subir a Drive** (carpeta Entrada). **Guardar mensaje de archivo** y **Registrar archivo** escriben en Supabase (el archivo queda `pendiente`). Si el archivo trae **pie de texto** y se registró, **¿Pie para procesar?** → **Poner pie en cola** lo mete en la cola de texto citando al propio archivo (no pregunta qué es; el flujo principal lo archiva o lo clasifica con ese pie). **Esperar a más archivos** → **Reclamar confirmación de archivos** → **Agrupar confirmaciones** juntan en UN mensaje los avisos de los archivos que llegan seguidos (`ESPERA_ARCHIVOS_S`). Todo lo que falla o se rechaza contesta con un mensaje honesto en **Preparar envío**.'),
    nota(106, PASO * 8 - 40, FILA_AUDIO - 60 - NOTA, PASO * 12, NOTA, 7, '## ⑤ Audio (notas de voz)\n**Leer datos del audio** y **Comprobar audio** (dominio de Meta, formato que entiende Gemini y `LIMITE_AUDIO_MB`) → **Descargar audio** → **Preparar transcripción** (binario a base64) → **Transcribir audio** (Gemini, credencial Header Auth **de Gemini**) → **Leer transcripción**. Si se entendió, **Entrada del audio** lo mete en la cola como un mensaje más (sin eco de lo entendido); si no, contesta con un aviso honesto. El audio no se guarda en Drive.'),
    nota(107, PASO * 9 - 40, FILA_ENVIO - 160 - 60 - NOTA, PASO * 10, NOTA, 3, '## ⑥ Mandar archivos al usuario\nDespués del texto y antes de soltar el turno (**¿Mandar archivos?**, tras **Soltar turno**): **Preparar archivos a enviar** toma de la respuesta los archivos pedidos (hasta 20, agrupados por carpeta) y arma la secuencia: nombre de carpeta, sus archivos, siguiente carpeta… **Recorrer envíos** (Loop Over Items, de 1 en 1) procesa cada elemento completo antes del siguiente: **¿Es cabecera?** → **Mensaje de cabecera** (el nombre en negrita) o bien **Leer datos de Drive** → **Decidir envío de archivo** (tipo y tamaño que admite Meta) → **Descargar de Drive** → **Subir a WhatsApp** → **Preparar mensaje de archivo**; todo termina en **Enviar archivo**, que vuelve al bucle. Lo que no se puede mandar va como enlace de Drive. Al acabar, **Revisar envíos de archivos** resume los envíos y sigue a **Marcar contestados** (si alguno falló, **Comprobar envío** pone la ejecución en rojo). Credencial **Google Drive OAuth2** en *Leer datos de Drive* y *Descargar de Drive*; **Header Auth de WhatsApp** en *Subir a WhatsApp* y *Enviar archivo*.'),
    nota(108, PASO * 7 - 40, FILA_ECO - 60 - 200, PASO * 8, 200, 4, '## Cola de mensajes\nTexto y audios transcritos: **Preparar cola** → **Guardar en cola** → **En cola** → **Esperar a más mensajes** (`ESPERA_AGRUPAR_S`) → **Reclamar mensajes**. **Juntar mensajes**: si llegó otro después, no hace nada (los junta la ejecución del último); si otra ejecución tiene el turno, **Esperar turno** (`ESPERA_TURNO_S`) y vuelta a reclamar; si no, **Procesar mensaje** con todos juntos (un archivo con pie de texto va aparte, con su archivo). También espera si llegó antes algo sin contestar (una foto, un audio que se transcribe). El turno se suelta en **Liberar turno**, después de mandar la respuesta: las respuestas no se desordenan.'),
    nota(103, PASO * 8 - 40, -420, PASO * 3, 200, 6, '## ③ Proceso y respuesta\n**Procesar mensaje** llama al flujo "Secretaria · Procesar mensaje". **Preparar envío** convierte su campo `mensajes` en un item por mensaje (o un aviso honesto si falló). **¿Me toca contestar?** → **Turno de respuesta**: espera (**Esperar para contestar**) a que se conteste lo que llegó antes y cita tu mensaje solo si mandaste varios. **Recorrer mensajes** (Loop Over Items, de 1 en 1) manda los mensajes uno tras otro y en orden: **Enviar WhatsApp** (un POST a la API de Meta), **Anotar confirmación**, **Cerrar envío**; al acabar, **Soltar turno** → **¿Mandar archivos?** (los pedidos, abajo) → **Marcar contestados** → **Guardar respuesta** (ids y texto de lo enviado) → **Liberar turno** → **Comprobar envío** (pone la ejecución en rojo, y avisa, solo si un envío falló o el flujo principal falló de verdad: `fallo_flujo`).'),
    nota(
      104,
      -40,
      380,
      PASO * 4,
      360,
      2,
      '## Antes de ejecutar\n1. Identificadores: `SUPABASE_URL`, `WHATSAPP_PHONE_NUMBER_ID` y `DRIVE_ENTRADA_ID` en el `.env` del servidor (no hace falta tocar **Configuración**).\n2. En **Procesar mensaje**, elige el flujo "Secretaria · Procesar mensaje".\n3. Credenciales (¡revisa cada nodo, n8n a veces asigna la equivocada!): **Supabase API** en *Comprobar duplicados*, *Registrar llegadas*, *Guardar en cola*, *Reclamar mensajes*, *¿Me toca contestar?*, *Marcar contestados*, *Guardar respuesta*, *Liberar turno*, *Guardar mensaje de archivo*, *Registrar archivo*, *Poner pie en cola*, *Reclamar confirmación de archivos* y *Guardar id de la confirmación*; **Header Auth de WhatsApp** (nombre `Authorization`, valor `Bearer <token de acceso>`) en *Enviar WhatsApp*, *Leer datos del adjunto*, *Descargar adjunto*, *Leer datos del audio* y *Descargar audio*; **Header Auth de Gemini** en *Transcribir audio* (la misma que usa *Modelo* en el flujo principal); **Google Drive OAuth2** en *Subir a Drive*.\n4. En el `.env`: `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_NUMERO_PERMITIDO`, `N8N_WEBHOOK_URL`. En `docker-compose.yml`: `NODE_FUNCTION_ALLOW_BUILTIN=crypto`.\n5. **Activa** el flujo (la URL de producción es `/webhook/whatsapp`; la de prueba no la usa Meta).\n6. En Meta: URL de devolución de llamada = tu URL pública + `/webhook/whatsapp`, y el mismo verify token. Suscribe el campo `messages`.',
    ),
  ];

  const a = (nombre, indice = 0) => ({ node: nombre, type: 'main', index: indice });
  const cadena = ['Configuración', 'Verificar', 'Responder', 'Separar mensajes', 'Comprobar duplicados', 'Quitar duplicados', '¿Es texto?'];
  const conexiones = {};
  for (let i = 0; i < cadena.length - 1; i++) conexiones[cadena[i]] = { main: [[a(cadena[i + 1])]] };
  // Primero (más arriba) se registran las llegadas; después, cada mensaje por su rama
  conexiones['Quitar duplicados'] = { main: [[a('Registrar llegadas'), a('¿Es texto?')]] };
  // IF: salida 0 (verdadero) al flujo principal; salida 1 (falso) a "¿Es archivo?" (imágenes y documentos se guardan; el resto
  // recibe la respuesta honesta de que aún no se entiende)
  conexiones['¿Es texto?'] = { main: [[a('Preparar cola')], [a('¿Es archivo?')]] };
  // Cola: guardar, esperar, reclamar; procesar o volver a esperar turno (lo que no es ninguna de las dos, termina sin contestar)
  conexiones['Preparar cola'] = { main: [[a('Guardar en cola')]] };
  conexiones['Guardar en cola'] = { main: [[a('En cola')]] };
  conexiones['En cola'] = { main: [[a('Esperar a más mensajes')]] };
  conexiones['Esperar a más mensajes'] = { main: [[a('Reclamar mensajes')]] };
  conexiones['Reclamar mensajes'] = { main: [[a('Juntar mensajes')]] };
  conexiones['Juntar mensajes'] = { main: [[a('¿Procesar?')]] };
  // Al procesar: se llama al flujo principal
  conexiones['¿Procesar?'] = { main: [[a('Procesar mensaje')], [a('¿Esperar turno?')]] };
  conexiones['¿Esperar turno?'] = { main: [[a('Esperar turno')], []] };
  conexiones['Esperar turno'] = { main: [[a('Reclamar mensajes')]] };
  // Rama de archivos. Todo lo que falla o se rechaza va directo a "Preparar envío" con su mensaje.
  conexiones['¿Es archivo?'] = { main: [[a('Leer datos del adjunto')], [a('¿Es audio?')]] };
  conexiones['Leer datos del adjunto'] = { main: [[a('Comprobar adjunto')]] };
  conexiones['Comprobar adjunto'] = { main: [[a('¿Adjunto aceptado?')]] };
  conexiones['¿Adjunto aceptado?'] = { main: [[a('Descargar adjunto')], [a('Preparar envío')]] };
  conexiones['Descargar adjunto'] = { main: [[a('Subir a Drive')]] };
  conexiones['Subir a Drive'] = { main: [[a('Preparar registro')]] };
  conexiones['Preparar registro'] = { main: [[a('¿Subido?')]] };
  conexiones['¿Subido?'] = { main: [[a('Guardar mensaje de archivo')], [a('Preparar envío')]] };
  conexiones['Guardar mensaje de archivo'] = { main: [[a('Registrar archivo')]] };
  conexiones['Registrar archivo'] = { main: [[a('¿Pie para procesar?')]] };
  // Con pie: entra en la cola de texto (cita al propio archivo). Sin pie: el aviso de guardado de siempre.
  conexiones['¿Pie para procesar?'] = { main: [[a('Poner pie en cola')], [a('Resultado archivo')]] };
  conexiones['Poner pie en cola'] = { main: [[a('En cola')]] };
  conexiones['Resultado archivo'] = { main: [[a('Esperar a más archivos')]] };
  conexiones['Esperar a más archivos'] = { main: [[a('Reclamar confirmación de archivos')]] };
  conexiones['Reclamar confirmación de archivos'] = { main: [[a('Agrupar confirmaciones')]] };
  conexiones['Agrupar confirmaciones'] = { main: [[a('Preparar envío')]] };
  // Rama de audio. Todo lo que falla o se rechaza va directo a "Preparar envío"; lo transcrito entra a "Procesar mensaje" (texto).
  conexiones['¿Es audio?'] = { main: [[a('Leer datos del audio')], [a('Preparar envío')]] };
  conexiones['Leer datos del audio'] = { main: [[a('Comprobar audio')]] };
  conexiones['Comprobar audio'] = { main: [[a('¿Audio aceptado?')]] };
  conexiones['¿Audio aceptado?'] = { main: [[a('Descargar audio')], [a('Preparar envío')]] };
  conexiones['Descargar audio'] = { main: [[a('Preparar transcripción')]] };
  conexiones['Preparar transcripción'] = { main: [[a('Transcribir audio')]] };
  conexiones['Transcribir audio'] = { main: [[a('Leer transcripción')]] };
  conexiones['Leer transcripción'] = { main: [[a('¿Transcrito?')]] };
  conexiones['¿Transcrito?'] = { main: [[a('Entrada del audio')], [a('Preparar envío')]] };
  conexiones['Entrada del audio'] = { main: [[a('Preparar cola')]] };
  conexiones['Webhook POST'] = { main: [[a('Configuración')]] };
  conexiones['Webhook GET'] = { main: [[a('Configuración')]] };
  // Procesar mensaje: la respuesta de texto (arriba) y, por debajo, los archivos que haya que mandar (casi siempre ninguno)
  // Procesar mensaje: la respuesta de texto. Los archivos que haya que mandar se mandan DESPUÉS del texto y ANTES de soltar el turno
  // («¿Mandar archivos?», tras «Soltar turno»): así la respuesta al mensaje siguiente no se cuela entre ellos
  conexiones['Procesar mensaje'] = { main: [[a('Preparar envío')]] };
  conexiones['Preparar archivos a enviar'] = { main: [[a('Recorrer envíos')]] };
  // Bucle de 1 en 1: loop (índice 1) -> cabecera o archivo -> Enviar archivo -> vuelve al bucle; done (índice 0) -> revisión de los envíos
  conexiones['Recorrer envíos'] = { main: [[a('Revisar envíos de archivos')], [a('¿Es cabecera?')]] };
  conexiones['Revisar envíos de archivos'] = { main: [[a('Marcar contestados')]] };
  conexiones['¿Es cabecera?'] = { main: [[a('Mensaje de cabecera')], [a('Leer datos de Drive')]] };
  conexiones['Mensaje de cabecera'] = { main: [[a('Enviar archivo')]] };
  conexiones['Leer datos de Drive'] = { main: [[a('Decidir envío de archivo')]] };
  conexiones['Decidir envío de archivo'] = { main: [[a('¿Se manda el archivo?')]] };
  // Lo que se manda sube a Meta; lo que va como enlace salta directo a Enviar archivo
  conexiones['¿Se manda el archivo?'] = { main: [[a('Descargar de Drive')], [a('Enviar archivo')]] };
  conexiones['Descargar de Drive'] = { main: [[a('Subir a WhatsApp')]] };
  conexiones['Subir a WhatsApp'] = { main: [[a('Preparar mensaje de archivo')]] };
  conexiones['Preparar mensaje de archivo'] = { main: [[a('Enviar archivo')]] };
  conexiones['Enviar archivo'] = { main: [[a('Recorrer envíos')]] };
  // Respuestas de texto, de una en una: bucle -> enviar -> anotar el id si era la confirmación de un archivo -> cerrar -> vuelta al bucle;
  // al acabar (done) se comprueba que todo fue bien
  // Antes de mandar: ¿le toca? Si no, espera y vuelve a preguntar; si sí, el bucle de envío
  conexiones['Preparar envío'] = { main: [[a('¿Me toca contestar?')]] };
  conexiones['¿Me toca contestar?'] = { main: [[a('Turno de respuesta')]] };
  conexiones['Turno de respuesta'] = { main: [[a('¿Esperar para contestar?')]] };
  conexiones['¿Esperar para contestar?'] = { main: [[a('Esperar para contestar')], [a('Recorrer mensajes')]] };
  conexiones['Esperar para contestar'] = { main: [[a('¿Me toca contestar?')]] };
  conexiones['Recorrer mensajes'] = { main: [[a('Soltar turno')], [a('Enviar WhatsApp')]] };
  conexiones['Soltar turno'] = { main: [[a('¿Mandar archivos?')]] };
  conexiones['¿Mandar archivos?'] = { main: [[a('Preparar archivos a enviar')], [a('Marcar contestados')]] };
  conexiones['Marcar contestados'] = { main: [[a('Guardar respuesta')]] };
  conexiones['Guardar respuesta'] = { main: [[a('¿Soltar turno?')]] };
  conexiones['¿Soltar turno?'] = { main: [[a('Liberar turno')], [a('Comprobar envío')]] };
  conexiones['Liberar turno'] = { main: [[a('Comprobar envío')]] };
  conexiones['Enviar WhatsApp'] = { main: [[a('Anotar confirmación')]] };
  conexiones['Anotar confirmación'] = { main: [[a('¿Guardar id?')]] };
  conexiones['¿Guardar id?'] = { main: [[a('Guardar id de la confirmación')], [a('Cerrar envío')]] };
  conexiones['Guardar id de la confirmación'] = { main: [[a('Cerrar envío')]] };
  conexiones['Cerrar envío'] = { main: [[a('Recorrer mensajes')]] };

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
