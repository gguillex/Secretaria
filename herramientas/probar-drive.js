// Pruebas sin red ni coste del flujo "Sincronizar Drive" (flujos/sincronizar-drive.json).
// Ejecuta el código real de herramientas/flujo-drive/*.js con entradas simuladas.
// Uso: node herramientas/probar-drive.js

const fs = require('fs');
const path = require('path');
const { construirFlujo } = require('./generar-drive.js');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const COMUN = fs.readFileSync(path.join(__dirname, 'flujo-drive', 'comun.js'), 'utf8').replace(/\r\n/g, '\n').trimEnd();
const nodo = (f, conComun = false) => {
  const codigo = fs.readFileSync(path.join(__dirname, 'flujo-drive', f), 'utf8').replace(/\r\n/g, '\n');
  return conComun ? codigo.split('/*__COMUN__*/').join(COMUN) : codigo;
};

// Las funciones puras de comun.js, para probarlas directamente. Se ejecuta el contenido de ese archivo del
// propio repositorio, leído del disco: nunca texto externo ni datos del usuario (por eso new Function es seguro aquí).
const comun = new Function(`${COMUN}\nreturn { rutaDestino, segmentosCarpeta, nombreArchivoSeguro, escaparQ, consultaCarpeta, consultaNivel, hijosPorPadre, resolverRuta, planificarAcciones };`)();

const CONFIG = { supabase_url: 'https://abc.supabase.co', carpeta_raiz_id: 'raiz-1234567890', lote: 20 };
const RAIZ = CONFIG.carpeta_raiz_id;
const BASE = 'https://abc.supabase.co/rest/v1';
const API = 'https://www.googleapis.com/drive/v3/files';
const ENTRADA = 'entrada-111';
const TRABAJO = 'trabajo-222';
const NOTAS = 'notas-333';
const AP = 'ap-444';
const FOTOS = 'fotos-555';
const VIAJES = 'viajes-666';

// Un listado de Drive por nivel, tal como lo devuelve la API con la respuesta completa
const lista = (files, extra = {}) => ({ statusCode: 200, body: { files, ...extra } });
const carp = (id, name, parent) => ({ id, name, parents: [parent] });
const NIVEL1 = [carp(ENTRADA, 'Entrada', RAIZ), carp(TRABAJO, 'Trabajo', RAIZ), carp(NOTAS, 'Notas', RAIZ), carp(FOTOS, 'Fotos', RAIZ)];
const NIVEL2 = [carp(AP, 'Informes técnicos', TRABAJO), carp(VIAJES, 'Viajes', FOTOS)];
const niveles = (n1 = NIVEL1, n2 = NIVEL2, n3 = []) => [lista(n1), lista(n2), lista(n3)];

function simular(nodos) {
  return (nombre) => {
    if (!(nombre in nodos)) throw new Error(`Node "${nombre}" hasn't been executed`);
    const items = nodos[nombre].map((json) => ({ json }));
    return { all: () => items, first: () => items[0] };
  };
}
async function correr(codigo, { input = [], nodos = {} } = {}) {
  const items = input.map((json) => ({ json }));
  const fn = new AsyncFunction('$input', '$', 'DateTime', codigo);
  const salida = await fn({ all: () => items, first: () => items[0] }, simular(nodos), undefined);
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

// Archivos de ejemplo tal como los devuelve PostgREST (con el item embebido)
const archivo = (n, items, extra = {}) => ({
  id: `0000000${n}-0000-4000-8000-000000000000`,
  drive_file_id: `F${n}`,
  nombre: `foto${n}.jpg`,
  item_id: items ? `1111111${n}-0000-4000-8000-000000000000` : null,
  carpeta_id: null,
  carpeta_destino: null,
  updated_at: `2026-10-12T10:00:0${n}.123456+00:00`,
  items,
  ...extra,
});
// Un archivo con carpeta pedida que existe (Trabajo/Informes técnicos) y otro cuya carpeta pedida falta (Trabajo/Contratos)
const A_PEDIDA = archivo(1, null, { carpeta_destino: 'Trabajo/Informes técnicos' });
const A_NOTA = archivo(2, { tipo: 'nota' });
const A_NUEVA = archivo(3, null, { carpeta_destino: 'Trabajo/Contratos' });
const A_SIN_ITEM = archivo(4, null);
// Respuesta de Drive al leer un archivo. Sin "name" no se considera ningún cambio de nombre.
const ok = (parents, extra = {}) => ({ statusCode: 200, body: { id: 'x', parents, ...extra } });

async function main() {
  console.log('Carpeta destino');
  {
    afirmar('los archivos de cualquier elemento van a Notas', ['nota', 'tarea', 'evento', 'lista'].every((t) => JSON.stringify(comun.rutaDestino({ tipo: t })) === '["Notas"]'));
  }

  console.log('Carpeta pedida por el usuario');
  {
    const s = comun.segmentosCarpeta;
    afirmar('rutas válidas de 1 a 3 niveles', JSON.stringify(s('Fotos')) === '["Fotos"]' && JSON.stringify(s('Fotos/Viajes')) === '["Fotos","Viajes"]' && s('a/b/c').length === 3 && s('Áreas ñ/Año 2026').length === 2 && s('x'.repeat(60)).length === 1);
    afirmar('rechaza vacío, 4 niveles, niveles vacíos y demasiado largos', ['', 'a/b/c/d', 'a//b', '/a', 'a/', 'x'.repeat(61)].every((v) => s(v) === null));
    afirmar('rechaza "." y ".." como nivel', ['.', '..', 'a/..', '../a', 'a/./b'].every((v) => s(v) === null));
    afirmar('rechaza espacios en los extremos de un nivel', [' a', 'a ', 'a/ b', 'a /b'].every((v) => s(v) === null));
    afirmar('rechaza barra invertida y caracteres de control', ['a\\b', 'a\nb', 'a\tb', 'a\u0001b', 'a\u007fb'].every((v) => s(v) === null));
    afirmar('rechaza lo que no es texto', [null, undefined, 5, {}, ['a']].every((v) => s(v) === null));

    const n = comun.nombreArchivoSeguro;
    afirmar('nombre de archivo: quita caracteres no válidos y espacios sobrantes', n('a/b\\c:d*e?f"g<h>i|j.pdf') === 'a_b_c_d_e_f_g_h_i_j.pdf' && n('  ..oculto   doc .pdf ') === 'oculto doc .pdf');
    afirmar('nombre de archivo: recorta a 120 conservando la extensión', (() => { const r = n(`${'a'.repeat(300)}.pdf`); return r.length === 120 && r.endsWith('.pdf'); })());
    afirmar('nombre de archivo: vacío o no texto da cadena vacía', n('') === '' && n(undefined) === '' && n(null) === '');
  }

  console.log('Búsqueda de carpetas');
  {
    afirmar('escapa la comilla simple y la barra invertida', comun.escaparQ("O'Brien\\Notes") === "O\\'Brien\\\\Notes", comun.escaparQ("O'Brien\\Notes"));
    const q = comun.consultaCarpeta('Facturas 2026', 'abc_DEF-123');
    afirmar('la consulta usa el formato oficial', q === "mimeType = 'application/vnd.google-apps.folder' and name = 'Facturas 2026' and 'abc_DEF-123' in parents and trashed = false", q);
    afirmar('una comilla en el nombre no rompe la consulta', comun.consultaCarpeta("D'Arcy", 'abc123').includes("name = 'D\\'Arcy'"));
    let error = null;
    try {
      comun.consultaCarpeta('X', "x' or 'a'='a");
    } catch (e) {
      error = e;
    }
    afirmar('un id de carpeta con caracteres raros se rechaza', error !== null && error.message.includes('no válido'));

    afirmar('consulta por nivel: varios padres con "or" y solo carpetas sin papelera', comun.consultaNivel(['a1', 'b_2']) === "mimeType = 'application/vnd.google-apps.folder' and trashed = false and ('a1' in parents or 'b_2' in parents)");
    afirmar('consulta por nivel: sin padres, una consulta válida y contradictoria sobre la raíz (nunca un id inventado, que Drive contesta con 404)', comun.consultaNivel([], RAIZ) === `mimeType = 'application/vnd.google-apps.folder' and trashed = false and ('${RAIZ}' in parents and name = 'a' and name != 'a')`, comun.consultaNivel([], RAIZ));
    afirmar('consulta por nivel: ningún id de padre es inventado (solo los de las carpetas leídas o el de la raíz)', ![[], ['f1'], ['f1', 'f2']].some((ids) => (comun.consultaNivel(ids, RAIZ).match(/'([^']+)' in parents/g) || []).some((m) => ![...ids, RAIZ].includes(m.split("'")[1])) || /sin-/.test(comun.consultaNivel(ids, RAIZ))));
    await lanza('consulta por nivel: sin padres hace falta un id de raíz válido', Promise.resolve().then(() => comun.consultaNivel([], "x' or 'a'='a")), 'no válido');
    afirmar('consulta por nivel: sin repetidos', comun.consultaNivel(['a', 'a'], RAIZ) === comun.consultaNivel(['a'], RAIZ));
    await lanza('consulta por nivel: un id raro se rechaza', Promise.resolve().then(() => comun.consultaNivel(["x' or 'a'='a"])), 'no válido');
    await lanza('consulta por nivel: demasiados padres', Promise.resolve().then(() => comun.consultaNivel(Array.from({ length: 101 }, (_, i) => `c${i}`))), 'Demasiadas carpetas');
  }

  console.log('Árbol de carpetas');
  {
    const h = comun.hijosPorPadre(niveles());
    afirmar('agrupa las carpetas por su padre', h.get(RAIZ).length === 4 && h.get(TRABAJO)[0].id === AP && h.get(FOTOS)[0].id === VIAJES);
    afirmar('orden estable por nombre', h.get(RAIZ).map((c) => c.name).join() === 'Entrada,Fotos,Notas,Trabajo', h.get(RAIZ).map((c) => c.name).join());
    await lanza('un listado con error HTTP se rechaza', Promise.resolve().then(() => comun.hijosPorPadre([{ statusCode: 403, body: {} }, lista([]), lista([])])), 'nivel 1');
    await lanza('un error de red sin código se rechaza', Promise.resolve().then(() => comun.hijosPorPadre([lista([]), { error: { message: 'ECONNRESET' } }, lista([])])), 'ECONNRESET');
    await lanza('una respuesta sin lista de carpetas se rechaza', Promise.resolve().then(() => comun.hijosPorPadre([lista([]), { statusCode: 200, body: {} }, lista([])])), 'nivel 2');
    await lanza('más de una página: se para para no duplicar carpetas', Promise.resolve().then(() => comun.hijosPorPadre([lista(NIVEL1, { nextPageToken: 'tok' }), lista([]), lista([])])), 'más de una página');

    const r = (segs, hijos = h) => comun.resolverRuta(segs, RAIZ, hijos);
    afirmar('ruta que existe entera: devuelve el id', r(['Fotos', 'Viajes']).id === VIAJES && r(['Trabajo']).id === TRABAJO);
    afirmar('ignora mayúsculas y la codificación de las tildes', r(['fotos', 'VIAJES']).id === VIAJES && r(['trabajo', 'informes técnicos'.normalize('NFD')]).id === AP);
    afirmar('falta el último nivel: dice cuál y dónde crearlo', JSON.stringify(r(['Fotos', 'Playa']).falta) === JSON.stringify({ padreId: FOTOS, nombre: 'Playa', ruta: 'Fotos/Playa' }));
    afirmar('falta el primer nivel: lo primero que se crea es ese', JSON.stringify(r(['Nueva', 'Sub', 'Sub2']).falta) === JSON.stringify({ padreId: RAIZ, nombre: 'Nueva', ruta: 'Nueva' }));
    afirmar('una carpeta con el mismo nombre pero en otro sitio no cuenta', r(['Viajes']).falta?.ruta === 'Viajes');
  }

  console.log('Planificar acciones');
  {
    const plan = (archivos, padres, extra = {}) => comun.planificarAcciones({ archivos, padres, raizId: RAIZ, niveles: niveles(), ...extra });

    const m = plan([A_PEDIDA], [ok([ENTRADA])]);
    afirmar('un archivo se mueve a su carpeta pedida', m.acciones.length === 1 && m.acciones[0].tipo === 'mover' && m.acciones[0].carpeta_id === AP);
    afirmar('la URL añade el destino y quita Entrada', m.acciones[0].url === `${API}/F1?supportsAllDrives=true&addParents=${AP}&removeParents=${ENTRADA}`, m.acciones[0].url);
    afirmar('mover es un PATCH con cuerpo vacío si el nombre no cambia', m.acciones[0].metodo === 'PATCH' && JSON.stringify(m.acciones[0].cuerpo) === '{}');
    afirmar('la acción lleva el updated_at leído', m.acciones[0].updated_at === A_PEDIDA.updated_at);

    const n = plan([A_NOTA], [ok([ENTRADA])]);
    afirmar('una nota va a Notas', n.acciones[0].carpeta_id === NOTAS && n.acciones[0].url.includes(`addParents=${NOTAS}`));

    const dos = plan([A_PEDIDA], [ok([ENTRADA, 'otra'])]);
    afirmar('quita todos los padres actuales distintos del destino', dos.acciones[0].url.includes(`removeParents=${ENTRADA}%2Cotra`), dos.acciones[0].url);

    const yaEsta = plan([A_PEDIDA], [ok([AP])]);
    afirmar('si ya está en su carpeta no añade ni quita nada', yaEsta.acciones[0].tipo === 'mover' && yaEsta.acciones[0].url === `${API}/F1?supportsAllDrives=true`, yaEsta.acciones[0].url);

    const estaYMas = plan([A_PEDIDA], [ok([AP, ENTRADA])]);
    afirmar('si ya está en su carpeta pero también en otra, solo quita la otra', estaYMas.acciones[0].url === `${API}/F1?supportsAllDrives=true&removeParents=${ENTRADA}`, estaYMas.acciones[0].url);

    const falta = plan([A_NUEVA], [ok([ENTRADA])]);
    afirmar('si falta el último nivel de la carpeta pedida, se crea dentro del anterior', falta.acciones.length === 1 && falta.acciones[0].tipo === 'crear_carpeta' && falta.acciones[0].metodo === 'POST');
    afirmar('el cuerpo de la carpeta nueva es correcto', JSON.stringify(falta.acciones[0].cuerpo) === JSON.stringify({ name: 'Contratos', mimeType: 'application/vnd.google-apps.folder', parents: [TRABAJO], appProperties: { secretaria: '1' } }));
    afirmar('el archivo espera a la pasada siguiente (no se mueve a la vez)', !falta.acciones.some((x) => x.tipo === 'mover'));

    const A_NUEVA_2 = archivo(5, null, { carpeta_destino: 'Trabajo/Contratos' });
    const dup = plan([A_NUEVA, A_NUEVA_2], [ok([ENTRADA]), ok([ENTRADA])]);
    afirmar('dos archivos que piden la misma carpeta nueva la crean una sola vez', dup.acciones.filter((x) => x.tipo === 'crear_carpeta').length === 1);

    const mezcla = plan([A_NUEVA, A_PEDIDA], [ok([ENTRADA]), ok([ENTRADA])]);
    afirmar('un archivo que espera no impide mover los demás', mezcla.acciones.length === 2 && mezcla.acciones[1].tipo === 'mover');

    const nfd = plan([A_PEDIDA], [ok([ENTRADA])], { niveles: niveles(NIVEL1, [carp('nfd-1', 'Informes técnicos'.normalize('NFD'), TRABAJO)]) });
    afirmar('la comparación de nombres no depende de cómo estén codificadas las tildes', nfd.acciones[0].tipo === 'mover' && nfd.acciones[0].carpeta_id === 'nfd-1', JSON.stringify(nfd.acciones));

    const sinItem = plan([A_SIN_ITEM], [ok([ENTRADA])]);
    afirmar('un archivo sin item ni carpeta solo se limpia', sinItem.acciones[0].tipo === 'limpiar' && sinItem.acciones[0].url === `${API}/F4?supportsAllDrives=true`);

    const papelera = plan([A_PEDIDA], [ok([ENTRADA], { trashed: true })]);
    afirmar('un archivo en la papelera solo se limpia', papelera.acciones[0].tipo === 'limpiar' && papelera.acciones[0].etiqueta.includes('papelera'));

    const noExiste = plan([A_PEDIDA], [{ statusCode: 404, body: { error: { code: 404 } } }]);
    afirmar('un 404 al leer los padres limpia la marca', noExiste.acciones[0].tipo === 'limpiar' && noExiste.acciones[0].etiqueta.includes('ya no existe'));

    const caido = plan([A_PEDIDA, A_NOTA], [{ statusCode: 500, body: 'error' }, ok([ENTRADA])]);
    afirmar('un fallo al leer padres no hace nada con ese archivo y se anota', caido.acciones.length === 1 && caido.fallos.length === 1 && caido.fallos[0].includes('HTTP 500'));

    const sinPadres = plan([A_PEDIDA], [ok([])]);
    afirmar('un archivo sin padres solo se añade', sinPadres.acciones[0].url === `${API}/F1?supportsAllDrives=true&addParents=${AP}`, sinPadres.acciones[0].url);

    const errorRed = plan([A_PEDIDA], [{ error: { message: 'ECONNRESET' } }]);
    afirmar('un error de red sin código de estado cuenta como fallo', errorRed.acciones.length === 0 && errorRed.fallos[0].includes('ECONNRESET'));

    const sinPrimera = plan([A_PEDIDA], [ok([ENTRADA])], { niveles: niveles([carp(ENTRADA, 'Entrada', RAIZ), carp(NOTAS, 'Notas', RAIZ)], []) });
    afirmar('si falta el primer nivel de la carpeta pedida se crea bajo la raíz', sinPrimera.acciones.length === 1 && sinPrimera.acciones[0].tipo === 'crear_carpeta' && JSON.stringify(sinPrimera.acciones[0].cuerpo.parents) === JSON.stringify([RAIZ]) && sinPrimera.acciones[0].cuerpo.name === 'Trabajo');

    afirmar('un id de archivo raro se codifica en la URL', plan([archivo(6, { tipo: 'nota' }, { drive_file_id: 'a/b?c' })], [ok([ENTRADA])]).acciones[0].url.startsWith(`${API}/a%2Fb%3Fc?`));
    await lanza('un listado de carpetas roto detiene la planificación', Promise.resolve().then(() => plan([A_PEDIDA], [ok([ENTRADA])], { niveles: [{ statusCode: 401, body: {} }, lista([]), lista([])] })), 'no se pudieron listar');
  }

  console.log('Planificar: carpeta pedida');
  {
    const plan = (archivos, padres, extra = {}) => comun.planificarAcciones({ archivos, padres, raizId: RAIZ, niveles: niveles(), ...extra });
    const F = (n, carpeta, extra = {}) => archivo(n, null, { carpeta_destino: carpeta, ...extra });

    const m = plan([F(1, 'Fotos')], [ok([ENTRADA])]);
    afirmar('una carpeta pedida que existe: mueve el archivo (sin item)', m.acciones.length === 1 && m.acciones[0].tipo === 'mover' && m.acciones[0].carpeta_id === FOTOS && m.acciones[0].url === `${API}/F1?supportsAllDrives=true&addParents=${FOTOS}&removeParents=${ENTRADA}`, JSON.stringify(m.acciones));
    const anidada = plan([F(1, 'Fotos/Viajes')], [ok([ENTRADA])]);
    afirmar('una ruta de dos niveles que existe', anidada.acciones[0].carpeta_id === VIAJES && anidada.acciones[0].etiqueta.includes('Fotos/Viajes'));
    const mayus = plan([F(1, 'fotos/viajes')], [ok([ENTRADA])]);
    afirmar('"fotos" y "Fotos" son la misma carpeta (no se duplica)', mayus.acciones[0].tipo === 'mover' && mayus.acciones[0].carpeta_id === VIAJES);

    const nueva = plan([F(1, 'Documentos')], [ok([ENTRADA])]);
    afirmar('una carpeta nueva se crea bajo la raíz y el archivo espera', nueva.acciones.length === 1 && nueva.acciones[0].tipo === 'crear_carpeta' && JSON.stringify(nueva.acciones[0].cuerpo) === JSON.stringify({ name: 'Documentos', mimeType: 'application/vnd.google-apps.folder', parents: [RAIZ], appProperties: { secretaria: '1' } }));
    const nivelNuevo = plan([F(1, 'Fotos/Playa')], [ok([ENTRADA])]);
    afirmar('crea solo el primer nivel que falta, dentro de la carpeta que ya existe', nivelNuevo.acciones.length === 1 && nivelNuevo.acciones[0].cuerpo.name === 'Playa' && nivelNuevo.acciones[0].cuerpo.parents[0] === FOTOS);
    const profunda = plan([F(1, 'A/B/C')], [ok([ENTRADA])]);
    afirmar('una ruta de 3 niveles nueva empieza por el primero (un nivel por pasada)', profunda.acciones.length === 1 && profunda.acciones[0].cuerpo.name === 'A');
    const dosIguales = plan([F(1, 'Documentos'), F(2, 'documentos')], [ok([ENTRADA]), ok([ENTRADA])]);
    afirmar('dos archivos que piden la misma carpeta nueva (aunque cambie la capitalización) crean una sola', dosIguales.acciones.filter((x) => x.tipo === 'crear_carpeta').length === 1);

    const manda = plan([archivo(1, { tipo: 'nota' }, { carpeta_destino: 'Fotos' })], [ok([ENTRADA])]);
    afirmar('la carpeta pedida manda sobre la del item', manda.acciones[0].carpeta_id === FOTOS);
    const sinPedida = plan([archivo(1, { tipo: 'nota' }, { carpeta_destino: null })], [ok([ENTRADA])]);
    afirmar('sin carpeta pedida, el archivo de un item va a Notas', sinPedida.acciones[0].carpeta_id === NOTAS);

    const mala = plan([F(1, 'a/../b'), F(2, 'Fotos')], [ok([ENTRADA]), ok([ENTRADA])]);
    afirmar('una carpeta no válida no se mueve y se anota, sin afectar a los demás', mala.acciones.length === 1 && mala.acciones[0].carpeta_id === FOTOS && mala.fallos.length === 1 && mala.fallos[0].includes('no válida'));
    afirmar('con la carpeta vacía ("") también es no válida (no cae al item)', plan([F(1, '')], [ok([ENTRADA])]).fallos.length === 1);
  }

  console.log('Planificar: carpetas pedidas (crear carpeta sin mover archivos)');
  {
    const planC = (carpetas, extra = {}) => comun.planificarAcciones({ archivos: [], carpetas, padres: [], raizId: RAIZ, niveles: niveles(), ...extra });
    const C = (n, ruta) => ({ id: `cccccccc-0000-4000-8000-00000000000${n}`, ruta, updated_at: `2026-10-12T10:00:0${n}.123456+00:00` });

    const nueva = planC([C(1, 'Oficina')]);
    afirmar('una carpeta nueva de primer nivel se crea bajo la raíz', nueva.acciones.length === 1 && nueva.acciones[0].tipo === 'crear_carpeta' && JSON.stringify(nueva.acciones[0].cuerpo) === JSON.stringify({ name: 'Oficina', mimeType: 'application/vnd.google-apps.folder', parents: [RAIZ], appProperties: { secretaria: '1' } }));
    const dentro = planC([C(1, 'Fotos/Playa')]);
    afirmar('una carpeta dentro de otra existente se crea dentro de ella', dentro.acciones.length === 1 && dentro.acciones[0].cuerpo.name === 'Playa' && dentro.acciones[0].cuerpo.parents[0] === FOTOS);
    // Carpetas recién creadas por la pasada anterior (base de datos 1.5): cuentan aunque Drive aún no las liste
    const yaCreada = planC([C(1, 'Oficina')], { recientes: [{ drive_id: 'id-trabajo-recien', padre_id: RAIZ, nombre: 'oficina' }] });
    afirmar('una carpeta creada hace un momento (aún no listada) no se vuelve a crear: se da por lista con su id', yaCreada.acciones.length === 1 && yaCreada.acciones[0].tipo === 'carpeta_lista' && yaCreada.acciones[0].carpeta_id === 'id-trabajo-recien', JSON.stringify(yaCreada.acciones.map((x) => x.tipo)));
    const siguienteNivel = planC([C(1, 'Oficina/Proyectos')], { recientes: [{ drive_id: 'id-trabajo-recien', padre_id: RAIZ, nombre: 'Oficina' }] });
    afirmar('y el nivel siguiente se crea dentro de ella sin esperar a que Drive la liste', siguienteNivel.acciones[0].tipo === 'crear_carpeta' && siguienteNivel.acciones[0].cuerpo.parents[0] === 'id-trabajo-recien' && siguienteNivel.acciones[0].cuerpo.name === 'Proyectos');
    afirmar('una reciente que ya sale en el listado no se duplica', planC([C(1, 'Fotos')], { recientes: [{ drive_id: FOTOS, padre_id: RAIZ, nombre: 'Fotos' }] }).acciones[0].carpeta_id === FOTOS);
    afirmar('filas raras en las recientes se ignoran', planC([C(1, 'Oficina')], { recientes: [null, { drive_id: 1 }, {}] }).acciones[0].tipo === 'crear_carpeta');
    const profunda = planC([C(1, 'A/B/C')]);
    afirmar('una ruta de tres niveles nueva empieza por el primero (un nivel por pasada)', profunda.acciones.length === 1 && profunda.acciones[0].cuerpo.name === 'A' && profunda.acciones[0].cuerpo.parents[0] === RAIZ);
    const unicaCreada = planC([C(1, 'Oficina/Proyectos'), C(2, 'oficina/Otros')]);
    afirmar('dos carpetas pedidas bajo la misma carpeta nueva (aunque cambie la capitalización) crean el primer nivel una sola vez', unicaCreada.acciones.length === 1 && unicaCreada.acciones[0].cuerpo.name === 'Oficina');

    const lista = planC([C(1, 'Fotos/Viajes')]);
    afirmar('una carpeta que ya existe entera se da por lista, con su id', lista.acciones.length === 1 && lista.acciones[0].tipo === 'carpeta_lista' && lista.acciones[0].carpeta_id === VIAJES && lista.acciones[0].carpeta_pedida_id === C(1).id && lista.acciones[0].updated_at === C(1, '').updated_at, JSON.stringify(lista.acciones));
    afirmar('carpeta_lista es un PATCH vacío sobre la propia carpeta (no cambia nada)', lista.acciones[0].metodo === 'PATCH' && lista.acciones[0].url === `${API}/${VIAJES}?supportsAllDrives=true` && JSON.stringify(lista.acciones[0].cuerpo) === '{}');
    afirmar('"fotos/viajes" y "Fotos/Viajes" son la misma carpeta', planC([C(1, 'fotos/viajes')]).acciones[0].carpeta_id === VIAJES);

    const invalida = planC([C(1, 'a/../b'), C(2, 'Fotos')]);
    afirmar('una ruta no válida se anota como fallo y no impide las demás', invalida.acciones.length === 1 && invalida.acciones[0].carpeta_id === FOTOS && invalida.fallos.length === 1 && invalida.fallos[0].includes('no válida'));
    afirmar('con cuatro niveles también es no válida', planC([C(1, 'a/b/c/d')]).fallos.length === 1);

    // Mezcla con un archivo que necesita la misma carpeta: se crea una sola vez y las respuestas siguen alineadas
    const mezcla = comun.planificarAcciones({ archivos: [archivo(1, null, { carpeta_destino: 'Oficina' })], carpetas: [C(1, 'Oficina')], padres: [ok([ENTRADA])], raizId: RAIZ, niveles: niveles() });
    afirmar('un archivo y una carpeta pedida que necesitan la misma carpeta nueva la crean una sola vez', mezcla.acciones.length === 1 && mezcla.acciones[0].tipo === 'crear_carpeta');
    const mezcla2 = comun.planificarAcciones({ archivos: [archivo(1, null, { carpeta_destino: 'Fotos' })], carpetas: [C(1, 'Fotos/Viajes')], padres: [ok([ENTRADA])], raizId: RAIZ, niveles: niveles() });
    afirmar('mover un archivo y dar por lista una carpeta en la misma pasada: primero el archivo', mezcla2.acciones.length === 2 && mezcla2.acciones[0].tipo === 'mover' && mezcla2.acciones[1].tipo === 'carpeta_lista');
    afirmar('sin carpetas el comportamiento de siempre no cambia', comun.planificarAcciones({ archivos: [A_PEDIDA], padres: [ok([ENTRADA])], raizId: RAIZ, niveles: niveles() }).acciones[0].tipo === 'mover');
  }

  console.log('Planificar: renombrar');
  {
    const plan = (archivos, padres) => comun.planificarAcciones({ archivos, padres, raizId: RAIZ, niveles: niveles() });
    const nuevo = '2026-10-12 1830 · Factura de la luz.jpg';

    const r = plan([archivo(1, { tipo: 'nota' }, { nombre: nuevo })], [ok([ENTRADA], { name: '2026-10-12 1830 · WhatsApp.jpg' })]);
    afirmar('mover y renombrar en la misma petición', r.acciones[0].tipo === 'mover' && JSON.stringify(r.acciones[0].cuerpo) === JSON.stringify({ name: nuevo }), JSON.stringify(r.acciones[0]));
    const igual = plan([archivo(1, { tipo: 'nota' }, { nombre: nuevo })], [ok([ENTRADA], { name: nuevo })]);
    afirmar('si el nombre ya coincide no se renombra', JSON.stringify(igual.acciones[0].cuerpo) === '{}');

    const solo = plan([archivo(4, null, { nombre: nuevo })], [ok([ENTRADA], { name: 'foto.jpg' })]);
    afirmar('sin item ni carpeta, un cambio de nombre se hace en el sitio', solo.acciones.length === 1 && solo.acciones[0].tipo === 'renombrar' && solo.acciones[0].url === `${API}/F4?supportsAllDrives=true` && JSON.stringify(solo.acciones[0].cuerpo) === JSON.stringify({ name: nuevo }) && solo.acciones[0].carpeta_id === null);
    const sinCambio = plan([archivo(4, null, { nombre: 'foto.jpg' })], [ok([ENTRADA], { name: 'foto.jpg' })]);
    afirmar('sin item, carpeta ni cambio de nombre solo se limpia', sinCambio.acciones[0].tipo === 'limpiar');

    const sucio = plan([archivo(4, null, { nombre: 'a/b:c.jpg' })], [ok([ENTRADA], { name: 'otro.jpg' })]);
    afirmar('el nombre nuevo se limpia de caracteres no válidos', sucio.acciones[0].cuerpo.name === 'a_b_c.jpg');
    const vacio = plan([archivo(4, null, { nombre: '  ' })], [ok([ENTRADA], { name: 'otro.jpg' })]);
    afirmar('un nombre vacío no renombra', vacio.acciones[0].tipo === 'limpiar');
    const sinNombreEnDrive = plan([archivo(4, null, { nombre: 'x.jpg' })], [ok([ENTRADA])]);
    afirmar('si Drive no devuelve el nombre actual, no se toca', sinNombreEnDrive.acciones[0].tipo === 'limpiar');
    const conCarpeta = plan([archivo(1, null, { carpeta_destino: 'Fotos', nombre: nuevo })], [ok([ENTRADA], { name: 'x.jpg' })]);
    afirmar('carpeta pedida y nuevo nombre: mueve y renombra', conCarpeta.acciones[0].carpeta_id === FOTOS && conCarpeta.acciones[0].cuerpo.name === nuevo);
  }

  console.log('Nodo "Preparar"');
  {
    // Los archivos vienen de "Leer pendientes" y las carpetas pedidas, de "Leer carpetas pendientes" (los dos por su nombre: entre medias están el turno)
    const prep = (archivosFilas, carpetasFilas = [{}]) => correr(nodo('preparar.js'), { input: [{ turno: true }], nodos: { 'Leer pendientes': archivosFilas, 'Leer carpetas pendientes': carpetasFilas } });
    afirmar('sin pendientes (item vacío) devuelve cero items y el flujo termina', (await prep([{}])).length === 0);
    afirmar('sin ningún item también', (await prep([], [])).length === 0);
    const dos = await prep([A_PEDIDA, A_NOTA]);
    afirmar('un item por archivo, con el archivo dentro', dos.length === 2 && dos[0].archivo.id === A_PEDIDA.id);
    afirmar('descarta filas sin drive_file_id', (await prep([{ ...A_PEDIDA, drive_file_id: '' }, A_NOTA])).length === 1);
    afirmar('descarta un error de PostgREST', (await prep([{ code: 'PGRST', message: 'x' }], [{ code: 'PGRST', message: 'x' }])).length === 0);
    const CARPETA = { id: 'cccccccc-0000-4000-8000-000000000001', ruta: 'Trabajo/Proyectos', updated_at: '2026-10-12T10:00:00.123456+00:00' };
    const soloCarpeta = await prep([{}], [CARPETA]);
    afirmar('una carpeta pedida sin archivos pendientes también sigue adelante (antes el flujo terminaba)', soloCarpeta.length === 1 && soloCarpeta[0].carpeta.ruta === 'Trabajo/Proyectos' && soloCarpeta[0].archivo === undefined);
    const mixto = await prep([A_PEDIDA], [CARPETA]);
    afirmar('los archivos van antes que las carpetas (el orden de Leer padres)', mixto.length === 2 && mixto[0].archivo && mixto[1].carpeta);
    afirmar('descarta carpetas sin ruta o sin id', (await prep([{}], [{ id: CARPETA.id, ruta: '' }, { ruta: 'x' }])).length === 0);

    // «Hay trabajo»: un solo item si hay algo pendiente (para pedir el turno una vez), ninguno si no
    const hay = (archivosFilas, carpetasFilas = [{}]) => correr(construirFlujo().nodes.find((x) => x.name === 'Hay trabajo').parameters.jsCode, { input: [{}], nodos: { 'Leer pendientes': archivosFilas, 'Leer carpetas pendientes': carpetasFilas } });
    afirmar('Hay trabajo: sin nada pendiente, cero items (el flujo acaba sin pedir el turno)', (await hay([{}])).length === 0 && (await hay([], [])).length === 0);
    afirmar('Hay trabajo: con varios archivos y una carpeta pedida, un solo item', (await hay([A_NOTA, A_NOTA], [CARPETA])).length === 1 && (await hay([{}], [CARPETA])).length === 1);
  }

  console.log('Nodo "Planificar"');
  {
    const nodos = (extra = {}) => ({
      Configuración: [{ config: CONFIG }],
      Preparar: [{ archivo: A_PEDIDA }, { archivo: A_NUEVA }],
      'Leer padres': [ok([ENTRADA]), ok([ENTRADA])],
      'Listar nivel 1': [lista(NIVEL1)],
      'Listar nivel 2': [lista(NIVEL2)],
      'Listar nivel 3': [lista([])],
      ...extra,
    });
    const codigo = nodo('planificar.js', true);
    const s = await correr(codigo, { nodos: nodos() });
    afirmar('emite una acción por item, mover y crear', s.length === 2 && s[0].tipo === 'mover' && s[1].tipo === 'crear_carpeta');
    await lanza('si no se pueden listar las carpetas es un error', correr(codigo, { nodos: nodos({ 'Listar nivel 2': [{ statusCode: 404, body: {} }] }) }), 'no se pudieron listar');
    await lanza('si Drive devuelve más de una página es un error (no duplica carpetas)', correr(codigo, { nodos: nodos({ 'Listar nivel 1': [lista(NIVEL1, { nextPageToken: 't' })] }) }), 'más de una página');
    await lanza('si no se puede leer ningún padre es un error', correr(codigo, { nodos: nodos({ 'Leer padres': [{ statusCode: 401, body: {} }, { statusCode: 401, body: {} }] }) }), '2 fallo(s)');
    const parcial = await correr(codigo, { nodos: nodos({ 'Leer padres': [{ statusCode: 500, body: {} }, ok([ENTRADA])] }) });
    afirmar('un fallo parcial no impide el resto', parcial.length === 1 && parcial[0].tipo === 'crear_carpeta');
    const pedida = await correr(codigo, { nodos: nodos({ Preparar: [{ archivo: archivo(1, null, { carpeta_destino: 'Fotos/Viajes' }) }], 'Leer padres': [ok([ENTRADA])] }) });
    afirmar('el nodo respeta la carpeta pedida', pedida.length === 1 && pedida[0].carpeta_id === VIAJES);

    // Carpetas pedidas: llegan por "Preparar" (después de los archivos); "Leer padres" tiene una respuesta por elemento
    const CP = { id: 'cccccccc-0000-4000-8000-000000000001', ruta: 'Fotos/Viajes', updated_at: '2026-10-12T10:00:00.123456+00:00' };
    const soloCarpeta = await correr(codigo, { nodos: nodos({ Preparar: [{ carpeta: CP }], 'Leer padres': [{ statusCode: 200, body: { id: RAIZ } }] }) });
    afirmar('el nodo planifica una carpeta pedida sin ningún archivo', soloCarpeta.length === 1 && soloCarpeta[0].tipo === 'carpeta_lista' && soloCarpeta[0].carpeta_id === VIAJES);
    const conArchivo = await correr(codigo, { nodos: nodos({ Preparar: [{ archivo: A_PEDIDA }, { carpeta: CP }], 'Leer padres': [ok([ENTRADA]), { statusCode: 200, body: { id: RAIZ } }] }) });
    afirmar('con archivo y carpeta, la respuesta de Leer padres del archivo es la suya', conArchivo.length === 2 && conArchivo[0].tipo === 'mover' && conArchivo[0].carpeta_id === AP && conArchivo[1].tipo === 'carpeta_lista');
    await lanza('una sola carpeta con ruta no válida y nada más que hacer es un error visible', correr(codigo, { nodos: nodos({ Preparar: [{ carpeta: { ...CP, ruta: '../x' } }], 'Leer padres': [{ statusCode: 200, body: {} }] }) }), '1 fallo(s)');
  }

  console.log('Nodo "Registrar"');
  {
    const codigo = nodo('registrar.js');
    const accionMover = { tipo: 'mover', etiqueta: 'mover x', archivo_id: A_PEDIDA.id, updated_at: A_PEDIDA.updated_at, carpeta_id: AP };
    const accionLimpiar = { tipo: 'limpiar', etiqueta: 'limpiar y', archivo_id: A_SIN_ITEM.id, updated_at: A_SIN_ITEM.updated_at, carpeta_id: null };
    const accionRenombrar = { tipo: 'renombrar', etiqueta: 'renombrar w', archivo_id: A_NOTA.id, updated_at: A_NOTA.updated_at, carpeta_id: null };
    const accionCrear = { tipo: 'crear_carpeta', etiqueta: 'crear z' };
    const nodos = (acciones) => ({ Configuración: [{ config: CONFIG }], Planificar: acciones });

    const e = await correr(codigo, { input: [{ statusCode: 200, body: { id: 'F1' } }], nodos: nodos([accionMover]) });
    afirmar('mover bien: limpia la marca y guarda la carpeta', e.length === 1 && e[0].metodo === 'PATCH' && JSON.stringify(e[0].cuerpo) === JSON.stringify({ drive_pendiente: false, carpeta_id: AP }));
    afirmar('la escritura lleva la condición sobre updated_at', e[0].url === `${BASE}/archivos?id=eq.${A_PEDIDA.id}&updated_at=eq.${encodeURIComponent(A_PEDIDA.updated_at)}`, e[0].url);
    afirmar('y no devuelve filas', e[0].prefer === 'return=minimal');

    const l = await correr(codigo, { input: [{ statusCode: 200, body: {} }], nodos: nodos([accionLimpiar]) });
    afirmar('limpiar no toca carpeta_id', JSON.stringify(l[0].cuerpo) === '{"drive_pendiente":false}');
    const rn = await correr(codigo, { input: [{ statusCode: 200, body: {} }], nodos: nodos([accionRenombrar]) });
    afirmar('renombrar tampoco toca carpeta_id: solo limpia la marca', JSON.stringify(rn[0].cuerpo) === '{"drive_pendiente":false}');

    const c = await correr(codigo, { input: [{ statusCode: 200, body: { id: 'nueva' } }], nodos: nodos([accionCrear]) });
    afirmar('crear una carpeta no anota nada: solo una escritura que no toca ninguna fila (así se suelta el turno)', c.length === 1 && c[0].etiqueta === 'nada que anotar' && c[0].url === `${BASE}/carpetas_pedidas?id=eq.00000000-0000-0000-0000-000000000000` && c[0].metodo === 'PATCH');

    const crearConCuerpo = { tipo: 'crear_carpeta', etiqueta: 'crear Trabajo', cuerpo: { name: 'Trabajo', parents: [RAIZ] } };
    const cc = await correr(codigo, { input: [{ statusCode: 200, body: { id: 'id-nueva-12345' } }], nodos: nodos([crearConCuerpo]) });
    afirmar('crear una carpeta la anota en carpetas_creadas (base de datos 1.5) con su id, su padre y su nombre', cc.length === 1 && cc[0].metodo === 'POST' && cc[0].url === `${BASE}/carpetas_creadas?on_conflict=drive_id` && JSON.stringify(cc[0].cuerpo) === JSON.stringify({ drive_id: 'id-nueva-12345', padre_id: RAIZ, nombre: 'Trabajo' }) && cc[0].prefer === 'resolution=merge-duplicates,return=minimal', JSON.stringify(cc));
    const mezcla = await correr(codigo, { input: [{ statusCode: 200, body: {} }, { statusCode: 500, body: 'x' }], nodos: nodos([accionMover, accionLimpiar]) });
    afirmar('un fallo aislado no impide anotar lo que sí se hizo', mezcla.length === 1 && mezcla[0].etiqueta === 'mover x');
    await lanza('si no se hace nada es un error', correr(codigo, { input: [{ statusCode: 403, body: { error: 'x' } }], nodos: nodos([accionMover]) }), 'nada hecho');
    const soloCrear = await correr(codigo, { input: [{ statusCode: 200, body: {} }, { statusCode: 500, body: 'x' }], nodos: nodos([accionCrear, accionMover]) });
    afirmar('crear una carpeta cuenta como algo hecho (no lanza error)', soloCrear.length === 1 && soloCrear[0].etiqueta === 'nada que anotar');
    const red = await correr(codigo, { input: [{ statusCode: 200, body: {} }, { error: { message: 'ECONNRESET' } }], nodos: nodos([accionLimpiar, accionMover]) });
    afirmar('un error de red se trata como fallo', red.length === 1);

    // Carpeta pedida lista: se limpia su marca en carpetas_pedidas, con la condición sobre updated_at
    const accionCarpeta = { tipo: 'carpeta_lista', etiqueta: 'carpeta Fotos/Viajes lista', carpeta_pedida_id: 'cccccccc-0000-4000-8000-000000000001', updated_at: '2026-10-12T10:00:00.123456+00:00', carpeta_id: VIAJES };
    const cl = await correr(codigo, { input: [{ statusCode: 200, body: { id: VIAJES } }], nodos: nodos([accionCarpeta]) });
    afirmar('carpeta lista: limpia la marca y guarda el id de la carpeta', cl.length === 1 && cl[0].metodo === 'PATCH' && JSON.stringify(cl[0].cuerpo) === JSON.stringify({ drive_pendiente: false, carpeta_id: VIAJES }));
    afirmar('la escritura va a carpetas_pedidas con la condición sobre updated_at y sin devolver filas', cl[0].url === `${BASE}/carpetas_pedidas?id=eq.cccccccc-0000-4000-8000-000000000001&updated_at=eq.${encodeURIComponent('2026-10-12T10:00:00.123456+00:00')}` && cl[0].prefer === 'return=minimal', cl[0].url);
    const clFalla = await correr(codigo, { input: [{ statusCode: 200, body: {} }, { statusCode: 403, body: 'x' }], nodos: nodos([accionMover, accionCarpeta]) });
    afirmar('si Drive rechaza el PATCH de la carpeta, no se limpia su marca (se reintenta al minuto)', clFalla.length === 1 && clFalla[0].etiqueta === 'mover x');
    await lanza('si lo único que había era una carpeta y falla, es un error visible', correr(codigo, { input: [{ statusCode: 500, body: 'x' }], nodos: nodos([accionCarpeta]) }), 'nada hecho');
  }

  console.log('Estructura del flujo');
  {
    const flujo = construirFlujo();
    const por = (n) => flujo.nodes.find((x) => x.name === n);
    const trabajo = flujo.nodes.filter((x) => x.type !== 'n8n-nodes-base.stickyNote');
    afirmar('25 nodos de trabajo', trabajo.length === 25, String(trabajo.length));
    afirmar('nombres de nodo únicos', new Set(flujo.nodes.map((x) => x.name)).size === flujo.nodes.length);
    afirmar('ids de nodo únicos', new Set(flujo.nodes.map((x) => x.id)).size === flujo.nodes.length);
    afirmar('zona Europe/Madrid', flujo.settings.timezone === 'Europe/Madrid');
    afirmar('todas las conexiones apuntan a nodos que existen', Object.entries(flujo.connections).every(([origen, c]) => por(origen) && c.main.flat().every((d) => por(d.node))));
    const cadena = ['Configuración', 'Leer pendientes', 'Leer carpetas pendientes', 'Hay trabajo', 'Tomar turno', '¿Tengo turno?', 'Preparar', 'Leer padres', 'Listar nivel 1', 'Listar nivel 2', 'Listar nivel 3', 'Leer carpetas creadas', 'Planificar', 'Google Drive', 'Registrar', 'Escribir en Supabase', 'Soltar turno'];
    afirmar('la cadena de nodos está completa y en orden', cadena.slice(0, -1).every((n, i) => flujo.connections[n]?.main[0][0].node === cadena[i + 1]));
    {
      // Vaciar carpetas (base de datos 1.5)
      const vac = ['Leer carpetas por vaciar', 'Preparar vaciado', 'Mirar si está vacía', 'Decidir vaciado', 'Vaciar en Drive', 'Anotar vaciado'];
      afirmar('Configuración arranca las dos ramas: la de siempre y la de vaciar carpetas', flujo.connections['Configuración'].main[0].map((x) => x.node).join() === 'Leer pendientes,Leer carpetas por vaciar');
      afirmar('la rama de vaciar está completa y en orden', vac.slice(0, -1).every((n, i) => flujo.connections[n]?.main[0][0].node === vac[i + 1]));
      const lcc = por('Leer carpetas creadas');
      afirmar('Leer carpetas creadas: una vez, siempre con salida y sin cortar el flujo (sin actualizar la base de datos a la 1.5 falla)', lcc.executeOnce === true && lcc.alwaysOutputData === true && lcc.onError === 'continueRegularOutput' && lcc.parameters.url.includes('/rest/v1/carpetas_creadas?select=drive_id,padre_id,nombre&creada_at=gte.'));
      const prep = (filas) => correr(nodo('preparar-vaciado.js'), { input: filas });
      const F = (ruta, extra = {}) => ({ id: 'aaaaaaaa-0000-4000-8000-000000000001', carpeta_id: 'carpeta-vaciar-01', ruta, ...extra });
      afirmar('Preparar vaciado: una carpeta normal pasa', (await prep([F('Budapest')])).length === 1);
      for (const r of ['Entrada', 'notas', '']) afirmar(`Preparar vaciado: «${r}» NUNCA se vacía (tercera barrera)`, (await prep([F(r)])).length === 0);
      afirmar('Preparar vaciado: sin actualizar la base de datos a la 1.5 (un error) o con ids raros, nada', (await prep([{ error: { message: 'x' } }, F('X', { carpeta_id: "a' or 1=1" }), F('X', { id: 'no' })])).length === 0);
      const decidir = (listados, preps = [{ vaciar: F('Budapest').valueOf() }]) => correr(nodo('decidir-vaciado.js'), { input: listados, nodos: { 'Preparar vaciado': preps.map((x) => (x.vaciar ? x : { vaciar: x })) } });
      afirmar('Decidir vaciado: vacía en Drive → a la papelera', (await decidir([{ statusCode: 200, body: { files: [] } }])).length === 1);
      afirmar('Decidir vaciado: con algo dentro (también lo subido a mano), se deja', (await decidir([{ statusCode: 200, body: { files: [{ id: 'f' }] } }])).length === 0);
      afirmar('Decidir vaciado: si Drive falla o no existe, no se toca (se reintenta)', (await decidir([{ statusCode: 404, body: {} }])).length === 0 && (await decidir([{ error: { message: 'red' } }])).length === 0);
      const ev = (expr, json, previos = {}) => new Function('$json', '$', `return (${expr.trim().slice(3, -2)});`)(json, (n) => ({ item: { json: previos[n] }, first: () => ({ json: n === 'Configuración' ? { config: CONFIG } : previos[n] }) }));
      const mirar = ev(por('Mirar si está vacía').parameters.url, { vaciar: { carpeta_id: 'C1aaaaaaaa' } });
      afirmar('Mirar si está vacía: lista los hijos de esa carpeta (archivos y carpetas, sin papelera), uno basta', decodeURIComponent(mirar) === "https://www.googleapis.com/drive/v3/files?pageSize=1&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=nextPageToken,files(id)&q='C1aaaaaaaa' in parents and trashed = false", mirar);
      afirmar('Vaciar en Drive: PATCH trashed true (va a la papelera, se recupera)', ev(por('Vaciar en Drive').parameters.url, { vaciar: { carpeta_id: 'C1aaaaaaaa' } }) === 'https://www.googleapis.com/drive/v3/files/C1aaaaaaaa?supportsAllDrives=true' && ev(por('Vaciar en Drive').parameters.jsonBody, {}) === '{"trashed":true}' && por('Vaciar en Drive').parameters.method === 'PATCH');
      const anot = (json) => JSON.parse(ev(por('Anotar vaciado').parameters.jsonBody, json, { 'Decidir vaciado': { vaciar: { id: 'id-fila' } } }));
      afirmar('Anotar vaciado: si Drive la mandó a la papelera, se anota; si no, un id que no existe (no anota y se reintenta)', anot({ statusCode: 200 }).p_id === 'id-fila' && anot({ statusCode: 403 }).p_id === '00000000-0000-0000-0000-000000000000' && anot({ error: {} }).p_id === '00000000-0000-0000-0000-000000000000');
      for (const n of ['Mirar si está vacía', 'Vaciar en Drive']) afirmar(`"${n}" usa la credencial de Google Drive y no corta el flujo`, por(n).parameters.nodeCredentialType === 'googleDriveOAuth2Api' && por(n).onError === 'continueRegularOutput');
      for (const n of ['Leer carpetas por vaciar', 'Anotar vaciado', 'Leer carpetas creadas']) afirmar(`"${n}" usa la credencial de Supabase`, por(n).parameters.nodeCredentialType === 'supabaseApi');
    }
    afirmar('los dos disparadores van a Configuración', flujo.connections['Programación'].main[0][0].node === 'Configuración' && flujo.connections['Disparador manual'].main[0][0].node === 'Configuración');
    afirmar('se ejecuta cada 10 segundos', por('Programación').parameters.rule.interval[0].field === 'seconds' && por('Programación').parameters.rule.interval[0].secondsInterval === 10);
    afirmar('no guarda las ejecuciones que salen bien (sí las que fallan)', flujo.settings.saveDataSuccessExecution === 'none' && flujo.settings.saveDataErrorExecution === 'all');
    afirmar('¿Tengo turno? solo deja seguir por «sí»: sin turno, el flujo acaba', flujo.connections['¿Tengo turno?'].main.length === 1 || flujo.connections['¿Tengo turno?'].main[1]?.length === 0 || flujo.connections['¿Tengo turno?'].main[1] === undefined);
    {
      const ev = (expr, json, previos = {}) => new Function('$json', '$', `return (${expr.trim().slice(3, -2)});`)(json, (n) => ({ first: () => ({ json: n === 'Configuración' ? { config: { ...CONFIG, turno_s: 60 } } : previos[n] }) }));
      const tomar = por('Tomar turno');
      afirmar('Tomar turno: RPC tomar_turno con el nombre del turno y su duración, una sola vez y SIN tragarse el error (sin actualizar la base de datos a la 1.5, la ejecución sale en rojo)', tomar.parameters.url.endsWith('/rest/v1/rpc/tomar_turno') && JSON.stringify(JSON.parse(ev(tomar.parameters.jsonBody, {}))) === JSON.stringify({ p_nombre: 'sincronizar_drive', p_segundos: 60 }) && tomar.executeOnce === true && tomar.onError === undefined && tomar.parameters.nodeCredentialType === 'supabaseApi');
      const cond = por('¿Tengo turno?').parameters.conditions.conditions[0].leftValue;
      afirmar('¿Tengo turno?: sí solo con turno: true', ev(cond, { turno: true, token: 'x' }) === 'si' && ev(cond, { turno: false }) === 'no' && ev(cond, {}) === 'no' && ev(cond, { turno: 'true' }) === 'no');
      const soltar = por('Soltar turno');
      afirmar('Soltar turno: RPC soltar_turno con el token de «Tomar turno», una sola vez y sin cortar el flujo', soltar.parameters.url.endsWith('/rest/v1/rpc/soltar_turno') && JSON.stringify(JSON.parse(ev(soltar.parameters.jsonBody, {}, { 'Tomar turno': { turno: true, token: 'tok-1' } }))) === JSON.stringify({ p_nombre: 'sincronizar_drive', p_token: 'tok-1' }) && soltar.executeOnce === true && soltar.onError === 'continueRegularOutput');
    }
    for (const n of ['Leer padres', 'Listar nivel 1', 'Listar nivel 2', 'Listar nivel 3', 'Google Drive']) {
      afirmar(`"${n}" usa la credencial de Google Drive`, por(n).parameters.nodeCredentialType === 'googleDriveOAuth2Api');
      afirmar(`"${n}" devuelve la respuesta completa sin fallar ante HTTP`, por(n).parameters.options.response.response.fullResponse === true && por(n).parameters.options.response.response.neverError === true);
    }
    afirmar('los tres listados se ejecutan una sola vez', ['Listar nivel 1', 'Listar nivel 2', 'Listar nivel 3'].every((n) => por(n).executeOnce === true));
    afirmar('"Leer padres" se ejecuta una vez por archivo y pide también el nombre', !por('Leer padres').executeOnce && por('Leer padres').parameters.url.includes('fields=id,name,parents,trashed'));
    afirmar('"Leer pendientes" siempre produce salida', por('Leer pendientes').alwaysOutputData === true);
    const lcp = por('Leer carpetas pendientes');
    afirmar('"Leer carpetas pendientes": Execute Once (cuelga de «Leer pendientes», que da un item por archivo: sin esto cada carpeta salía repetida)', lcp.executeOnce === true);
    afirmar('"Leer carpetas pendientes": GET a carpetas_pedidas, solo las pendientes, con credencial de Supabase y siempre con salida', lcp.parameters.method === 'GET' && lcp.parameters.url.includes('/rest/v1/carpetas_pedidas?select=id,ruta,updated_at&drive_pendiente=eq.true&eliminada_at=is.null&order=updated_at.asc&limit=') && lcp.parameters.nodeCredentialType === 'supabaseApi' && lcp.alwaysOutputData === true && lcp.onError === undefined, lcp.parameters.url);
    // La URL de "Leer padres", evaluada como lo hará n8n, para un archivo y para una carpeta pedida
    {
      const expr = por('Leer padres').parameters.url.replace(/^=\{\{\s*/, '').replace(/\s*\}\}$/, '');
      const dolar = (n) => ({ first: () => ({ json: { config: { carpeta_raiz_id: RAIZ } } }) });
      const evaluarPadres = (json) => new Function('$', '$json', 'encodeURIComponent', `return ${expr}`)(dolar, json, encodeURIComponent);
      afirmar('"Leer padres" de un archivo: sus padres, nombre y papelera', evaluarPadres({ archivo: { drive_file_id: 'F1' } }) === 'https://www.googleapis.com/drive/v3/files/F1?fields=id,name,parents,trashed&supportsAllDrives=true', evaluarPadres({ archivo: { drive_file_id: 'F1' } }));
      afirmar('"Leer padres" de una carpeta pedida: una petición inocua sobre la raíz', evaluarPadres({ carpeta: { id: 'x', ruta: 'a' } }) === `https://www.googleapis.com/drive/v3/files/${RAIZ}?fields=id&supportsAllDrives=true`, evaluarPadres({ carpeta: { id: 'x', ruta: 'a' } }));
    }
    afirmar('el nodo de Drive toma método, URL y cuerpo de la acción', por('Google Drive').parameters.method === '={{ $json.metodo }}' && por('Google Drive').parameters.url === '={{ $json.url }}' && por('Google Drive').parameters.sendBody === true);
    afirmar('Supabase usa la credencial predefinida', por('Leer pendientes').parameters.nodeCredentialType === 'supabaseApi' && por('Escribir en Supabase').parameters.nodeCredentialType === 'supabaseApi');
    afirmar('el SELECT embebe el item y trae la carpeta pedida', por('Leer pendientes').parameters.url.includes('items(tipo)') && por('Leer pendientes').parameters.url.includes('carpeta_destino') && por('Leer pendientes').parameters.url.includes('drive_pendiente=eq.true'));
    afirmar('Escribir en Supabase y Google Drive no abortan el flujo ante un fallo', por('Escribir en Supabase').onError === 'continueRegularOutput' && por('Google Drive').onError === 'continueRegularOutput');
    afirmar('ningún nodo contiene una clave', !/sb_secret_|AIza|ya29\./.test(JSON.stringify(flujo)));

    // La expresión de cada listado, evaluada como lo hará n8n, pide lo mismo que consultaNivel y la API de Drive
    const evaluar = (nodoNombre, previos) => {
      const expr = por(nodoNombre).parameters.url.replace(/^=\{\{\s*/, '').replace(/\s*\}\}$/, '');
      const $ = (n) => ({ first: () => ({ json: previos[n] }) });
      const c = { carpeta_raiz_id: RAIZ };
      const $config = c;
      // La expresión usa $('Configuración').first().json.config; se sirve ese nodo con el mismo $
      const dolar = (n) => (n === 'Configuración' ? { first: () => ({ json: { config: $config } }) } : $(n));
      return new Function('$', 'encodeURIComponent', `return ${expr}`)(dolar, encodeURIComponent);
    };
    const url1 = evaluar('Listar nivel 1', {});
    const q1 = decodeURIComponent(url1.split('&q=')[1]);
    afirmar('nivel 1: pregunta por las hijas de la raíz con la misma consulta que consultaNivel', q1 === comun.consultaNivel([RAIZ]) && url1.startsWith('https://www.googleapis.com/drive/v3/files?pageSize=1000&supportsAllDrives=true&fields='), url1);
    afirmar('nivel 1: pide nextPageToken y los padres', decodeURIComponent(url1.split('&fields=')[1].split('&q=')[0]) === 'nextPageToken,files(id,name,parents)');
    const q2 = decodeURIComponent(evaluar('Listar nivel 2', { 'Listar nivel 1': { body: { files: NIVEL1 } } }).split('&q=')[1]);
    afirmar('nivel 2: pregunta por las hijas de todas las carpetas del nivel 1', q2 === comun.consultaNivel(NIVEL1.map((f) => f.id)), q2);
    const q3vacio = decodeURIComponent(evaluar('Listar nivel 3', { 'Listar nivel 2': { body: { files: [] } } }).split('&q=')[1]);
    afirmar('nivel 3 sin carpetas arriba: una consulta que no devuelve nada', q3vacio === comun.consultaNivel([], RAIZ) && !q3vacio.includes('sin-padre'), q3vacio);
    const q3roto = decodeURIComponent(evaluar('Listar nivel 3', { 'Listar nivel 2': { statusCode: 500, body: 'error' } }).split('&q=')[1]);
    afirmar('nivel 3 tras un fallo del nivel 2: tampoco rompe (Planificar lo detecta)', q3roto === comun.consultaNivel([], RAIZ), q3roto);

    const enDisco = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'flujos', 'sincronizar-drive.json'), 'utf8'));
    afirmar('flujos/sincronizar-drive.json está al día con las fuentes', JSON.stringify(enDisco) === JSON.stringify(flujo), 'ejecuta: node herramientas/generar-drive.js');
  }

  console.log(`\n${pasan} comprobaciones correctas, ${fallan.length} fallan.`);
  if (fallan.length > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
