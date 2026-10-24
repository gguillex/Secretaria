// Genera flujos/sincronizar-drive.json (el flujo que mueve los archivos de Drive a la carpeta de su item) a partir de:
//   - herramientas/flujo-drive/*.js   código de los nodos Code (y comun.js, que se inserta donde aparece /*__COMUN__*/)
// Uso: node herramientas/generar-drive.js
// Solo escribe el flujo de salida; no modifica ningún otro archivo.
//
// Los secretos no van en el JSON: las credenciales se eligen a mano al importar.

const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
const ruta = (...p) => path.join(RAIZ, ...p);
const SALIDA = ruta('flujos', 'sincronizar-drive.json');
const { prepararImportacion } = require('./comun/importacion');
const NOMBRE_FLUJO = 'Secretaria · Sincronizar Drive';
const MARCADOR_COMUN = '/*__COMUN__*/';

const fallar = (msg) => {
  throw new Error(`generar-drive: ${msg}`);
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

// Los nodos usan "return" al nivel superior y variables de n8n: se comprueba que compilan
function comprobarSintaxis(codigo, nodo) {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  try {
    new AsyncFunction('$input', '$', 'DateTime', codigo);
  } catch (e) {
    fallar(`el código de "${nodo}" no compila: ${e.message}`);
  }
}

const id = (n) => `d71e7e00-${String(n).padStart(4, '0')}-4000-8000-${String(n).padStart(12, '0')}`;
const CFG = "$('Configuración').first().json.config";
const PASO = 240;
const CRED_DRIVE = { authentication: 'predefinedCredentialType', nodeCredentialType: 'googleDriveOAuth2Api' };
// Devuelve la respuesta completa y no falla ante un error HTTP: así el código ve el estado (404, 403…)
const RESPUESTA_COMPLETA = { response: { response: { fullResponse: true, neverError: true, responseFormat: 'json' } } };

// La función preparar() de preparar.js (sin su pegamento con n8n), para insertarla en «Hay trabajo»
const funcionPreparar = () => leer(ruta('herramientas', 'flujo-drive', 'preparar.js')).split('// --- Pegamento con n8n ---')[0].trimEnd();

function nodoCode(n, nombre, posicion, archivo, { conComun = false, conPreparar = false } = {}) {
  let codigo = leer(ruta('herramientas', 'flujo-drive', archivo));
  if (conComun) codigo = sustituir(codigo, MARCADOR_COMUN, leer(ruta('herramientas', 'flujo-drive', 'comun.js')).trimEnd(), nombre);
  if (conPreparar) codigo = sustituir(codigo, '/*__PREPARAR__*/', funcionPreparar(), nombre);
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

// Carpetas hijas de una o varias carpetas (solo carpetas, sin papelera), en una sola consulta:
// ('a' in parents or 'b' in parents). `expresionIds` es una expresión de n8n que devuelve un array de ids; si está vacío,
// la consulta no devuelve nada. Se pide nextPageToken para que "Planificar" detecte que hay más de una página y pare
// (con el árbol incompleto se crearían carpetas duplicadas). La misma consulta que construye consultaNivel (comun.js).
const urlNivel = (expresionIds) =>
  `={{ 'https://www.googleapis.com/drive/v3/files?pageSize=1000&supportsAllDrives=true&fields=' + encodeURIComponent('nextPageToken,files(id,name,parents)') + '&q=' + encodeURIComponent("mimeType = 'application/vnd.google-apps.folder' and trashed = false and (" + ((${expresionIds}).map((id) => "'" + id + "' in parents").join(' or ') || ("'" + ${CFG}.carpeta_raiz_id + "' in parents and name = 'a' and name != 'a'")) + ")") }}`;
// Ids de las carpetas que devolvió un listado anterior
const idsDe = (nodo) => `($('${nodo}').first().json.body?.files || []).map((f) => f.id)`;

function construirFlujoBase() {
  const ARRIBA = -120;
  const ABAJO = 160;
  const FILA_VACIAR = 900; // la rama de vaciar carpetas, debajo de la nota «Antes de ejecutar»

  const nodos = [
    {
      parameters: { rule: { interval: [{ field: 'seconds', secondsInterval: 10 }] } },
      id: id(1),
      name: 'Programación',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.2,
      position: [0, ARRIBA],
    },
    { parameters: {}, id: id(2), name: 'Disparador manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, ABAJO] },
    nodoCode(3, 'Configuración', [PASO, 0], 'configuracion.js'),
    // Con nada pendiente devuelve cero items y el flujo se pararía: Always Output Data lo evita (Preparar lo descarta)
    nodoHttp(
      4,
      'Leer pendientes',
      [PASO * 2, 0],
      {
        method: 'GET',
        url: `={{ ${CFG}.supabase_url }}/rest/v1/archivos?select=id,drive_file_id,nombre,item_id,carpeta_id,carpeta_destino,updated_at,items(tipo)&drive_pendiente=eq.true&eliminado_at=is.null&order=updated_at.asc&limit={{ ${CFG}.lote }}`,
        ...supabase,
      },
      { alwaysOutputData: true, retryOnFail: true, maxTries: 3, waitBetweenTries: 2000 },
    ),
    // Las carpetas que el usuario ha pedido crear sin mover archivos (tabla carpetas_pedidas)
    nodoHttp(
      14,
      'Leer carpetas pendientes',
      [PASO * 2 + PASO / 2, ABAJO],
      {
        method: 'GET',
        url: `={{ ${CFG}.supabase_url }}/rest/v1/carpetas_pedidas?select=id,ruta,updated_at&drive_pendiente=eq.true&eliminada_at=is.null&order=updated_at.asc&limit={{ ${CFG}.lote }}`,
        ...supabase,
      },
      // Una sola vez: cuelga de «Leer pendientes», que da un item por archivo; sin esto se repetía por cada archivo pendiente y cada carpeta
      // pedida salía varias veces (podía crearse duplicada en Drive).
      { alwaysOutputData: true, executeOnce: true },
    ),
    // Hay algo pendiente: un item; nada: cero items y el flujo termina aquí (casi siempre), sin pedir el turno ni tocar Drive
    nodoCode(15, 'Hay trabajo', [PASO * 3, 0], 'hay-trabajo.js', { conPreparar: true }),
    // El turno (base de datos 1.5): con una pasada cada 10 s, dos podrían solaparse si Drive va lento y crearían la misma carpeta dos veces.
    // Solo sigue la que lo toma. Sin la base de datos 1.5 la llamada falla y la ejecución sale en rojo (avisa «Aviso de fallos»): mejor que mover a ciegas.
    nodoHttp(
      16,
      'Tomar turno',
      [PASO * 4, 0],
      {
        method: 'POST',
        url: `={{ ${CFG}.supabase_url }}/rest/v1/rpc/tomar_turno`,
        ...supabase,
        sendBody: true,
        specifyBody: 'json',
        jsonBody: `={{ JSON.stringify({ p_nombre: 'sincronizar_drive', p_segundos: ${CFG}.turno_s }) }}`,
      },
      { executeOnce: true },
    ),
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [{ id: 'd71e7e00-0017-4000-8000-000000000001', leftValue: "={{ $json.turno === true ? 'si' : 'no' }}", rightValue: 'si', operator: { type: 'string', operation: 'equals' } }],
          combinator: 'and',
        },
        options: {},
      },
      id: id(17),
      name: '¿Tengo turno?',
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: [PASO * 5, 0],
    },
    nodoCode(5, 'Preparar', [PASO * 6, 0], 'preparar.js'),
    // Un GET por archivo: sus padres reales en Drive, para calcular removeParents. Para un elemento que es una carpeta pedida
    // (no tiene archivo) no hay nada que leer: se pide la propia raíz con fields=id, una petición inocua que mantiene el orden
    // de las respuestas (Planificar no la usa).
    nodoHttp(
      6,
      'Leer padres',
      [PASO * 7, 0],
      {
        method: 'GET',
        url: `={{ $json.archivo ? 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent($json.archivo.drive_file_id) + '?fields=id,name,parents,trashed&supportsAllDrives=true' : 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(${CFG}.carpeta_raiz_id) + '?fields=id&supportsAllDrives=true' }}`,
        ...CRED_DRIVE,
        options: RESPUESTA_COMPLETA,
      },
      { onError: 'continueRegularOutput' },
    ),
    // El árbol de carpetas, nivel a nivel y con una sola petición por nivel aunque haya varios archivos (Execute Once):
    // hijas de la raíz, hijas de esas y hijas de esas (hasta 3 niveles, lo que admite una carpeta pedida).
    nodoHttp(
      7,
      'Listar nivel 1',
      [PASO * 8, 0],
      { method: 'GET', url: urlNivel(`[${CFG}.carpeta_raiz_id]`), ...CRED_DRIVE, options: RESPUESTA_COMPLETA },
      { onError: 'continueRegularOutput', executeOnce: true },
    ),
    nodoHttp(
      8,
      'Listar nivel 2',
      [PASO * 9, 0],
      { method: 'GET', url: urlNivel(idsDe('Listar nivel 1')), ...CRED_DRIVE, options: RESPUESTA_COMPLETA },
      { onError: 'continueRegularOutput', executeOnce: true },
    ),
    nodoHttp(
      13,
      'Listar nivel 3',
      [PASO * 10, 0],
      { method: 'GET', url: urlNivel(idsDe('Listar nivel 2')), ...CRED_DRIVE, options: RESPUESTA_COMPLETA },
      { onError: 'continueRegularOutput', executeOnce: true },
    ),
    // Las carpetas que creó una pasada anterior hace menos de 60 s (base de datos 1.5): cuentan como existentes aunque Drive aún no las liste. Poco
    // margen a propósito: si la borras a mano justo después, como mucho durante un minuto se la sigue dando por existente.
    // Sin la base de datos 1.5 falla sin cortar el flujo y no hay ninguna (como antes).
    nodoHttp(
      19,
      'Leer carpetas creadas',
      [PASO * 10 + PASO / 2, ABAJO],
      {
        method: 'GET',
        url: `={{ ${CFG}.supabase_url }}/rest/v1/carpetas_creadas?select=drive_id,padre_id,nombre&creada_at=gte.{{ encodeURIComponent(new Date(Date.now() - 60000).toISOString()) }}&limit=500`,
        ...supabase,
      },
      { alwaysOutputData: true, executeOnce: true, onError: 'continueRegularOutput' },
    ),
    nodoCode(9, 'Planificar', [PASO * 11, 0], 'planificar.js', { conComun: true }),
    // Solo POST (crear carpeta) y PATCH (mover o limpiar), siempre con cuerpo
    nodoHttp(
      10,
      'Google Drive',
      [PASO * 12, 0],
      {
        method: '={{ $json.metodo }}',
        url: '={{ $json.url }}',
        ...CRED_DRIVE,
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify($json.cuerpo) }}',
        options: RESPUESTA_COMPLETA,
      },
      { onError: 'continueRegularOutput' },
    ),
    nodoCode(11, 'Registrar', [PASO * 13, 0], 'registrar.js'),
    nodoHttp(
      12,
      'Escribir en Supabase',
      [PASO * 14, 0],
      {
        method: '={{ $json.metodo }}',
        url: '={{ $json.url }}',
        ...supabase,
        sendHeaders: true,
        specifyHeaders: 'keypair',
        headerParameters: { parameters: [{ name: 'Prefer', value: '={{ $json.prefer }}' }] },
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify($json.cuerpo) }}',
      },
      { onError: 'continueRegularOutput' },
    ),
    // Al acabar se suelta el turno (solo con el token de quien lo tomó): la pasada siguiente no espera a que caduque
    nodoHttp(
      18,
      'Soltar turno',
      [PASO * 15, 0],
      {
        method: 'POST',
        url: `={{ ${CFG}.supabase_url }}/rest/v1/rpc/soltar_turno`,
        ...supabase,
        sendBody: true,
        specifyBody: 'json',
        jsonBody: "={{ JSON.stringify({ p_nombre: 'sincronizar_drive', p_token: $('Tomar turno').first().json.token }) }}",
      },
      { executeOnce: true, onError: 'continueRegularOutput' },
    ),

    // --- Vaciar las carpetas que se quedan vacías al mover sus archivos (base de datos 1.5). Rama aparte, cada pasada: casi siempre no
    // hay ninguna y termina en la primera lectura. Entrada y Notas no se vacían nunca (tres barreras).
    nodoHttp(
      20,
      'Leer carpetas por vaciar',
      [PASO, FILA_VACIAR],
      { method: 'POST', url: `={{ ${CFG}.supabase_url }}/rest/v1/rpc/carpetas_por_vaciar`, ...supabase, sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify({ p_espera_s: 20 }) }}' },
      { onError: 'continueRegularOutput' },
    ),
    nodoCode(21, 'Preparar vaciado', [PASO * 2, FILA_VACIAR], 'preparar-vaciado.js'),
    nodoHttp(
      22,
      'Mirar si está vacía',
      [PASO * 3, FILA_VACIAR],
      {
        method: 'GET',
        url: `={{ 'https://www.googleapis.com/drive/v3/files?pageSize=1&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=' + encodeURIComponent('nextPageToken,files(id)') + '&q=' + encodeURIComponent("'" + $json.vaciar.carpeta_id + "' in parents and trashed = false") }}`,
        ...CRED_DRIVE,
        options: RESPUESTA_COMPLETA,
      },
      { onError: 'continueRegularOutput' },
    ),
    nodoCode(23, 'Decidir vaciado', [PASO * 4, FILA_VACIAR], 'decidir-vaciado.js'),
    nodoHttp(
      24,
      'Vaciar en Drive',
      [PASO * 5, FILA_VACIAR],
      {
        method: 'PATCH',
        url: "={{ 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent($json.vaciar.carpeta_id) + '?supportsAllDrives=true' }}",
        ...CRED_DRIVE,
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify({ trashed: true }) }}',
        options: RESPUESTA_COMPLETA,
      },
      { onError: 'continueRegularOutput' },
    ),
    // Si Drive no la mandó a la papelera, una llamada con un id que no existe: no anota nada y se reintenta en la pasada siguiente
    nodoHttp(
      25,
      'Anotar vaciado',
      [PASO * 6, FILA_VACIAR],
      {
        method: 'POST',
        url: `={{ ${CFG}.supabase_url }}/rest/v1/rpc/vaciado_hecho`,
        ...supabase,
        sendBody: true,
        specifyBody: 'json',
        jsonBody: "={{ JSON.stringify({ p_id: $json.statusCode >= 200 && $json.statusCode < 300 ? $('Decidir vaciado').item.json.vaciar.id : '00000000-0000-0000-0000-000000000000', p_resultado: 'papelera' }) }}",
      },
      { onError: 'continueRegularOutput' },
    ),
    nota(107, PASO - 40, FILA_VACIAR - 240, PASO * 6, 200, 6, '## ⑥ Vaciar carpetas (base de datos 1.5)\nCuando mueves los archivos de una carpeta a otra (o juntas dos), la de origen se apunta para vaciar. Aquí, si ya no tiene ningún archivo registrado dentro, **Mirar si está vacía** lo comprueba **en Drive** (también lo subido a mano) y solo entonces va a la papelera (se recupera desde Drive). **Entrada y Notas nunca se vacían.** Lo que sigue con algo dentro se deja (a los 30 minutos se da por cerrado).'),

    nota(101, -40, -420, PASO * 2, 200, 4, '## ① Disparo y configuración\nSe ejecuta **cada 10 segundos** (Programación) o a mano (Disparador manual). Las ejecuciones que salen bien **no se guardan** (serían más de 8.000 al día y n8n borraría el historial de los demás flujos); las que fallan, sí.\n**Configuración**: el único sitio con valores a mano (URL de Supabase, ID de la carpeta "Secretaria", lote).'),
    nota(102, PASO * 2 - 40, -420, PASO * 5 - 20, 200, 5, '## ② Pendientes\nLee los archivos marcados `drive_pendiente` (lo marcan triggers de la base de datos al asignar un archivo a un item, al pedir o cambiar su carpeta, al cambiar su nombre o al cambiar el tipo del item). Lee también las **carpetas pedidas** (`carpetas_pedidas`: "crea la carpeta Proyectos dentro de Trabajo"). Si no hay ningún archivo ni carpeta pendiente, el flujo termina en **Hay trabajo**. Si hay algo, **Tomar turno** (base de datos 1.5) deja seguir a una sola ejecución a la vez y **Soltar turno**, al final, lo suelta.'),
    nota(103, PASO * 7 - 40, -420, PASO * 4, 200, 6, '## ③ Lectura de Drive\n**Leer padres**: carpetas actuales y nombre de cada archivo. **Listar nivel 1, 2 y 3**: el árbol de carpetas bajo `Secretaria`, un nivel por petición (hasta 3 niveles). Si Drive devuelve más de una página, se para en vez de arriesgar carpetas duplicadas.'),
    nota(104, PASO * 11 - 40, -420, PASO * 2, 200, 3, '## ④ Planificar y mover\n**Planificar** decide el destino: la **carpeta pedida** por el usuario (`Fotos`, `Fotos/Viajes`) manda; si no hay, `Notas`. Mueve, crea las carpetas que falten (un nivel por pasada de 10 s; el archivo se mueve en la siguiente), renombra si cambió el nombre o limpia la marca si no hay nada que hacer. Una **carpeta pedida** sin archivos se crea nivel a nivel y, cuando existe entera, se anota (`carpeta_lista`).'),
    nota(105, PASO * 13 - 40, -420, PASO * 2, 200, 7, '## ⑤ Registro\n**Registrar** limpia `drive_pendiente` y guarda `carpeta_id` (en `archivos` o en `carpetas_pedidas`), con una condición sobre `updated_at`: si la fila cambió mientras se movía, sigue pendiente.'),
    nota(
      106,
      -40,
      340,
      PASO * 3,
      300,
      2,
      '## Antes de ejecutar\n1. Elige la credencial **Google Drive OAuth2 API** (con el alcance completo `drive`, no `drive.file`) en *Leer padres*, *Listar nivel 1*, *Listar nivel 2*, *Listar nivel 3*, *Google Drive*, *Mirar si está vacía* y *Vaciar en Drive*, y la **Supabase API** en *Leer pendientes*, *Leer carpetas pendientes*, *Tomar turno*, *Leer carpetas creadas*, *Escribir en Supabase*, *Soltar turno*, *Leer carpetas por vaciar* y *Anotar vaciado*. Antes, la base de datos al día (`supabase/instalar.sql`, o los `supabase/actualizar-*.sql` que te falten).\n2. Identificadores: `SUPABASE_URL` y `DRIVE_CARPETA_RAIZ_ID` en el `.env` del servidor (no hace falta tocar **Configuración**).\n3. Bajo "Secretaria" debe existir la carpeta `Entrada` (donde llegan los archivos); las demás (`Notas` y las que pida el usuario) se crean solas.\n4. Publica el flujo para que se ejecute cada 10 segundos.',
    ),
  ];

  const a = (nombre) => ({ node: nombre, type: 'main', index: 0 });
  const cadena = ['Configuración', 'Leer pendientes', 'Leer carpetas pendientes', 'Hay trabajo', 'Tomar turno', '¿Tengo turno?', 'Preparar', 'Leer padres', 'Listar nivel 1', 'Listar nivel 2', 'Listar nivel 3', 'Leer carpetas creadas', 'Planificar', 'Google Drive', 'Registrar', 'Escribir en Supabase', 'Soltar turno'];
  const conexiones = {
    Programación: { main: [[a('Configuración')]] },
    'Disparador manual': { main: [[a('Configuración')]] },
  };
  for (let i = 0; i < cadena.length - 1; i++) conexiones[cadena[i]] = { main: [[a(cadena[i + 1])]] };
  // Configuración también arranca la rama de vaciar carpetas
  conexiones['Configuración'] = { main: [[a('Leer pendientes'), a('Leer carpetas por vaciar')]] };
  const vaciar = ['Leer carpetas por vaciar', 'Preparar vaciado', 'Mirar si está vacía', 'Decidir vaciado', 'Vaciar en Drive', 'Anotar vaciado'];
  for (let i = 0; i < vaciar.length - 1; i++) conexiones[vaciar[i]] = { main: [[a(vaciar[i + 1])]] };

  return { name: NOMBRE_FLUJO, nodes: nodos, connections: conexiones, pinData: {}, settings: { executionOrder: 'v1', timezone: 'Europe/Madrid', saveDataSuccessExecution: 'none', saveDataErrorExecution: 'all', saveManualExecutions: true } };
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
