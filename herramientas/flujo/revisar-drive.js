// Nodo "Revisar Drive": borrar carpetas y archivos de Drive con confirmación.
// Corre en la rama de carpetas, después de leer el árbol de Secretaria/ (Listar nivel 1, 2 y 3) y los archivos registrados (Contar archivos).
//
//   - Al PEDIR el borrado (meta.borrar_drive): busca la carpeta o los archivos y devuelve UN item { propuesta } con lo que se mandaría a la
//     papelera (y lo que cuelga de cada carpeta). No toca nada: «Resultado» lo enseña y deja la pregunta abierta.
//   - Al CONFIRMAR (meta.papelera, los ids que se enseñaron): vuelve a comprobar cada id con el árbol y los archivos de AHORA. Solo pasa
//     una carpeta que cuelgue de Secretaria (hasta 3 niveles) y no sea Entrada ni Notas, y un archivo que esté registrado. Devuelve
//     un item { papelera } por cada cosa que sí se puede mandar (el nodo siguiente las manda una a una) o, si no queda ninguna, un item
//     { nada: true }. Los rechazados viajan en cada item para que «Resultado» los cuente.
//   - Al MOVER carpetas dentro de otra (meta.mover_carpeta): busca las carpetas y la de destino en el árbol real y decide. Devuelve UN item
//     { mover_plan } con la carpeta de destino que haya que crear antes (si se pidió y no existe), los movimientos que sí se pueden hacer (ids, rutas y
//     cuántas cosas viajan) y, por cada carpeta que no se puede mover, su motivo (no existe, es ambigua, Entrada/Notas, dentro de sí misma, ya está ahí,
//     ya hay otra con ese nombre, quedaría a más de 3 niveles). No toca nada.
//   - Con cualquier otra intención (la lista de carpetas): un item vacío.
// Si el árbol no se puede leer entero, no se manda nada (con el árbol incompleto no se sabe qué cuelga de qué).

const NIVELES = 3;
const PROTEGIDAS = ['entrada', 'notas']; // las usa la secretaria para ordenar: se puede borrar lo de dentro, no la carpeta
const MAX_PAPELERA = 50;
const clave = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

// Las carpetas bajo la raíz, con su ruta y su nivel. Cada nivel cuelga del anterior: lo que no cuelga de algo ya visto se ignora.
function leerArbol(niveles, raizId) {
  const porId = new Map([[raizId, { id: raizId, ruta: '', nivel: 0 }]]);
  const carpetas = [];
  for (let i = 0; i < NIVELES; i++) {
    const r = niveles[i];
    if (!r || !(r.statusCode >= 200 && r.statusCode < 300) || !Array.isArray(r.body?.files)) return { error: `No se pudo leer el nivel ${i + 1} de carpetas de Drive` };
    if (r.body.nextPageToken) return { error: `Drive devolvió más de una página de carpetas en el nivel ${i + 1}` };
    for (const f of r.body.files) {
      if (!f || typeof f.id !== 'string' || porId.has(f.id)) continue;
      const padre = (Array.isArray(f.parents) ? f.parents : []).map((p) => porId.get(p)).find((p) => p && p.nivel === i);
      if (!padre) continue;
      const nombre = String(f.name ?? '');
      const c = { id: f.id, nombre, padre: padre.id, nivel: i + 1, ruta: padre.ruta ? `${padre.ruta}/${nombre}` : nombre };
      porId.set(f.id, c);
      carpetas.push(c);
    }
  }
  return { carpetas, porId };
}

const esProtegida = (c) => c.nivel === 1 && PROTEGIDAS.includes(clave(c.nombre));
// Las carpetas que cuelgan de c (sus hijas, las hijas de esas…), por el padre y no por la ruta (un nombre puede llevar «/»)
function descendientes(c, carpetas) {
  const dentro = new Set([c.id]);
  const lista = [];
  for (const d of carpetas) {
    if (dentro.has(d.padre)) {
      dentro.add(d.id);
      lista.push(d);
    }
  }
  return lista;
}

// Dónde está cada archivo registrado: su carpeta (si está en el árbol) o, si nunca se movió, Entrada
function conRuta(filas, arbol) {
  const entrada = arbol.carpetas.find((c) => c.nivel === 1 && clave(c.nombre) === 'entrada');
  return filas
    .filter((f) => f && typeof f.id === 'string' && typeof f.drive_file_id === 'string' && f.drive_file_id !== '')
    .map((f) => {
      const carpeta = typeof f.carpeta_id === 'string' && f.carpeta_id ? arbol.porId.get(f.carpeta_id) : f.estado === 'pendiente' ? entrada : null;
      const nombre = String(f.nombre ?? '');
      return { ...f, carpeta_arbol: carpeta?.id ?? null, ruta: carpeta?.ruta ? `${carpeta.ruta}/${nombre}` : nombre };
    });
}
const dentroDe = (archivos, ids) => archivos.filter((f) => f.carpeta_arbol && ids.has(f.carpeta_arbol));

// --- Proponer: qué se mandaría a la papelera ---
function proponer(pedido, arbol, archivos) {
  const objetivos = [];
  const propuesta = { objetivos, no_encontrada: null, ambiguas: null, protegida: null, vacia: null, sin_encontrar: 0, demasiados: 0 };
  let cubiertas = new Set();
  if (pedido.carpeta) {
    let candidatas = arbol.carpetas.filter((c) => clave(c.ruta) === clave(pedido.carpeta));
    // «borra la carpeta Viajes» cuando está en Fotos/Viajes: por el nombre, si solo dijo un nivel
    if (candidatas.length === 0 && !pedido.carpeta.includes('/')) candidatas = arbol.carpetas.filter((c) => clave(c.nombre) === clave(pedido.carpeta));
    if (candidatas.length === 0) propuesta.no_encontrada = pedido.carpeta;
    else if (candidatas.length > 1) propuesta.ambiguas = candidatas.map((c) => c.ruta).sort();
    else {
      const c = candidatas[0];
      const desc = descendientes(c, arbol.carpetas);
      const ids = new Set([c.id, ...desc.map((d) => d.id)]);
      const suyos = dentroDe(archivos, ids);
      if (pedido.solo_archivos) {
        if (suyos.length === 0) propuesta.vacia = c.ruta;
        for (const f of suyos) objetivos.push({ tipo: 'archivo', id: f.drive_file_id, nombre: f.ruta });
      } else if (esProtegida(c)) {
        propuesta.protegida = c.ruta;
      } else {
        objetivos.push({ tipo: 'carpeta', id: c.id, nombre: c.ruta, subcarpetas: desc.map((d) => d.ruta), archivos: suyos.map((f) => f.ruta) });
        cubiertas = ids;
      }
    }
  }
  const porId = new Map(archivos.map((f) => [f.id, f]));
  for (const idArchivo of pedido.archivo_ids ?? []) {
    const f = porId.get(idArchivo);
    if (!f) propuesta.sin_encontrar += 1;
    else if (!(f.carpeta_arbol && cubiertas.has(f.carpeta_arbol)) && !objetivos.some((o) => o.id === f.drive_file_id)) objetivos.push({ tipo: 'archivo', id: f.drive_file_id, nombre: f.ruta });
  }
  if (objetivos.length > MAX_PAPELERA) {
    propuesta.demasiados = objetivos.length;
    objetivos.length = 0;
  }
  return propuesta;
}

// --- Comprobar lo confirmado, id a id, con lo que hay ahora ---
function comprobar(papelera, arbol, archivos) {
  const validos = [];
  const rechazados = [];
  const porDrive = new Map(archivos.map((f) => [f.drive_file_id, f]));
  for (const e of Array.isArray(papelera) ? papelera.slice(0, MAX_PAPELERA) : []) {
    const nombre = String(e?.nombre ?? '');
    if (e?.tipo === 'carpeta') {
      const c = arbol.porId.get(e.id);
      if (!c || c.nivel < 1) rechazados.push({ nombre, motivo: 'ya no está en Secretaria (o está a más de 3 niveles)' });
      else if (esProtegida(c)) rechazados.push({ nombre, motivo: 'es una carpeta que uso para ordenar' });
      else validos.push({ tipo: 'carpeta', id: c.id, nombre: c.ruta, descendientes: descendientes(c, arbol.carpetas).map((d) => d.id) });
    } else if (e?.tipo === 'archivo') {
      const f = porDrive.get(e.id);
      if (!f) rechazados.push({ nombre, motivo: 'ya no lo tengo registrado (puede que ya estuviera borrado)' });
      else validos.push({ tipo: 'archivo', id: f.drive_file_id, nombre: f.ruta, descendientes: [], carpeta: f.carpeta_arbol });
    }
  }
  // Un archivo que está dentro de una carpeta que también se borra ya va con ella
  const carpetasQueVan = new Set(validos.filter((v) => v.tipo === 'carpeta').flatMap((v) => [v.id, ...v.descendientes]));
  const finales = validos.filter((v) => v.tipo === 'carpeta' || !(v.carpeta && carpetasQueVan.has(v.carpeta))).map(({ carpeta, ...v }) => v);
  return { validos: finales, rechazados };
}

// --- Mover carpetas dentro de otra: qué hay que hacer, o por qué no se puede ---
// Una carpeta se busca por su ruta completa, por su nombre si solo hay una con él y, si no, por las palabras que lleva su nombre («el tren de hierro»
// encuentra «Viaje Tren de Hierro») siempre que solo encaje una. Con varias que encajan no elige: pide la ruta.
const RELLENO_NOMBRE = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'y']);
const palabrasDe = (s) => clave(s).split(/[^a-z0-9ñ]+/).filter(Boolean);
function buscarCarpeta(arbol, texto, parcial) {
  let c = arbol.carpetas.filter((x) => clave(x.ruta) === clave(texto));
  if (c.length === 0 && !texto.includes('/')) c = arbol.carpetas.filter((x) => clave(x.nombre) === clave(texto));
  if (c.length === 0 && parcial && !texto.includes('/')) {
    const q = palabrasDe(texto).filter((w) => !RELLENO_NOMBRE.has(w));
    if (q.length > 0) c = arbol.carpetas.filter((x) => { const n = new Set(palabrasDe(x.nombre)); return q.every((w) => n.has(w)); });
  }
  return c;
}
// ¿Se parecen dos nombres de carpeta? Uno tiene todas las palabras del otro («viaje Tren de Hierro» y «Tren de Hierro») sin contar artículos ni
// «carpeta». Es la misma regla que nombresParecidos de planificar.js (sin las erratas: aquí basta con lo seguro).
const VACIAS_NOMBRE = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'lo', 'y', 'e', 'a', 'al', 'en', 'un', 'una', 'mi', 'mis', 'carpeta', 'carpetas']);
const palabrasNombre = (s) => clave(s).replace(/[^\p{L}\p{N} ]+/gu, ' ').split(' ').filter((w) => w && !VACIAS_NOMBRE.has(w));
function nombresParecidos(a, b) {
  const pa = palabrasNombre(a);
  const pb = palabrasNombre(b);
  if (pa.length === 0 || pb.length === 0) return false;
  const [corto, largo] = pa.length <= pb.length ? [pa, pb] : [pb, pa];
  return corto.every((w) => largo.includes(w));
}

// Devuelve el plan: { crear, movimientos, rechazos, error_global }. «crear» es la carpeta de destino que hay que crear antes (su id real se
// pone en «Preparar movimientos»); cada movimiento es { id, nuevo_padre_id, viejo_padre_id, nombre, ruta_origen, ruta_destino, archivos, subcarpetas };
// cada rechazo es { origen, error, … } (no se puede mover esa carpeta, las demás sí); error_global es un fallo que afecta a todo el pedido.
function decidirMover(pedido, arbol, archivos, raizId) {
  const plan = { crear: null, movimientos: [], rechazos: [], error_global: null };
  const origenes = Array.isArray(pedido.origenes) ? pedido.origenes : typeof pedido.origen === 'string' ? [pedido.origen] : [];
  const destinoTexto = pedido.destino;
  if (origenes.length === 0 || origenes.some((o) => typeof o !== 'string' || o === '') || typeof destinoTexto !== 'string' || destinoTexto === '') {
    plan.error_global = { error: 'pedido', detalle: 'falta el origen o el destino' };
    return plan;
  }
  const crear = pedido.crear === true;

  // El destino: una carpeta que existe o, si se pidió crearla, una nueva (en la raíz o dentro de una que exista)
  let destino = null;
  const d = buscarCarpeta(arbol, destinoTexto, !crear);
  if (d.length > 1) {
    plan.error_global = { error: 'destino_ambiguo', rutas: d.map((c) => c.ruta).sort() };
    return plan;
  }
  if (d.length === 1) destino = d[0];
  else if (!crear) {
    plan.error_global = { error: 'destino_no_encontrado', nombre: destinoTexto };
    return plan;
  } else {
    const segs = destinoTexto.split('/');
    const nombre = segs.at(-1);
    let padre = { id: raizId, nivel: 0, ruta: '' };
    if (segs.length > 1) {
      const p = buscarCarpeta(arbol, segs.slice(0, -1).join('/'), false);
      if (p.length !== 1) {
        plan.error_global = p.length === 0 ? { error: 'destino_no_encontrado', nombre: segs.slice(0, -1).join('/') } : { error: 'destino_ambiguo', rutas: p.map((c) => c.ruta).sort() };
        return plan;
      }
      padre = p[0];
    }
    const ruta = padre.ruta ? `${padre.ruta}/${nombre}` : nombre;
    if (padre.nivel + 1 > NIVELES) {
      plan.error_global = { error: 'profundidad', ruta };
      return plan;
    }
    destino = { id: '@nueva', nivel: padre.nivel + 1, ruta, nombre, nueva: true };
    plan.crear = { nombre, padre_id: padre.id, ruta };
  }

  const yaElegidas = [];
  const nombresDentro = new Set();
  for (const texto of origenes) {
    const rechazar = (error) => plan.rechazos.push({ origen: texto, ...error });
    const o = buscarCarpeta(arbol, texto, true);
    if (o.length === 0) { rechazar({ error: 'origen_no_encontrado', nombre: texto }); continue; }
    if (o.length > 1) { rechazar({ error: 'origen_ambiguo', rutas: o.map((c) => c.ruta).sort() }); continue; }
    const origen = o[0];
    // Entrada y Notas no se mueven
    if (esProtegida(origen)) { rechazar({ error: 'protegida', ruta: origen.ruta }); continue; }
    if (yaElegidas.some((x) => x.id === origen.id)) continue; // la misma carpeta dicha dos veces
    const desc = descendientes(origen, arbol.carpetas);
    if (destino.id === origen.id || desc.some((x) => x.id === destino.id)) { rechazar({ error: 'dentro_de_si', ruta: origen.ruta }); continue; }
    // Dos de las que se mueven, una dentro de la otra: se mueve la de fuera y la de dentro va con ella
    if (yaElegidas.some((x) => clave(origen.ruta).startsWith(`${clave(x.ruta)}/`) || clave(x.ruta).startsWith(`${clave(origen.ruta)}/`))) { rechazar({ error: 'anidada', ruta: origen.ruta }); continue; }
    if (!destino.nueva && origen.padre === destino.id) { rechazar({ error: 'ya_esta', origen: origen.nombre, destino: destino.ruta }); continue; }
    if ((!destino.nueva && arbol.carpetas.some((x) => x.padre === destino.id && clave(x.nombre) === clave(origen.nombre))) || nombresDentro.has(clave(origen.nombre))) {
      rechazar({ error: 'choque', nombre: origen.nombre, ruta: origen.ruta, destino: destino.ruta });
      continue;
    }
    // Una carpeta con nombre PARECIDO en el destino («viaje Tren de Hierro» a Viajes, donde ya está «Tren de Hierro»): quedarían dos casi iguales.
    // No se mueve y se dice cómo juntarlas 
    const gemela = destino.nueva ? null : arbol.carpetas.find((x) => x.padre === destino.id && x.id !== origen.id && nombresParecidos(x.nombre, origen.nombre));
    if (gemela) {
      rechazar({ error: 'parecida', nombre: origen.nombre, ruta: origen.ruta, destino: destino.ruta, parecida: gemela.ruta });
      continue;
    }
    // Hasta 3 niveles: cuenta lo más hondo que cuelga de la carpeta (en Drive y entre los archivos ya clasificados dentro de ella)
    const bajoOrigen = (ruta) => typeof ruta === 'string' && ruta !== '' && (clave(ruta) === clave(origen.ruta) || clave(ruta).startsWith(`${clave(origen.ruta)}/`));
    const hondoDrive = Math.max(0, ...desc.map((x) => x.nivel - origen.nivel));
    const hondoArchivos = Math.max(0, ...archivos.filter((f) => bajoOrigen(f.carpeta_destino)).map((f) => String(f.carpeta_destino).split('/').length - origen.nivel));
    if (destino.nivel + 1 + Math.max(hondoDrive, hondoArchivos) > NIVELES) { rechazar({ error: 'profundidad', ruta: `${destino.ruta}/${origen.nombre}` }); continue; }
    const ids = new Set([origen.id, ...desc.map((x) => x.id)]);
    yaElegidas.push(origen);
    nombresDentro.add(clave(origen.nombre));
    plan.movimientos.push({
      id: origen.id,
      nuevo_padre_id: destino.id,
      viejo_padre_id: origen.padre,
      nombre: origen.nombre,
      ruta_origen: origen.ruta,
      ruta_destino: `${destino.ruta}/${origen.nombre}`,
      archivos: dentroDe(archivos, ids).length,
      subcarpetas: desc.length,
    });
  }
  // Una carpeta nueva solo se crea si hay algo que meter dentro
  if (plan.movimientos.length === 0) plan.crear = null;
  return plan;
}

function revisar({ meta, niveles, raizId, filas }) {
  const mueve = meta && meta.mover_carpeta && typeof meta.mover_carpeta === 'object';
  const pide = meta && meta.borrar_drive && typeof meta.borrar_drive === 'object';
  const confirma = meta && Array.isArray(meta.papelera);
  if (!pide && !confirma && !mueve) return [{}];
  const arbol = leerArbol(niveles, raizId);
  if (arbol.error) return mueve ? [{ mover_plan: { crear: null, movimientos: [], rechazos: [], error_global: { error: 'arbol', detalle: arbol.error } } }] : [{ nada: true, error: arbol.error, rechazados: [] }];
  const archivos = conRuta(filas, arbol);
  if (mueve) return [{ mover_plan: decidirMover(meta.mover_carpeta, arbol, archivos, raizId) }];
  if (pide) return [{ propuesta: proponer(meta.borrar_drive, arbol, archivos) }];
  const { validos, rechazados } = comprobar(meta.papelera, arbol, archivos);
  if (validos.length === 0) return [{ nada: true, rechazados }];
  return validos.map((papelera) => ({ papelera, rechazados }));
}

// --- Pegamento con n8n ---
const meta = $('Planificar').first().json.meta;
const leerNodo = (nombre) => {
  try {
    return $(nombre).first().json;
  } catch (e) {
    return null;
  }
};
let filas = [];
try {
  filas = $('Contar archivos').all().map((i) => i.json).filter((r) => r && !r.error);
} catch (e) {
  filas = [];
}
const salida = revisar({
  meta,
  niveles: ['Listar nivel 1', 'Listar nivel 2', 'Listar nivel 3'].map(leerNodo),
  raizId: $('Configuración').first().json.config.carpeta_raiz_id,
  filas,
});
return salida.map((json) => ({ json }));
