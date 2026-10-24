// Funciones puras compartidas por los nodos del flujo "Sincronizar Drive".
// n8n no permite importar código entre nodos: el generador inserta este archivo en cada nodo que
// lo necesita, en la línea que contiene solo el marcador COMUN (entre guiones bajos dobles y en un
// comentario de bloque). No usa nada de n8n, así que se prueba sin red.

// Estructura de carpetas bajo la carpeta raíz "Secretaria":
//   Entrada/                  archivos recibidos que aún no tienen item ni carpeta pedida
//   Notas/                    archivos que cuelgan de un item
//   {carpeta pedida}/         lo que el usuario pide ("Fotos", "Fotos/Viajes"; hasta 3 niveles): manda sobre el item
// Todas las carpetas que falten se crean solas, nivel a nivel (un nivel por pasada de un minuto).
const CARPETA_NOTAS = 'Notas';
const NIVELES_MAX = 3; // niveles de carpetas que se leen y que puede tener una carpeta pedida

const textoOnull = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

// Ruta de carpetas (desde la raíz) donde debe estar el archivo de un item: siempre ['Notas'] (una carpeta pedida manda sobre esto).
function rutaDestino() {
  return [CARPETA_NOTAS];
}

// Ruta pedida por el usuario ("Fotos/Viajes") -> ['Fotos', 'Viajes'], o null si no es válida. Las mismas reglas que la
// restricción archivos_carpeta_destino_valida de la base de datos (segunda barrera): de 1 a 3 niveles de 1 a 60
// caracteres, sin "\" ni caracteres de control, ningún nivel es "." ni "..", y ninguno empieza ni acaba en espacio.
function segmentosCarpeta(texto) {
  if (typeof texto !== 'string') return null;
  const segs = texto.split('/');
  if (segs.length < 1 || segs.length > NIVELES_MAX) return null;
  for (const s of segs) {
    if (s.length < 1 || s.length > 60) return null;
    if (/[\\\u0000-\u001f\u007f]/.test(s)) return null;
    if (s === '.' || s === '..') return null;
    if (s !== s.trim()) return null;
  }
  return segs;
}

// Nombre de archivo apto para Drive (el que se pone al renombrar): sin caracteres de control ni \ / : * ? " < > |, sin
// puntos iniciales y de hasta 120 caracteres conservando la extensión
function nombreArchivoSeguro(nombre) {
  let n = String(nombre ?? '')
    .replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  if (n.length > 120) {
    const p = n.lastIndexOf('.');
    const ext = p > 0 && n.length - p <= 10 ? n.slice(p) : '';
    n = n.slice(0, 120 - ext.length).trimEnd() + ext;
  }
  return n;
}

// Literal de cadena para el parámetro q de files.list: la barra invertida y la comilla simple se escapan con barra
const escaparQ = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

// Búsqueda de una carpeta por nombre exacto dentro de otra (sintaxis oficial de la guía "Search for files and folders")
function consultaCarpeta(nombre, padreId) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(padreId))) throw new Error(`Id de carpeta no válido: ${padreId}`);
  return `mimeType = 'application/vnd.google-apps.folder' and name = '${escaparQ(nombre)}' and '${padreId}' in parents and trashed = false`;
}

// Carpetas hijas de varias carpetas a la vez ("'a' in parents or 'b' in parents"): una sola consulta por nivel. Sin
// padres, una consulta que no devuelve nada. Los ids de Drive son alfanuméricos; cualquier otra cosa se rechaza.
const MAX_PADRES_POR_CONSULTA = 100;
function consultaNivel(padreIds, raizId) {
  const ids = [...new Set(padreIds)];
  if (ids.some((id) => !/^[A-Za-z0-9_-]+$/.test(String(id)))) throw new Error('Id de carpeta no válido');
  if (ids.length > MAX_PADRES_POR_CONSULTA) throw new Error(`Demasiadas carpetas en un nivel (${ids.length}): no se puede listar de una vez`);
  let padres;
  if (ids.length > 0) {
    padres = ids.map((id) => `'${id}' in parents`).join(' or ');
  } else {
    // Sin padres que consultar no vale inventar un id: Drive contesta 404 a un id que no existe (así falló la primera versión,
    // que usaba un marcador). Se pregunta por algo válido que no puede devolver nada: las hijas de la raíz con un nombre que es
    // y no es a la vez.
    if (!/^[A-Za-z0-9_-]+$/.test(String(raizId))) throw new Error(`Id de carpeta no válido: ${raizId}`);
    padres = `'${raizId}' in parents and name = 'a' and name != 'a'`;
  }
  return `mimeType = 'application/vnd.google-apps.folder' and trashed = false and (${padres})`;
}

const API_DRIVE = 'https://www.googleapis.com/drive/v3/files';
const MIME_CARPETA = 'application/vnd.google-apps.folder';
const nfc = (s) => String(s).normalize('NFC');
// Dos nombres de carpeta son la misma si solo difieren en mayúsculas o en cómo está codificada una tilde
const clave = (s) => nfc(s).toLowerCase();

// Carpetas hijas de cada carpeta, a partir de los listados por nivel (un listado por nivel: { statusCode, body }).
// Devuelve un Map idPadre -> [{ id, name }]. Falla si un listado no es correcto o Drive devolvió más de una página:
// con el árbol incompleto parecería que faltan carpetas que sí existen y se crearían duplicadas.
function hijosPorPadre(niveles) {
  const hijos = new Map();
  (niveles || []).forEach((r, i) => {
    if (!r || !(r.statusCode >= 200 && r.statusCode < 300) || !Array.isArray(r.body?.files)) {
      throw new Error(`no se pudieron listar las carpetas de Drive (nivel ${i + 1}: ${r?.error ? String(r.error.message ?? r.error) : `HTTP ${r?.statusCode}`})`);
    }
    if (r.body.nextPageToken) {
      throw new Error(`Drive devolvió más de una página de carpetas en el nivel ${i + 1}; se para para no crear carpetas duplicadas`);
    }
    for (const f of r.body.files) {
      for (const p of Array.isArray(f.parents) ? f.parents : []) {
        if (!hijos.has(p)) hijos.set(p, []);
        hijos.get(p).push({ id: f.id, name: f.name });
      }
    }
  });
  // Orden estable (por nombre y luego por id): si hubiera dos carpetas con el mismo nombre se elige siempre la misma
  for (const lista of hijos.values()) lista.sort((a, b) => nfc(a.name).localeCompare(nfc(b.name)) || String(a.id).localeCompare(String(b.id)));
  return hijos;
}

// Baja por la ruta desde la raíz. Devuelve { id } si existe entera o { falta: { padreId, nombre, ruta } } con la primera
// carpeta que no existe (se crea; el archivo se mueve en la pasada siguiente).
function resolverRuta(segmentos, raizId, hijos) {
  let padre = raizId;
  for (let i = 0; i < segmentos.length; i++) {
    const existente = (hijos.get(padre) || []).find((c) => clave(c.name) === clave(segmentos[i]));
    if (!existente) return { falta: { padreId: padre, nombre: segmentos[i], ruta: segmentos.slice(0, i + 1).join('/') } };
    padre = existente.id;
  }
  return { id: padre };
}

// Decide qué hacer con cada archivo pendiente. Entradas:
//   archivos   filas de Supabase (con el item embebido en "items": objeto o null)
//   carpetas   filas de carpetas_pedidas pendientes ({ id, ruta, updated_at }); van DESPUÉS de los archivos
//   padres     respuestas de GET files/{id}?fields=id,name,parents,trashed, en el mismo orden: { statusCode, body }
//   raizId     id de la carpeta "Secretaria"
//   niveles    listados de carpetas por nivel (hijas de la raíz, de esas, y de esas): [{ statusCode, body }]
//   recientes  carpetas que creó una pasada anterior hace menos de 60 s ({ drive_id, padre_id, nombre }, tabla carpetas_creadas de la
//              base de datos 1.5): cuentan como existentes aunque Drive aún no las liste, para no crearlas dos veces (pasadas cada 10 s)
// Devuelve { acciones, fallos }. Cada acción lleva metodo, url y cuerpo (lo que ejecuta el nodo HTTP) y, si es
// de un archivo, archivo_id, updated_at (para escribir con condición) y carpeta_id (destino).
//   crear_carpeta  falta una carpeta de la ruta: se crea y el archivo se mueve en la pasada siguiente
//   mover          addParents/removeParents calculados con los padres reales (y, si hace falta, el nuevo nombre)
//   renombrar      el archivo no tiene a dónde ir (sin item ni carpeta pedida) pero su nombre ha cambiado
//   limpiar        no hay nada que hacer (sin destino ni cambio de nombre, en la papelera o ya no existe)
//   carpeta_lista  una carpeta pedida ya existe entera: se anota su id y se limpia la marca (PATCH vacío sobre la carpeta)
// El destino sale de la carpeta pedida si la hay (manda siempre) o, si no, del item.
function planificarAcciones({ archivos, carpetas = [], padres, raizId, niveles, recientes = [] }) {
  const acciones = [];
  const fallos = [];
  const creadas = new Set();
  const hijos = hijosPorPadre(niveles);
  for (const r of recientes) {
    if (!r || typeof r.drive_id !== 'string' || typeof r.padre_id !== 'string' || typeof r.nombre !== 'string') continue;
    const lista = hijos.get(r.padre_id) ?? [];
    if (!lista.some((c) => c.id === r.drive_id || clave(c.name) === clave(r.nombre))) lista.push({ id: r.drive_id, name: r.nombre });
    hijos.set(r.padre_id, lista);
  }

  // Crea el primer nivel que falta de una ruta (un nivel por pasada). Si dos peticiones piden la misma carpeta (aunque
  // cambie la capitalización) se crea una sola vez.
  const crearSiHaceFalta = (f) => {
    const k = `${f.padreId}|${clave(f.nombre)}`;
    if (creadas.has(k)) return;
    creadas.add(k);
    acciones.push({
      tipo: 'crear_carpeta',
      etiqueta: `crear carpeta ${f.ruta}`,
      metodo: 'POST',
      url: `${API_DRIVE}?supportsAllDrives=true`,
      // appProperties: marca privada de esta aplicación en Drive. «Vigilar Drive» la lee para no confundir las carpetas que crea la secretaria
      // con las que crea el usuario a mano.
      cuerpo: { name: f.nombre, mimeType: MIME_CARPETA, parents: [f.padreId], appProperties: { secretaria: '1' } },
    });
  };

  const limpiar = (a, motivo) =>
    acciones.push({
      tipo: 'limpiar',
      etiqueta: `limpiar ${a.id} (${motivo})`,
      archivo_id: a.id,
      updated_at: a.updated_at,
      carpeta_id: null,
      metodo: 'PATCH',
      url: `${API_DRIVE}/${encodeURIComponent(a.drive_file_id)}?supportsAllDrives=true`,
      cuerpo: {},
    });

  archivos.forEach((a, i) => {
    const r = padres[i] || {};
    if (r.statusCode === 404) return limpiar(a, 'ya no existe en Drive');
    if (!(r.statusCode >= 200 && r.statusCode < 300)) {
      fallos.push(`leer padres de ${a.id}: ${r.error ? String(r.error.message ?? r.error) : `HTTP ${r.statusCode}`}`);
      return;
    }
    if (r.body?.trashed === true) return limpiar(a, 'está en la papelera');

    // Nombre: la base de datos manda. Solo se cambia si Drive tiene otro.
    const deseado = textoOnull(a.nombre) ? nombreArchivoSeguro(a.nombre) : '';
    const renombrado = deseado !== '' && typeof r.body?.name === 'string' && r.body.name !== deseado ? deseado : null;

    // Destino: la carpeta pedida manda sobre la del item
    let segmentos = null;
    if (a.carpeta_destino !== null && a.carpeta_destino !== undefined) {
      segmentos = segmentosCarpeta(a.carpeta_destino);
      if (!segmentos) {
        fallos.push(`carpeta de destino no válida en ${a.id}: ${JSON.stringify(a.carpeta_destino).slice(0, 80)}`);
        return;
      }
    } else if (a.items) {
      segmentos = rutaDestino(a.items);
    }

    if (!segmentos) {
      if (!renombrado) return limpiar(a, 'no tiene item ni carpeta pedida');
      return acciones.push({
        tipo: 'renombrar',
        etiqueta: `renombrar ${a.id} a «${renombrado}»`,
        archivo_id: a.id,
        updated_at: a.updated_at,
        carpeta_id: null,
        metodo: 'PATCH',
        url: `${API_DRIVE}/${encodeURIComponent(a.drive_file_id)}?supportsAllDrives=true`,
        cuerpo: { name: renombrado },
      });
    }

    const resuelta = resolverRuta(segmentos, raizId, hijos);
    if (resuelta.falta) {
      crearSiHaceFalta(resuelta.falta);
      return; // el archivo espera a la pasada siguiente
    }
    const destino = resuelta.id;

    const padresActuales = Array.isArray(r.body?.parents) ? r.body.parents : [];
    const anadir = padresActuales.includes(destino) ? [] : [destino];
    const quitar = padresActuales.filter((p) => p !== destino);
    const params = ['supportsAllDrives=true'];
    if (anadir.length) params.push(`addParents=${encodeURIComponent(anadir.join(','))}`);
    if (quitar.length) params.push(`removeParents=${encodeURIComponent(quitar.join(','))}`);
    acciones.push({
      tipo: 'mover',
      etiqueta: `mover ${a.id} a ${segmentos.join('/')}`,
      archivo_id: a.id,
      updated_at: a.updated_at,
      carpeta_id: destino,
      metodo: 'PATCH',
      url: `${API_DRIVE}/${encodeURIComponent(a.drive_file_id)}?${params.join('&')}`,
      cuerpo: renombrado ? { name: renombrado } : {},
    });
  });

  // Carpetas pedidas sin mover archivos ("crea la carpeta Proyectos dentro de Trabajo"). Se crea el primer nivel que falte;
  // cuando la ruta existe entera se anota (carpeta_lista). Esa acción pasa por el nodo de Drive como un PATCH vacío sobre la
  // propia carpeta, que no cambia nada (el mismo recurso que usa "limpiar" con los archivos): así todas las acciones tienen
  // la misma forma y el registro sigue alineado con las respuestas.
  carpetas.forEach((c) => {
    const segmentos = segmentosCarpeta(c.ruta);
    if (!segmentos) {
      fallos.push(`carpeta pedida no válida en ${c.id}: ${JSON.stringify(c.ruta).slice(0, 80)}`);
      return;
    }
    const resuelta = resolverRuta(segmentos, raizId, hijos);
    if (resuelta.falta) {
      crearSiHaceFalta(resuelta.falta);
      return;
    }
    acciones.push({
      tipo: 'carpeta_lista',
      etiqueta: `carpeta ${segmentos.join('/')} lista`,
      carpeta_pedida_id: c.id,
      updated_at: c.updated_at,
      carpeta_id: resuelta.id,
      metodo: 'PATCH',
      url: `${API_DRIVE}/${encodeURIComponent(resuelta.id)}?supportsAllDrives=true`,
      cuerpo: {},
    });
  });

  return { acciones, fallos };
}
