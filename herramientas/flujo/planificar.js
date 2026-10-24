// Nodo "Planificar": convierte la respuesta del modelo en las peticiones REST que hay que
// ejecutar contra Supabase. No escribe nada por sí mismo: devuelve un item por petición y el
// nodo "Escribir en Supabase" las ejecuta en orden.
//
// Validación tolerante:
//   - una clave ausente cuenta como null;
//   - intención, tipo y fechas ISO inválidos siguen siendo error.
// Cualquier error deja el mensaje con procesado = false y el motivo en la columna "error".
//
// Seguridad: el modelo solo aporta parámetros, nunca SQL ni URLs. Los ids que cita (corregir,
// completar, cancelar) son referencias cortas (i1, i2…) a los items pendientes que se le dieron, y los archivos que cita (a1, a2…) son
// referencias a los archivos recibidos; la ruta de una carpeta pedida la valida este código; las columnas
// que puede cambiar y los filtros de una consulta son listas cerradas.
//
// Las consultas (GET) no pasan por "Escribir en Supabase": n8n no permite una expresión en
// "Send Body", así que el GET lo ejecuta el nodo "Leer consulta" con meta.consulta_url.

const INTENCIONES = ['guardar', 'consultar', 'corregir', 'completar', 'recordar', 'aclarar', 'descartar', 'charla', 'archivar', 'carpetas', 'cancelar', 'ver_archivos', 'crear_carpeta', 'mover_carpeta', 'mover_archivos', 'borrar_drive', 'horario', 'ayuda', 'proyectos', 'proyecto'];
// Intenciones que no crean items (si el modelo devuelve alguno, se ignora)
const SIN_ITEMS = ['charla', 'horario', 'archivar', 'carpetas', 'cancelar', 'completar', 'ver_archivos', 'crear_carpeta', 'mover_carpeta', 'mover_archivos', 'borrar_drive', 'ayuda', 'proyectos', 'proyecto'];
// Niveles de una carpeta pedida (Fotos/Viajes/2026)
const NIVELES_CARPETA_MAX = 3;
const MAX_CARPETAS_PEDIDAS = 10; // carpetas que se pueden pedir en un solo mensaje
const TIPOS = ['evento', 'tarea', 'lista', 'nota'];
const ESTADOS = ['pendiente', 'hecho', 'archivado'];
const CAMPOS_FECHA = ['fecha_inicio', 'fecha_fin', 'fecha_limite', 'recordar_en'];
// "etiquetas" se sigue aceptando por compatibilidad, pero ya no se pide ni se enseña
const CAMPOS_CORREGIBLES = ['tipo', 'titulo', 'contenido', 'anadir_contenido', ...CAMPOS_FECHA, 'lista', 'proyecto', 'etiquetas'];
// Los listados llevan solo el título; el contenido (el contexto) solo hace falta para marcar «…» y para el detalle completo. No se pide
// el mensaje original del usuario: saldría idéntico en todo lo que nació de un mismo mensaje.
const CAMPOS_CONSULTA = 'tipo,titulo,contenido,lista,estado,fecha_inicio,fecha_fin,fecha_limite,recordar_en,proyecto';
// Tipos que admite el filtro de cancelar y completar: los de los items más "alarma" (tarea con hora de aviso y sin fecha límite, como en los listados)
const TIPOS_FILTRO = [...TIPOS, 'alarma'];
// Cancelar o completar más de estos elementos de una vez se pregunta antes (se enseña la lista)
const MAX_SIN_CONFIRMAR = 3;
const MAX_TEXTO_BUSCAR = 40;
const MAX_PENDIENTES_VISTOS = 200; // los que lee "Leer items pendientes" (si hay más, un filtro no los ve todos)
const MAX_FILAS_CONSULTA = 500;
const MAX_TEXTO_ERROR = 500;

class ErrorValidacion extends Error {}
const fallo = (msg) => {
  throw new ErrorValidacion(msg);
};

const sinAcentos = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();

const textoONull = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

const fechaValida = (s) => typeof s === 'string' && DateTime.fromISO(s, { setZone: true }).isValid;

// --- Hora de Madrid (con el cambio de hora de marzo y octubre) ---

function offsetMadridMin(ms) {
  const partes = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Madrid', timeZoneName: 'longOffset' }).formatToParts(new Date(ms));
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(partes.find((p) => p.type === 'timeZoneName')?.value ?? '');
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
}

// Instante UTC de una hora local de Madrid. El offset se evalúa dos veces por si el cambio de hora cae en medio.
function madridAUtc(anio, mes, dia, h = 0, mi = 0) {
  const base = Date.UTC(anio, mes - 1, dia, h, mi);
  const candidato = base - offsetMadridMin(base) * 60000;
  return new Date(base - offsetMadridMin(candidato) * 60000);
}

// --- Normalizaciones de campos (las comparten guardar, corregir y consultar) ---

function normalizarFecha(valor, ref) {
  const f = valor ?? null;
  if (f !== null && !fechaValida(f)) fallo(`${ref} no es una fecha ISO válida: ${f}`);
  return f;
}

const normalizarLista = (valor) => {
  const l = textoONull(valor);
  return l ? l.toLowerCase() : null;
};

const normalizarEtiquetas = (valor) =>
  Array.isArray(valor) ? valor.filter((e) => typeof e === 'string' && e.trim() !== '').map((e) => e.trim()) : [];

// Nombre de proyecto: sin barras ni caracteres de control (como la restricción de la tabla), de hasta 60 caracteres, y escrito como figura en
// la lista de proyectos si ya existe (sin distinguir mayúsculas ni tildes). Uno que no existe se devuelve tal cual: la base de datos lo
// crea al guardar el item, salvo que se parezca a uno que ya existe, en cuyo caso se pregunta (comprobarProyectos).
function normalizarProyecto(valor, proyectos = [], avisos, ref) {
  let texto = textoONull(valor);
  if (!texto) return null;
  texto = texto.replace(/[\\/\u0000-\u001f\u007f]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 60).trim();
  if (!texto) return null;
  if (/^proyecto\s+/i.test(texto) && texto.length > 9) texto = texto.replace(/^proyecto\s+/i, '');
  const canonico = (proyectos ?? []).find((p) => sinAcentos(p) === sinAcentos(texto));
  if (canonico) return canonico;
  avisos.push(`${ref}: proyecto nuevo: ${texto}`);
  return texto;
}

function normalizarItem(it, i, config, avisos) {
  const ref = `items[${i}]`;
  if (typeof it !== 'object' || it === null || Array.isArray(it)) fallo(`${ref} no es un objeto`);
  if (!TIPOS.includes(it.tipo)) fallo(`${ref}.tipo no permitido: ${it.tipo}`);
  const titulo = textoONull(it.titulo);
  if (!titulo) fallo(`${ref}.titulo vacío`);

  const fechas = {};
  for (const c of CAMPOS_FECHA) fechas[c] = normalizarFecha(it[c], `${ref}.${c}`);
  // Solo las tareas llevan recordatorio (la base de datos también lo borra de lo que no sea una tarea)
  if (it.tipo !== 'tarea' && fechas.recordar_en !== null) {
    avisos.push(`${ref}: recordar_en solo se usa en tareas, se ignora`);
    fechas.recordar_en = null;
  }

  let esperaArchivo = false;
  if (it.espera_archivo !== undefined && it.espera_archivo !== null) {
    if (typeof it.espera_archivo === 'boolean') esperaArchivo = it.espera_archivo;
    else avisos.push(`${ref}: espera_archivo no es booleano (${it.espera_archivo}), se usa false`);
  }

  let confianza = null;
  if (typeof it.confianza === 'number' && it.confianza >= 0 && it.confianza <= 1) {
    confianza = Math.round(it.confianza * 100) / 100;
  } else if (it.confianza !== undefined && it.confianza !== null) {
    avisos.push(`${ref}: confianza fuera de rango (${it.confianza}), se ignora`);
  }

  return {
    tipo: it.tipo,
    titulo,
    contenido: textoONull(it.contenido),
    ...fechas,
    lista: normalizarLista(it.lista),
    proyecto: normalizarProyecto(it.proyecto, config.proyectos, avisos, ref),
    etiquetas: normalizarEtiquetas(it.etiquetas),
    confianza,
    espera_archivo: esperaArchivo,
  };
}

// --- Corregir y completar ---

// "refs" traduce las referencias cortas que vio el modelo (i1, i2…) a los ids reales de la base de datos
function validarIds(ids, refs, ref) {
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((i) => typeof i === 'string' && i !== '')) {
    fallo(`${ref} necesita una lista de ids`);
  }
  if (Object.keys(refs).length === 0) fallo(`${ref}: no hay items pendientes sobre los que actuar`);
  const fuera = ids.filter((i) => !Object.prototype.hasOwnProperty.call(refs, i));
  if (fuera.length) fallo(`${ref}: ids que no están entre los items pendientes: ${fuera.join(', ')}`);
  return [...new Set(ids.map((i) => refs[i]))];
}

function normalizarCambios(cambios, config, avisos) {
  if (typeof cambios !== 'object' || cambios === null || Array.isArray(cambios)) fallo('corregir: cambios no es un objeto');
  if ('asociar_a' in cambios) fallo('corregir: asociar archivos (asociar_a) aún no implementado');

  const out = {};
  for (const [k, v] of Object.entries(cambios)) {
    if (!CAMPOS_CORREGIBLES.includes(k)) {
      avisos.push(`corregir: el campo "${k}" no es editable, se ignora`);
      continue;
    }
    const ref = `cambios.${k}`;
    if (k === 'tipo') {
      if (!TIPOS.includes(v)) fallo(`${ref} no permitido: ${v}`);
      out.tipo = v;
    } else if (k === 'titulo') {
      const t = textoONull(v);
      if (!t) fallo(`${ref} vacío`);
      out.titulo = t;
    } else if (k === 'contenido') out.contenido = textoONull(v);
    else if (k === 'anadir_contenido') {
      const t = textoONull(v);
      if (t) out.anadir_contenido = t;
      else avisos.push('cambios.anadir_contenido vacío, se ignora');
    } else if (CAMPOS_FECHA.includes(k)) out[k] = normalizarFecha(v, ref);
    else if (k === 'lista') out.lista = normalizarLista(v);
    else if (k === 'proyecto') out.proyecto = normalizarProyecto(v, config.proyectos, avisos, ref);
    else if (k === 'etiquetas') out.etiquetas = normalizarEtiquetas(v);
  }

  // Añadir y sustituir el contenido a la vez es contradictorio: manda añadir (no se pierde lo que había)
  if ('anadir_contenido' in out && 'contenido' in out) {
    avisos.push('corregir: contenido y anadir_contenido a la vez; se añade y no se sustituye');
    delete out.contenido;
  }
  if (Object.keys(out).length === 0) fallo('corregir sin cambios válidos');
  return out;
}

// --- Cancelar y completar: ids concretos o un filtro ---
// El modelo cita elementos concretos (item_ids, referencias i1…) o, para "todos los pensamientos", "todas las tareas", "toda la lista de
// la compra", un filtro {tipo, lista, proyecto}. El filtro lo resuelve este código sobre los elementos pendientes que vio el
// modelo (enumerar decenas de ids era donde fallaba). Sin proyecto, el filtro abarca solo lo que no es de ningún proyecto (como en los
// listados, donde lo de los proyectos va aparte).
function normalizarSeleccion(valor, refs, ref, config, avisos) {
  if (Array.isArray(valor)) valor = { item_ids: valor };
  if (typeof valor === 'string') valor = { item_ids: [valor] };
  const v = valor && typeof valor === 'object' ? valor : {};
  let ids = v.item_ids;
  if (ids === undefined && typeof v.item_id === 'string') ids = [v.item_id];
  const hayIds = Array.isArray(ids) && ids.length > 0;
  const f = v.filtro && typeof v.filtro === 'object' && !Array.isArray(v.filtro) ? v.filtro : null;
  if (hayIds && f) avisos.push(`${ref}: trae ids y filtro a la vez; se usan los ids`);
  if (hayIds) return { ids: validarIds(ids, refs, `${ref}.item_ids`) };
  const normFiltro = (f) => {
    let tipo = null;
    if (f.tipo !== undefined && f.tipo !== null && f.tipo !== '') {
      if (!TIPOS_FILTRO.includes(f.tipo)) fallo(`${ref}.filtro.tipo no permitido: ${f.tipo}`);
      tipo = f.tipo;
    }
    return {
      tipo,
      lista: normalizarLista(f.lista),
      proyecto: textoONull(f.proyecto) ? normalizarProyecto(f.proyecto, config.proyectos, [], `${ref}.filtro.proyecto`) : null,
    };
  };
  // Varias secciones a la vez (solo las genera el código): cada una con su filtro
  if (Array.isArray(v.filtros) && v.filtros.length > 0 && v.filtros.every((x) => x && typeof x === 'object' && !Array.isArray(x))) {
    return { filtros: v.filtros.map(normFiltro) };
  }
  if (f) return { filtro: normFiltro(f) };
  // Nada que hacer (lista vacía o ausente): no es un fallo, se contesta con honestidad
  return { ids: [] };
}

// Memoria de hechos del usuario: el nombre con el que quiere que se le llame vive con un término fijo, como el de la secretaria
const NOMBRE_USUARIO = 'nombre del usuario';
const MAX_TERMINO = 60;
const MAX_SIGNIFICADO = 300;
// Solo un término que diga «usuario»: «mi nombre» o «cómo llamarme» son ambiguos (justo tras «¿cómo quieres llamarme?» hablan de la secretaria)
const esNombreDelUsuario = (termino) => /\busuario\b/.test(sinAcentos(termino ?? ''));
const NOMBRE_VALIDO_USUARIO = /^[\p{L}\p{N}][\p{L}\p{N} .'’-]{0,59}$/u;
// La charla la redacta el modelo, pero nunca puede decir que ha hecho algo: no escribe nada
const PROMETE_ALGO = /\b(?:he (?:apuntado|guardado|anadido|anotado|borrado|quitado|cambiado|puesto|creado|movido)|(?:te )?(?:lo )?(?:he )?apuntad[oa]s?|guardad[oa]s?|te avis(?:o|are)|(?:lo )?recordare)\b/;
const TEXTO_CHARLA_SEGURO = 'No he apuntado nada.';
// (si la charla trae un dato que sí se guarda en la memoria, Resultado ya lo dice: el texto seguro sería contradictorio)
// El modelo no sabe que se pueden mover carpetas : si dice que no puede, se le corrige con el ejemplo de cómo pedirlo
const DICE_QUE_NO_MUEVE = /\bno (?:puedo|se|sé) (?:mover|meter|cambiar de sitio|reorganizar)(?: [a-záéíóúñ]+){0,3} carpetas?\b/i;
// (un caso real repitió esta frase cinco veces; ahora dice las dos formas, lo de dentro y la carpeta entera)
const TEXTO_SI_MUEVE_CARPETAS = 'Sí puedo mover carpetas. Dímelo así: «mueve todo lo de Notas a Viajes/Budapest» (lo de dentro) o «mete la carpeta Budapest dentro de Viajes» (la carpeta entera).';
// Lo mismo con los archivos ya guardados : «mueve las fotos de Budapest a Viajes/Budapest» se hace por código
const DICE_QUE_NO_MUEVE_ARCHIVOS = /\b(?:no|ni) (?:puedo|se|sé) (?:mover|cambiar de sitio|cambiar de carpeta|pasar)(?: [a-záéíóúñ]+){0,3} (?:archivos|fotos|documentos|imagenes|imágenes|ficheros)\b/i;
const TEXTO_SI_MUEVE_ARCHIVOS = 'Sí puedo moverlos. Dímelo así: «mueve todo lo de Notas a Viajes/Budapest» o «mueve las fotos de Budapest a Viajes/Budapest».';
function textoCharla(texto, guardaDato = false) {
  const t = String(texto ?? '').replace(/\s+/g, ' ').trim().slice(0, 400);
  if (DICE_QUE_NO_MUEVE.test(t)) return TEXTO_SI_MUEVE_CARPETAS;
  if (DICE_QUE_NO_MUEVE_ARCHIVOS.test(t)) return TEXTO_SI_MUEVE_ARCHIVOS;
  if (!t || PROMETE_ALGO.test(sinAcentos(t))) return guardaDato ? 'De acuerdo.' : TEXTO_CHARLA_SEGURO;
  return t;
}

// --- Memoria permanente: verla, olvidar un dato y el tope ---
const MAX_MEMORIA = 50;
const VACIAS_MEMORIA = new Set(['que', 'del', 'los', 'las', 'una', 'uno', 'con', 'por', 'para', 'sobre', 'mis', 'tus', 'esto', 'eso', 'dato']);
const filasDeMemoria = (lista) =>
  (Array.isArray(lista) ? lista : []).filter((m) => m && typeof m.id === 'string' && typeof m.termino === 'string' && typeof m.significado === 'string');
const esNombreSecretaria = (m) => sinAcentos(m.termino) === NOMBRE_TERMINO;
function lineaMemoria(m) {
  const t = sinAcentos(m.termino);
  const etiqueta = t === NOMBRE_TERMINO ? 'Mi nombre' : t === NOMBRE_USUARIO ? 'Cómo te llamo' : limpiarTxt(m.termino);
  return `${etiqueta}: ${limpiarTxt(m.significado)}`;
}
// La lista numerada: el número es el que usa /forget (mismo orden que «Leer memoria»: por término)
function textoMemoria(filas, pista = false) {
  if (filas.length === 0) return 'Todavía no recuerdo nada de ti.';
  const lineas = filas.map((m, i) => `${i + 1}. ${lineaMemoria(m)}`);
  return [
    `*Lo que recuerdo* (${filas.length} de ${MAX_MEMORIA})`,
    ...lineas,
    pista ? 'Dime cuál olvido: /forget y su número (por ejemplo /forget 2).' : 'Para olvidar uno: /forget y su número.',
  ].join('\n');
}
// Los datos que encajan con lo que dice el usuario: todas sus palabras (de 3 letras o más) en el término o el significado
function buscarEnMemoria(filas, texto) {
  const palabras = sinAcentos(texto).replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter((w) => w.length > 2 && !VACIAS_MEMORIA.has(w));
  if (palabras.length === 0) return [];
  return filas.filter((m) => {
    const en = sinAcentos(`${m.termino} ${m.significado}`);
    return palabras.every((w) => en.includes(w.length > 4 ? w.replace(/s$/, '') : w));
  });
}
const TEXTO_NOMBRE_NO_SE_OLVIDA = 'Mi nombre no se olvida. Para cambiarlo: «te llamas Marta».';
const textoMemoriaLlena = (termino) => `Tengo la memoria llena (${MAX_MEMORIA} datos) y no he guardado «${limpiarTxt(termino)}». Olvida alguno con /forget.`;

// --- Horario fijo semanal ---
const DIAS_SEMANA = ['', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
const MAX_HORARIO = 40; // bloques guardados como mucho (uno por día y franja)
const HORA_HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const aMinutos = (h) => {
  const m = HORA_HHMM.exec(String(h ?? '').trim().slice(0, 5).padStart(5, '0'));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const hhmm = (h) => String(h ?? '').trim().slice(0, 5).padStart(5, '0');
const filasDeHorario = (lista) =>
  (Array.isArray(lista) ? lista : []).filter(
    (b) => b && typeof b.id === 'string' && typeof b.titulo === 'string' && Number.isInteger(b.dia_semana) && b.dia_semana >= 1 && b.dia_semana <= 7 && aMinutos(b.hora_inicio) !== null && aMinutos(b.hora_fin) !== null,
  );
const lineaHorario = (b) => `${DIAS_SEMANA[b.dia_semana]} de ${hhmm(b.hora_inicio)} a ${hhmm(b.hora_fin)}: ${limpiarTxt(b.titulo)}`;
// La lista numerada (por día y hora, como la lee «Leer horario»): el número es el de /horario quitar N
function textoMiHorario(filas, pista = false) {
  if (filas.length === 0) return 'No tienes horario fijo. Dímelo así: «trabajo los viernes de 16 a 20».';
  return [
    '*Tu horario fijo*',
    ...filas.map((b, i) => `${i + 1}. ${lineaHorario(b)}`),
    pista ? 'Dime cuál quito: /horario quitar y su número (por ejemplo /horario quitar 2).' : 'Para quitar uno: /horario quitar y su número (por ejemplo /horario quitar 2).',
  ].join('\n');
}
// Día de la semana (1 = lunes) y minuto del día en Madrid de un instante
const fmtPartesMadrid = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const ISO_DIA = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
function partesMadrid(ms) {
  const p = Object.fromEntries(fmtPartesMadrid.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { dia: ISO_DIA[p.weekday], min: Number(p.hour) * 60 + Number(p.minute) };
}

const esAlarmaItem = (r) => r.tipo === 'tarea' && Boolean(r.recordar_en) && !r.fecha_limite;

// Los elementos pendientes (con ids reales) que cumplen el filtro
function resolverFiltro(filtro, pendientes) {
  return pendientes.filter((r) => {
    if (filtro.tipo === 'alarma' && !esAlarmaItem(r)) return false;
    if (filtro.tipo === 'tarea' && (r.tipo !== 'tarea' || esAlarmaItem(r))) return false;
    if (filtro.tipo && !['alarma', 'tarea'].includes(filtro.tipo) && r.tipo !== filtro.tipo) return false;
    if (filtro.lista && sinAcentos(r.lista) !== sinAcentos(filtro.lista)) return false;
    if (filtro.proyecto ? sinAcentos(r.proyecto) !== sinAcentos(filtro.proyecto) : Boolean(r.proyecto)) return false;
    return true;
  });
}

// Texto de búsqueda de una consulta: solo letras, números y espacios (va dentro de un filtro ilike de PostgREST, entre comillas)
function normalizarBuscar(valor) {
  const t = textoONull(valor);
  if (!t) return null;
  const limpio = t.normalize('NFC').replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXTO_BUSCAR).trim();
  return limpio || null;
}

// --- Consultar ---

// Una fecha de la consulta: "2026-10-11" (día completo, hora de Madrid) o un ISO con hora.
// "hasta" con solo el día es exclusivo: llega hasta el final de ese día.
function aInstante(valor, ref, esHasta) {
  const v = textoONull(valor);
  if (v === null) return null;
  if (!fechaValida(v)) fallo(`${ref} no es una fecha ISO válida: ${v}`);
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (m) {
    const [y, mo, d] = m.slice(1).map(Number);
    return esHasta ? { fecha: madridAUtc(y, mo, d + 1), exclusivo: true } : { fecha: madridAUtc(y, mo, d), exclusivo: false };
  }
  m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(v);
  if (m) {
    const [y, mo, d, h, mi] = m.slice(1).map(Number);
    return { fecha: madridAUtc(y, mo, d, h, mi), exclusivo: false }; // sin zona: hora de Madrid
  }
  return { fecha: new Date(v), exclusivo: false };
}

function normalizarConsulta(c, config, avisos) {
  const hayObjeto = typeof c === 'object' && c !== null && !Array.isArray(c);
  if (c !== null && c !== undefined && !hayObjeto) avisos.push('consulta no es un objeto: se muestra todo lo pendiente');
  const q = hayObjeto ? c : {};

  // «alarma» no es un tipo de la base de datos: es una tarea con hora de aviso y sin fecha límite (vista «alarmas»). «Qué tareas tengo» es la
  // vista «tareas» (sin las alarmas). Las vistas las usan también los atajos por código.
  let tipo = null;
  let vista = ['alarmas', 'tareas'].includes(q.vista) ? q.vista : null;
  if (q.tipo !== undefined && q.tipo !== null && q.tipo !== '') {
    if (q.tipo === 'alarma') {
      tipo = 'tarea';
      vista = 'alarmas';
    } else if (TIPOS.includes(q.tipo)) tipo = q.tipo;
    else avisos.push(`consulta.tipo "${q.tipo}" no es un tipo: se muestra todo`);
  }
  if (vista && tipo !== 'tarea') vista = null;

  let estado = 'pendiente'; // por defecto, lo hecho y lo archivado no se muestra
  if (q.estado !== undefined && q.estado !== null && q.estado !== '') {
    if (ESTADOS.includes(q.estado)) estado = q.estado;
    else avisos.push(`consulta.estado "${q.estado}" no es un estado: se usa "pendiente"`);
  }

  return {
    tipo,
    vista,
    lista: normalizarLista(q.lista),
    proyecto: textoONull(q.proyecto) ? normalizarProyecto(q.proyecto, config.proyectos, [], 'consulta.proyecto') : null,
    buscar: normalizarBuscar(q.buscar),
    completo: q.completo === true,
    estado,
    desde: aInstante(q.desde, 'consulta.desde', false),
    hasta: aInstante(q.hasta, 'consulta.hasta', true),
  };
}

function urlConsulta(base, q) {
  const partes = [`select=${CAMPOS_CONSULTA}`, `estado=eq.${q.estado}`, 'order=created_at.desc', `limit=${MAX_FILAS_CONSULTA}`];
  if (q.tipo) partes.push(`tipo=eq.${q.tipo}`);
  if (q.vista === 'alarmas') partes.push('recordar_en=not.is.null', 'fecha_limite=is.null');
  if (q.lista) partes.push(`lista=eq.${encodeURIComponent(q.lista)}`);
  if (q.proyecto) partes.push(`proyecto=eq.${encodeURIComponent(q.proyecto)}`);
  // Búsqueda por tema en el título o en el contenido (el texto ya viene limpio: letras, números y espacios). Si también hay un rango de
  // fechas, las dos condiciones se combinan con and() porque PostgREST solo admite un parámetro "or".
  // Los espacios pasan a "*" (comodín): "casero nuevo" encuentra "casero … nuevo" y no hacen falta comillas
  const patron = q.buscar ? `*${q.buscar.replace(/ /g, '*')}*` : null;
  const busqueda = patron ? `or(titulo.ilike.${patron},contenido.ilike.${patron})` : null;
  if (busqueda && !(q.desde || q.hasta)) partes.push(`or=${encodeURIComponent(busqueda.slice(2))}`);
  if (q.desde || q.hasta) {
    // Con rango, solo cuentan los items con fecha: la de inicio (citas), la límite (tareas) o la del aviso (alarmas: «qué tengo hoy» las incluye)
    const rango = (campo) => {
      const c = [];
      if (q.desde) c.push(`${campo}.gte."${q.desde.fecha.toISOString()}"`);
      if (q.hasta) c.push(`${campo}.${q.hasta.exclusivo ? 'lt' : 'lte'}."${q.hasta.fecha.toISOString()}"`);
      return c.length > 1 ? `and(${c.join(',')})` : c[0];
    };
    const fechas = `or(${rango('fecha_inicio')},${rango('fecha_limite')},${rango('recordar_en')})`;
    if (busqueda) partes.push(`and=${encodeURIComponent(`(${fechas},${busqueda})`)}`);
    else partes.push(`or=${encodeURIComponent(fechas.slice(2))}`);
  }
  return `${base}/items?${partes.join('&')}`;
}

// El rango de una consulta dicho con palabras, para «no tienes nada…»
// Por ejemplo: «hoy (mar 20 oct)», «mañana (…)», «el vie 23 oct», «entre el … y el …». null sin rango.
function textoRango(q, ahora) {
  if (!q.desde && !q.hasta) return null;
  const dia = (d) => diaMadrid(d.getTime());
  const corto = (d) => diaCorto(d.getTime());
  const ini = q.desde ? q.desde.fecha : null;
  const fin = q.hasta ? (q.hasta.exclusivo ? new Date(q.hasta.fecha.getTime() - 1) : q.hasta.fecha) : null;
  const hoy = diaMadrid(ahora.getTime());
  const [y, m, d] = hoy.split('-').map(Number);
  const manana = diaMadrid(madridAUtc(y, m, d + 1, 12, 0).getTime());
  if (ini && fin && dia(ini) === dia(fin)) {
    if (dia(ini) === hoy) return `hoy (${corto(ini)})`;
    if (dia(ini) === manana) return `mañana (${corto(ini)})`;
    return `el ${corto(ini)}`;
  }
  if (ini && fin) return `entre el ${corto(ini)} y el ${corto(fin)}`;
  return ini ? `desde el ${corto(ini)}` : `hasta el ${corto(fin)}`;
}

// Devuelve { datos, avisos } o lanza ErrorValidacion
// Término de la memoria donde se guarda el nombre que el usuario le pone a la secretaria (sin acentos ni mayúsculas, como termino_norm)
const NOMBRE_TERMINO = 'nombre de la secretaria';
// Por debajo de esta confianza no se guarda nada: se pregunta (regla 5 del prompt)
const UMBRAL_CONFIANZA = 0.7;
const NOMBRE_TIPO = { evento: 'cita', tarea: 'tarea', lista: 'lista', nota: 'pensamiento' };
const TEXTO_QUE_BORRAR_DRIVE = 'Dime qué carpeta o archivo de Drive quieres borrar.';
const TEXTO_PEDIR_NOMBRE = 'Antes de nada, ¿cómo quieres que me llame? Luego repíteme lo que me has escrito.';

function validarRespuesta(texto, config, refs, refsArchivos = {}, opciones = {}) {
  const limpio = String(texto)
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  let datos;
  try {
    datos = JSON.parse(limpio);
  } catch (e) {
    fallo(`JSON no válido (${e.message})`);
  }
  if (typeof datos !== 'object' || datos === null || Array.isArray(datos)) fallo('la raíz no es un objeto');
  if (!INTENCIONES.includes(datos.intencion)) fallo(`intencion no permitida: ${datos.intencion}`);

  const avisos = [];
  const itemsBrutos = datos.items ?? [];
  if (!Array.isArray(itemsBrutos)) fallo('items no es una lista');
  const items = itemsBrutos.map((it, i) => normalizarItem(it, i, config, avisos));

  const respuestaUsuario = typeof datos.respuesta_usuario === 'string' ? datos.respuesta_usuario : '';
  let pregunta = textoONull(datos.pregunta);

  if (datos.intencion === 'guardar' && items.length === 0) fallo('guardar sin items');

  let archivos = null;
  if (datos.archivos !== undefined && datos.archivos !== null) {
    if (datos.intencion === 'guardar' || datos.intencion === 'archivar') archivos = normalizarArchivos(datos.archivos, datos.intencion, refsArchivos, avisos);
    else if (Array.isArray(datos.archivos?.refs) && datos.archivos.refs.length > 0) avisos.push(`archivos solo se usa en guardar y archivar, se ignora (${datos.intencion})`);
  }
  if (datos.intencion === 'archivar' && !archivos) fallo('archivar necesita archivos con refs y carpeta');
  if (datos.intencion === 'guardar' && archivos && items.length !== 1) fallo('guardar con archivos necesita exactamente un item');
  if (SIN_ITEMS.includes(datos.intencion) && items.length > 0) {
    avisos.push(`${datos.intencion} no crea items: se ignoran los que ha devuelto el modelo`);
    items.length = 0;
  }

  if (datos.intencion === 'aclarar') {
    if (!pregunta && respuestaUsuario.trim()) {
      avisos.push('aclarar sin pregunta: se usa respuesta_usuario');
      pregunta = respuestaUsuario.trim();
    }
    if (!pregunta) fallo('aclarar sin pregunta');
  }

  let memoriaNueva = null;
  let nombreNuevo = null;
  let nombreUsuario = null;
  // Un dato duradero del usuario («Emma es mi hermana», «llámame Ana») puede venir también con guardar,
  // charla o aclarar (memoria_nueva junto a lo demás). Ahí nunca puede cambiar el nombre de la secretaria: eso solo con recordar.
  if (datos.intencion !== 'recordar' && datos.memoria_nueva && typeof datos.memoria_nueva === 'object' && ['guardar', 'charla', 'aclarar'].includes(datos.intencion)) {
    let termino = textoONull(datos.memoria_nueva.termino);
    const significado = textoONull(datos.memoria_nueva.significado);
    if (termino && significado && sinAcentos(termino) !== NOMBRE_TERMINO && termino.length <= MAX_TERMINO && significado.length <= MAX_SIGNIFICADO) {
      if (!esNombreDelUsuario(termino)) memoriaNueva = { termino, significado };
      else if (NOMBRE_VALIDO_USUARIO.test(significado)) {
        memoriaNueva = { termino: NOMBRE_USUARIO, significado };
        nombreUsuario = significado;
      } else avisos.push('nombre del usuario no válido: se ignora');
    } else if (termino || significado) avisos.push(`memoria_nueva no válida junto a ${datos.intencion}: se ignora`);
  }
  if (datos.intencion === 'recordar') {
    let termino = textoONull(datos.memoria_nueva?.termino);
    const significado = textoONull(datos.memoria_nueva?.significado);
    if (!termino || !significado) fallo('recordar: memoria_nueva necesita termino y significado');
    // El nombre del USUARIO (cómo quiere que le llamen) no es el de la secretaria, aunque llegue justo tras preguntarle el suyo
    // («La reina de España» → «no tú no, yo»)
    if (esNombreDelUsuario(termino)) {
      if (!NOMBRE_VALIDO_USUARIO.test(significado)) fallo(`el nombre no es válido (hasta 60 letras, sin signos raros): ${significado.slice(0, 60)}`);
      memoriaNueva = { termino: NOMBRE_USUARIO, significado };
      nombreUsuario = significado;
    }
    // El nombre de la secretaria vive en la memoria con un término fijo. Si la última pregunta era «¿cómo quieres llamarme?», lo que
    // responda el usuario es ese nombre sea cual sea el término que haya puesto el modelo; también cuando pide cambiárselo.
    // (con la pregunta del nombre abierta solo cuenta como nombre si el término que eligió el modelo habla de un nombre; si no, es otro término)
    const hablaDeNombre = /nombre|secretari|llam|apodo|mote/.test(sinAcentos(termino));
    if (nombreUsuario) {
      // ya resuelto arriba
    } else if ((opciones.esperaNombre && hablaDeNombre) || sinAcentos(termino) === NOMBRE_TERMINO) {
      if (!/^[\p{L}\p{N}][\p{L}\p{N} .'’-]{0,39}$/u.test(significado)) fallo(`el nombre no es válido (hasta 40 letras, sin signos raros): ${significado.slice(0, 60)}`);
      termino = NOMBRE_TERMINO;
      nombreNuevo = significado;
    }
    if (!nombreUsuario) memoriaNueva = { termino, significado };
  }

  let correccion = null;
  if (datos.intencion === 'corregir') {
    const c = datos.correccion;
    if (typeof c !== 'object' || c === null || Array.isArray(c)) fallo('corregir: falta correccion (debe ser un objeto con item_ids y cambios)');
    let ids = c.item_ids;
    if (ids === undefined && typeof c.item_id === 'string') {
      avisos.push('corregir: item_id suelto, se usa como lista de un elemento');
      ids = [c.item_id];
    }
    // Cambiar de tipo: el modelo solo dice a cuál (alarma, cita o tarea) y, si el usuario la dio, la fecha nueva. Las fechas y el tipo los
    // mueve Planificar; los cambios que el modelo ponga además (título…) se respetan. Con convertir_a, "cambios" puede venir vacío.
    const convertir = ['alarma', 'cita', 'tarea'].includes(c.convertir_a) ? c.convertir_a : null;
    if (c.convertir_a != null && c.convertir_a !== '' && !convertir) avisos.push(`correccion.convertir_a "${c.convertir_a}" no es alarma, cita ni tarea: se ignora`);
    const cuando = convertir && textoONull(c.cuando) ? normalizarFecha(c.cuando, 'correccion.cuando') : null;
    const cambiosVacios = c.cambios == null || (typeof c.cambios === 'object' && !Array.isArray(c.cambios) && Object.keys(c.cambios).length === 0);
    correccion = {
      ids: validarIds(ids, refs, 'correccion.item_ids'),
      cambios: convertir && cambiosVacios ? {} : normalizarCambios(c.cambios, config, avisos),
      convertir,
      cuando,
    };
  }

  // Completar (marcar como hecho) y cancelar (anular: pasa a archivado): uno, varios o un filtro ("todas las tareas"). Mismas referencias
  // cortas que corregir. Nada que hacer (lista vacía o ausente) no es un fallo: se contesta con honestidad.
  const seleccion = ['completar', 'cancelar'].includes(datos.intencion) ? normalizarSeleccion(datos[datos.intencion], refs, datos.intencion, config, avisos) : null;

  // Crear o cerrar un proyecto ("crea el proyecto Mudanza", "cierra el proyecto Mudanza")
  let proyecto = null;
  if (datos.intencion === 'proyecto') {
    const p = datos.proyecto && typeof datos.proyecto === 'object' && !Array.isArray(datos.proyecto) ? datos.proyecto : {};
    if (!['crear', 'cerrar'].includes(p.accion)) fallo(`proyecto.accion debe ser crear o cerrar: ${p.accion}`);
    const nombre = normalizarProyecto(p.nombre, config.proyectos, [], 'proyecto.nombre');
    if (!nombre) fallo('proyecto: falta el nombre');
    proyecto = { accion: p.accion, nombre };
  }

  // Ver los archivos ("dime todos los archivos y fotos que tengo", "los pdf", "¿qué hay en Fotos?"). Todos los filtros
  // son opcionales; sin ninguno se enseña todo. La carpeta se valida como la de archivar.
  let filtroArchivos = null;
  if (datos.intencion === 'ver_archivos') {
    const f = typeof datos.ver_archivos === 'object' && datos.ver_archivos !== null && !Array.isArray(datos.ver_archivos) ? datos.ver_archivos : {};
    let carpeta = null;
    if (f.carpeta !== undefined && f.carpeta !== null && f.carpeta !== '') {
      const segs = segmentosCarpeta(f.carpeta);
      if (!segs) fallo(`ver_archivos.carpeta no es una ruta válida (de 1 a ${NIVELES_CARPETA_MAX} niveles, sin barras invertidas ni ".."): ${JSON.stringify(f.carpeta)}`);
      carpeta = segs.join('/');
    }
    let tipo = null;
    if (f.tipo === 'imagen' || f.tipo === 'documento') tipo = f.tipo;
    else if (f.tipo !== undefined && f.tipo !== null && f.tipo !== '') avisos.push(`ver_archivos.tipo "${f.tipo}" no es imagen ni documento: se muestran todos`);
    filtroArchivos = { carpeta, tipo, solo_pendientes: f.solo_pendientes === true, enviar: f.enviar === true };
  }

  // Borrar en Drive: una carpeta (entera, o solo sus archivos) y/o archivos concretos por su referencia
  // (a1…). Aquí solo se valida lo que pide: qué hay dentro lo resuelve «Resultado» con el árbol de Drive y lo enseña antes de borrar nada.
  let borrarDrive = null;
  if (datos.intencion === 'borrar_drive') {
    const b = typeof datos.borrar_drive === 'object' && datos.borrar_drive !== null && !Array.isArray(datos.borrar_drive) ? datos.borrar_drive : {};
    let carpeta = null;
    if (textoONull(b.carpeta)) {
      const segs = segmentosCarpeta(String(b.carpeta).split('/').map((x) => x.trim()).join('/'));
      if (!segs) fallo(`borrar_drive.carpeta no es una ruta válida (de 1 a ${NIVELES_CARPETA_MAX} niveles, sin barras invertidas ni ".."): ${JSON.stringify(b.carpeta)}`);
      carpeta = segs.join('/');
    }
    const refsPedidas = Array.isArray(b.archivos) ? b.archivos.filter((r) => typeof r === 'string') : [];
    const fuera = refsPedidas.filter((r) => !Object.prototype.hasOwnProperty.call(refsArchivos, r));
    if (fuera.length > 0) avisos.push(`borrar_drive.archivos: referencias que no existen (${fuera.join(', ')}): se ignoran`);
    const archivoIds = [...new Set(refsPedidas.filter((r) => !fuera.includes(r)).map((r) => refsArchivos[r]))];
    if (carpeta || archivoIds.length > 0) borrarDrive = { carpeta, archivo_ids: archivoIds, solo_archivos: Boolean(carpeta) && b.solo_archivos === true };
  }

  // Mover carpetas dentro de otra: solo se valida lo que pide; qué carpetas son y si se puede lo resuelve «Revisar Drive»
  let moverCarpeta = null;
  if (datos.intencion === 'mover_carpeta') {
    const m = typeof datos.mover_carpeta === 'object' && datos.mover_carpeta !== null && !Array.isArray(datos.mover_carpeta) ? datos.mover_carpeta : {};
    const limpia = (t) => {
      const segs = typeof t === 'string' ? segmentosCarpeta(t.split('/').map((x) => x.trim()).join('/')) : null;
      return segs ? segs.join('/') : null;
    };
    const lista = Array.isArray(m.origenes) ? m.origenes : typeof m.origen === 'string' ? [m.origen] : [];
    const origenes = [...new Set(lista.map(limpia))];
    const destino = limpia(m.destino);
    if (origenes.length === 0 || origenes.length > 6 || origenes.some((o) => !o) || !destino) {
      fallo(`mover_carpeta necesita de 1 a 6 carpetas de origen y un destino (rutas de 1 a ${NIVELES_CARPETA_MAX} niveles, sin barras invertidas ni ".."): ${JSON.stringify(m).slice(0, 160)}`);
    }
    moverCarpeta = { origenes, destino, crear: m.crear === true };
  }
  // Mover fotos o archivos ya guardados de una carpeta a otra: origen obligatorio y destino
  // opcional (sin él, se le pregunta adónde). Qué archivos son lo decide planMoverArchivos con las carpetas conocidas.
  let moverArchivos = null;
  if (datos.intencion === 'mover_archivos') {
    const m = typeof datos.mover_archivos === 'object' && datos.mover_archivos !== null && !Array.isArray(datos.mover_archivos) ? datos.mover_archivos : {};
    const limpia = (t) => {
      const segs = typeof t === 'string' ? segmentosCarpeta(t.split('/').map((x) => x.trim()).join('/')) : null;
      return segs ? segs.join('/') : null;
    };
    const origen = limpia(m.origen);
    const sinDestino = m.destino === null || m.destino === undefined || m.destino === '';
    const destino = sinDestino ? null : limpia(m.destino);
    // Un archivo concreto por su nombre : nombre y destino, sin carpeta de origen
    const nombre = typeof m.nombre === 'string' && m.nombre.trim() !== '' && m.nombre.length <= 150 && !/[\\/\u0000-\u001f]/.test(m.nombre) ? m.nombre.trim() : null;
    if (nombre) {
      if (!destino) fallo(`mover_archivos con nombre necesita la carpeta de destino: ${JSON.stringify(m).slice(0, 160)}`);
      moverArchivos = { nombre, destino, todos: m.todos === true };
    } else if (m.esos === true) {
      // «Mueve esos archivos a X» : los últimos que movió o guardó la secretaria
      if (!destino) fallo(`mover_archivos de «esos» necesita la carpeta de destino: ${JSON.stringify(m).slice(0, 160)}`);
      moverArchivos = { esos: true, destino };
    } else {
      if (!origen || (!sinDestino && !destino)) fallo(`mover_archivos necesita una carpeta de origen y, si la dice, una de destino (rutas de 1 a ${NIVELES_CARPETA_MAX} niveles): ${JSON.stringify(m).slice(0, 160)}`);
      moverArchivos = { origen, destino, solo_fotos: m.solo_fotos === true };
    }
  }

  // Horario fijo semanal: bloques {titulo, dias (1-7), desde, hasta}; uno por día al guardarlo
  let horarioNuevo = null;
  if (datos.intencion === 'horario') {
    const lista = Array.isArray(datos.horario_nuevo) ? datos.horario_nuevo : [];
    if (lista.length === 0) fallo('horario: falta horario_nuevo (una lista de {titulo, dias, desde, hasta})');
    horarioNuevo = [];
    for (const b of lista.slice(0, 10)) {
      const titulo = textoONull(b?.titulo);
      const dias = Array.isArray(b?.dias) ? [...new Set(b.dias.map(Number))].filter((d) => Number.isInteger(d) && d >= 1 && d <= 7) : [];
      const ini = aMinutos(b?.desde);
      const fin = aMinutos(b?.hasta);
      if (!titulo || titulo.length > 60 || dias.length === 0 || ini === null || fin === null || fin <= ini) fallo(`horario_nuevo no válido (título, días 1-7 y horas HH:MM con el fin después del inicio): ${JSON.stringify(b).slice(0, 160)}`);
      for (const d of dias) horarioNuevo.push({ titulo, dia_semana: d, hora_inicio: hhmm(b.desde), hora_fin: hhmm(b.hasta) });
    }
  }

  // Crear carpetas vacías ("crea la carpeta Proyectos dentro de Trabajo"): una lista de rutas bajo Secretaria/, con las mismas reglas que
  // la carpeta de archivar. Los espacios alrededor de las barras ("Trabajo / Proyectos") se limpian; sin distinguir mayúsculas ni
  // tildes, una ruta repetida cuenta una sola vez.
  let rutasNuevas = null;
  if (datos.intencion === 'crear_carpeta') {
    const c = datos.crear_carpeta;
    const lista = Array.isArray(c) ? c : c?.rutas;
    if (!Array.isArray(lista) || lista.length === 0 || !lista.every((r) => typeof r === 'string')) fallo('crear_carpeta necesita crear_carpeta.rutas, una lista de rutas');
    if (lista.length > MAX_CARPETAS_PEDIDAS) fallo(`crear_carpeta: demasiadas carpetas en un mensaje (máximo ${MAX_CARPETAS_PEDIDAS})`);
    const vistas = new Set();
    rutasNuevas = [];
    for (const r of lista) {
      const segs = segmentosCarpeta(r.split('/').map((s) => s.trim()).join('/'));
      if (!segs) fallo(`crear_carpeta.rutas: ruta no válida (de 1 a ${NIVELES_CARPETA_MAX} niveles, sin barras invertidas ni ".."): ${JSON.stringify(r)}`);
      const ruta = segs.join('/');
      if (!vistas.has(sinAcentos(ruta))) {
        vistas.add(sinAcentos(ruta));
        rutasNuevas.push(ruta);
      }
    }
  }

  const consulta = datos.intencion === 'consultar' ? normalizarConsulta(datos.consulta, config, avisos) : null;

  return { datos: { intencion: datos.intencion, items, pregunta, memoriaNueva, nombreNuevo, nombreUsuario, correccion, seleccion, proyecto, consulta, archivos, filtroArchivos, rutasNuevas, borrarDrive, moverCarpeta, moverArchivos, horarioNuevo, respuestaUsuario }, avisos };
}

// --- Archivos: carpeta pedida, referencias y nombres ---

// Ruta pedida ("Fotos/Viajes") -> ['Fotos', 'Viajes'], o null si no es válida. Las mismas reglas que la restricción
// archivos_carpeta_destino_valida de la base de datos y que el flujo "Sincronizar Drive": de 1 a 3 niveles de 1 a 60 caracteres,
// sin "\" ni caracteres de control, ningún nivel es "." ni "..", y ninguno empieza ni acaba en espacio.
function segmentosCarpeta(texto) {
  if (typeof texto !== 'string') return null;
  const segs = texto.split('/');
  if (segs.length < 1 || segs.length > NIVELES_CARPETA_MAX) return null;
  for (const s of segs) {
    if (s.length < 1 || s.length > 60) return null;
    if (/[\\\u0000-\u001f\u007f]/.test(s)) return null;
    if (s === '.' || s === '..') return null;
    if (s !== s.trim()) return null;
  }
  return segs;
}

// Nombre de archivo apto para Drive: sin caracteres de control ni \ / : * ? " < > |, sin puntos iniciales y de hasta 120
// caracteres conservando la extensión
function nombreSeguro(nombre) {
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

const extensionDe = (n) => /\.([A-Za-z0-9]{1,5})$/.exec(String(n ?? ''))?.[1] ?? '';
// El nombre que pone el sistema al recibir una foto: "2026-10-12 1830 · WhatsApp.jpg" (desde la sección 76, "… · WhatsApp k3f9.jpg")
const NOMBRE_AUTOMATICO = /^(\d{4}-\d{2}-\d{2} \d{4}) · WhatsApp(?: [0-9a-z]{4})?\.[A-Za-z0-9]{1,5}$/;

// Nuevo nombre de cada archivo (o null si se queda como está):
//   - si el usuario da un nombre, ese (con (1), (2)… si son varios) y la extensión de siempre;
//   - si se asocian a un item y el archivo tiene el nombre automático de una foto, "fecha hora · título del item";
//   - en cualquier otro caso se respeta el nombre actual (un PDF con nombre propio no se renombra).
function nombresNuevos(refs, info, { titulo = null, nombre = null }) {
  const total = refs.length;
  return refs.map((r, i) => {
    const actual = String(info[r]?.nombre ?? '');
    const ext = extensionDe(actual);
    const sufijo = total > 1 ? ` (${i + 1})` : '';
    const final = (base) => {
      const limpio = nombreSeguro(base).replace(/\.[A-Za-z0-9]{1,5}$/, (e) => (ext && e.slice(1).toLowerCase() === ext.toLowerCase() ? '' : e));
      return limpio === '' ? null : `${limpio}${sufijo}${ext ? `.${ext}` : ''}`;
    };
    if (nombre) return final(nombre);
    const auto = NOMBRE_AUTOMATICO.exec(actual);
    if (titulo && auto) return final(`${auto[1]} · ${titulo}`);
    return null;
  });
}

// Valida lo que el modelo dice de los archivos. refsArchivos: referencias (a1…) que se le dieron. Devuelve
// { refs, carpeta, nombre } o null (sin archivos).
function normalizarArchivos(a, intencion, refsArchivos, avisos) {
  if (typeof a !== 'object' || a === null || Array.isArray(a)) fallo('archivos no es un objeto');
  if (!Array.isArray(a.refs) || !a.refs.every((r) => typeof r === 'string')) fallo('archivos.refs debe ser una lista de referencias');
  if (a.refs.length === 0) return null;
  if (Object.keys(refsArchivos).length === 0) fallo('archivos: no hay archivos recibidos sobre los que actuar');
  const fuera = a.refs.filter((r) => !Object.prototype.hasOwnProperty.call(refsArchivos, r));
  if (fuera.length) fallo(`archivos.refs: referencias que no están entre los archivos recibidos: ${fuera.join(', ')}`);
  let carpeta = null;
  if (intencion === 'archivar') {
    const segs = segmentosCarpeta(a.carpeta);
    if (!segs) fallo(`archivos.carpeta no es una ruta válida (de 1 a ${NIVELES_CARPETA_MAX} niveles, sin barras invertidas ni ".."): ${JSON.stringify(a.carpeta)}`);
    carpeta = segs.join('/');
  } else if (a.carpeta !== undefined && a.carpeta !== null) {
    avisos.push('archivos.carpeta solo se usa en archivar, se ignora');
  }
  return { refs: [...new Set(a.refs)], carpeta, nombre: textoONull(a.nombre) };
}

function aFila(item, mensajeId, ahora, config) {
  const { espera_archivo, ...resto } = item;
  return {
    mensaje_id: mensajeId,
    ...resto,
    espera_archivo_hasta: espera_archivo ? new Date(ahora.getTime() + config.espera_min * 60000).toISOString() : null,
  };
}

function textoDeRespuesta(resp) {
  if (resp?.error) {
    const e = resp.error;
    return { error: typeof e === 'string' ? e : (e.message ?? JSON.stringify(e)) };
  }
  const texto = (resp?.candidates?.[0]?.content?.parts ?? [])
    .filter((p) => typeof p.text === 'string' && !p.thought)
    .map((p) => p.text)
    .join('');
  if (!texto) return { error: `sin texto en la respuesta: ${JSON.stringify(resp).slice(0, 300)}` };
  return { texto };
}

// --- Agenda: solapes y días ocupados ---
// Regla 1 (bloqueo): un evento no puede coincidir en el tiempo con otro pendiente. Nunca se salta.
// Regla 2 (confirmación): si el día ya tiene eventos o tareas con fecha límite, se muestra y se pregunta si se continúa.
//   Al aceptar, la pregunta guardada lleva motivo "confirmar_agenda" y los días: ese día no se vuelve a preguntar.
// Solo ve lo que pasa por la secretaria (los 200 pendientes más recientes): un evento creado a mano en Google no cuenta.

const DURACION_POR_DEFECTO_MIN = 60;
const esFecha = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const diaMadrid = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date(ms));
const fmtDiaCorto = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', weekday: 'short', day: 'numeric', month: 'short' });
const fmtHoraCorta = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const diaCorto = (ms) => {
  const p = Object.fromEntries(fmtDiaCorto.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.day} ${p.month}`.replace(/\./g, '');
};
const horaCorta = (ms) => fmtHoraCorta.format(new Date(ms));
const limpiarTxt = (s) => String(s ?? '').replace(/[*_~`]/g, '').replace(/\s+/g, ' ').trim();

// Intervalo de un evento en milisegundos; sin fin válido dura DURACION_POR_DEFECTO_MIN (como en Calendar)
function intervalo(inicio, fin) {
  const ini = Date.parse(inicio);
  let f = esFecha(fin) ? Date.parse(fin) : NaN;
  if (!(f > ini)) f = ini + DURACION_POR_DEFECTO_MIN * 60000;
  return { ini, fin: f };
}
// Chocan si se pisan; que uno acabe justo cuando empieza el otro no es un choque
const solapa = (a, b) => a.ini < b.fin && b.ini < a.fin;

// Lo que el usuario ya aceptó en la pregunta anterior (el último turno del hilo es la pregunta guardada, que fabrica este código):
// los días ocupados que aceptó agendar y los proyectos nuevos que aceptó crear. Las listas viajan en cualquiera de las
// preguntas: si una confirmación lleva a otra ("¿Creo el proyecto?" -> "sí" -> "ese día ya tienes…"), lo aceptado antes no se
// vuelve a preguntar (si no, el "sí" reabriría la primera pregunta una y otra vez).
//
// Se leen TODOS los turnos del hilo y no solo el último: si el usuario interrumpe con una pregunta ("¿qué proyectos
// tengo?") el modelo la contesta con su propio turno, que no lleva estas listas, y con "solo el último" se perdía lo que el código
// había preguntado y volvía a preguntar lo mismo. Que el usuario haya aceptado lo
// decide el modelo (regla 11 del prompt: solo guarda si acepta); el código solo recuerda qué se le planteó en este hilo.
// Viajan también los LOTES: los elementos
// que se iba a cancelar o completar de golpe (más de MAX_SIN_CONFIRMAR) o a archivar al cerrar un proyecto, con sus ids reales.
const MOTIVOS_CODIGO = ['confirmar_agenda', 'solape', 'crear_proyecto', 'confirmar_lote', 'repetido', 'convertir_hora', 'elegir_seccion', 'confirmar_horario', 'aviso_compra'];
function confirmacionesDelHilo(hilo) {
  const dias = new Set();
  const proyectos = new Set();
  const repetidos = new Set();
  const horario = new Set();
  const lotes = [];
  const textos = (v) => (Array.isArray(v) ? v.filter((d) => typeof d === 'string') : []);
  for (const turno of Array.isArray(hilo) ? hilo : []) {
    if (turno?.rol !== 'model') continue;
    try {
      const j = JSON.parse(turno.texto);
      if (!MOTIVOS_CODIGO.includes(j?.motivo)) continue;
      textos(j.dias).forEach((d) => dias.add(d));
      textos(j.proyectos).forEach((p) => proyectos.add(sinAcentos(p)));
      textos(j.repetidos).forEach((t) => repetidos.add(sinAcentos(t)));
      textos(j.horario).forEach((h) => horario.add(h));
      for (const l of Array.isArray(j.lotes) ? j.lotes : []) {
        if (l && typeof l.accion === 'string' && Array.isArray(l.ids)) lotes.push({ accion: l.accion, ids: textos(l.ids) });
      }
    } catch {
      // un turno del modelo que no es JSON no confirma nada
    }
  }
  return { dias, proyectos, repetidos, horario, lotes };
}
const diasConfirmados = (hilo) => confirmacionesDelHilo(hilo).dias;

// --- La compra ---
// Todo lo que sea comprar cosas va a la lista de la compra, aunque diga un día («mañana compra pan»): si el modelo lo apunta como tarea
// «Comprar pan y huevos», el código lo pasa a la lista (un elemento por cosa). Si el mensaje dice un día, después de apuntarlo se pregunta
// si se le avisa ese día para ir a comprar («¿Te aviso mañana (mié 21) para ir a comprar? Dime a qué hora.»); la respuesta la resuelve el
// código (respuestaAvisoCompra). Si dice que quiere ir a comprar un día sin decir qué («quiero ir a comprar mañana»), en vez de «¿alarma,
// cita o tarea?» se pregunta directamente lo del aviso.
const ES_COMPRA = /\b(?:compr(?:a|ar|o|amos|ad|e|en|as|arme|arte)|la compra|supermercado|super|mercado)\b/;
const LISTA_COMPRA = 'compra';
const TITULO_COMPRAR = /^comprar\s+(.+)$/i;
const ES_IR_A_COMPRAR = /^(?:ir a )?(?:hacer la )?compra(?:r)?$/;
const capitalizar = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
function aListaDeCompra(items, avisos) {
  const salida = [];
  for (const it of items) {
    const m = it.tipo === 'tarea' && !esFecha(it.recordar_en) ? TITULO_COMPRAR.exec(String(it.titulo).trim()) : null;
    if (!m || ES_IR_A_COMPRAR.test(sinSignos(it.titulo))) {
      salida.push(it);
      continue;
    }
    const cosas = m[1].split(/\s*,\s*|\s+(?:y|e)\s+/).map((c) => c.trim()).filter(Boolean);
    avisos.push(`«${it.titulo}» era una tarea de comprar: pasa a la lista de la compra (${cosas.length})`);
    for (const c of cosas) {
      salida.push({ ...it, tipo: 'lista', lista: LISTA_COMPRA, titulo: capitalizar(c), contenido: null, fecha_limite: null, recordar_en: null, fecha_inicio: null, fecha_fin: null });
    }
  }
  return salida;
}
// El día que dice el mensaje (hora de Madrid): hoy, mañana, pasado (mañana), un día de la semana (el próximo; si es hoy, el de la semana
// que viene) o «el (día) 25». Devuelve { dia: 'AAAA-MM-DD', etiqueta } o null.
const SEMANA = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
function diaDeCompra(mensaje, ahora) {
  const m = ` ${sinSignos(mensaje ?? '')} `;
  const [y, mo, d] = diaMadrid(ahora.getTime()).split('-').map(Number);
  const masDias = (n) => diaMadrid(madridAUtc(y, mo, d + n, 12, 0).getTime());
  const etiquetaDe = (dia, nombre) => {
    const [a, b, c] = dia.split('-').map(Number);
    const corto = diaCorto(madridAUtc(a, b, c, 12, 0).getTime());
    return nombre ? `${nombre} (${corto})` : `el ${corto}`;
  };
  if (/ pasado(?: manana)? /.test(m) && !/ (?:lunes|martes|miercoles|jueves|viernes|sabado|domingo|semana|mes|ano) pasado /.test(m)) {
    const dia = masDias(2);
    return { dia, etiqueta: etiquetaDe(dia, 'pasado mañana') };
  }
  if (/ manana /.test(m.replace(/ (?:por|de) la manana | esta manana /g, ' '))) {
    const dia = masDias(1);
    return { dia, etiqueta: etiquetaDe(dia, 'mañana') };
  }
  if (/ hoy | esta tarde | esta noche /.test(m)) {
    const dia = masDias(0);
    return { dia, etiqueta: etiquetaDe(dia, 'hoy') };
  }
  const ds = / (lunes|martes|miercoles|jueves|viernes|sabado|domingo) /.exec(m);
  if (ds) {
    const hoy = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
    const n = ((SEMANA.indexOf(ds[1]) - hoy + 7) % 7) || 7;
    const dia = masDias(n);
    return { dia, etiqueta: etiquetaDe(dia) };
  }
  const num = / el (?:dia )?(\d{1,2}) /.exec(m);
  if (num && Number(num[1]) >= 1 && Number(num[1]) <= 31) {
    const objetivo = Number(num[1]);
    const n = Array.from({ length: 62 }, (_, i) => i).find((i) => Number(masDias(i).slice(8)) === objetivo);
    if (n !== undefined) {
      const dia = masDias(n);
      return { dia, etiqueta: etiquetaDe(dia) };
    }
  }
  return null;
}
// Sin repetidos en las listas: un elemento que ya está pendiente en la MISMA lista (o repetido en el
// mismo mensaje) no se vuelve a guardar. Iguales sin mayúsculas, tildes, artículos («la leche» = «leche») ni plural simple («huevo» =
// «huevos», «limón» = «limones»). Devuelve { items, repetidos: [{ titulo, lista }] } (los que ya estaban).
const ARTICULO_LISTA = /^(?:un|una|unos|unas|el|la|los|las|lo|algo de|mas|otra|otro|otras|otros)\s+/;
const palabrasLista = (t) => sinAcentos(t).replace(/[^a-z0-9n ]/g, ' ').replace(/\s+/g, ' ').trim().replace(ARTICULO_LISTA, '').split(' ').filter(Boolean);
const mismaPalabra = (a, b) => a === b || `${a}s` === b || `${b}s` === a || `${a}es` === b || `${b}es` === a;
function mismoElemento(a, b) {
  const x = palabrasLista(a);
  const y = palabrasLista(b);
  return x.length > 0 && x.length === y.length && x.every((p, i) => mismaPalabra(p, y[i]));
}
function quitarRepetidosDeLista(items, pendientes) {
  const enLista = (Array.isArray(pendientes) ? pendientes : []).filter((r) => r && r.tipo === 'lista' && typeof r.titulo === 'string');
  const vistos = [];
  const repetidos = [];
  const salida = [];
  for (const it of items) {
    if (it.tipo !== 'lista') {
      salida.push(it);
      continue;
    }
    const lista = sinAcentos(it.lista ?? '');
    // Se enseña el nombre que ya tiene en la lista («Leche»), no como lo escribió ahora («la leche»)
    const existente = enLista.find((r) => sinAcentos(r.lista ?? '') === lista && mismoElemento(r.titulo, it.titulo))
      ?? vistos.find((v) => v.lista === lista && mismoElemento(v.titulo, it.titulo));
    if (existente) repetidos.push({ titulo: existente.titulo, lista: it.lista ?? '' });
    else {
      vistos.push({ lista, titulo: it.titulo });
      salida.push(it);
    }
  }
  return { items: salida, repetidos };
}
const enumerar = (xs) => xs.map((t) => limpiarTxt(capitalizar(String(t)))).join(', ');
// La confirmación cuando el código ha cambiado lo que propuso el modelo (pasar a la lista o quitar repetidos): la frase del modelo ya no vale
function textoCompraGuardada(items, repetidos, nombreLista) {
  const deLista = items.filter((it) => it.tipo === 'lista');
  const otros = items.filter((it) => it.tipo !== 'lista');
  const enLa = nombreLista === LISTA_COMPRA ? 'la lista de la compra' : `la lista «${limpiarTxt(nombreLista)}»`;
  const lineas = [];
  if (deLista.length > 0) lineas.push(`🛒 Apuntado en ${enLa}: ${enumerar(deLista.map((it) => it.titulo))}.`);
  if (repetidos.length > 0) {
    const nombres = enumerar(repetidos.map((r) => r.titulo));
    lineas.push(deLista.length > 0 ? `Ya estaban: ${nombres}.` : otros.length > 0 ? `Ya estaban en ${enLa}: ${nombres}.` : `Ya lo tenías todo en ${enLa}: ${nombres}.`);
  }
  if (otros.length > 0) lineas.push(`Apuntado también: ${otros.map((it) => `«${limpiarTxt(it.titulo)}»`).join(', ')}.`);
  return lineas.join('\n');
}
const textoAvisoCompra = (etiqueta) => `¿Te aviso ${etiqueta} para ir a comprar? Dime a qué hora (o «no»).`;
const turnoAvisoCompra = (aviso, texto) =>
  JSON.stringify({ intencion: 'aclarar', motivo: 'aviso_compra', origen: 'codigo', aviso_compra: aviso, pregunta: texto, items: [], respuesta_usuario: texto });

// --- Comandos y ayuda ---
// Los comandos empiezan por «/», se escriben en inglés (/help, /about, /manual…) y su contenido está en español. Los resuelve este código, sin el modelo:
// es más fiable y no cuesta nada. Dos clases:
//   - de TEXTO: ayuda fija (/help, /about, /manual, /examples, /name);
//   - ATAJOS (/pending, /today, /files, /folders): se convierten en la respuesta que daría el modelo y siguen por el mismo camino de validación.
// También se reconocen las frases de quien está perdido («ayuda», «estoy perdido», «qué puedes hacer»…) y, con el modelo, la intención «ayuda».
// Un comando NUNCA cierra una pregunta que haya quedado pendiente: se contesta y todo sigue como estaba.

const LIMITE_AYUDA = 3800;

const COMANDOS = [
  ['help', 'Esta lista de comandos', 'aprender'],
  ['about', 'Qué soy y para qué sirvo', 'aprender'],
  ['manual', 'Guía de uso por temas (/manual agenda, /manual archivos…)', 'aprender'],
  ['examples', 'Frases de ejemplo que entiendo', 'aprender'],
  ['pending', 'Lo que tienes pendiente (/pending completo: con todo el detalle)', 'atajos'],
  ['today', 'Lo de hoy', 'atajos'],
  ['files', 'Tus archivos y fotos, con su enlace', 'atajos'],
  ['folders', 'Tus carpetas de Drive', 'atajos'],
  ['projects', 'Tus proyectos', 'atajos'],
  ['name', 'Mi nombre y cómo cambiarlo', 'atajos'],
  ['memory', 'Lo que recuerdo de ti, numerado', 'atajos'],
  ['forget', 'Olvidar un dato de mi memoria: /forget 2 (el número de /memory)', 'atajos'],
  ['schedule', 'Tu horario fijo (/horario quitar 2 para quitar un bloque)', 'atajos'],
];
// Alias en español, por si se escriben sin pensar (el comando oficial es el inglés)
const ALIAS_COMANDO = {
  ayuda: 'help', comandos: 'help', commands: 'help', menu: 'help', menú: 'help', start: 'help', inicio: 'help',
  info: 'about', acerca: 'about', quien: 'about',
  manuales: 'manual', guia: 'manual', guía: 'manual',
  ejemplos: 'examples', example: 'examples',
  pendiente: 'pending', pendientes: 'pending',
  hoy: 'today',
  archivos: 'files', file: 'files', fotos: 'files',
  carpetas: 'folders', folder: 'folders',
  proyectos: 'projects', project: 'projects',
  nombre: 'name',
  memoria: 'memory', recuerdos: 'memory', recuerdas: 'memory',
  olvidar: 'forget', olvida: 'forget', olvidalo: 'forget',
  horario: 'schedule', horarios: 'schedule',
};

const TEXTO_AYUDA =
  '*Comandos* (empiezan por /)\n' +
  'Puedes escribirme con tus palabras; estos atajos son opcionales:\n\n' +
  '*Para aprender*\n' +
  COMANDOS.filter((c) => c[2] === 'aprender').map((c) => `/${c[0]} — ${c[1]}`).join('\n') +
  '\n\n*Atajos*\n' +
  COMANDOS.filter((c) => c[2] === 'atajos').map((c) => `/${c[0]} — ${c[1]}`).join('\n');

const textoAbout = (nombre) =>
  [
    `*Qué soy*\nSoy tu secretaria personal por WhatsApp${nombre ? ` y me llamo ${nombre}` : ''}. Me mandas texto, audios y fotos y lo ordeno en su sitio.`,
    '*Qué puedo hacer por ti*\n' +
      '📅 *Citas*: «dentista el jueves a las 10»\n' +
      '🔔 *Alarmas*: «avísame en 20 minutos de lo del horno»\n' +
      '✅ *Tareas*: «entregar el informe el viernes»\n' +
      '📁 *Proyectos*: «proyecto Mudanza: llamar al casero»\n' +
      '🛒 *Listas*: «añade leche y huevos a la compra»\n' +
      '📝 *Notas*: ideas y cosas que no quieres olvidar\n' +
      '📎 *Archivos*: fotos y documentos en carpetas de Drive\n' +
      '🔎 *Consultas*: «qué tengo pendiente», «qué tengo mañana»',
    '*Además*\n' +
      '• Cada mañana te mando un resumen.\n' +
      '• Recuerdo lo que me cuentes de ti: /memory.\n' +
      '• Conozco tu horario fijo: /horario.\n' +
      '• Si cambias algo a mano en Drive o en Google Calendar, te lo cuento.\n' +
      '• Borro carpetas y archivos de Drive si me lo pides, con confirmación (van a la papelera).\n\n' +
      'Escribe /help para los comandos y /manual para la guía completa.',
  ];

const MANUAL = {
  agenda: {
    titulo: 'Agenda: citas, alarmas y recordatorios',
    texto:
      '*Citas*\n• «dentista el jueves a las 10». Si falta la hora, te la pregunto. Por defecto dura 1 hora; si dura otra cosa: «dura 2 horas».\n' +
      '• Va a tu calendario «Secretaria» y te aviso 30 minutos antes.\n' +
      '• Si ya hay algo a esa hora, no la agendo y te digo con qué choca.\n' +
      '• Cambiar: «pasa el dentista al viernes a las 11». Quitar: «quita la cita del dentista».\n' +
      '• Horario fijo: «trabajo los viernes de 16 a 20», «voy a natación lunes y miércoles de 19 a 20». Si una cita cae dentro, te pregunto antes. /horario para verlo y /horario quitar 2 para quitar un bloque.\n\n' +
      '*Alarmas*\n• Todo lo que ocurre entre ahora y las 02:00 de mañana (por ejemplo «cortarme el pelo en 2 horas») es una alarma 🔔: no va a Google Calendar y te aviso 1 hora antes, 30 minutos antes y a la hora.\n' +
      '• Lo que sea para más adelante es una cita, aunque lo digas de otra manera.',
  },
  tareas: {
    titulo: 'Tareas',
    texto:
      '• «entregar el informe el viernes» → tarea con fecha límite. Sin fecha también vale: «llamar al banco».\n' +
      '• Cuando la hagas: «ya entregué el informe» (la marco como hecha).\n' +
      '• Para verlas: /pending o «qué tengo pendiente». Si tienes algo atrasado, te lo recuerdo en el resumen de la mañana.',
  },
  proyectos: {
    titulo: 'Proyectos',
    texto:
      '• «proyecto Mudanza: llamar al casero y pedir cajas» → dos tareas del proyecto Mudanza. Si el proyecto no existe, lo creo.\n' +
      '• «crea el proyecto Web del club» (vacío) y luego «para el proyecto Web del club: comprar el dominio».\n' +
      '• Las *Tareas* son las del día a día; lo de cada proyecto sale aparte, en *Proyectos*.\n' +
      '• Ver: «qué tengo del proyecto Mudanza» o /projects (todos, con lo pendiente de cada uno).\n' +
      '• Mover algo a un proyecto: «mete lo del casero en el proyecto Mudanza».\n' +
      '• Cerrar: «cierra el proyecto Mudanza» (quita también sus cosas pendientes; si te equivocas, «deshaz»).',
  },
  listas: {
    titulo: 'Listas',
    texto:
      '• «añade leche y huevos a la compra» (cada cosa se apunta por separado). Comprar siempre va a la lista de la compra, aunque digas un día («mañana compra pan»).\n' +
      '• Si algo ya estaba en la lista, no lo repito: te digo qué apunté y qué ya estaba.\n' +
      '• «qué hay en la compra».\n• «ya compré la leche» la quita de la lista.',
  },
  notas: {
    titulo: 'Notas',
    texto:
      '• «idea: probar el nuevo gimnasio» o «nota: la contraseña del wifi está en el router».\n' +
      '• Aparecen en tu lista de pendientes como *Pensamientos*: «quita todos los pensamientos» las quita todas.\n' +
      '• Si algo es para hacer («tengo que…», «llamar a…»), lo guardo como tarea, no como nota.',
  },
  archivos: {
    titulo: 'Archivos y fotos',
    texto:
      '• Mándame una foto o un documento: lo guardo en *Entrada* de Drive y te lo confirmo.\n' +
      '• Para clasificarlo, *responde a su foto* (o a mi confirmación) con, por ejemplo, «guárdala en Fotos/Viajes» o «es la factura de la luz». También en bloque: «las 3 últimas a Fotos».\n' +
      '• O escríbelo directamente en el *pie de la foto*: si pones una ruta («Fotos/Viajes») la guardo ahí sin preguntarte.\n' +
      '• Para recibirlos: «dame las fotos» (te las mando), «dime qué archivos tengo» o /files (la lista con enlaces).\n' +
      '• Si mandas varias seguidas, te contesto con un solo mensaje, y «ponlo en Budapest» (sin citar nada) vale para todas.\n' +
      '• Si la carpeta no existe pero hay una parecida («Budapest» y ya tienes «Viajes/Budapest»), te pregunto dónde: contesta con el número.\n' +
      '• Para cambiar de carpeta las ya guardadas, también con un audio: «mueve las fotos de Budapest a Viajes/Budapest» («los archivos» son todos) o «mueve todo lo de Notas a Budapest». Uno solo, con su nombre exacto: «mueve 2026-10-23 1504 · WhatsApp k3f9.jpg a Notas». Y los que acabo de mover o guardar: «muévelos a Viajes» o «mueve esos archivos a Viajes». Si te equivocas, justo después: «déjalo como estaba» o «deshaz».\n' +
      '• Nada se clasifica solo: lo que no clasifiques sigue en Entrada y te lo recuerdo.',
  },
  drive: {
    titulo: 'Carpetas de Drive',
    texto:
      '• «crea la carpeta Proyectos dentro de Trabajo» (hasta 3 niveles). Para ver todas: /folders.\n' +
      '• Mover una carpeta dentro de otra: «mete la carpeta Viajes dentro de Fotos» o «mueve Budapest a Viajes». Varias a la vez: «crea la carpeta Viajes y mete dentro Budapest y Roma». Va con todo lo que tenga dentro. No se mueven Entrada ni Notas, ni puede quedar a más de 3 niveles.\n' +
      '• Si te propongo algo («¿Paso los archivos de «Budapest» a «Viajes/Budapest»?»), basta con «sí».\n' +
      '• Lo que pides se ve en Drive en unos segundos. Si al mover sus archivos una carpeta se queda vacía, la mando a la papelera (nunca Entrada ni Notas).\n' +
      '• Borrar: «borra la carpeta Fotos/Viajes», «vacía la carpeta Facturas» (quita lo de dentro y deja la carpeta), «borra la foto del DNI». Te enseño lo que se borraría y solo lo mando a la papelera de Drive si me dices que sí (se recupera unos 30 días). Entrada y Notas no se borran enteras.\n' +
      '• Si cambias algo a mano en Drive, lo anoto y te aviso.',
  },
  avisos: {
    titulo: 'Avisos y resumen',
    texto:
      '• Cada mañana a las 7:00 te mando un resumen (citas de hoy, alarmas, tareas, notas, listas y archivos sin clasificar).\n' +
      '• Te aviso antes de tus citas y a las horas de tus alarmas.\n' +
      '• Importante: WhatsApp solo me deja escribirte yo primero si tú me has escrito en las últimas 23 horas. Si no, mi aviso espera a que me escribas.\n' +
      '• Si algo falla o se atasca, te lo digo.',
  },
  cambios: {
    titulo: 'Corregir, completar y cancelar',
    texto:
      '• Corregir: «cambia la hora del dentista a las 11», «el título es otro», «mételo en el proyecto Mudanza».\n' +
      '• Añadir detalles sin borrar lo que había: «añade a la tarea del banco que lleve el DNI».\n' +
      '• Completar: «ya compré la leche», «ya entregué el informe». Todo de golpe: «ya hice todas las tareas».\n' +
      '• Cancelar: «quita la cita de mañana», «olvida lo de la leche». Si solo hay una que encaje, la quito sin preguntar; si hay varias, te pregunto cuál. Todo de golpe: «quita todos los pensamientos», «vacía la lista de la compra».\n' +
      '• Quitar es inmediato y sin preguntar, y te digo lo que he quitado: una cosa, una sección, varias («borra las alarmas y las tareas») o todo («borra todo»).\n' +
      '• Si te equivocas: «deshaz» recupera lo último que quitaste (todo de una vez) y «recupera la tarea del banco» algo concreto de los últimos 7 días. Solo vale para lo que quitaste desde que existe el deshacer.\n' +
      '• Ver los detalles de algo: «qué apunté del casero», «enséñame el contenido de la tarea del banco».\n' +
      '• Todo con todos los detalles: «dámelo todo completo» o /pending completo.\n' +
      '• Si no estoy segura de a cuál te refieres, te pregunto.\n' +
      '• Si te pregunto algo (por ejemplo «¿la apunto igualmente?») y me escribes otra cosa sin contestar, no apunto lo que estaba pendiente y te lo digo.\n' +
      '• Puedes responder citando cualquiera de mis mensajes (con texto o con un audio): así sé a cuál te refieres («cámbialo a las 6», «sí, apúntala»). Vale para los mensajes que te mande de ahora en adelante.',
  },
  memoria: {
    titulo: 'Lo que recuerdo de ti',
    texto:
      '• Si me cuentas algo que no cambia («Emma es mi hermana», «vivo en Granada»), lo recuerdo y te lo digo con 📌.\n' +
      '• Un horario semanal con días y horas («trabajo los viernes de 16 a 20») no va aquí: va a tu horario fijo (/horario).\n' +
      '• «Llámame Ana»: así te llamaré. «Te llamas Lola»: es mi nombre.\n' +
      '• Ver lo que recuerdo: /memory o «qué sabes de mí» (una lista numerada).\n' +
      '• Olvidar un dato: /forget y su número (/forget 2), o «borra de tu memoria lo de Emma» (te pregunto antes).\n' +
      '• «Olvida lo de la leche» sin decir «memoria» es quitar una tarea o una nota, no un dato.\n' +
      '• Recuerdo como mucho 50 datos. Mi nombre no lo olvido: se cambia.',
  },
};
const TEMAS_MANUAL = Object.keys(MANUAL);

const TEXTO_EJEMPLOS =
  '*Frases que entiendo*\n' +
  '• dentista el jueves a las 10\n' +
  '• avísame en 20 minutos de sacar la ropa\n' +
  '• entregar el informe el viernes\n' +
  '• proyecto Mudanza: llamar al casero y pedir cajas\n' +
  '• añade leche y huevos a la compra\n' +
  '• idea: probar el nuevo gimnasio\n' +
  '• es la factura de la luz (respondiendo a una foto o a un PDF)\n' +
  '• qué tengo pendiente · qué tengo mañana · qué hay en la compra\n' +
  '• pasa el dentista al viernes a las 11\n' +
  '• quita la cita de mañana\n' +
  '• ya compré la leche\n' +
  '• añade a la tarea del banco que lleve el DNI\n' +
  '• quita todos los pensamientos\n' +
  '• guárdala en Fotos/Viajes (respondiendo a una foto), o escribe Fotos/Viajes en el pie de la foto\n' +
  '• dame las fotos de Viajes\n' +
  '• crea la carpeta Proyectos dentro de Trabajo\n' +
  '• borra la carpeta Fotos/Viajes (te enseño lo que hay y te pregunto)\n' +
  '• llámate Marta (para cambiarme el nombre) · llámame Ana\n' +
  '• para que lo sepas: Emma es mi hermana · qué sabes de mí\n' +
  '• trabajo los viernes de 16 a 20 (tu horario fijo)\n\n' +
  'Y si no sabes cómo decirlo, dilo como te salga: te preguntaré lo que me falte.';

const textoManualIndice = () =>
  '*Manual*\nElige un tema con /manual y su nombre, por ejemplo /manual agenda:\n' +
  TEMAS_MANUAL.map((t) => `• ${t} — ${MANUAL[t].titulo}`).join('\n') +
  '\n• todo — el manual entero\n\nTambién tienes /about (qué soy) y /examples (frases de ejemplo).';

const textoName = (nombre) =>
  nombre
    ? `Me llamo ${nombre}.`
    : 'Todavía no me has puesto nombre.';

// Quita acentos, signos y mayúsculas para comparar frases de ayuda
const sinSignos = (s) => sinAcentos(s).replace(/[¿?¡!.,;:()"«»]/g, ' ').replace(/\s+/g, ' ').trim();
const FRASES_AYUDA = new Set([
  'ayuda', 'ayuda por favor', 'necesito ayuda', 'ayudame', 'ayudame por favor', 'help', 'menu', 'comandos', 'instrucciones', 'socorro', 'auxilio',
  'no se que hacer', 'no se que puedo hacer', 'no se que decir', 'no se como funciona', 'no se usarte', 'no se como usarte',
  'estoy perdido', 'estoy perdida', 'me he perdido', 'me he perdido un poco', 'no entiendo', 'no entiendo nada', 'no entiendo como funciona',
  'como funciona', 'como funcionas', 'como se usa', 'como te uso', 'como te utilizo', 'que comandos hay', 'que comandos tienes', 'lista de comandos', 'ver comandos', 'muestrame los comandos',
]);
// Preguntar el nombre de la secretaria: lo contesta el código con el nombre guardado (como /name). El modelo no tiene una intención para esto.
const FRASES_NOMBRE = new Set([
  'como te llamas', 'como te llamabas', 'como se llama', 'como se llama la secretaria', 'cual es tu nombre', 'como es tu nombre', 'tu nombre',
  'tienes nombre', 'como te llamo', 'como te puedo llamar', 'como debo llamarte', 'como quieres que te llame', 'te acuerdas de tu nombre',
  'sabes como te llamas', 'dime tu nombre', 'cual era tu nombre',
  'cual es su nombre', 'como es su nombre', 'su nombre', 'como se llama usted', 'como te llamas tu', 'tu como te llamas', 'cual es tu nombre ahora',
  'como te llamas ahora', 'cual es el nombre de la secretaria', 'recuerdas tu nombre', 'sabes tu nombre', 'que nombre tienes', 'tienes algun nombre',
]);
// Saludos y muletillas al principio que no cambian la pregunta del nombre («hola, ¿cómo te llamas?», «oye y tú cómo te llamas»)
const SALUDO_INICIAL = /^(?:(?:hola|holi|oye|buenas|buenos dias|buenas tardes|buenas noches|hey|ey|y|vale|bueno|perdona|por cierto|una pregunta)\s+)+/;
// Ponerle o cambiarle el nombre («llámate Lola», «te llamas Lola», «tu nombre es Lola»): lo aplica el código, sin depender del modelo. Si es una
// pregunta («¿te llamas Lola?»), se contesta con el nombre que tiene.
const PONER_NOMBRE = /^\s*¿?\s*(?:ll[aá]mate|te llamas|te llamar[aá]s|tu nombre (?:es|ser[aá])|a partir de ahora te llamas|desde ahora te llamas|quiero que te llames|ahora te llamas)\s+(.+?)[\s.!?]*$/iu;
const NOMBRE_VALIDO = /^[\p{L}\p{N}][\p{L}\p{N} .'’-]{0,39}$/u;

const FRASES_ABOUT = new Set([
  'que puedes hacer', 'que sabes hacer', 'que puedes hacer por mi', 'que sabes', 'para que sirves', 'para que sirve esto', 'para que sirve', 'que eres', 'quien eres', 'que haces',
  'que funciones tienes', 'que funcionalidades tienes', 'que haces tu', 'que eres capaz de hacer',
]);

// La memoria permanente: verla y olvidar un dato se resuelven sin el modelo. Para olvidar con palabras hay que nombrar la memoria
// («borra de tu memoria lo del trabajo», «olvida el dato del trabajo»): «olvida lo de la leche» a secas es quitar una tarea o una nota.
const FRASES_MEMORIA = new Set([
  'que recuerdas de mi', 'que sabes de mi', 'que sabes sobre mi', 'que recuerdas sobre mi', 'que guardas de mi', 'dime que sabes de mi',
  'que tienes en la memoria', 'que tienes en tu memoria', 'que hay en tu memoria', 'que hay en la memoria', 'que recuerdas', 'que te acuerdas de mi',
  'ensename tu memoria', 'muestrame tu memoria', 'dime tu memoria', 'tu memoria', 'memoria', 'ver memoria', 'ver tu memoria', 'mi memoria',
]);
const FRASES_HORARIO = new Set(['mi horario', 'que horario tengo', 'cual es mi horario', 'ensename mi horario', 'muestrame mi horario', 'dime mi horario', 'horario', 'ver horario', 'ver mi horario']);
const OLVIDAR_MEMORIA = /^(?:por favor )?(?:olvida|olvidate|borra|quita|elimina)(?:r|me)? (?:de (?:tu|la) memoria|del? (?:tu|la) memoria|el dato|ese dato|de lo que (?:recuerdas|sabes) de mi) (?:(?:lo )?(?:del|de|que|sobre) )?(.+)$/;

// Las preguntas más corrientes sobre lo pendiente se resuelven aquí con una consulta SIN filtros, igual que /pending y /today: no dependen de que el modelo
// las interprete bien (si añadía un filtro, "nada pendiente" salía como "nada con esos criterios").
const FRASES_PENDIENTE = new Set([
  'que tengo pendiente', 'que tengo pendiente ahora', 'que tengo', 'que pendientes tengo', 'que tengo por hacer', 'que me queda por hacer', 'que me falta por hacer',
  'que me queda', 'pendientes', 'mis pendientes', 'lo pendiente', 'dime lo pendiente', 'dime mis pendientes', 'que hay pendiente', 'tengo algo pendiente', 'tengo algo pendiente ahora',
]);
// «Dámelo todo completo»: lo pendiente entero, con todo el detalle de cada elemento (el contenido entero). Lo
// decide el código, no el modelo: sin memoria de la conversación, una frase así suelta el modelo no sabe a qué se refiere.
const PEDIR_COMPLETO = /\b(complet[oa]s?|enter[oa]s?|detallad[oa]s?|con (todo el |todos los )?detalles?|todo el contenido|sin (cortar|resumir|recortar))\b/;
// Se compara con un espacio delante (« dame todo completo»): así cada palabra opcional lleva su espacio y «completo» suelto también vale
const FRASE_TODO_COMPLETO = /^( dame| damelo| damela| damelos| dimelo| ensename| ensenamelo| muestrame| muestramelo| pasame| pasamelo| ponmelo| quiero| quiero verlo| lo quiero| y)?( lo| la| los| las)?( todo| toda| todos| todas)?( lo pendiente| mis pendientes| las tareas| mis tareas| la lista| el listado)?( completo| completa| completos| completas| entero| entera| con todo el detalle| con detalle| detallado| sin cortar| sin resumir)$/;
// «Dame todo» (sin «completo»): lo mismo que /pending. Hace falta un verbo delante: un «todo» suelto puede ser la respuesta a otra pregunta.
const FRASE_TODO_SUELTO = /^ (dame|damelo|dimelo|dime|ensename|ensenamelo|muestrame|muestramelo|pasame|pasamelo|ponme|ponmelo|quiero ver) (lo )?todo( lo que (tengo|hay)( pendiente)?)?$/;
// Un archivo con pie de texto, o una respuesta a su confirmación, que es SOLO una ruta de carpeta («Fotos/Viajes», «guárdala en Trabajo/Informes»): se archiva
// por código, sin el modelo y sin preguntar. Hace falta un archivo citado y una «/» (un nombre suelto como «Fotos» puede ser también una descripción:
// ese caso lo decide el modelo). Devuelve { ruta, refs } o null.
const VERBOS_ARCHIVAR = '(?:guarda|guardala|guardalo|guardalas|guardalos|mueve|muevela|muevelo|muevelas|muevelos|pon|ponla|ponlo|ponlas|ponlos|archivala|archivalo|archivalas|archivalos|metela|metelo|metelas|metelos|llevala|llevalo|llevalas|llevalos)';
const PREFIJO_ARCHIVAR = new RegExp(`^(?:${VERBOS_ARCHIVAR}\\s+)?(?:(?:en|a|dentro de|hacia)\\s+)?(?:la\\s+)?(?:carpeta\\s+)?`);
function interpretarCarpetaSuelta(mensaje, refsCitados) {
  if (!Array.isArray(refsCitados) || refsCitados.length === 0 || typeof mensaje !== 'string') return null;
  const t = mensaje.normalize('NFC').trim();
  if (t === '' || t.length > 200) return null;
  const base = sinAcentos(t).toLowerCase();
  if (base.length !== t.length) return null; // sin correspondencia carácter a carácter no se corta por posición
  const prefijo = PREFIJO_ARCHIVAR.exec(base)[0];
  // En un audio la «/» se dice «barra» («Fotos barra Viajes») y la transcripción la escribe como palabra
  const resto = t.slice(prefijo.length).replace(/[\s.!,;:]+$/, '').replace(/^[«"“']+|[»"”']+$/g, '').replace(/\s+(?:barra|slash)\s+/gi, '/').trim();
  if (!resto.includes('/')) return null;
  const trozos = resto.split('/').map((s) => s.trim());
  // Un nombre de carpeta es corto: una frase entera con una «/» («mañana tengo reunión en Trabajo/Informes», «qué hay en Fotos/Viajes») no es una ruta.
  // Sin verbo ni preposición delante («Fotos/Viajes» a secas) se exige más: el primer tramo, de hasta 3 palabras y sin empezar por una pregunta u orden.
  const maxPalabras = prefijo === '' ? 3 : 4;
  if (trozos.some((s, k) => s.split(/\s+/).length > (k === 0 ? maxPalabras : 4)) || trozos.join(' ').split(/\s+/).length > 8) return null;
  if (prefijo === '' && /^(?:que|como|cuando|donde|cual|cuales|quien|hay|tengo|tienes|dime|ensename|muestrame|borra|elimina|quita|crea|haz|apunta|recuerdame|manana|hoy|ayer)\b/.test(sinAcentos(trozos[0]).toLowerCase())) return null;
  const segs = segmentosCarpeta(trozos.join('/'));
  if (!segs) return null;
  return { ruta: segs.join('/'), refs: [...new Set(refsCitados)] };
}
// Pide el detalle completo (vale para cualquier consulta: «qué tengo pendiente completo», «las tareas del banco enteras»)
const pideCompleto = (mensaje) => PEDIR_COMPLETO.test(sinSignos(mensaje ?? ''));

const FRASES_HOY = new Set([
  'que tengo hoy', 'que hay para hoy', 'que tengo para hoy', 'que tengo que hacer hoy', 'que hago hoy', 'agenda de hoy', 'mi agenda de hoy', 'lo de hoy', 'que hay hoy', 'tengo algo hoy',
]);

// «Qué proyectos / alarmas / citas / tareas / pensamientos / listas tengo»: la lista de eso y NADA más, resuelta por código (sin modelo y sin
// detalle). Solo las frases cortas que son exactamente eso; con cualquier otra palabra («tareas del proyecto Mudanza») decide el modelo.
const LISTA_DE = /^(?:(?:que|cuales|dime|dame|ensename|muestrame|lista(?: de)?|ver)\s+)?(?:(?:mis|las|los|todas las|todos los|todas mis|todos mis)\s+)?(proyectos|alarmas|citas|eventos|tareas|notas|pensamientos|ideas|listas)(?:\s+(?:tengo|hay|tienes|guardad[oa]s|pendientes|activ[oa]s))*$/;
const ATAJO_LISTA = {
  proyectos: { intencion: 'proyectos' },
  alarmas: { intencion: 'consultar', consulta: { tipo: 'tarea', vista: 'alarmas', estado: 'pendiente' } },
  citas: { intencion: 'consultar', consulta: { tipo: 'evento', estado: 'pendiente' } },
  eventos: { intencion: 'consultar', consulta: { tipo: 'evento', estado: 'pendiente' } },
  tareas: { intencion: 'consultar', consulta: { tipo: 'tarea', vista: 'tareas', estado: 'pendiente' } },
  notas: { intencion: 'consultar', consulta: { tipo: 'nota', estado: 'pendiente' } },
  pensamientos: { intencion: 'consultar', consulta: { tipo: 'nota', estado: 'pendiente' } },
  ideas: { intencion: 'consultar', consulta: { tipo: 'nota', estado: 'pendiente' } },
  listas: { intencion: 'consultar', consulta: { tipo: 'lista', estado: 'pendiente' } },
};

// --- Mover carpetas dentro de otra : «mete la carpeta Viajes dentro de Fotos» ---
// Se reconoce por código (texto o audio). Formas admitidas:
//   · «mete la carpeta A dentro de B», «mueve las carpetas A y B a C», «pon las carpetas A, B y C en D»
//   · «mete dentro de B las carpetas A y C» (el destino primero)
//   · «crea una carpeta llamada B y mete dentro A y C» (crea B si no existe y mete A y C dentro)
// Siempre con la palabra «carpeta»: «mete las fotos en Viajes» es archivar y lo decide el modelo. Las carpetas se separan con «y», «e» o comas;
// un nombre con esas palabras va entre «comillas» o se da con su ruta. Qué carpeta es cada una y si se puede lo resuelve «Revisar Drive» con el
// árbol real. «Cambia» y «renombra» no mueven (podría ser un renombrado).
const VERBO_MOVER = '(?:mueve|muevas|mover|muevela|muevelas|muevelo|muevelos|mete|metas|meter|metela|metelas|metelo|metelos|pon|pongas|poner|ponla|ponlas|ponlo|ponlos|pasa|pases|pasala|pasalas|pasalo|pasalos|coloca|coloques|colocala|colocalas|colocalo|colocalos|lleva|lleves|llevala|llevalas|llevalo|llevalos)';
const PREFIJO_MOVER = '^(?:(?:por favor|oye|eh|pues|venga|hola|ahora|vale|bueno)[ ,]+|(?:no|si|nada|claro|vale|bueno), ?)*(?:(?:quiero|necesito) que |me gustaria que |puedes |podrias )?';
const ENLACE_MOVER = '(?:dentro de|dentro|debajo de|bajo|hacia|en|a)';
const ARTICULO_MOVER = '(?:las |los |la |el )?';
const MOVER_LISTA = new RegExp(`${PREFIJO_MOVER}${VERBO_MOVER} ${ARTICULO_MOVER}carpetas? (.+) ${ENLACE_MOVER} ${ARTICULO_MOVER}(?:carpeta )?(.+)$`, 'd');
const MOVER_CREANDO = new RegExp(`${PREFIJO_MOVER}(?:crea|creas|crees|crear|haz|hagas|hacer|genera|generes)(?:me)? (?:una |la |otra )?carpeta (?:llamada |que se llame |que se llama |de nombre |con el nombre )?(.+?) (?:y luego |y despues |y ahora |y |e |, )${VERBO_MOVER} (?:ahi dentro |ahi |dentro de ella |dentro |en ella |en esa )?${ARTICULO_MOVER}(?:carpetas? )?(?:de )?(.+)$`, 'd');
const MOVER_DESTINO_PRIMERO = new RegExp(`${PREFIJO_MOVER}${VERBO_MOVER} (?:dentro de |en )${ARTICULO_MOVER}(?:carpeta )?(.+?) (?:las |los |la |el )carpetas? (?:de )?(.+)$`, 'd');
const ENLACE_SUELTO = '(?:a dentro de|adentro de|dentro de|al interior de|debajo de|en|a)';
const MOVER_SUELTO = new RegExp(`${PREFIJO_MOVER}${VERBO_MOVER} ${ARTICULO_MOVER}(.+) ${ENLACE_SUELTO} ${ARTICULO_MOVER}(?:carpeta )?(.+)$`, 'd');
const MOVER_TEMA_PRIMERO = new RegExp(`${PREFIJO_MOVER}${ARTICULO_MOVER}(?:carpetas? )?(.+?) (?:la|las|lo|los) ${VERBO_MOVER} ${ENLACE_SUELTO} ${ARTICULO_MOVER}(?:carpeta )?(.+)$`, 'd');
const MAX_CARPETAS_A_MOVER = 6;
// Parte «A, B y C» por comas, «y» y «e» (sin partir lo que va entre comillas)
function partirLista(texto) {
  const piezas = [];
  let actual = '';
  let comillas = null;
  for (let k = 0; k < texto.length; k++) {
    const c = texto[k];
    if (comillas) {
      if (c === comillas) comillas = null;
      actual += c;
    } else if (c === '«' || c === '"') {
      comillas = c === '«' ? '»' : '"';
      actual += c;
    } else if (c === ',') {
      piezas.push(actual);
      actual = '';
    } else if (/^ (?:y|e) /i.test(texto.slice(k, k + 3))) {
      piezas.push(actual);
      actual = '';
      k += 2; // se salta « y »; el bucle avanza al carácter siguiente
    } else actual += c;
  }
  piezas.push(actual);
  return piezas.map((x) => x.trim()).filter(Boolean);
}
function interpretarMoverCarpeta(mensaje, conocidas = []) {
  if (typeof mensaje !== 'string') return null;
  const t = mensaje.normalize('NFC').replace(/\s+/g, ' ').replace(/[\s.!?,;:]+$/, '').trim();
  if (t === '' || t.length > 260) return null;
  const base = sinAcentos(t);
  if (base.length !== t.length) return null; // sin correspondencia carácter a carácter no se corta por posición
  // En un audio la «/» se dice «barra»; se quitan comillas, artículos y la palabra «carpeta» alrededor de cada nombre
  const ruta = (texto) => {
    const limpio = texto.replace(/\s+(?:barra|slash)\s+/gi, '/').split('/').map((x) => x.replace(/^[«"“'`\s]+|[»"”'`\s]+$/g, ''));
    if (limpio.some((x) => x === '' || x.split(' ').length > 4)) return null;
    const segs = segmentosCarpeta(limpio.join('/'));
    return segs ? segs.join('/') : null;
  };
  const nombre = (pieza) => ruta(pieza.replace(/^(?:(?:las|los|la|el|de|del|carpetas?)\s+)+/i, ''));
  const lista = (texto) => {
    const nombres = partirLista(texto).map(nombre);
    return nombres.length > 0 && nombres.length <= MAX_CARPETAS_A_MOVER && nombres.every(Boolean) ? [...new Set(nombres)] : null;
  };
  const trozo = (m, g) => t.slice(m.indices[g][0], m.indices[g][1]);
  const mayuscula = (r) => (r === r.toLowerCase() ? r.replace(/(^|\/)(\p{L})/gu, (x, a, b) => `${a}${b.toUpperCase()}`) : r);
  let m = MOVER_CREANDO.exec(base);
  if (m) {
    const destino = nombre(trozo(m, 1));
    const origenes = lista(trozo(m, 2));
    return destino && origenes ? { origenes, destino: mayuscula(destino), crear: true } : null;
  }
  m = MOVER_LISTA.exec(base);
  if (m) {
    const origenes = lista(trozo(m, 1));
    const destino = nombre(trozo(m, 2));
    return origenes && destino ? { origenes, destino, crear: false } : null;
  }
  m = MOVER_DESTINO_PRIMERO.exec(base);
  if (m) {
    const destino = nombre(trozo(m, 1));
    const origenes = lista(trozo(m, 2));
    return origenes && destino ? { origenes, destino, crear: false } : null;
  }
  // Sin la palabra «carpeta» delante del nombre(«Mueve Budapest a la carpeta Viajes», «Mueve viaje tren de hierro a
  // dentro de Viajes»): solo si CADA nombre es una carpeta que ya existe. Así «mueve la cita al viernes» o «pon la lavadora a las 5» no se toman
  // por carpetas. «La carpeta Budapest la muevas a Viajes» (el nombre delante, con «la carpeta») vale siempre.
  const sinEnlace = (o) => o.replace(/ (?:a|al|hacia)$/, '');
  m = MOVER_TEMA_PRIMERO.exec(base);
  if (m) {
    const conPalabra = /carpetas? $/.test(base.slice(0, m.indices[1][0]));
    const origenes = lista(trozo(m, 1));
    const destino = nombre(trozo(m, 2));
    if (origenes && destino && (conPalabra || origenes.every((o) => carpetaConocida(o, conocidas)))) return { origenes, destino, crear: false };
  }
  m = MOVER_SUELTO.exec(base);
  if (m) {
    const origenes = lista(sinEnlace(trozo(m, 1)));
    const destino = nombre(trozo(m, 2));
    // El destino también tiene que sonar a carpeta: una que existe, una ruta con «/» o dicha con «la carpeta» («pon Budapest en la lista» no lo es)
    const destinoClaro = Boolean(destino) && (carpetaConocida(destino, conocidas) || destino.includes('/') || /carpeta $/.test(base.slice(0, m.indices[2][0])));
    if (origenes && destino && destinoClaro && origenes.every((o) => carpetaConocida(o, conocidas)) && !origenes.some((o) => clavesIguales(o, destino))) return { origenes, destino, crear: false };
  }
  return null;
}

// --- Carpetas conocidas (base de datos 1.5): las que existen en Drive, las pedidas y las de los archivos clasificados ---
// Comparar nombres de carpeta sin mayúsculas, tildes, artículos ni la palabra «carpeta»: «el tren de hierro» y «Tren de Hierro» son lo mismo.
const VACIAS_CARPETA = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'lo', 'y', 'e', 'a', 'al', 'en', 'un', 'una', 'mi', 'mis', 'carpeta', 'carpetas']);
const palabrasCarpeta = (s) => sinAcentos(s).replace(/[^\p{L}\p{N}/ ]+/gu, ' ').split(/[\s/]+/).filter((w) => w && !VACIAS_CARPETA.has(w));
const claveCarpeta = (s) => palabrasCarpeta(s).join(' ');
const clavesIguales = (a, b) => claveCarpeta(a) !== '' && claveCarpeta(a) === claveCarpeta(b);
const ultimoTramo = (r) => String(r ?? '').split('/').at(-1);
// Distancia de edición (para erratas de una o dos letras: «Viaje» y «Viajes», «Budapets» y «Budapest»)
function distanciaCarpeta(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
// ¿Se parecen dos NOMBRES de carpeta (un tramo, sin ruta)? Iguales, uno contiene todas las palabras del otro («viaje Budapest» y «Budapest»;
// «viaje Tren de Hierro» y «Tren de Hierro») o una errata pequeña en un nombre de al menos 5 letras.
function nombresParecidos(a, b) {
  const pa = palabrasCarpeta(a);
  const pb = palabrasCarpeta(b);
  if (pa.length === 0 || pb.length === 0) return false;
  const ka = pa.join(' ');
  const kb = pb.join(' ');
  if (ka === kb) return true;
  const [corto, largo] = pa.length <= pb.length ? [pa, pb] : [pb, pa];
  if (corto.every((w) => largo.includes(w))) return true;
  return Math.min(ka.length, kb.length) >= 5 && distanciaCarpeta(ka, kb) <= 2;
}
// ¿Es este texto una carpeta que existe? Por su ruta entera, por su último tramo, porque todas sus palabras están en uno («tren de hierro» y
// «viaje Tren de Hierro») o por una errata pequeña. NO al revés: «dos fotos de Budapest» no es la carpeta «Budapest» (tiene palabras de más).
// Lo exacto lo decide después «Revisar Drive» con el árbol real.
function carpetaConocida(texto, conocidas) {
  const rutas = (Array.isArray(conocidas) ? conocidas : []).map((c) => (typeof c === 'string' ? c : c?.ruta)).filter((r) => typeof r === 'string' && r !== '');
  const pt = palabrasCarpeta(texto);
  if (rutas.length === 0 || pt.length === 0) return false;
  const kt = pt.join(' ');
  return rutas.some((r) => {
    if (clavesIguales(r, texto) || clavesIguales(ultimoTramo(r), texto)) return true;
    if (texto.includes('/')) return false;
    const pk = palabrasCarpeta(ultimoTramo(r));
    const kk = pk.join(' ');
    return pt.every((w) => pk.includes(w)) || (Math.min(kt.length, kk.length) >= 5 && distanciaCarpeta(kt, kk) <= 2);
  });
}

// --- Mover las fotos o los archivos de una carpeta a otra: «mueve las fotos de Budapest a Viajes/Budapest» ---
// Por código. Mueve lo que la secretaria tiene clasificado en esa carpeta (y en las de dentro): cambia su carpeta y «Sincronizar Drive» los
// mueve de verdad en unos segundos. Lo que subiste a mano a Drive no lo conoce y se queda. «Las fotos» son solo las imágenes; «los archivos»,
// todo. Entrada (los que aún no tienen sitio) lo decide el modelo, como siempre. Devuelve { origen, destino (o null si no lo dice), solo_fotos }.
const TIPO_ARCHIVOS = '(fotos?|imagenes|imagen|archivos?|documentos?|ficheros?|pdfs?|cosas)';
const CANTIDAD_ARCHIVOS = '(?:todas |todos |toda |todo )?(?:las |los |mis |la |el )?(?:\\d+ |dos |tres |cuatro |cinco |seis |siete |ocho |nueve |diez )?';
const DE_CARPETA = '(?: que (?:hay|tengo|estan|guarde|guardaste))? (?:de|del|en|dentro de) (?:la |el )?(?:carpeta )?';
const MOVER_ARCHIVOS = new RegExp(`${PREFIJO_MOVER}${VERBO_MOVER} ${CANTIDAD_ARCHIVOS}${TIPO_ARCHIVOS}${DE_CARPETA}(.+)$`, 'd');
const MOVER_ARCHIVOS_TEMA = new RegExp(`${PREFIJO_MOVER}${CANTIDAD_ARCHIVOS}${TIPO_ARCHIVOS}${DE_CARPETA}(.+?) (?:las|los|la|lo) ${VERBO_MOVER}(?: (.+))?$`, 'd');
const ENLACE_DESTINO = / (?:a dentro de|adentro de|dentro de|al interior de|hacia|en|a) (?:las |los |la |el )?(?:carpeta (?:de |del )?)?/g;
function interpretarMoverArchivos(mensaje, conocidas = []) {
  if (typeof mensaje !== 'string') return null;
  const t = mensaje.normalize('NFC').replace(/\s+/g, ' ').replace(/[\s.!?,;:]+$/, '').trim();
  if (t === '' || t.length > 200) return null;
  const base = sinAcentos(t);
  if (base.length !== t.length) return null;
  const ruta = (texto) => {
    const limpio = String(texto ?? '').replace(/\s+(?:barra|slash)\s+/gi, '/').split('/').map((x) => x.replace(/^[«"“'`\s]+|[»"”'`\s]+$/g, ''));
    if (limpio.some((x) => x === '' || x.split(' ').length > 4)) return null;
    const segs = segmentosCarpeta(limpio.join('/'));
    return segs ? segs.join('/') : null;
  };
  const de = (m, g) => (m.indices[g] ? t.slice(m.indices[g][0], m.indices[g][1]) : '');
  let origen = null;
  let destino = null;
  let tipo = '';
  let m = MOVER_ARCHIVOS_TEMA.exec(base);
  if (m) {
    tipo = m[1];
    origen = ruta(de(m, 2));
    const resto = de(m, 3).replace(/^(?:a dentro de|adentro de|dentro de|al interior de|hacia|en|a) (?:las |los |la |el )?(?:carpeta )?/i, '');
    destino = resto ? ruta(resto) : null;
    if (!origen || (resto && !destino)) return null;
  } else {
    m = MOVER_ARCHIVOS.exec(base);
    if (!m) return null;
    tipo = m[1];
    // «de Budapest a Viajes/Budapest»: de los cortes posibles, el que deja como origen una carpeta conocida (el de más a la derecha si ninguna lo es)
    const resto = de(m, 2);
    const restoBase = sinAcentos(resto);
    const cortes = [...restoBase.matchAll(ENLACE_DESTINO)].map((x) => ({ i: x.index, fin: x.index + x[0].length })).reverse();
    const elegido = cortes.find((c) => carpetaConocida(resto.slice(0, c.i), conocidas)) ?? cortes[0];
    if (elegido) {
      origen = ruta(resto.slice(0, elegido.i));
      destino = ruta(resto.slice(elegido.fin));
      if (!origen || !destino) return null;
    } else {
      origen = ruta(resto);
      if (!origen) return null;
    }
  }
  if (clavesIguales(origen, 'Entrada')) return null;
  return { origen, destino, solo_fotos: /^(?:fotos?|imagen|imagenes)$/.test(tipo) };
}

// --- «Mueve todo lo de Notas a Budapest» ---
// Mover el CONTENIDO de una carpeta a otra con palabras que no son «las fotos de» ni «los archivos de»: «todo lo de», «todo el contenido de», «lo que
// hay en», «las cosas de». El origen tiene que ser una carpeta que existe (o decirse «la carpeta X») y el destino sonar a carpeta (existe, se
// parece a una, lleva «/» o se dice «la carpeta»): «pon todo lo de la compra en la lista» no lo es. Devuelve { origen, destino, solo_fotos: false }.
const CONTENIDO_CARPETA = '(?:todo lo que hay|todo lo que tengo|lo que hay|lo que tengo|todo el contenido|el contenido|todas las cosas|las cosas|todo lo|todo|lo)';
const MOVER_CONTENIDO = new RegExp(`${PREFIJO_MOVER}${VERBO_MOVER} ${CONTENIDO_CARPETA} (?:que hay |que tengo |guardado )?(?:de|del|en|dentro de) (?:la |el )?(carpeta (?:de |del )?)?(.+?) (?:a dentro de|adentro de|dentro de|al interior de|hacia|en|al|a) (?:las |los |la |el )?(carpeta (?:de |del )?)?(.+)$`, 'd');
function interpretarMoverContenido(mensaje, conocidas = []) {
  if (typeof mensaje !== 'string') return null;
  const t = mensaje.normalize('NFC').replace(/[\u200B-\u200F\u2060-\u2064\uFEFF\u00AD]/g, '').replace(/\s+/g, ' ').replace(/[\s.!?,;:]+$/, '').trim();
  if (t === '' || t.length > 200) return null;
  const base = sinAcentos(t);
  if (base.length !== t.length) return null;
  const m = MOVER_CONTENIDO.exec(base);
  if (!m) return null;
  const ruta = (k) => {
    const limpio = t.slice(m.indices[k][0], m.indices[k][1]).replace(/\s+(?:barra|slash)\s+/gi, '/').split('/').map((x) => x.replace(/^[«"“'`\s]+|[»"”'`\s]+$/g, ''));
    if (limpio.some((x) => x === '' || x.split(' ').length > 4)) return null;
    const segs = segmentosCarpeta(limpio.join('/'));
    return segs ? segs.join('/') : null;
  };
  const origen = ruta(2);
  const destino = ruta(4);
  if (!origen || !destino) return null;
  if (/^(?:lista|listas|agenda|calendario|compra|tareas)\b/.test(sinAcentos(destino))) return null;
  const origenClaro = Boolean(m[1]) || carpetaConocida(origen, conocidas);
  const destinoClaro = Boolean(m[3]) || destino.includes('/') || carpetaConocida(destino, conocidas) || (conocidas ?? []).some((c) => nombresParecidos(ultimoTramo(typeof c === 'string' ? c : c?.ruta ?? ''), ultimoTramo(destino)));
  return origenClaro && destinoClaro && !clavesIguales(origen, destino) ? { origen, destino, solo_fotos: false } : null;
}

// --- Mover UN archivo por su nombre: «Mueve 2026-10-23 1504 · WhatsApp.jpg a Notas» ---
// El modelo solo ve los archivos pendientes y los citados: uno ya guardado no lo encontraba. Se reconoce por código: un nombre con extensión de
// archivo y una carpeta de destino. WhatsApp mete caracteres invisibles al copiar un nombre (U+2060…): se quitan. Devuelve
// { nombre, destino } o null. El archivo se busca por su nombre exacto en la base de datos (lo hace Planificar).
const EXT_ARCHIVO = '(?:jpe?g|png|heic|heif|webp|gif|pdf|docx?|xlsx?|pptx?|odt|txt|csv|mp4|mov|m4a|mp3|ogg|opus|wav|zip)';
// «todos los archivos X» / «los 2 archivos X»: la respuesta a «Hay 2 archivos que se llaman X… ¿Muevo los 2?» 
const MOVER_UN_ARCHIVO = new RegExp(`${PREFIJO_MOVER}${VERBO_MOVER} (?:(todos los archivos |todas las fotos |los \\d+ archivos |las \\d+ fotos )|(?:el |la |mi )?(?:(?:archivo|foto|documento|fichero|imagen|pdf) (?:de |del |llamad[oa] |que se llama )?)?)[«"“']?(.+?\\.${EXT_ARCHIVO})[»"”']? (?:a dentro de|adentro de|dentro de|al interior de|hacia|en|a) (?:las |los |la |el )?(?:carpeta (?:de |del )?)?(.+)$`, 'd');
const INVISIBLES = /[\u200B-\u200F\u2060-\u2064\uFEFF\u00AD]/g;
function interpretarMoverArchivoNombre(mensaje) {
  if (typeof mensaje !== 'string') return null;
  const t = mensaje.normalize('NFC').replace(INVISIBLES, '').replace(/\s+/g, ' ').replace(/[\s.!?,;:]+$/, '').trim();
  if (t === '' || t.length > 220) return null;
  const base = sinAcentos(t);
  if (base.length !== t.length) return null;
  const m = MOVER_UN_ARCHIVO.exec(base);
  if (!m) return null;
  const nombre = t.slice(m.indices[2][0], m.indices[2][1]).trim();
  const limpio = t.slice(m.indices[3][0], m.indices[3][1]).replace(/\s+(?:barra|slash)\s+/gi, '/').split('/').map((x) => x.replace(/^[«"“'`\s]+|[»"”'`\s]+$/g, ''));
  if (nombre.length > 150 || limpio.some((x) => x === '' || x.split(' ').length > 4)) return null;
  const segs = segmentosCarpeta(limpio.join('/'));
  return segs ? { nombre, destino: segs.join('/'), ...(m[1] ? { todos: true } : {}) } : null;
}

// --- «Mueve esos archivos a Viajes/Budapest»: los últimos que movió o guardó la secretaria ---
// El modelo veía la conversación pero no podía señalar esos archivos (solo tiene referencias de los pendientes y del citado). Cada vez que la
// secretaria mueve o guarda archivos, anota sus ids en el hilo del mensaje («Resultado»); «Construir petición» busca el último en la
// conversación. Hace falta una referencia clara: «esos», «estos», «los de antes», «los mismos» o «muévelos». Con «muévelos/ponlos a X» el destino
// tiene que sonar a carpeta (una que existe, una ruta con «/» o dicha con «la carpeta»): «ponlas en la nevera» no lo es. Devuelve { destino } o null.
const DESTINO_ESOS = ' (?:a dentro de|adentro de|dentro de|al interior de|hacia|en|a) (?:las |los |la |el )?(?:carpeta (?:de |del )?)?(.+)$';
const NUMERO_ESOS = '(?:dos |tres |cuatro |cinco |seis |siete |ocho |nueve |diez |\\d+ )?';
const TIPO_ESOS = '(?:archivos?|fotos?|imagen|imagenes|documentos?|ficheros?|pdfs?)';
const ANTES_ESOS = '(?: de antes| de hace un momento| que (?:acabas de|has) (?:mover|movido|guardar|guardado))';
const MOVER_ESOS = new RegExp(`${PREFIJO_MOVER}${VERBO_MOVER} (?:(?:esos|estos|esas|estas|los mismos|las mismas) ${NUMERO_ESOS}${TIPO_ESOS}${ANTES_ESOS}?|(?:los|las) ${NUMERO_ESOS}${TIPO_ESOS}${ANTES_ESOS})${DESTINO_ESOS}`, 'd');
const MOVER_ESOS_CLITICO = new RegExp(`${PREFIJO_MOVER}(?:muevelos|muevelas|pasalos|pasalas|metelos|metelas|llevalos|llevalas|ponlos|ponlas|colocalos|colocalas)(?: tambien)?${DESTINO_ESOS}`, 'd');
function interpretarMoverEsos(mensaje, conocidas = []) {
  if (typeof mensaje !== 'string') return null;
  const t = mensaje.normalize('NFC').replace(INVISIBLES, '').replace(/\s+/g, ' ').replace(/[\s.!?,;:]+$/, '').trim();
  if (t === '' || t.length > 160) return null;
  const base = sinAcentos(t);
  if (base.length !== t.length) return null;
  const explicito = MOVER_ESOS.exec(base);
  const m = explicito ?? MOVER_ESOS_CLITICO.exec(base);
  if (!m) return null;
  const destinoBase = base.slice(m.indices[1][0], m.indices[1][1]);
  // «ponlos en la lista de la compra» no es una carpeta
  if (/^(?:mi |tu )?(?:lista|listas|agenda|calendario|compra|tareas|notas de)\b/.test(destinoBase)) return null;
  const limpio = t.slice(m.indices[1][0], m.indices[1][1]).replace(/\s+(?:barra|slash)\s+/gi, '/').split('/').map((x) => x.replace(/^[«"“'`\s]+|[»"”'`\s]+$/g, ''));
  if (limpio.some((x) => x === '' || x.split(' ').length > 4)) return null;
  const segs = segmentosCarpeta(limpio.join('/'));
  if (!segs) return null;
  const destino = segs.join('/');
  if (!explicito && !(destino.includes('/') || / carpeta (?:de |del )?$/.test(base.slice(0, m.indices[1][0])) || carpetaConocida(destino, conocidas))) return null;
  return { destino };
}

// --- «Ponlo en Budapest» sin citar nada, justo después de mandar fotos(preguntaba «¿a cuál te refieres?») ---
// Vale para el último lote de archivos que llegaron seguidos y siguen sin sitio (lote: sus referencias, lo calcula «Construir petición»).
// Solo con un verbo de guardar y un sitio; si el sitio suena a una lista o a la agenda («ponlo en la lista de la compra») no es una carpeta.
const VERBO_ULTIMO_LOTE = '(?:ponlo|ponla|ponlos|ponlas|pon|ponmelo|ponmela|ponmelos|ponmelas|guardalo|guardala|guardalos|guardalas|guarda|guardamelo|guardamela|guardamelos|guardamelas|metelo|metela|metelos|metelas|mete|metemelo|metemela|metemelos|metemelas|muevelo|muevela|muevelos|muevelas|archivalo|archivala|archivalos|archivalas|archiva|llevalo|llevala|llevalos|llevalas|dejalo|dejala|dejalos|dejalas)';
const OBJETO_LOTE = '(?: (?:todo|todas|todos|las dos|los dos|ambas|ambos|esto|eso|esta|esa|estas|esas|estos|esos|las fotos|la foto|los archivos|el archivo|los documentos|el documento|las imagenes|la imagen)(?: tambien)?)?';
const ARCHIVAR_LOTE = new RegExp(`${PREFIJO_MOVER}${VERBO_ULTIMO_LOTE}${OBJETO_LOTE} (?:en|dentro de|a) (?:las |los |la |el )?(?:carpeta )?(.+)$`, 'd');
const NO_ES_CARPETA = /\b(?:lista|compra|tareas?|alarmas?|citas?|calendario|agenda|recordatorios?|memoria|proyecto|pendientes?|manana|hoy|lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b|\d{1,2}(?::\d{2})? ?h\b|\b(?:las|la) \d/;
function archivarUltimoLote(mensaje, lote) {
  if (!Array.isArray(lote) || lote.length === 0 || typeof mensaje !== 'string') return null;
  const t = mensaje.normalize('NFC').replace(/\s+/g, ' ').replace(/[\s.!?,;:]+$/, '').trim();
  if (t === '' || t.length > 120) return null;
  const base = sinAcentos(t);
  if (base.length !== t.length) return null;
  const m = ARCHIVAR_LOTE.exec(base);
  if (!m) return null;
  const resto = t.slice(m.indices[1][0], m.indices[1][1]);
  if (NO_ES_CARPETA.test(sinAcentos(resto))) return null;
  const limpio = resto.replace(/\s+(?:barra|slash)\s+/gi, '/').split('/').map((x) => x.replace(/^[«"“'`\s]+|[»"”'`\s]+$/g, ''));
  if (limpio.some((x) => x === '' || x.split(' ').length > 4)) return null;
  const segs = segmentosCarpeta(limpio.join('/'));
  return segs ? { ruta: segs.join('/'), refs: [...new Set(lote)] } : null;
}

// --- Propuestas concretas de la secretaria : «¿Paso los archivos de «Budapest» a «Viajes/Budapest»?» ---
// La propuesta queda abierta como pregunta (motivo sugerencia, origen codigo) con la orden exacta. Un «sí» (o «vale», «júntalas», «muévelos»…) o
// repetir el principio de la orden («Mueve los archivos») la ejecuta como si el usuario la hubiera escrito entera; un
// «no» la deja como está. Devuelve null (no contesta a la propuesta), { tipo: 'no' } o { tipo: 'si', orden }.
const PALABRAS_ACEPTA = new Set(['si', 'vale', 'ok', 'okey', 'venga', 'dale', 'claro', 'adelante', 'hazlo', 'perfecto', 'exacto', 'eso', 'es', 'de', 'acuerdo', 'por', 'favor', 'porfa', 'juntalas', 'juntalos', 'juntala', 'juntalo', 'muevelos', 'muevelas', 'muevelo', 'muevela', 'pasalos', 'pasalas', 'pasalo', 'pasala', 'ya', 'bien', 'genial']);
const RECHAZA_SUGERENCIA = /^(?:no|nop|mejor no|no gracias|dejalo|dejalo asi|da igual|nada|olvidalo|no hace falta)$/;
function aceptaSugerencia(mensaje, hilo) {
  const t = motivoDelHilo(hilo);
  if (t?.motivo !== 'sugerencia' || t.origen !== 'codigo' || typeof t.orden !== 'string' || t.orden === '' || t.orden.length > 200) return null;
  const m = sinSignos(mensaje ?? '');
  if (!m) return null;
  if (RECHAZA_SUGERENCIA.test(m)) return { tipo: 'no' };
  const palabras = m.split(' ').filter(Boolean);
  if (palabras.length <= 5 && palabras.every((w) => PALABRAS_ACEPTA.has(w))) return { tipo: 'si', orden: t.orden };
  const orden = sinSignos(t.orden);
  if (palabras.length >= 2 && (orden === m || orden.startsWith(`${m} `))) return { tipo: 'si', orden: t.orden };
  return null;
}
const turnoSugerencia = (orden, texto) => JSON.stringify({ intencion: 'aclarar', motivo: 'sugerencia', origen: 'codigo', orden, pregunta: texto, items: [], respuesta_usuario: texto });

// --- «¿Dónde la guardo?» ante una carpeta parecida : la respuesta se resuelve por código ---
// La pregunta la escribe «Planificar» (motivo carpeta_parecida, origen codigo) con las opciones, la ruta pedida y los ids de los archivos.
// Vale: el número («1», «la 2»), «la primera», «sí» (si solo había una opción), «crea»/«nueva» (crea la pedida), el nombre de una opción, o
// «no»/«déjalo» (se quedan en Entrada). Devuelve null (no contesta a esa pregunta), { tipo: 'no' }, { tipo: 'repetir' } (contesta pero no se
// entiende cuál: se vuelve a preguntar) o { tipo: 'elegida', ruta, archivos, nombre, nueva }.
const ORDINALES_CARPETA = { primera: 1, primero: 1, uno: 1, una: 1, segunda: 2, segundo: 2, dos: 2, tercera: 3, tercero: 3, tres: 3, cuarta: 4, cuarto: 4, cuatro: 4, quinta: 5, quinto: 5, cinco: 5 };
const CREA_NUEVA = /^(?:crea(?:la|lo|r)?|creala nueva|crea(?:la)? (?:una )?nueva|una nueva|nueva|otra|otra nueva|en una nueva|en otra|haz(?:la)? (?:una )?nueva)\b/;
const NO_CARPETA = /^(?:no|nop|mejor no|dejalo|dejala|dejalos|dejalas|nada|ninguna|cancela|olvidalo|da igual|en entrada)\b/;
const SI_CARPETA = /^(?:si|vale|ok|okey|claro|ahi|esa|en esa|alli|perfecto|venga|dale|si ahi|si en esa|si esa)$/;
function carpetaDelHilo(t) {
  if (t?.motivo !== 'carpeta_parecida' || t.origen !== 'codigo' || !Array.isArray(t.opciones) || typeof t.nueva !== 'string' || !Array.isArray(t.archivos)) return null;
  const opciones = t.opciones.filter((r) => typeof r === 'string' && segmentosCarpeta(r)).slice(0, 5);
  const archivos = t.archivos.filter((x) => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x)).slice(0, 20);
  if (opciones.length === 0 || archivos.length === 0 || !segmentosCarpeta(t.nueva)) return null;
  return { opciones, archivos, nueva: t.nueva, nombre: typeof t.nombre === 'string' ? t.nombre : null };
}
function respuestaCarpeta(mensaje, hilo) {
  const c = carpetaDelHilo(motivoDelHilo(hilo));
  if (!c) return null;
  const m = sinSignos(mensaje ?? '').replace(/^(?:pues|mejor|en|la|el|opcion|numero|carpeta)\s+/g, '').replace(/^(?:la|el|opcion|numero)\s+/, '').trim();
  if (!m || m.split(' ').length > 6) return null;
  const elegir = (ruta, nueva = false) => ({ tipo: 'elegida', ruta, archivos: c.archivos, nombre: c.nombre, nueva });
  const n = /^\d$/.test(m) ? Number(m) : ORDINALES_CARPETA[m] ?? null;
  if (n !== null) {
    if (n >= 1 && n <= c.opciones.length) return elegir(c.opciones[n - 1]);
    if (n === c.opciones.length + 1) return elegir(c.nueva, true);
    return { tipo: 'repetir' };
  }
  if (NO_CARPETA.test(m)) return { tipo: 'no' };
  if (CREA_NUEVA.test(m)) return elegir(c.nueva, true);
  if (SI_CARPETA.test(m)) return c.opciones.length === 1 ? elegir(c.opciones[0]) : { tipo: 'repetir' };
  // El nombre de una opción: por su ruta entera o, si no hay dudas, por su último tramo
  const original = String(mensaje ?? '').trim();
  const porRuta = c.opciones.filter((r) => clavesIguales(r, original));
  if (porRuta.length === 1) return elegir(porRuta[0]);
  const porTramo = c.opciones.filter((r) => clavesIguales(ultimoTramo(r), original));
  if (porTramo.length === 1 && !clavesIguales(c.nueva, original)) return elegir(porTramo[0]);
  if (porTramo.length > 0 || clavesIguales(c.nueva, original)) return { tipo: 'repetir' };
  return null;
}
// Antes de guardar en una carpeta que NO existe, se mira si hay otra que se le parece (por su último tramo, en cualquier nivel): «Budapest»
// cuando ya hay «Viajes/Budapest», «viaje Tren de Hierro» cuando hay «Viajes/Tren de Hierro», «Viaje» cuando hay «Viajes». Si la hay, se
// pregunta; si no, se crea. Una ruta que ya existe con otra escritura («viajes/budapest») se escribe como ya está. Entrada no cuenta.
// Devuelve { ruta } (la que se usa) o { ruta, parecidas } (hay que preguntar). Sin carpetas conocidas (sin actualizar la base de datos a la 1.5), { ruta } tal cual.
const MAX_OPCIONES_CARPETA = 4;
// Primero las de nombre igual, después las que solo cambian en una errata y al final las que contienen sus palabras
const rangoParecido = (a, b) => (clavesIguales(a, b) ? 0 : palabrasCarpeta(a).length === palabrasCarpeta(b).length ? 1 : 2);
function revisarCarpetaPedida(ruta, conocidas) {
  // Una sola por ruta sin mayúsculas ni tildes («Viajes/Budapest» y «viajes/Budapest» de archivos antiguos): la primera, que es la de Drive
  // (Construir petición las ordena así; sección 77)
  const vistas = new Set();
  const lista = (Array.isArray(conocidas) ? conocidas : []).map((c) => (typeof c === 'string' ? c : c?.ruta)).filter((r) => typeof r === 'string' && segmentosCarpeta(r) && !vistas.has(sinAcentos(r)) && vistas.add(sinAcentos(r)));
  if (lista.length === 0 || typeof ruta !== 'string') return { ruta };
  const igual = lista.find((r) => sinAcentos(r) === sinAcentos(ruta));
  if (igual) return { ruta: igual };
  // Los tramos de delante que ya existen se escriben como están («viajes/Nueva» → «Viajes/Nueva»)
  const segs = ruta.split('/');
  let canon = ruta;
  for (let k = segs.length - 1; k >= 1; k--) {
    const pref = lista.find((r) => sinAcentos(r) === sinAcentos(segs.slice(0, k).join('/')));
    if (pref) {
      canon = [pref, ...segs.slice(k)].join('/');
      break;
    }
  }
  const nombre = segs.at(-1);
  const parecidas = lista
    .filter((r) => sinAcentos(r.split('/')[0]) !== 'entrada' && !sinAcentos(canon).startsWith(`${sinAcentos(r)}/`) && nombresParecidos(ultimoTramo(r), nombre))
    .sort((a, b) => rangoParecido(ultimoTramo(a), nombre) - rangoParecido(ultimoTramo(b), nombre) || a.split('/').length - b.split('/').length || a.localeCompare(b, 'es'))
    .slice(0, MAX_OPCIONES_CARPETA);
  return parecidas.length > 0 ? { ruta: canon, parecidas } : { ruta: canon };
}
// Mover las fotos o los archivos de una carpeta a otra . conocidas: las de carpetas_conocidas(), con cuántos archivos tiene cada una.
// Devuelve { texto } (no se mueve nada y se dice por qué) o { origen, destino, cambios: [{ de, a }] } (una ruta exacta de la base de datos por
// cambio: la carpeta y las de dentro).
function planMoverArchivos(pedido, conocidas) {
  const filas = (Array.isArray(conocidas) ? conocidas : []).filter((c) => c && typeof c.ruta === 'string' && segmentosCarpeta(c.ruta));
  const conArchivos = filas.filter((c) => Number(c.archivos) > 0).map((c) => c.ruta);
  const que = pedido.solo_fotos ? 'fotos' : 'archivos';
  // El origen: la ruta tal cual o, si no hay dudas, por su último tramo
  let origen = conArchivos.find((r) => sinAcentos(r) === sinAcentos(pedido.origen)) ?? null;
  if (!origen) {
    const vistos = new Set();
    const porTramo = conArchivos.filter((r) => (clavesIguales(ultimoTramo(r), pedido.origen) || clavesIguales(r, pedido.origen)) && !vistos.has(sinAcentos(r)) && vistos.add(sinAcentos(r)));
    if (porTramo.length > 1) return { texto: `Hay varias carpetas «${limpiarTxt(pedido.origen)}» con ${que}:\n${porTramo.map((r) => `• ${limpiarTxt(r)}`).join('\n')}\nDime la ruta completa.` };
    origen = porTramo[0] ?? null;
  }
  if (!origen) return { texto: `No tengo ${que} guardad${pedido.solo_fotos ? 'as' : 'os'} en «${limpiarTxt(pedido.origen)}».` };
  // Se escribe como en Drive («Viajes/Budapest», no «viajes/Budapest» de archivos antiguos; sección 78). Los cambios ya cogen todas las variantes.
  origen = filas.find((c) => sinAcentos(c.ruta) === sinAcentos(origen))?.ruta ?? origen;
  if (!pedido.destino) return { texto: `¿Adónde? Dime, por ejemplo: «mueve ${pedido.solo_fotos ? 'las' : 'los'} ${que} de ${limpiarTxt(origen)} a Viajes/${limpiarTxt(ultimoTramo(origen))}».` };
  // El destino: si existe, como está escrito; si es el último tramo de UNA sola carpeta («Budapest» y solo existe «Viajes/Budapest»), esa
  // (sección 77: no tiene sentido preguntar); si no existe pero se parece a otra, se dice (no se crea a ciegas una casi repetida)
  let destinoPedido = pedido.destino;
  if (!filas.some((c) => sinAcentos(c.ruta) === sinAcentos(destinoPedido)) && !destinoPedido.includes('/')) {
    const vistos = new Set();
    const porTramo = filas.map((c) => c.ruta).filter((r) => clavesIguales(ultimoTramo(r), destinoPedido) && !vistos.has(sinAcentos(r)) && vistos.add(sinAcentos(r)));
    if (porTramo.length === 1) destinoPedido = porTramo[0];
  }
  const rev = revisarCarpetaPedida(destinoPedido, filas);
  const destinoExiste = filas.some((c) => sinAcentos(c.ruta) === sinAcentos(rev.ruta));
  if (!destinoExiste && rev.parecidas) {
    // Con una sola parecida, la propuesta queda abierta: «sí» la hace 
    if (rev.parecidas.length === 1) {
      return { texto: `No tengo «${limpiarTxt(rev.ruta)}». ¿Paso ${pedido.solo_fotos ? 'las' : 'los'} ${que} de «${limpiarTxt(origen)}» a «${limpiarTxt(rev.parecidas[0])}»?`, sugerencia: `mueve los ${pedido.solo_fotos ? 'fotos' : 'archivos'} de ${origen} a ${rev.parecidas[0]}`.replace('los fotos', 'las fotos') };
    }
    return { texto: `No tengo «${limpiarTxt(rev.ruta)}». ¿Es ${rev.parecidas.map((r) => `«${limpiarTxt(r)}»`).join(' o ')}? Dímelo con la ruta: «mueve ${pedido.solo_fotos ? 'las' : 'los'} ${que} de ${limpiarTxt(origen)} a ${limpiarTxt(rev.parecidas[0])}».` };
  }
  const destino = rev.ruta;
  if (sinAcentos(destino.split('/')[0]) === 'entrada') return { texto: 'Entrada es para lo que aún no tiene sitio: elige otra carpeta.' };
  if (sinAcentos(destino) === sinAcentos(origen)) return { texto: `Ya están en «${limpiarTxt(origen)}».` };
  // Si el destino está dentro del origen, solo se mueve lo que está justo en el origen (lo de las subcarpetas acabaría dentro de sí mismo)
  const dentroDelOrigen = sinAcentos(destino).startsWith(`${sinAcentos(origen)}/`);
  const cambios = conArchivos
    .filter((r) => sinAcentos(r) === sinAcentos(origen) || (!dentroDelOrigen && sinAcentos(r).startsWith(`${sinAcentos(origen)}/`)))
    .map((r) => ({ de: r, a: `${destino}${r.slice(origen.length)}` }))
    .filter((c) => segmentosCarpeta(c.a));
  if (cambios.length === 0) return { texto: `No puedo moverlos ahí: quedarían a más de ${NIVELES_CARPETA_MAX} niveles.` };
  return { origen, destino, cambios };
}
// ¿Mover UNA carpeta donde ya hay otra igual o parecida?  Devuelve { origen, destino } con las rutas como están escritas (la carpeta
// que se mueve, con archivos guardados, y la que ya existe dentro del destino) o null. Varias carpetas, crear el destino o sin archivos
// guardados: null (lo decide «Revisar Drive», que explica cómo juntarlas).
function fusionDeCarpetas(pedido, conocidas) {
  if (!pedido || pedido.crear === true || !Array.isArray(pedido.origenes) || pedido.origenes.length !== 1) return null;
  const filas = (Array.isArray(conocidas) ? conocidas : []).filter((c) => c && typeof c.ruta === 'string' && segmentosCarpeta(c.ruta));
  const rutas = [...new Set(filas.map((c) => c.ruta))];
  const destino = rutas.find((r) => sinAcentos(r) === sinAcentos(pedido.destino)) ?? (() => {
    const porClave = rutas.filter((r) => clavesIguales(r, pedido.destino));
    return porClave.length === 1 ? porClave[0] : undefined;
  })();
  if (!destino) return null;
  const pedidoOrigen = pedido.origenes[0];
  let origen = rutas.find((r) => sinAcentos(r) === sinAcentos(pedidoOrigen)) ?? null;
  if (!origen) {
    const porTramo = rutas.filter((r) => clavesIguales(ultimoTramo(r), pedidoOrigen));
    if (porTramo.length !== 1) return null;
    origen = porTramo[0];
  }
  const padreDe = (r) => r.split('/').slice(0, -1).join('/');
  if (sinAcentos(padreDe(origen)) === sinAcentos(destino)) return null; // ya está ahí: lo dice «Revisar Drive»
  const gemela = rutas.find((r) => sinAcentos(padreDe(r)) === sinAcentos(destino) && sinAcentos(r) !== sinAcentos(origen) && nombresParecidos(ultimoTramo(r), ultimoTramo(origen)));
  if (!gemela) return null;
  const conArchivos = filas.some((c) => Number(c.archivos) > 0 && (sinAcentos(c.ruta) === sinAcentos(origen) || sinAcentos(c.ruta).startsWith(`${sinAcentos(origen)}/`)));
  return conArchivos ? { origen, destino: gemela } : null;
}
function textoCarpetaParecida(nueva, parecidas, n) {
  const opciones = [...parecidas.map((r, i) => `${i + 1}. ${limpiarTxt(r)}`), `${parecidas.length + 1}. Crear «${limpiarTxt(nueva)}»`];
  return `No tengo «${limpiarTxt(nueva)}», pero sí:\n${opciones.join('\n')}\n¿Dónde ${n === 1 ? 'la' : 'las'} guardo?`;
}

// --- Órdenes de LECTURA con tus palabras : ver, listar, enseñar ---
// Reconoce por palabras clave, con sinónimos y erratas, lo que equivale a un comando de lectura (/pending, /today, /folders, /files, /subjects,
// /projects, /memory, /schedule o la lista de una sección) y lo resuelve SIN el modelo. Solo lectura: nunca borra, quita ni cambia nada, así que
// una errata o un falso positivo como mucho enseña una lista de más. Es deliberadamente conservador: si el mensaje trae cualquier palabra que
// no conoce, o dos temas distintos, devuelve null y decide el modelo («dame la foto del DNI», «borra todo», «apunta comprar pan»).
const LECT_PETICION = new Set([
  'dame', 'damelo', 'damela', 'damelos', 'damelas', 'dime', 'dimelo', 'dimela', 'dimelas', 'dimelos', 'ensename', 'ensenamelo', 'ensenamela', 'ensenamelas', 'ensenamelos',
  'muestrame', 'muestramelo', 'muestramela', 'muestramelas', 'muestramelos', 'muestra', 'muestrame', 'mostrar', 'mostrarme', 'pasame', 'pasamelo', 'pasamela', 'ponme', 'ponmelo',
  'quiero', 'quisiera', 'necesito', 'ver', 'veo', 'verlo', 'verla', 'verlos', 'verlas', 'lista', 'listame', 'listado', 'listar', 'listamelo', 'cual', 'cuales', 'que', 'dar', 'darme',
  'decirme', 'puedes', 'podrias', 'show', 'list', 'see', 'give', 'abre', 'abreme', 'sacame', 'saca', 'revisa', 'consulta', 'consultame',
]);
const LECT_RELLENO = new Set([
  'el', 'la', 'lo', 'los', 'las', 'mi', 'mis', 'tu', 'tus', 'de', 'del', 'en', 'por', 'favor', 'porfa', 'porfavor', 'pf', 'me', 'un', 'una', 'unos', 'unas', 'y', 'e', 'a', 'al',
  'para', 'tengo', 'tienes', 'tiene', 'hay', 'esta', 'estan', 'son', 'es', 'ahora', 'todavia', 'aun', 'ya', 'guardado', 'guardada', 'guardados', 'guardadas', 'apuntado', 'apuntada',
  'apuntados', 'apuntadas', 'registrado', 'registrada', 'registrados', 'registradas', 'mas', 'solo', 'que', 'hola', 'oye', 'vale', 'gracias', 'actual', 'actuales', 'todos', 'todas',
  'the', 'my', 'all', 'of', 'me', 'please', 'tuyo', 'mio', 'mias', 'mios',
  // Muletillas de un audio transcrito («eh, pues, dame la jerarquía, por favor»)
  'eh', 'ehh', 'em', 'emm', 'mm', 'mmm', 'ah', 'uh', 'pues', 'bueno', 'venga', 'entonces', 'mira', 'porfi', 'hey', 'ey', 'buenas', 'buenos', 'dias', 'tardes', 'noches', 'secretaria', 'si', 'ok', 'okey', 'vamos',
]);
const LECT_TEMA = {
  carpetas: ['carpeta', 'carpetas', 'jerarquia', 'jerarquias', 'arbol', 'arboles', 'estructura', 'estructuras', 'directorio', 'directorios', 'folder', 'folders', 'organizacion'],
  archivos: ['archivo', 'archivos', 'foto', 'fotos', 'fotografia', 'fotografias', 'imagen', 'imagenes', 'documento', 'documentos', 'fichero', 'ficheros', 'pdf', 'pdfs', 'file', 'files', 'adjunto', 'adjuntos'],
  pendientes: ['pendiente', 'pendientes', 'pending', 'pendent', 'porhacer'],
  hoy: ['hoy', 'today'],
  tareas: ['tarea', 'tareas', 'task', 'tasks', 'quehacer', 'quehaceres'],
  alarmas: ['alarma', 'alarmas', 'recordatorio', 'recordatorios', 'alarm', 'alarms', 'reminder', 'reminders'],
  citas: ['cita', 'citas', 'evento', 'eventos', 'event', 'events', 'reunion', 'reuniones'],
  notas: ['nota', 'notas', 'idea', 'ideas', 'pensamiento', 'pensamientos', 'apunte', 'apuntes', 'note', 'notes'],
  listas: ['listas', 'lists'],
  proyectos: ['proyecto', 'proyectos', 'project', 'projects'],
  horario: ['horario', 'horarios', 'schedule', 'timetable'],
  memoria: ['memoria', 'memory', 'recuerdos'],
};
const LECT_TEMA_DE = new Map(Object.entries(LECT_TEMA).flatMap(([clave, palabras]) => palabras.map((p) => [p, clave])));
// Pedir que te ENTREGUEN algo: con archivos («dame las fotos», «pásame el pdf») el manual dice que se mandan, no que se listan, así que eso lo decide el modelo
const LECT_ENTREGA = new Set(['dame', 'damelo', 'damela', 'damelos', 'damelas', 'dar', 'darme', 'pasame', 'pasamelo', 'pasamela', 'ponme', 'ponmelo', 'give', 'sacame', 'saca', 'abre', 'abreme']);
const LECT_TODO = new Set(['todo', 'toda', 'todos', 'todas', 'everything', 'all']);
const LECT_COMPLETO = new Set(['completo', 'completa', 'completos', 'completas', 'entero', 'entera', 'enteros', 'enteras', 'detallado', 'detallada', 'detallados', 'detalladas', 'detalle', 'detalles', 'full', 'complete']);
// Palabras a las que se puede corregir una errata (no las de 3 letras o menos: «hoy» y «hay» están a una letra de media docena de palabras)
const LECT_VOCABULARIO = [...new Set([...LECT_TEMA_DE.keys(), ...LECT_TODO, ...LECT_COMPLETO, ...LECT_PETICION].filter((p) => p.length >= 4))];

// Distancia de edición con transposiciones («carpteas» está a 1 de «carpetas»)
function distanciaLect(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const coste = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + coste);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}
// Qué es una palabra conocida: un tema (con su clave), «todo», «completo» o una petición. Dos candidatas de la misma clase no son un empate de verdad.
const claseLect = (p) => (LECT_TEMA_DE.has(p) ? `tema:${LECT_TEMA_DE.get(p)}` : LECT_TODO.has(p) ? 'todo' : LECT_COMPLETO.has(p) ? 'completo' : 'peticion');
// Corrige una palabra con errata a la palabra conocida más parecida: misma letra inicial, a una letra de distancia (a dos si es larga). Si hay
// varias igual de parecidas, vale solo si son de la misma clase («todd» está a una letra de todo, toda y todos: todas son «todo»)
function corregirLect(palabra) {
  if (palabra.length < 4 || /\d/.test(palabra)) return palabra;
  const tope = palabra.length >= 8 ? 2 : 1;
  let mejor = null;
  for (const candidata of LECT_VOCABULARIO) {
    if (candidata[0] !== palabra[0] || Math.abs(candidata.length - palabra.length) > tope) continue;
    const d = distanciaLect(palabra, candidata);
    if (d > tope) continue;
    if (!mejor || d < mejor.d) mejor = { c: candidata, d, clases: new Set([claseLect(candidata)]) };
    else if (d === mejor.d) mejor.clases.add(claseLect(candidata));
  }
  return mejor && mejor.clases.size === 1 ? mejor.c : palabra;
}

function interpretarLectura(texto, ahora, nombre) {
  const palabras = sinSignos(texto).split(' ').filter(Boolean);
  if (palabras.length === 0 || palabras.length > 9) return null;
  // Su propio nombre al empezar o acabar («Marta, dame todo»), que en un audio es lo más normal
  const propios = new Set(sinSignos(nombre ?? '').split(' ').filter((p) => p.length >= 2 && !LECT_TEMA_DE.has(p) && !LECT_TODO.has(p) && !LECT_COMPLETO.has(p) && !LECT_PETICION.has(p)));
  let peticion = false;
  let entrega = false;
  let todo = false;
  let completo = false;
  const temas = new Set();
  for (const bruta of palabras) {
    // La palabra tal cual y, si no se conoce, corregida; «pendientes» también si viene pegada a otras («porhacer»)
    const candidatas = [bruta, corregirLect(bruta)];
    const w = candidatas.find((c) => LECT_TEMA_DE.has(c) || LECT_TODO.has(c) || LECT_COMPLETO.has(c) || LECT_PETICION.has(c) || LECT_RELLENO.has(c) || propios.has(c));
    if (w === undefined) return null; // una palabra que no conoce: lo decide el modelo
    if (LECT_TEMA_DE.has(w)) temas.add(LECT_TEMA_DE.get(w));
    else if (LECT_TODO.has(w)) todo = true;
    else if (LECT_COMPLETO.has(w)) completo = true;
    else if (LECT_PETICION.has(w)) {
      peticion = true;
      if (LECT_ENTREGA.has(w)) entrega = true;
    }
  }
  // Un tema suelto sin pedir nada («tareas» a secas, «todo») puede ser la respuesta a otra pregunta: hace falta una petición o un «mis»
  const posesivo = palabras.includes('mis') || palabras.includes('mi');
  if (!peticion && !posesivo) return null;
  // «Pendientes» acompaña a otro tema sin cambiarlo («tareas pendientes», «lo de hoy pendiente»)
  if (temas.has('pendientes') && temas.size === 2) temas.delete('pendientes');
  const consulta = (extra = {}) => ({ tipo: 'atajo', datos: { intencion: 'consultar', consulta: { estado: 'pendiente', ...extra, ...(completo ? { completo: true } : {}) } } });
  if (temas.size === 0) return todo || completo ? consulta() : null;
  if (temas.size > 1) return null;
  const [tema] = temas;
  if (tema === 'pendientes') return consulta();
  if (tema === 'hoy') {
    const hoy = diaMadrid((ahora ?? new Date()).getTime());
    return consulta({ desde: hoy, hasta: hoy });
  }
  if (['tareas', 'alarmas', 'citas', 'notas', 'listas'].includes(tema)) {
    const clave = tema === 'citas' ? 'citas' : tema;
    const base = ATAJO_LISTA[clave];
    return { tipo: 'atajo', datos: { ...base, consulta: { ...base.consulta, ...(completo ? { completo: true } : {}) } } };
  }
  if (tema === 'proyectos') return { tipo: 'atajo', datos: ATAJO_LISTA.proyectos };
  if (tema === 'carpetas') return { tipo: 'atajo', datos: { intencion: 'carpetas' } };
  // «dame las fotos» las manda (lo decide el modelo); «ver mis archivos», «qué archivos tengo», «enséñame las fotos» las lista
  if (tema === 'archivos') return entrega ? null : { tipo: 'atajo', datos: { intencion: 'ver_archivos', ver_archivos: { enviar: false } } };
  if (tema === 'memoria') return { tipo: 'memoria', accion: 'ver' };
  if (tema === 'horario') return { tipo: 'horario', accion: 'ver' };
  return null;
}

// Devuelve null si el mensaje no es un comando ni una petición de ayuda; si lo es: { tipo: 'texto', mensajes, motivo } o { tipo: 'atajo', datos }.
function interpretarComando(mensaje, { ahora, nombre } = {}) {
  const texto = typeof mensaje === 'string' ? mensaje.trim() : '';
  if (texto === '') return null;

  if (!texto.startsWith('/')) {
    const f = sinSignos(texto);
    if (FRASES_NOMBRE.has(f) || FRASES_NOMBRE.has(f.replace(SALUDO_INICIAL, ''))) return { tipo: 'texto', mensajes: [textoName(nombre)], motivo: 'name' };
    const pone = PONER_NOMBRE.exec(texto);
    if (pone) {
      const esPregunta = /[¿?]/.test(texto);
      const nuevo = pone[1].replace(/^["«“']+|["»”']+$/g, '').trim();
      if (esPregunta) return { tipo: 'texto', mensajes: [textoName(nombre)], motivo: 'name' };
      if (NOMBRE_VALIDO.test(nuevo) && nuevo.split(/\s+/).length <= 3) {
        return { tipo: 'atajo', datos: { intencion: 'recordar', memoria_nueva: { termino: NOMBRE_TERMINO, significado: nuevo } } };
      }
    }
    if (FRASES_MEMORIA.has(f) || FRASES_MEMORIA.has(f.replace(SALUDO_INICIAL, ''))) return { tipo: 'memoria', accion: 'ver' };
    if (FRASES_HORARIO.has(f) || FRASES_HORARIO.has(f.replace(SALUDO_INICIAL, ''))) return { tipo: 'horario', accion: 'ver' };
    const olvido = OLVIDAR_MEMORIA.exec(f.replace(SALUDO_INICIAL, ''));
    if (olvido) return { tipo: 'memoria', accion: 'olvidar', arg: olvido[1].trim() };
    if (FRASES_AYUDA.has(f)) return { tipo: 'texto', mensajes: [TEXTO_AYUDA], motivo: 'help' };
    if (FRASES_ABOUT.has(f)) return { tipo: 'texto', mensajes: textoAbout(nombre), motivo: 'about' };
    if (FRASES_PENDIENTE.has(f)) return { tipo: 'atajo', datos: { intencion: 'consultar', consulta: { estado: 'pendiente' } } };
    const lista = LISTA_DE.exec(f);
    if (lista) return { tipo: 'atajo', datos: ATAJO_LISTA[lista[1]] };
    if (FRASE_TODO_COMPLETO.test(` ${f}`)) return { tipo: 'atajo', datos: { intencion: 'consultar', consulta: { estado: 'pendiente', completo: true } } };
    if (FRASE_TODO_SUELTO.test(` ${f}`)) return { tipo: 'atajo', datos: { intencion: 'consultar', consulta: { estado: 'pendiente' } } };
    if (FRASES_HOY.has(f)) {
      const hoy = diaMadrid((ahora ?? new Date()).getTime());
      return { tipo: 'atajo', datos: { intencion: 'consultar', consulta: { estado: 'pendiente', desde: hoy, hasta: hoy } } };
    }
    // Lo mismo dicho de otra forma, con sinónimos o erratas («dame la jerarquía de carpetas», «dame todd»): solo lecturas, sin el modelo
    return interpretarLectura(texto, ahora, nombre);
  }

  const m = /^\/+([\p{L}]*)\s*(.*)$/su.exec(texto);
  const bruto = (m?.[1] ?? '').toLowerCase();
  const arg = sinSignos(m?.[2] ?? '');
  const cmd = ALIAS_COMANDO[bruto] ?? (COMANDOS.some((c) => c[0] === bruto) ? bruto : null);

  if (bruto === '') return { tipo: 'texto', mensajes: [TEXTO_AYUDA], motivo: 'help' };
  if (cmd === null) {
    // Un comando que no existe: se dice y se sugiere el más parecido por el principio del nombre
    const parecido = COMANDOS.find((c) => c[0].startsWith(bruto.slice(0, 2)) && bruto.length >= 2);
    return {
      tipo: 'texto',
      mensajes: [`No conozco el comando /${bruto.slice(0, 30)}.${parecido ? ` ¿Querías decir /${parecido[0]}?` : ''}`],
      motivo: 'desconocido',
    };
  }
  switch (cmd) {
    case 'help':
      return { tipo: 'texto', mensajes: [TEXTO_AYUDA], motivo: 'help' };
    case 'about':
      return { tipo: 'texto', mensajes: textoAbout(nombre), motivo: 'about' };
    case 'examples':
      return { tipo: 'texto', mensajes: [TEXTO_EJEMPLOS], motivo: 'examples' };
    case 'name':
      return { tipo: 'texto', mensajes: [textoName(nombre)], motivo: 'name' };
    case 'memory':
      return { tipo: 'memoria', accion: 'ver' };
    case 'forget':
      return arg ? { tipo: 'memoria', accion: 'olvidar', arg } : { tipo: 'memoria', accion: 'ver', pista: true };
    case 'schedule': {
      if (arg === '') return { tipo: 'horario', accion: 'ver' };
      const q = /^(?:quitar|quita|borrar|borra|eliminar|elimina|olvida|olvidar) (\d{1,2})$/.exec(arg);
      return q ? { tipo: 'horario', accion: 'quitar', n: Number(q[1]) } : { tipo: 'horario', accion: 'ver', pista: true };
    }
    case 'manual': {
      if (arg === '') return { tipo: 'texto', mensajes: [textoManualIndice()], motivo: 'manual' };
      if (arg === 'todo' || arg === 'todos' || arg === 'completo') {
        return { tipo: 'texto', mensajes: TEMAS_MANUAL.map((t) => `*${MANUAL[t].titulo}*\n${MANUAL[t].texto}`), motivo: 'manual' };
      }
      const tema = TEMAS_MANUAL.find((t) => t === arg || sinAcentos(MANUAL[t].titulo).startsWith(arg)) ?? null;
      if (tema === null) return { tipo: 'texto', mensajes: [`No tengo un tema «${arg.slice(0, 30)}». ${textoManualIndice()}`], motivo: 'manual' };
      return { tipo: 'texto', mensajes: [`*${MANUAL[tema].titulo}*\n${MANUAL[tema].texto}`], motivo: 'manual' };
    }
    case 'pending':
      // «/pending completo» (o full, todo, entero): con todo el detalle
      return { tipo: 'atajo', datos: { intencion: 'consultar', consulta: { estado: 'pendiente', completo: /^(complet[oa]|full|todo|enter[oa]|detalle)$/.test(arg) } } };
    case 'today': {
      const hoy = diaMadrid((ahora ?? new Date()).getTime());
      return { tipo: 'atajo', datos: { intencion: 'consultar', consulta: { estado: 'pendiente', desde: hoy, hasta: hoy } } };
    }
    case 'files':
      return { tipo: 'atajo', datos: { intencion: 'ver_archivos', ver_archivos: { enviar: false } } };
    case 'folders':
      return { tipo: 'atajo', datos: { intencion: 'carpetas' } };
    case 'projects':
      return { tipo: 'atajo', datos: { intencion: 'proyectos' } };
    default:
      return null;
  }
}

// --- Aplazar una alarma o una cita RESPONDIENDO a su aviso ---
// «10 minutos», «otros 10», «pospón media hora», «1 hora más», «+15», «en 20 minutos»: lo resuelve este código, sin el modelo (rápido,
// gratis y sin errores de cuentas). Solo cuando se responde a un aviso con UN elemento (si el aviso llevaba varios, decide el modelo,
// que ve cuáles son). Una fecha concreta («al viernes a las 9») también va al modelo.
// La hora nueva:
//   - alarma que YA sonó, o «en N…»: desde ahora (si son las 18:35, «10 minutos» -> 18:45);
//   - alarma que aún no ha sonado: desde su hora (18:30 + «1 hora» -> 19:30);
//   - cita: desde su hora de inicio («retrásala media hora»); con «en N…», desde ahora. Conserva la duración (lo hace comprobarAgenda) y
//     pasa por el control de solapes como cualquier cambio de hora.
const NUMEROS_APLAZAR = {
  un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  doce: 12, quince: 15, veinte: 20, veinticinco: 25, treinta: 30, cuarenta: 40, cuarenta_y_cinco: 45, cincuenta: 50,
};
const RELLENO_APLAZAR = new Set([
  'y', 'vale', 'ok', 'mejor', 'pues', 'venga', 'porfa', 'porfavor', 'pospon', 'posponla', 'posponlo', 'posponer', 'aplaza', 'aplazala', 'aplazalo',
  'retrasa', 'retrasala', 'retrasalo', 'atrasa', 'atrasala', 'atrasalo', 'amplia', 'ampliala', 'amplialo', 'alarga', 'alargala', 'alargalo',
  'mueve', 'muevela', 'muevelo', 'dame', 'dejame', 'recuerdamelo', 'recuerdamela', 'recuerdame', 'avisame', 'vuelve', 'a', 'avisarme',
  'otra', 'vez', 'la', 'lo', 'alarma', 'cita', 'aviso', 'snooze',
]);
const MAX_APLAZAR_MIN = 7 * 24 * 60;

// Minutos que pide el texto ya normalizado, o null si no es solo una cantidad de tiempo
function minutosDeAplazar(t) {
  let m;
  if ((m = /^\+?(\d{1,5})\s*(min|mins|minuto|minutos|m|h|hora|horas)?$/.exec(t))) return Number(m[1]) * (/^h/.test(m[2] ?? '') ? 60 : 1);
  if (/^media hora$/.test(t)) return 30;
  if (/^(?:un |una )?cuarto de hora$/.test(t)) return 15;
  if (/^tres cuartos de hora$/.test(t)) return 45;
  if ((m = /^(\d{1,3}|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|doce) (?:horas?|h) y media$/.exec(t))) {
    return (Number(m[1]) || NUMEROS_APLAZAR[m[1]]) * 60 + 30;
  }
  if ((m = /^([a-z_ ]+?) (minutos?|horas?)$/.exec(t))) {
    const n = NUMEROS_APLAZAR[m[1].replace(/ /g, '_')];
    if (n) return n * (m[2].startsWith('hora') ? 60 : 1);
  }
  return null;
}

// Devuelve null (no es un aplazamiento resoluble por código) o { ref, cambios, minutos }. "citados": los elementos del aviso al que se
// responde, con su referencia corta (ref), tipo, recordar_en o fecha_inicio.
function interpretarAplazamiento(mensaje, citados, ahora) {
  if (!Array.isArray(citados) || citados.length !== 1) return null;
  const item = citados[0];
  let palabras = sinSignos(mensaje ?? '').split(' ').filter(Boolean);
  while (palabras.length > 0 && RELLENO_APLAZAR.has(palabras[0])) palabras.shift();
  while (palabras.length > 0 && ['mas', 'porfa', 'por', 'favor'].includes(palabras.at(-1))) palabras.pop();
  let desdeAhora = false;
  if (palabras[0] === 'en') {
    desdeAhora = true;
    palabras.shift();
  } else if (palabras[0] === 'dentro' && palabras[1] === 'de') {
    desdeAhora = true;
    palabras = palabras.slice(2);
  }
  while (palabras.length > 0 && ['otros', 'otras', 'otro', 'unos', 'unas', 'por', 'durante', 'de'].includes(palabras[0])) palabras.shift();
  const minutos = palabras.length > 0 ? minutosDeAplazar(palabras.join(' ')) : null;
  if (!minutos || minutos < 1 || minutos > MAX_APLAZAR_MIN) return null;

  const ahoraMs = (ahora ?? new Date()).getTime();
  if (item.tipo === 'tarea' && typeof item.recordar_en === 'string' && !Number.isNaN(Date.parse(item.recordar_en))) {
    const hora = Date.parse(item.recordar_en);
    const base = desdeAhora || hora <= ahoraMs ? ahoraMs : hora;
    return { ref: item.ref, minutos, cambios: { recordar_en: new Date(base + minutos * 60000).toISOString() } };
  }
  if (item.tipo === 'evento' && typeof item.fecha_inicio === 'string' && !Number.isNaN(Date.parse(item.fecha_inicio))) {
    const base = desdeAhora ? ahoraMs : Date.parse(item.fecha_inicio);
    return { ref: item.ref, minutos, cambios: { fecha_inicio: new Date(base + minutos * 60000).toISOString() } };
  }
  return null;
}

// --- Nombre repetido: «¿cuáles hay?» antes de decidir ---
// Si tu última pregunta era "Ya tienes «Dentista» (…). ¿La cambio o añado otra?" y el usuario pregunta cuáles existen, lo contesta el código
// con la lista de las que existen y la pregunta sigue abierta para que decida después.
const PIDE_CUALES = /^(?:y )?(?:(?:dime|dame|muestrame|ensename|ver|lista) )?(?:cuales|cual|las que|lo que|que)(?: ya)?(?: hay| existen| existe| tengo| tienes| son| ya hay)*$|^(?:muestramelas|ensenamelas|dimelas|la lista|lista)$/;
// El turno del modelo se guarda tal cual en el hilo. Una confirmación de borrar en Drive solo la puede escribir el código («Resultado»):
// si el modelo devuelve algo con esa forma (por ejemplo, porque un mensaje reenviado se lo pide), se le quita antes de guardarlo.
function sinMarcaDeCodigo(texto) {
  try {
    const j = JSON.parse(texto);
    if (j && typeof j === 'object' && (j.motivo === 'confirmar_drive' || j.motivo === 'confirmar_memoria' || 'papelera' in j || 'olvidar' in j || 'origen' in j)) {
      delete j.motivo;
      delete j.papelera;
      delete j.olvidar;
      delete j.origen;
      return JSON.stringify(j);
    }
  } catch {
    // no es JSON: se guarda tal cual
  }
  return texto;
}
function motivoDelHilo(hilo) {
  const ultimo = (Array.isArray(hilo) ? hilo : []).at(-1);
  if (ultimo?.rol !== 'model') return null;
  try {
    return JSON.parse(ultimo.texto);
  } catch {
    return null;
  }
}
// Devuelve los títulos (sin acentos) del nombre repetido sobre el que se preguntó, o null si el mensaje no pide la lista
function pideListarRepetidos(mensaje, hilo) {
  const turno = motivoDelHilo(hilo);
  if (turno?.motivo !== 'repetido' || !PIDE_CUALES.test(sinSignos(mensaje ?? ''))) return null;
  return Array.isArray(turno.repetidos) ? turno.repetidos.filter((t) => typeof t === 'string') : [];
}

// --- Varias preguntas abiertas a la vez ---
// Si el usuario escribe antes de que le llegue la respuesta, quedan abiertas varias preguntas («¿alarma, cita o tarea?», «¿los quito?»,
// «¿a qué hora?»). Antes cada pregunta nueva cerraba la anterior y un «sí» acababa contestando a la equivocada. Ahora se leen hasta
// tres y el mensaje contesta a la que encaja con lo que dice; una orden nueva («borra…», «dame…») no contesta a ninguna y las deja abiertas.
const SI_NO = /^(?:si|no|vale|ok|okey|dale|venga|claro|adelante|hazlo|perfecto|de acuerdo|correcto|exacto|por supuesto|sip|nop|ni hablar|mejor no|no gracias|cancelalo|dejalo|quitalos|quitalo|quitala|quitalas|borralos|borralo|borrala|borralas|eliminalo|eliminala|eliminalos|eliminalas|mandalo|mandalos|olvidalo|olvidalos|marcalos|cierralo)\b/;
const CUANDO = /\d|\b(?:mediodia|medianoche|manana|hoy|pasado|noche|tarde|lunes|martes|miercoles|jueves|viernes|sabado|domingo|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)\b/;
const ELIGE_TIPO = /\b(?:alarma|cita|tarea)s?\b/;
const ELIGE_REPETIDO = /\b(?:cambia|cambiala|cambialo|actualiza|actualizala|modifica|sustituye|reemplaza|anade|anadela|otra|otro|nueva|nuevo|las dos|los dos|ambas|ambos|si|no|cuales|cual)\b/;
const ORDEN_NUEVA = /^(?:que|cuales|cual|cuantos|cuantas|dame|dime|ensename|muestrame|mis|lista|borra|quita|elimina|recuerdame|apunta|anota|crea|abre|cierra|completa|marca|\/)/;
const MOTIVOS_SI_NO = ['confirmar_agenda', 'confirmar_lote', 'crear_proyecto', 'confirmar_drive', 'confirmar_horario', 'confirmar_memoria'];
function tipoDePregunta(fila) {
  const motivo = motivoDelHilo(fila.hilo)?.motivo;
  if (MOTIVOS_SI_NO.includes(motivo)) return 'sino';
  if (motivo === 'repetido') return 'eleccion';
  if (motivo === 'oferta') return 'oferta';
  if (motivo === 'carpeta_parecida') return 'carpeta';
  if (motivo === 'sugerencia') return 'sugerencia';
  if (motivo === 'convertir_hora' || motivo === 'solape') return 'cuando';
  const texto = sinAcentos(fila.pregunta);
  if (/alarma/.test(texto) && /cita/.test(texto) && /tarea/.test(texto)) return 'tipo';
  if (/\bhora\b/.test(texto)) return 'cuando';
  return 'libre';
}
// Una confirmación (sí/no) solo la contesta un sí o un no, o un cambio corto («a las 6», «mejor el jueves»: hasta 4 palabras con un día o
// una hora). Algo más largo es otra cosa («mañana dentista a las 10») y no la contesta.
// Una orden nueva («borra…», «dame…», «apunta…»), salvo un sí/no (se usa también para saber si citar una pregunta es contestarla)
const esOrdenNueva = (mensaje) => { const m = sinSignos(mensaje ?? ''); return ORDEN_NUEVA.test(m) && !SI_NO.test(m); };
const RESPONDE_SINO = { test: (m) => SI_NO.test(m) || (CUANDO.test(m) && m.split(' ').filter(Boolean).length <= 4) };
// Una oferta de la charla («¿quieres que te lo apunte como tarea?») la contesta un sí, un no o «apúntalo» (aunque «apúntalo»
// empiece como una orden nueva); cualquier otra cosa es otro tema.
// Lista CERRADA de palabras y de hasta 4 en total: «claro, y qué tengo mañana» o «anota que mañana tengo dentista» NO son respuestas a la oferta.
const PALABRAS_OFERTA = new Set(['si', 'sii', 'vale', 'ok', 'okey', 'claro', 'dale', 'venga', 'perfecto', 'hazlo', 'adelante', 'de', 'acuerdo', 'por', 'favor', 'no', 'nop', 'mejor', 'ya', 'esta', 'gracias', 'pues', 'bueno', 'todo', 'tambien', 'apuntalo', 'apuntala', 'apuntamelo', 'apuntamela', 'anotalo', 'anotala', 'anotamelo', 'anotamela', 'guardalo', 'guardala', 'ponlo', 'ponla', 'ponmelo', 'ponmela']);
const OFERTA_ACEPTA = {
  test: (m) => {
    const p = String(m ?? '').split(' ').filter(Boolean);
    // «vale gracias» o «gracias» solos son un acuse, no una aceptación: solo vale «gracias» tras un «no»
    return p.length > 0 && p.length <= 4 && p.every((w) => PALABRAS_OFERTA.has(w)) && (!p.includes('gracias') || p.includes('no'));
  },
};
// «¿Dónde la guardo?» : un número, «la primera», «sí», «créala», «no» o un nombre corto
const ELIGE_CARPETA = { test: (m) => /^(?:\d|la \d|el \d|opcion \d|numero \d|primera|segunda|tercera|cuarta|quinta|si|vale|ahi|esa|en esa|crea|creala|crear|nueva|una nueva|otra|no|dejalo|nada|cancela)\b/.test(m) || m.split(' ').filter(Boolean).length <= 3 };
// Una propuesta concreta : un sí o un no cortos, o repetir el principio de la orden («mueve los archivos»)
const RESPONDE_SUGERENCIA = { test: (m) => { const p = m.split(' ').filter(Boolean); return RECHAZA_SUGERENCIA.test(m) || (p.length <= 5 && p.every((w) => PALABRAS_ACEPTA.has(w))) || /^(?:mueve|mover|pasa|pasar|junta|juntar|mete|meter)\b/.test(m); } };
const RESPONDE = { sino: RESPONDE_SINO, cuando: CUANDO, tipo: ELIGE_TIPO, eleccion: ELIGE_REPETIDO, oferta: OFERTA_ACEPTA, carpeta: ELIGE_CARPETA, sugerencia: RESPONDE_SUGERENCIA };
// Si el mensaje no encaja con ninguna, solo se toma como respuesta a la más reciente si esta admite cualquier cosa (una pregunta libre, una
// hora o una elección). A una confirmación o a «¿alarma, cita o tarea?» no la contesta algo que no encaja: es otra cosa.
const ACEPTA_CUALQUIERA = new Set(['libre', 'cuando', 'eleccion']);
// De las preguntas abiertas (la más reciente primero) devuelve la que este mensaje contesta, o null si es una orden nueva.
// 1) la más reciente cuyo contenido encaja con el mensaje; 2) si no encaja con ninguna pero tampoco parece una orden nueva, la más
// reciente si admite cualquier respuesta (libre, hora, elección; no una confirmación ni el tipo); 3) si parece una
// orden nueva, ninguna.
function elegirPregunta(mensaje, abiertas) {
  const filas = (Array.isArray(abiertas) ? abiertas : []).filter((f) => f && typeof f.id === 'string');
  if (filas.length === 0) return null;
  const m = sinSignos(mensaje ?? '');
  const esOrden = ORDEN_NUEVA.test(m) && !SI_NO.test(m);
  if (esOrden) return filas.find((f) => tipoDePregunta(f) === 'libre') ?? filas.find((f) => tipoDePregunta(f) === 'oferta' && OFERTA_ACEPTA.test(m)) ?? filas.find((f) => tipoDePregunta(f) === 'carpeta' && CREA_NUEVA.test(m)) ?? null;
  return filas.find((f) => RESPONDE[tipoDePregunta(f)]?.test(m)) ?? (ACEPTA_CUALQUIERA.has(tipoDePregunta(filas[0])) ? filas[0] : null);
}

// Un «sí» o un «no» sueltos sin ninguna pregunta abierta (ya caducó o ya se contestó): no hay nada que confirmar y el modelo se lo inventaba
// («¿a qué hora?»). Se contesta sin él. Solo «sí» y «no» exactos: un «vale» o un «ok» pueden ser un simple acuse de recibo y no se tocan.
const TEXTO_SI_NO_SUELTO = 'No tengo ninguna pregunta pendiente. ¿Qué quieres que haga?';
function siNoSinPregunta(mensaje, hilo) {
  if (Array.isArray(hilo) && hilo.length > 0) return null;
  return /^(?:si|no)$/.test(sinSignos(mensaje ?? '')) ? TEXTO_SI_NO_SUELTO : null;
}

// «Tarea», «cita» o «alarma» suelto SIN pregunta abierta: el usuario contesta a una pregunta que
// ya se resolvió (los mensajes se cruzaron: «Tarea» a «¿alarma, cita o tarea?» cuando ya estaba apuntada) y el modelo contestaba «No te he
// entendido…» tras 30 s. Si en los últimos 2 minutos se apuntó algo (reciente: el pendiente más nuevo, con su created_at), se resuelve por
// código, sin el modelo: mismo tipo → se dice que ya está; otro tipo → se convierte. Sin nada reciente, decide el modelo como siempre.
// Devuelve null o { ref, pedido, actual, igual, titulo, item }.
const TIPO_SUELTO = /^(?:pues |mejor |como )?(?:una? )?(tarea|cita|evento|alarma|recordatorio)(?: por favor)?$/;
const TIPO_PEDIDO = { tarea: 'tarea', cita: 'cita', evento: 'cita', alarma: 'alarma', recordatorio: 'alarma' };
const VENTANA_TIPO_SUELTO_MS = 2 * 60 * 1000;
function tipoSuelto(mensaje, hilo, reciente, ahora) {
  if (Array.isArray(hilo) && hilo.length > 0) return null;
  const m = TIPO_SUELTO.exec(sinSignos(mensaje ?? ''));
  if (!m || !reciente || typeof reciente.ref !== 'string') return null;
  const creado = Date.parse(reciente.created_at);
  const edad = (ahora instanceof Date ? ahora.getTime() : Date.now()) - creado;
  if (!Number.isFinite(creado) || edad < 0 || edad > VENTANA_TIPO_SUELTO_MS) return null;
  const actual = reciente.tipo === 'evento' ? 'cita' : reciente.tipo !== 'tarea' ? null : reciente.recordar_en && !reciente.fecha_limite ? 'alarma' : 'tarea';
  if (!actual) return null; // una nota o una lista: decide el modelo
  const pedido = TIPO_PEDIDO[m[1]];
  return { ref: reciente.ref, pedido, actual, igual: pedido === actual, titulo: String(reciente.titulo ?? ''), item: reciente };
}

// Respuesta a «¿Te aviso mañana (…) para ir a comprar? Dime a qué hora.» (motivo aviso_compra), por código:
//   «no» → no se avisa; «a las 18», «sí, a las 6 y media», «18:30», «a las 7 de la tarde» → alarma «Ir a comprar» ese día a esa hora;
//   «sí» sin hora → se pregunta la hora. Una hora de 1 a 7 sin «de la mañana» se entiende de la tarde («a las 6» → 18:00).
//   Cualquier otra cosa (una orden nueva, «mejor el jueves»…) no es una respuesta de este tipo: null, y sigue el camino de siempre.
const NO_AVISO_COMPRA = /^(?:no|nop|no hace falta|no gracias|mejor no|nada|no te preocupes|no avises|sin aviso)$/;
const SI_AVISO_COMPRA = /^(?:si|vale|ok|venga|claro|por favor|si por favor|si porfa|perfecto|dale)$/;
const HORA_AVISO_COMPRA = /^(?:(?:si|vale|ok|venga|claro|perfecto|dale) )?(?:avisame )?(?:(?:a|sobre|hacia) (?:las|la) )?(\d{1,2})(?: ?h| (\d{2}))?(?: y (media|cuarto))?(?: (?:de la|por la) (manana|tarde|noche))?(?: por favor)?$/;
function respuestaAvisoCompra(mensaje, hilo) {
  const turno = motivoDelHilo(hilo);
  if (turno?.motivo !== 'aviso_compra' || typeof turno.aviso_compra?.dia !== 'string') return null;
  const m = sinSignos(mensaje ?? '');
  if (NO_AVISO_COMPRA.test(m)) return { tipo: 'no' };
  const h = HORA_AVISO_COMPRA.exec(m);
  if (h) {
    let hora = Number(h[1]);
    let min = h[2] ? Number(h[2]) : h[3] === 'media' ? 30 : h[3] === 'cuarto' ? 15 : 0;
    if (h[4] === 'tarde' || h[4] === 'noche' ? hora < 12 : !h[4] && hora >= 1 && hora <= 7) hora += 12;
    if (hora > 23 || min > 59) return null;
    return { tipo: 'hora', hora, min, dia: turno.aviso_compra.dia, etiqueta: turno.aviso_compra.etiqueta ?? '' };
  }
  if (SI_AVISO_COMPRA.test(m)) return { tipo: 'sin_hora', dia: turno.aviso_compra.dia, etiqueta: turno.aviso_compra.etiqueta ?? '' };
  return null;
}

// El «no» a una oferta de la charla («¿quieres que te lo apunte?») se resuelve por código: no hay nada que hacer. El «sí» sí pasa
// por el modelo, que es quien sabe qué título darle.
const NO_OFERTA = /^(?:no|nop|no gracias|mejor no|no hace falta|ya esta|no te preocupes|da igual|olvidalo|dejalo)$/;
function respuestaOferta(mensaje, hilo) {
  if (motivoDelHilo(hilo)?.motivo !== 'oferta') return null;
  return NO_OFERTA.test(sinSignos(mensaje ?? '')) ? { tipo: 'no' } : null;
}
const TEXTO_OFERTA_NO = 'Vale, no lo apunto.';
// ¿Lo que dice la charla es una oferta de apuntar algo? (acaba en pregunta y habla de apuntar, anotar, guardar, recordar, agendar…)
function esOfertaDeApuntar(texto) {
  const t = sinAcentos(texto ?? '');
  if (!/\?[^a-z0-9?]*(?:\([^)]*\)[^a-z0-9?]*)?$/.test(t)) return false; // acaba en pregunta (se admite detrás un emoji o una aclaración entre paréntesis)
  // Solo la última pregunta: «Claro, puedo recordarte lo que quieras. ¿Qué te recuerdo?» no ofrece apuntar nada
  const ultima = t.includes('¿') ? t.slice(t.lastIndexOf('¿')) : t.split(/[.!]\s+/).pop();
  return /\b(?:quieres|prefieres|deseas|necesitas|te gustaria|te interesa) que (?:te |se )?(?:lo |la |los |las )?(?:apunte|anote|guarde|agende|recuerde|programe|ponga|anada)\b/.test(ultima)
    || /\b(?:lo|la|los|las) (?:apunto|anoto|guardo|agendo|recuerdo|pongo)\b/.test(ultima)
    || /\b(?:apunto|anoto|guardo|agendo)(?:lo|la)?\b.*\bcomo (?:tarea|cita|alarma|nota|recordatorio)\b/.test(ultima);
}

// «Borra todo»: nunca se borra todo de golpe. La frase se reconoce aquí, sin el modelo, y se convierte en un
// cancelar sin sección, que Planificar contesta preguntando qué sección se quiere borrar.
const BORRAR_TODO = /^(?:por favor )?(?:quiero |puedes |me )?(?:borra(?:r|lo|me)?|elimina(?:r|lo)?|quita(?:r|lo)?|limpia(?:r|lo)?|vacia(?:r|lo)?)(?: lo)? todo(?: lo que tengo| lo pendiente| lo que hay| lo apuntado)?(?: por favor)?$/;
const pideBorrarTodo = (mensaje) => BORRAR_TODO.test(sinSignos(mensaje ?? ''));

// «Borra la cita», «elimina la tarea del banco», «quita la alarma de la ropa» (con UNA sola cita, el modelo llegaba a contestar
// «Tienes varias citas de Médico, ¿cuál?»). Se resuelve por código cuando no hay duda: si de ese tipo (y con
// esas palabras en el título) hay exactamente uno, se quita ese, sin el modelo; si no hay ninguno, se dice; si hay varios, decide el modelo
// (que pregunta cuál). pendientes: los elementos pendientes con su id (real o referencia corta, el que use quien llama).
const QUITAR_UNO = /^(?:por favor )?(?:borra|borrame|elimina|eliminame|quita|quitame|cancela|cancelame|anula)(?:r)? (?:la|el|mi) (cita|evento|tarea|alarma|recordatorio|nota|pensamiento|idea)(?: (?:del|de la|de|para|con|sobre) (.+))?$/;
const TIPO_A_QUITAR = { cita: 'cita', evento: 'cita', tarea: 'tarea', alarma: 'alarma', recordatorio: 'alarma', nota: 'nota', pensamiento: 'nota', idea: 'nota' };
const NOMBRE_A_QUITAR = { cita: 'ninguna cita', tarea: 'ninguna tarea', alarma: 'ninguna alarma', nota: 'ningún pensamiento' };
// (los días no se ignoran: «la cita de mañana» con una única cita de la semana que viene no encaja, y decide el modelo)
const VACIAS_QUITAR = new Set(['del', 'las', 'los', 'una', 'uno', 'que', 'con', 'para', 'esta', 'este', 'esa', 'ese']);
function quitarConcreto(mensaje, pendientes) {
  const m = QUITAR_UNO.exec(sinSignos(mensaje ?? ''));
  if (!m) return null;
  // Con un número («la cita del 25», «la de las 10») el título no lo lleva y no se puede comprobar: decide el modelo
  if (m[2] && /\d/.test(m[2])) return null;
  const clase = TIPO_A_QUITAR[m[1]];
  const esAlarma = (r) => r.tipo === 'tarea' && Boolean(r.recordar_en) && !r.fecha_limite;
  const deClase = (Array.isArray(pendientes) ? pendientes : []).filter((r) => {
    if (!r || typeof r.id !== 'string') return false;
    if (clase === 'cita') return r.tipo === 'evento';
    if (clase === 'alarma') return esAlarma(r);
    if (clase === 'tarea') return r.tipo === 'tarea' && !esAlarma(r);
    return r.tipo === 'nota';
  });
  const palabras = m[2] ? m[2].split(' ').filter((w) => w.length > 2 && !VACIAS_QUITAR.has(w)) : [];
  const encajan = palabras.length === 0 ? deClase : deClase.filter((r) => palabras.every((w) => sinAcentos(r.titulo ?? '').includes(w)));
  if (encajan.length === 1) return { id: encajan[0].id };
  // «No tienes ninguna…» solo si no hay nada pendiente: si hay otras cosas, puede que el usuario llame «tarea» a una alarma (decide el modelo)
  if ((Array.isArray(pendientes) ? pendientes : []).filter((r) => r && typeof r.id === 'string').length === 0) return { ninguno: `No tienes ${NOMBRE_A_QUITAR[clase]} pendiente.` };
  return null;
}

// --- Deshacer lo quitado por WhatsApp ---
// Quitar, completar y cerrar un proyecto se hacen sin preguntar, así que se pueden recuperar: «deshaz» (o «deshaz todo», /undo) recupera lo que
// quitó la ÚLTIMA orden (todos sus elementos de una vez); «recupera la tarea del banco» / «deshaz lo de la compra», algo concreto de lo
// quitado en los últimos 7 días. Solo vale lo que el usuario quitó por WhatsApp (items.quitado_en): una alarma que ya sonó o
// algo borrado a mano en Calendar no cuenta. Se resuelve por código, sin el modelo.
const VERBO_DESHACER = '(?:deshaz|deshacer|deshazlo|desharlo|restaura|restaurar|recupera|recuperar|devuelve|devuelveme)';
const DESHACER_TODO = new RegExp(`^(?:por favor )?${VERBO_DESHACER}(?: lo)?(?: todo| lo ultimo| ultimo| lo anterior| eso| lo que (?:acabo de |he )?(?:quitado|borrado|quitar|borrar|quite|borre|quitaste|borraste))?(?: todo)?(?: por favor)?$`);
const DESHACER_CONCRETO = /^(?:por favor )?(?:deshaz|deshacer|restaura|restaurar|recupera|recuperar)(?:me)? (?:lo del? |lo de la |lo de los |lo de las |la |el |las |los |mi |mis )?(cita|evento|tarea|alarma|recordatorio|nota|pensamiento|idea)?\s*(.*?)(?: por favor)?$/;
const DIA_MS = 86400000;
function interpretarDeshacer(mensaje) {
  const bruto = String(mensaje ?? '').trim().toLowerCase();
  if (/^\/undo\b/.test(bruto)) return { todo: true };
  const m = sinSignos(mensaje ?? '');
  if (DESHACER_TODO.test(m)) return { todo: true };
  const c = DESHACER_CONCRETO.exec(m);
  if (!c || (!c[1] && !c[2].trim())) return null;
  const palabras = c[2].split(' ').filter((w) => w.length > 2 && !VACIAS_QUITAR.has(w));
  if (!c[1] && palabras.length === 0) return null;
  return { clase: c[1] ? TIPO_A_QUITAR[c[1]] : null, tipoPalabra: c[1] ?? null, palabras };
}
// «Déjalo como estaba» / «deshaz» justo después de MOVER archivos: vuelven a la carpeta en la que estaban.
// Solo vale si lo último que hizo la secretaria fue mover archivos (lo decide «Construir petición» con la anotación del mensaje anterior).
const COMO_ESTABA = /\b(?:dejalo|dejalos|dejalas|dejala|ponlo|ponlos|ponlas|ponla|vuelve a ponerlo|vuelve a ponerlos|vuelve a ponerlas|vuelve a dejarlo|vuelve a dejarlos|vuelve a dejarlas|devuelvelo|devuelvelos|devuelvelas|devuelvela|vuelvelo a poner|vuelvelos a poner|vuelvelas a poner)(?: todo)? (?:como (?:estaba|estaban|antes)|donde (?:estaba|estaban)|en su sitio|a su sitio)\b/;
const DEVUELVE_SOLO = /^(?:(?:perdon|vaya|uy|ups|no|me he equivocado|me equivoque)[ ,]+)*(?:devuelvelos|devuelvelas|devuelvelo|devuelvela|deshazlo|deshaz|deshacer|deshaz eso|deshaz lo ultimo)(?: por favor)?$/;
function interpretarDeshacerMovimiento(mensaje) {
  const t = sinSignos(mensaje ?? '');
  if (!t || t.split(' ').length > 25) return false;
  return COMO_ESTABA.test(t) || DEVUELVE_SOLO.test(t) || interpretarDeshacer(mensaje)?.todo === true;
}
const claseDeQuitado = (r) => (r.tipo === 'evento' ? 'cita' : r.tipo === 'tarea' ? (r.recordar_en && !r.fecha_limite ? 'alarma' : 'tarea') : r.tipo === 'nota' ? 'nota' : r.tipo);
// Devuelve { items } (lo que se recupera) o { texto } (nada que recuperar)
function elegirParaDeshacer(pedido, quitados, ahora) {
  const todos = (Array.isArray(quitados) ? quitados : [])
    .filter((r) => r && typeof r.id === 'string' && typeof r.titulo === 'string' && Number.isFinite(Date.parse(r.quitado_en)))
    .sort((a, b) => Date.parse(b.quitado_en) - Date.parse(a.quitado_en));
  if (todos.length === 0) return { texto: 'No hay nada que recuperar.' };
  if (pedido.todo) {
    const ultimo = Date.parse(todos[0].quitado_en);
    if (ahora.getTime() - ultimo > DIA_MS) return { texto: 'No hay nada que recuperar de las últimas 24 horas.' };
    // Una orden puede tocar varias filas con unos segundos de diferencia: el lote son las que se quitaron con menos de un minuto de separación
    return { items: todos.filter((r) => ultimo - Date.parse(r.quitado_en) <= 60000) };
  }
  const buscar = (clase, palabras) => todos.filter((r) => {
    if (clase && claseDeQuitado(r) !== clase) return false;
    const t = sinAcentos(`${r.titulo} ${r.lista ?? ''}`);
    return palabras.every((w) => t.includes(w));
  });
  let encajan = buscar(pedido.clase, pedido.palabras);
  // «Recupera idea vieja»: «idea» puede ser parte del título y no el tipo (nota)
  if (encajan.length === 0 && pedido.tipoPalabra && pedido.tipoPalabra.length > 2) encajan = buscar(null, [pedido.tipoPalabra, ...pedido.palabras]);
  return encajan.length > 0 ? { items: encajan.slice(0, 30) } : { texto: 'No encuentro eso entre lo que has quitado.' };
}

// Respuestas a las preguntas de borrar, resueltas por CÓDIGO (a «¿Qué sección quieres borrar?» se puede contestar
// «Tareas», que es también el atajo de «enséñame las tareas»; si ese atajo fuera primero, enseñaría el listado):
//   - con la pregunta de la sección abierta, el nombre de una sección es esa sección (y no un listado): un cancelar con su filtro;
//   - con la confirmación de un lote abierta, un «sí» corto repite ese lote (sus ids exactos) y un «no» corto no toca nada.
// Así ninguno de los dos pasos depende de cómo interprete el modelo un hilo que empieza por «borra todo».
function seccionElegida(mensaje, hilo) {
  if (motivoDelHilo(hilo)?.motivo !== 'elegir_seccion') return null;
  const m = sinSignos(mensaje ?? '')
    .replace(/^(?:pues|vale|ok|venga)\s+/, '')
    .replace(/^(?:borra(?:r|me)?|quita(?:r|me)?|elimina(?:r)?)\s+/, '');
  return filtroDeSeccion(m);
}
// Quitar secciones enteras, una o varias a la vez : «borra las alarmas y las tareas». Solo si TODAS las partes son secciones
// reconocibles y hay al menos dos (con una sola, decide el modelo como siempre). Devuelve la lista de filtros o null.
const QUITAR_SECCIONES = /^(?:por favor )?(?:quiero |puedes |me )?(?:borra(?:r|me)?|quita(?:r|me)?|elimina(?:r)?|cancela(?:r)?)\s+(.+?)(?: por favor)?$/;
function borrarSecciones(mensaje) {
  const cuerpo = QUITAR_SECCIONES.exec(sinSignos(String(mensaje ?? '').replace(/,/g, ' y ')))?.[1];
  if (!cuerpo) return null;
  const partes = cuerpo.split(/\s*,\s*|\s+y\s+|\s+e\s+/).map((p) => p.trim()).filter(Boolean);
  if (partes.length < 2 || partes.length > 6) return null;
  // «La cita y la alarma» (singular) es una de cada: no es una sección entera. Se exige plural o un nombre inequívoco (compra, proyecto, lista)
  const entera = (p) => /^(?:todas?|todos?|las|los)\s/.test(p) || /(?:s|compra)$/.test(p) || /(?:^|\s)(?:proyecto|lista)\s/.test(p);
  if (!partes.every(entera)) return null;
  const filtros = partes.map((p) => filtroDeSeccion(p));
  return filtros.every(Boolean) ? filtros : null;
}
function filtroDeSeccion(texto) {
  const m = String(texto ?? '')
    .replace(/^(?:todas?|todos?)\s+/, '')
    .replace(/^(?:las|los|la|el|mis)\s+/, '')
    .trim();
  if (/^alarmas?$/.test(m)) return { tipo: 'alarma' };
  if (/^tareas?$/.test(m)) return { tipo: 'tarea' };
  if (/^(?:citas?|eventos?|calendario)$/.test(m)) return { tipo: 'evento' };
  if (/^(?:pensamientos?|notas?|ideas?)$/.test(m)) return { tipo: 'nota' };
  if (/^(?:lista (?:de (?:la )?)?)?compra$/.test(m)) return { tipo: 'lista', lista: 'compra' };
  let r = /^lista (?:de la |del |de )?(.+)$/.exec(m);
  if (r) return { tipo: 'lista', lista: r[1] };
  r = /^(?:lo )?(?:del |de )?proyecto (.+)$/.exec(m);
  if (r) return { proyecto: r[1] };
  return null;
}
const NO_CONFIRMA = /^(?:no|mejor no|no gracias|ni hablar|dejalo|cancela|cancelalo|espera|olvidalo|olvidate)\b/;
const SI_CONFIRMA = /^(?:si|vale|ok|okey|dale|venga|claro|adelante|hazlo|por supuesto|de acuerdo|sip|perfecto|correcto|quitalos|quitalo|quitalas|quitala|borralos|borralo|borralas|borrala|eliminalos|eliminalo|eliminala|eliminalas|mandalo|mandalos|marcalos|marcalo)\b/;
// Lo que se manda a la papelera de Drive: ids de Drive con la forma de siempre, como mucho MAX_PAPELERA
const ID_DRIVE_PAPELERA = /^[A-Za-z0-9_-]{10,100}$/;
const MAX_PAPELERA = 50;
function papeleraDelHilo(t) {
  if (t?.motivo !== 'confirmar_drive' || t.origen !== 'codigo' || !Array.isArray(t.papelera)) return null;
  const lista = t.papelera
    .filter((e) => e && ['carpeta', 'archivo'].includes(e.tipo) && typeof e.id === 'string' && ID_DRIVE_PAPELERA.test(e.id))
    .map((e) => ({ tipo: e.tipo, id: e.id, nombre: String(e.nombre ?? '').slice(0, 200) }))
    .slice(0, MAX_PAPELERA);
  return lista.length > 0 ? lista : null;
}
// Olvidar datos de la memoria: ids de la tabla memoria, solo si la pregunta la escribió el código
const ID_MEMORIA = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function olvidarDelHilo(t) {
  if (t?.motivo !== 'confirmar_memoria' || t.origen !== 'codigo' || !Array.isArray(t.olvidar)) return null;
  const ids = t.olvidar.filter((x) => typeof x === 'string' && ID_MEMORIA.test(x)).slice(0, 50);
  return ids.length > 0 ? ids : null;
}
function respuestaConfirmacion(mensaje, hilo) {
  const t = motivoDelHilo(hilo);
  const papelera = papeleraDelHilo(t);
  const olvidar = olvidarDelHilo(t);
  if (!papelera && !olvidar && (t?.motivo !== 'confirmar_lote' || !Array.isArray(t.lotes) || t.lotes.length === 0)) return null;
  const m = sinSignos(mensaje ?? '');
  if (!m || m.split(' ').length > 4) return null;
  // «Olvídalo» es «sí» solo ante «¿Olvido esto?»; ante borrar en Drive o un lote es «déjalo»
  if (olvidar && /^olvidalos?\b/.test(m)) return { tipo: 'si', accion: 'olvidar', ids: olvidar };
  if (NO_CONFIRMA.test(m)) return { tipo: 'no' };
  if (!SI_CONFIRMA.test(m)) return null;
  if (papelera) return { tipo: 'si', accion: 'papelera', papelera };
  if (olvidar) return { tipo: 'si', accion: 'olvidar', ids: olvidar };
  const lote = t.lotes.at(-1);
  if (!['cancelar', 'completar'].includes(lote?.accion) || !Array.isArray(lote.ids)) return null;
  return { tipo: 'si', accion: lote.accion, ids: lote.ids.filter((x) => typeof x === 'string') };
}

// La respuesta del modelo que equivale a un atajo (con la forma de la respuesta de Gemini: así sigue el camino normal de validación)
const respuestaDeAtajo = (datos) => ({
  candidates: [{ content: { parts: [{ text: JSON.stringify({ items: [], respuesta_usuario: '', ...datos }) }] } }],
});

// --- Alarmas y citas ---
// Lo que empieza entre ahora y las 02:00 (hora de Madrid) del día siguiente es una ALARMA: una tarea con hora de aviso, sin calendario y
// sin control de solapes. Lo que empieza más tarde es una CITA y va al calendario. Lo decide el código, da igual cómo lo pida el usuario.
// Un evento cuya hora ya pasó se queda como evento (es un registro, no algo que avisar).
const HORA_FIN_ALARMAS = 2;
function limiteAlarmas(ahora) {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(ahora).split('-').map(Number);
  return madridAUtc(y, m, d + 1, HORA_FIN_ALARMAS, 0).getTime();
}

// Si el usuario dice «cita» o «en el calendario», es una cita aunque empiece enseguida: se respeta su palabra
const PIDE_CITA = /\b(citas?|calendario)\b/;
function eventosAAlarmas(datos, ahora, meta, mensaje = '') {
  if (datos.intencion !== 'guardar') return;
  if (PIDE_CITA.test(sinAcentos(mensaje))) return;
  const limite = limiteAlarmas(ahora);
  const convertidos = [];
  datos.items = datos.items.map((it) => {
    if (it.tipo !== 'evento' || !esFecha(it.fecha_inicio)) return it;
    const ini = Date.parse(it.fecha_inicio);
    if (!(ini > ahora.getTime() && ini <= limite)) return it;
    convertidos.push(it.titulo);
    return { ...it, tipo: 'tarea', recordar_en: it.fecha_inicio, fecha_inicio: null, fecha_fin: null, fecha_limite: null };
  });
  if (convertidos.length > 0) meta.alarmas = convertidos;
}

// --- Parecido entre un nombre y los proyectos que ya existen ---
const PALABRAS_VACIAS = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'y', 'e', 'en', 'a', 'al', 'para']);
const palabrasDe = (s) => sinAcentos(s).replace(/[^a-z0-9ñ]+/g, ' ').trim().split(' ').filter(Boolean);

function distanciaEdicion(a, b) {
  const fila = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let anterior = fila[0];
    fila[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const guardado = fila[j];
      fila[j] = Math.min(fila[j] + 1, fila[j - 1] + 1, anterior + (a[i - 1] === b[j - 1] ? 0 : 1));
      anterior = guardado;
    }
  }
  return fila[b.length];
}

// 0 = nada que ver; hasta 100 = casi seguro. Siglas («ONG» y «Organización No Gubernamental»), texto contenido, palabra compartida y distancia de edición.
function parecido(nombre, existente) {
  const pn = palabrasDe(nombre);
  const pe = palabrasDe(existente);
  const n = pn.join('');
  const e = pe.join('');
  if (!n || !e) return 0;
  const sigla = pe.filter((p) => !PALABRAS_VACIAS.has(p)).map((p) => p[0]).join('');
  let mejor = 0;
  if (sigla.length >= 2 && n === sigla) mejor = 100;
  else if (sigla.length >= 2 && n.length >= 2 && (sigla.startsWith(n) || n.startsWith(sigla))) mejor = 70;
  if (n.length >= 3 && (e.includes(n) || n.includes(e))) mejor = Math.max(mejor, 85);
  if (pn.some((p) => p.length >= 4 && !PALABRAS_VACIAS.has(p) && pe.includes(p))) mejor = Math.max(mejor, 60);
  const sim = 1 - distanciaEdicion(n, e) / Math.max(n.length, e.length);
  if (sim >= 0.6) mejor = Math.max(mejor, Math.round(sim * 55));
  return mejor;
}

// Hasta 3 nombres existentes, de más a menos parecidos (vacío si ninguno se parece)
function proyectosParecidos(nombre, existentes) {
  return [...new Set(existentes.map((a) => limpiarTxt(a)).filter(Boolean))]
    .map((a) => ({ a, p: parecido(nombre, a) }))
    .filter((x) => x.p >= 40)
    .sort((x, y) => y.p - x.p || x.a.localeCompare(y.a, 'es'))
    .slice(0, 3)
    .map((x) => x.a);
}

// --- Proyectos nuevos ---
// Un proyecto que no existe se crea solo al guardar (la base de datos lo crea con el item). Solo se pregunta si se PARECE a uno que ya
// existe ("Mudanzas" y "Mudanza"): así una errata no parte un proyecto en dos. Devuelve null o { motivo, proyectos, texto }.
function comprobarProyectos({ datos, config, hiloPrevio }) {
  const conocidos = new Set((config.proyectos ?? []).map(sinAcentos));
  const confirmados = confirmacionesDelHilo(hiloPrevio).proyectos;
  const candidatos = [];
  if (datos.intencion === 'guardar') for (const it of datos.items) if (it.proyecto) candidatos.push(it.proyecto);
  if (datos.intencion === 'corregir' && typeof datos.correccion.cambios.proyecto === 'string') candidatos.push(datos.correccion.cambios.proyecto);
  const vistos = new Set();
  for (const p of candidatos) {
    const k = sinAcentos(p);
    if (conocidos.has(k) || confirmados.has(k) || vistos.has(k)) continue;
    vistos.add(k);
    const parecidos = proyectosParecidos(p, config.proyectos ?? []).filter((x) => parecido(p, x) >= 60);
    if (parecidos.length > 0) {
      const texto = `¿Es el proyecto ${parecidos.map((x) => `«${x}»`).join(' o ')}, o creo uno nuevo, «${limpiarTxt(p)}»?`;
      return { motivo: 'crear_proyecto', proyectos: [p], texto };
    }
  }
  return null;
}

// Proyectos que no existían y que este guardado va a crear (para decírselo al usuario)
function proyectosNuevos(datos, config) {
  const conocidos = new Set((config.proyectos ?? []).map(sinAcentos));
  const nuevos = [];
  const cambios = datos.intencion === 'corregir' ? [datos.correccion.cambios.proyecto] : datos.intencion === 'guardar' ? datos.items.map((it) => it.proyecto) : [];
  for (const p of cambios) {
    if (typeof p === 'string' && p && !conocidos.has(sinAcentos(p)) && !nuevos.some((n) => sinAcentos(n) === sinAcentos(p))) nuevos.push(p);
  }
  return nuevos;
}

// «Ya lo tengo apuntado como tarea: «Ir a comprar» (mié 21).» (tipoSuelto con el mismo tipo)
function textoYaApuntado({ actual, titulo, item }) {
  const iso = actual === 'cita' ? item.fecha_inicio : actual === 'alarma' ? item.recordar_en : item.fecha_limite;
  const cuando = !esFecha(iso) ? '' : actual === 'tarea' ? ` (${diaCorto(Date.parse(iso))})` : ` (${diaCorto(Date.parse(iso))}, ${horaCorta(Date.parse(iso))})`;
  return `Ya lo tengo apuntado como ${actual}: «${limpiarTxt(titulo)}»${cuando}.`;
}

// --- Cambiar de tipo: tarea, alarma y cita ---
// El modelo solo dice a cuál (correccion.convertir_a) y, si el usuario la dio, la fecha nueva (correccion.cuando). Este código mueve la fecha
// de un campo a otro, que es lo que el modelo hacía mal («dice que lo ha hecho y no lo ha hecho»):
//   alarma: tarea con recordar_en (la hora de la cita, o la de la alarma, o la de un plazo con hora real) y sin fecha límite ni de inicio.
//   cita:   evento con fecha_inicio (la hora de la alarma o de la cita) y una hora de duración.
//   tarea:  sin hora de aviso ni de inicio; el día que tuviera pasa a ser su fecha límite (fin de ese día).
// Una alarma y una cita necesitan hora: si no hay de dónde sacarla, se pregunta (no se inventa).
const esFinDeDia = (iso) => esFecha(iso) && horaCorta(Date.parse(iso)) === '23:59';
function finDeDia(iso) {
  const [y, m, d] = diaMadrid(Date.parse(iso)).split('-').map(Number);
  return new Date(madridAUtc(y, m, d, 23, 59).getTime() + 59000).toISOString();
}
// Devuelve null o { motivo, texto } (falta la hora). Si todo está claro, deja los cambios de cada elemento en datos.correccion.porId.
function aplicarConversion({ datos, fechas, titulos }) {
  if (datos.intencion !== 'corregir' || !datos.correccion.convertir) return null;
  const c = datos.correccion;
  const porId = {};
  const sinHora = [];
  for (const id of c.ids) {
    const f = fechas.get(id) ?? {};
    const conHora = (iso) => (esFecha(iso) && !esFinDeDia(iso) ? iso : null);
    if (c.convertir === 'tarea') {
      const base = c.cuando ?? f.fecha_limite ?? f.recordar_en ?? f.fecha_inicio ?? null;
      porId[id] = { tipo: 'tarea', recordar_en: null, fecha_inicio: null, fecha_fin: null, fecha_limite: esFecha(base) ? finDeDia(base) : null };
    } else if (c.convertir === 'alarma') {
      const base = c.cuando ?? f.recordar_en ?? f.fecha_inicio ?? conHora(f.fecha_limite);
      if (!esFecha(base)) sinHora.push(id);
      else porId[id] = { tipo: 'tarea', recordar_en: new Date(base).toISOString(), fecha_inicio: null, fecha_fin: null, fecha_limite: null };
    } else {
      const base = c.cuando ?? f.fecha_inicio ?? f.recordar_en ?? conHora(f.fecha_limite);
      if (!esFecha(base)) sinHora.push(id);
      else {
        const inicio = new Date(base).toISOString();
        // Si ya era una cita y no se mueve, conserva su duración; si no, una hora
        const igual = esFecha(f.fecha_inicio) && Date.parse(f.fecha_inicio) === Date.parse(base);
        porId[id] = { tipo: 'evento', fecha_inicio: inicio, recordar_en: null, fecha_limite: null, ...(igual && esFecha(f.fecha_fin) ? {} : { fecha_fin: new Date(Date.parse(base) + 3600000).toISOString() }) };
      }
    }
  }
  if (sinHora.length > 0) {
    const quien = sinHora.map((id) => `«${limpiarTxt(titulos.get(id) ?? 'eso')}»`);
    const que = c.convertir === 'alarma' ? 'alarma' : 'cita';
    return {
      motivo: 'convertir_hora',
      texto: sinHora.length === 1
        ? `Para dejar ${quien[0]} como ${que} necesito la hora. ¿A qué hora?`
        : `Para dejarlas como ${que} necesito la hora de ${quien.join(', ')}. ¿A qué hora?`,
    };
  }
  // Lo que el modelo hubiera puesto de más en cambios (tipo, fechas) lo sustituye la conversión
  for (const k of ['tipo', 'recordar_en', 'fecha_inicio', 'fecha_fin', 'fecha_limite']) delete c.cambios[k];
  c.porId = porId;
  return null;
}

// Una alarma o una cita con un nombre igual o parecido al de otra pendiente: se pregunta si se cambia la que hay o se añade otra. Lo que el usuario
// ya aceptó añadir ("añade otra") viaja en el hilo (repetidos). Compara las alarmas y citas nuevas con las pendientes de las dos clases.
const esAlarmaOCita = (r) => r.tipo === 'evento' || esAlarmaItem(r);
function cuandoDe(r) {
  const iso = r.tipo === 'evento' ? r.fecha_inicio : r.recordar_en;
  return esFecha(iso) ? `${diaCorto(Date.parse(iso))}, ${horaCorta(Date.parse(iso))}` : 'sin hora';
}
const lineaExistente = (e) => `«${limpiarTxt(e.titulo)}» (${e.tipo === 'evento' ? 'cita' : 'alarma'}, ${cuandoDe(e)})`;
function comprobarRepetidos({ datos, pendientes, hiloPrevio }) {
  if (datos.intencion !== 'guardar') return null;
  const aceptados = confirmacionesDelHilo(hiloPrevio).repetidos;
  const existentes = pendientes.filter(esAlarmaOCita);
  const claves = [];
  const bloques = [];
  for (const it of datos.items.filter(esAlarmaOCita)) {
    const k = sinAcentos(it.titulo);
    if (!k || aceptados.has(k) || claves.includes(k)) continue;
    const parecidas = existentes.filter((e) => parecido(it.titulo, e.titulo) >= 70);
    if (parecidas.length === 0) continue;
    claves.push(k);
    bloques.push({ titulo: it.titulo, parecidas });
  }
  if (bloques.length === 0) return null;
  const linea = lineaExistente;
  const texto =
    bloques.length === 1 && bloques[0].parecidas.length === 1
      ? `Ya tienes ${linea(bloques[0].parecidas[0])}. ¿La cambio o añado otra con el mismo nombre?`
      : `Ya tienes esto parecido:\n${bloques.flatMap((b) => b.parecidas).map((e) => `• ${linea(e)}`).join('\n')}\n¿Cambio la que ya existe o añado otra nueva?`;
  return { motivo: 'repetido', repetidos: claves, texto };
}
// Las alarmas y citas que se parecen a los títulos de la pregunta (para contestar «¿cuáles hay?» sin cerrarla)
function parecidasA(titulos, pendientes) {
  return pendientes.filter(esAlarmaOCita).filter((e) => titulos.some((t) => parecido(t, e.titulo) >= 70));
}

// --- Cancelar o completar muchos de golpe ---
// Más de MAX_SIN_CONFIRMAR elementos (o cerrar un proyecto con cosas pendientes) se enseña y se pregunta antes. El "sí" repite la petición
// (regla 11 del prompt) y aquí se reconoce porque los ids ya se plantearon en este hilo.
const MAX_LINEAS_LOTE = 15;
const VERBO_LOTE = { cancelar: ['quitar', '¿Los quito?', '¿Lo quito?'], completar: ['marcar como hechos', '¿Los marco como hechos?', '¿Lo marco como hecho?'] };
function comprobarLote({ accion, ids, porId, hiloPrevio, proyecto = null, siempre = false }) {
  if (ids.length === 0) return null;
  if (!proyecto && !siempre && ids.length <= MAX_SIN_CONFIRMAR) return null;
  const confirmados = new Set(confirmacionesDelHilo(hiloPrevio).lotes.filter((l) => l.accion === accion).flatMap((l) => l.ids));
  if (ids.every((id) => confirmados.has(id))) return null;
  const titulos = ids.map((id) => porId.get(id)).filter(Boolean).map((r) => `• ${limpiarTxt(r.titulo)}`);
  const lineas = titulos.slice(0, MAX_LINEAS_LOTE).join('\n') + (titulos.length > MAX_LINEAS_LOTE ? `\n… y ${titulos.length - MAX_LINEAS_LOTE} más` : '');
  const texto = proyecto
    ? `El proyecto «${limpiarTxt(proyecto)}» tiene ${ids.length === 1 ? '1 cosa pendiente' : `${ids.length} cosas pendientes`}:\n${lineas}\nSi lo cierro, las quito. ¿Lo cierro?`
    : ids.length === 1
      ? `Voy a ${VERBO_LOTE[accion][0]} 1 elemento:\n${lineas}\n${VERBO_LOTE[accion][2]}`
      : `Voy a ${VERBO_LOTE[accion][0]} ${ids.length} elementos:\n${lineas}\n${VERBO_LOTE[accion][1]}`;
  return { motivo: 'confirmar_lote', lotes: [{ accion, ids }], texto };
}

const nombreEvento = (e) => `«${limpiarTxt(e.titulo)}» (${diaCorto(e.ini)}, ${horaCorta(e.ini)}-${horaCorta(e.fin)})`;

function textoSolape(choques, varios) {
  const frases = choques.map(({ p, e, entreNuevos }) =>
    entreNuevos
      ? `«${limpiarTxt(p.titulo)}» y «${limpiarTxt(e.titulo)}», que me pides a la vez, coinciden en el tiempo`
      : `${varios ? `«${limpiarTxt(p.titulo)}» ` : ''}choca con ${nombreEvento(e)}`,
  );
  return `No puedo agendarlo: ${frases.join('; ')}. ¿A qué otra hora lo pongo?`;
}

function textoConfirmar(ocupados, propuestos) {
  const bloques = ocupados.map((o) => {
    const lineas = [
      ...o.eventos.map((e) => `• ${limpiarTxt(e.titulo)}, ${horaCorta(e.ini)}-${horaCorta(e.fin)}`),
      ...o.tareas.map((t) => `• ${limpiarTxt(t.titulo)} (tarea que vence ese día)`),
    ];
    return `El ${diaCorto(o.ms)} ya tienes:\n${lineas.join('\n')}`;
  });
  const titulos = propuestos.map((p) => `«${limpiarTxt(p.titulo)}»`).join(' y ');
  return `${bloques.join('\n')}\n¿Agendo ${titulos} igualmente?`;
}

// Devuelve null (se puede continuar) o { motivo, texto, dias }. Al mover un evento sin tocar su fin, desplaza el fin lo
// mismo para conservar la duración (modifica datos.correccion.cambios).
function comprobarAgenda({ datos, agenda, hiloPrevio, horario = [] }) {
  const porId = new Map(agenda.map((a) => [a.id, a]));
  const propuestos = [];

  if (datos.intencion === 'guardar') {
    for (const it of datos.items) {
      if (it.tipo === 'evento' && esFecha(it.fecha_inicio)) propuestos.push({ titulo: it.titulo, ...intervalo(it.fecha_inicio, it.fecha_fin) });
    }
  } else if (datos.intencion === 'corregir') {
    const { ids, cambios: comunes, porId: porIdCambios } = datos.correccion;
    for (const id of ids) {
      // Al cambiar de tipo cada elemento lleva sus propios cambios (porId): los comunes (título…) más los suyos
      const propios = porIdCambios?.[id];
      const cambios = propios ? { ...comunes, ...propios } : comunes;
      const actual = porId.get(id);
      const eraEvento = actual?.tipo === 'evento' && esFecha(actual.fecha_inicio);
      const seraEvento = (cambios.tipo ?? actual?.tipo) === 'evento';
      const tocaFechas = 'fecha_inicio' in cambios || 'fecha_fin' in cambios || cambios.tipo === 'evento';
      if (!seraEvento || !tocaFechas) continue;
      if (eraEvento && esFecha(cambios.fecha_inicio) && !('fecha_fin' in cambios)) {
        const antes = intervalo(actual.fecha_inicio, actual.fecha_fin);
        cambios.fecha_fin = new Date(Date.parse(cambios.fecha_inicio) + (antes.fin - antes.ini)).toISOString();
        if (propios) propios.fecha_fin = cambios.fecha_fin;
      }
      const inicio = 'fecha_inicio' in cambios ? cambios.fecha_inicio : actual?.fecha_inicio;
      const fin = 'fecha_fin' in cambios ? cambios.fecha_fin : actual?.fecha_fin;
      if (!esFecha(inicio)) continue;
      propuestos.push({ titulo: cambios.titulo ?? actual?.titulo ?? 'el evento', ...intervalo(inicio, fin) });
    }
  }
  if (propuestos.length === 0) return null;

  // Los eventos que se están moviendo no cuentan como existentes (se compara con su nueva posición)
  const movidos = new Set(datos.intencion === 'corregir' ? datos.correccion.ids : []);
  const existentes = agenda
    .filter((a) => a.tipo === 'evento' && esFecha(a.fecha_inicio) && !movidos.has(a.id))
    .map((a) => ({ id: a.id, titulo: a.titulo, ...intervalo(a.fecha_inicio, a.fecha_fin) }));

  const choques = [];
  propuestos.forEach((p, i) => {
    for (const e of existentes) if (solapa(p, e)) choques.push({ p, e });
    for (let j = i + 1; j < propuestos.length; j++) if (solapa(p, propuestos[j])) choques.push({ p, e: propuestos[j], entreNuevos: true });
  });
  if (choques.length > 0) return { motivo: 'solape', dias: [], texto: textoSolape(choques, propuestos.length > 1) };

  // Horario fijo: una cita que cae dentro de un bloque se pregunta antes; el «sí» vale para ese bloque ese día
  const confirmadosHorario = confirmacionesDelHilo(hiloPrevio).horario;
  const choquesHorario = [];
  for (const p of propuestos) {
    const ini = partesMadrid(p.ini);
    const finMin = diaMadrid(p.fin - 1) === diaMadrid(p.ini) ? partesMadrid(p.fin).min || 24 * 60 : 24 * 60;
    for (const b of horario) {
      if (b.dia_semana !== ini.dia || !(ini.min < aMinutos(b.hora_fin) && aMinutos(b.hora_inicio) < finMin)) continue;
      const clave = `${diaMadrid(p.ini)}|${b.id}`;
      if (!confirmadosHorario.has(clave)) choquesHorario.push({ p, b, clave });
    }
  }
  if (choquesHorario.length > 0) {
    const lineas = choquesHorario.map(({ p, b }) => `«${limpiarTxt(p.titulo)}» (${diaCorto(p.ini)}, ${horaCorta(p.ini)}) cae en tu horario: ${lineaHorario(b)}.`);
    const verbo = datos.intencion === 'corregir' ? (propuestos.length > 1 ? '¿Las muevo igualmente?' : '¿La muevo igualmente?') : propuestos.length > 1 ? '¿Las apunto igualmente?' : '¿La apunto igualmente?';
    return { motivo: 'confirmar_horario', horario: [...new Set(choquesHorario.map((c) => c.clave))], texto: `${lineas.join('\n')}\n${verbo}` };
  }

  // Un día con más cosas ya no se pregunta : solo un solape real o el horario fijo bloquean
  return null;
}

// Función principal: no toca la red ni el reloj salvo por "ahora", que se pasa desde fuera
// "contexto": { mensaje (el texto de este mensaje), pendienteId (la pregunta anterior que este mensaje contesta,
// si la hay) y hiloPrevio (los turnos guardados hasta esa pregunta) }.
// "archivos": { refs (a1… -> id real), info (a1… -> { nombre, creado }) } de los archivos que vio el modelo.
// "pendientes": los elementos pendientes que vio el modelo, con ids reales (para resolver los filtros de cancelar y completar y para
// nombrar lo que se va a tocar). "config.proyectos": los nombres de los proyectos que existen (activos y cerrados).
function planificar({ resp, mensajeId, config, ahora, refs = {}, contexto = {}, agenda = [], archivos = {}, pendientes = [] }) {
  const base = config.supabase_url.replace(/\/+$/, '') + '/rest/v1';
  const peticion = (etiqueta, metodo, ruta, cuerpo, prefer) => ({ etiqueta, metodo, url: base + ruta, cuerpo, prefer });
  // Cada pregunta que queda abierta lleva la hora a la que se hizo (en el último turno del hilo, campo «en»): si el usuario escribe otra
  // cosa DESPUÉS sin contestarla, se cierra y se le dice. El modelo solo ve rol y texto de cada turno.
  const marcarMensaje = (cuerpo) => {
    const hilo = cuerpo?.pregunta_pendiente === true && Array.isArray(cuerpo.hilo) && cuerpo.hilo.length > 0
      ? [...cuerpo.hilo.slice(0, -1), { ...cuerpo.hilo.at(-1), en: cuerpo.hilo.at(-1).en ?? ahora.toISOString() }]
      : null;
    return peticion('actualizar mensaje', 'PATCH', `/mensajes?id=eq.${mensajeId}`, hilo ? { ...cuerpo, hilo } : cuerpo, 'return=minimal');
  };
  // "Leer consulta" se ejecuta siempre; si no hay consulta lee algo inocuo (el mensaje recién guardado)
  const urlNeutra = `${base}/mensajes?select=id&id=eq.${mensajeId}`;
  const conError = (motivo, meta) => ({
    peticiones: [marcarMensaje({ procesado: false, error: motivo })],
    meta: { ok: false, error: motivo, avisos: [], respuesta_usuario: '', pregunta: null, consulta_url: urlNeutra, consulta: null, ...meta },
  });

  // Comandos (/help, /manual…) y frases de quien está perdido («ayuda», «qué puedes hacer»): se contestan sin el modelo. Los atajos (/pending, /today…)
  // sustituyen la respuesta del modelo por la equivalente y siguen el camino normal. Nunca cierran una pregunta pendiente y van antes de la pregunta del nombre.
  // Demasiados mensajes seguidos: ni el modelo ni escritura alguna; el mensaje queda guardado y se avisa
  if (typeof contexto.avisoDemasiados === 'string' && contexto.avisoDemasiados !== '') {
    return {
      peticiones: [marcarMensaje({ procesado: true, error: null })],
      meta: { ok: true, error: null, intencion: 'ayuda', avisos: [], respuesta_usuario: contexto.avisoDemasiados, mensajes_fijos: [contexto.avisoDemasiados], pregunta: null, consulta_url: urlNeutra, consulta: null, carpetas: false, ahora: ahora.toISOString() },
    };
  }
  // Las respuestas a las preguntas de borrar van antes que los comandos y atajos («Tareas» es la sección, no el listado)
  const elegida = seccionElegida(contexto.mensaje, contexto.hiloPrevio);
  const confirmacion = elegida ? null : respuestaConfirmacion(contexto.mensaje, contexto.hiloPrevio);
  // La respuesta a «¿Dónde la guardo?» (carpeta parecida): también antes que los comandos («2» es la opción)
  const carpetaResp = elegida || confirmacion ? null : respuestaCarpeta(contexto.mensaje, contexto.hiloPrevio);
  const esUndo = /^\s*\/undo\b/i.test(contexto.mensaje ?? '');
  const comando = elegida || confirmacion || esUndo || carpetaResp ? null : interpretarComando(contexto.mensaje, { ahora, nombre: contexto.nombreSecretaria });
  const ayudaFija = (mensajes, intencion = 'ayuda') => ({
    peticiones: [marcarMensaje({ procesado: true, error: null })],
    meta: { ok: true, error: null, intencion, avisos: [], respuesta_usuario: mensajes.join('\n\n'), mensajes_fijos: mensajes, pregunta: null, consulta_url: urlNeutra, consulta: null, carpetas: false, ahora: ahora.toISOString() },
  });
  if (comando?.tipo === 'texto') return ayudaFija(comando.mensajes);
  const sugerida = comando ? null : aceptaSugerencia(contexto.mensaje, contexto.hiloPrevio);
  if (sugerida?.tipo === 'no') {
    return {
      peticiones: [...(contexto.pendienteId ? [peticion('cerrar pregunta anterior', 'PATCH', `/mensajes?id=eq.${encodeURIComponent(contexto.pendienteId)}`, { pregunta_pendiente: false }, 'return=minimal')] : []), marcarMensaje({ procesado: true, error: null })],
      meta: { ok: true, error: null, intencion: 'descartar', avisos: [], respuesta_usuario: 'Vale, lo dejo así.', respuesta_fija: true, pregunta: null, consulta_url: urlNeutra, consulta: null, carpetas: false, ahora: ahora.toISOString() },
    };
  }
  if (carpetaResp?.tipo === 'no') {
    return {
      peticiones: [...(contexto.pendienteId ? [peticion('cerrar pregunta anterior', 'PATCH', `/mensajes?id=eq.${encodeURIComponent(contexto.pendienteId)}`, { pregunta_pendiente: false }, 'return=minimal')] : []), marcarMensaje({ procesado: true, error: null })],
      meta: { ok: true, error: null, intencion: 'descartar', avisos: [], respuesta_usuario: 'Vale, se quedan en Entrada.', respuesta_fija: true, pregunta: null, consulta_url: urlNeutra, consulta: null, carpetas: false, ahora: ahora.toISOString() },
    };
  }
  // No se entiende cuál: la pregunta sigue abierta
  if (carpetaResp?.tipo === 'repetir') return ayudaFija(['Dime el número de la opción.']);
  // «Déjalo como estaba» / «deshaz» justo después de mover archivos : vuelven a donde estaban y, si la carpeta de la que salieron
  // estaba apuntada para vaciarla (base de datos 1.5), se anula (si ya fue a la papelera, «Sincronizar Drive» crea otra igual)
  const mov = contexto.movidosRecientes;
  const vuelta = comando || elegida || confirmacion || contexto.pedirNombre === true || contexto.esperaNombre === true
    ? null
    : mov?.ultimo === true && Array.isArray(mov.deshacer) && mov.deshacer.length > 0 && interpretarDeshacerMovimiento(contexto.mensaje) ? mov : null;
  if (vuelta) {
    const grupos = new Map();
    for (const d of vuelta.deshacer) grupos.set(d.de, [...(grupos.get(d.de) ?? []), d.id]);
    return {
      peticiones: [
        marcarMensaje({ procesado: true, error: null }),
        ...[...grupos].map(([de, ids]) => peticion(`devolver archivos a ${de}`, 'PATCH', `/archivos?id=in.(${ids.map(encodeURIComponent).join(',')})&eliminado_at=is.null`, { carpeta_destino: de, estado: 'asignado' }, 'return=representation')),
        ...(vuelta.vaciar ?? []).map((r) => peticion(`pedir vaciar anulada ${r}`, 'PATCH', `/carpetas_vaciar?hecha_at=is.null&ruta=ilike.${encodeURIComponent(r.replace(/[*%]/g, ''))}`, { hecha_at: ahora.toISOString(), resultado: 'no_vacia' }, 'return=minimal')),
      ],
      meta: { ok: true, error: null, intencion: 'mover_archivos', avisos: [], respuesta_usuario: '', pregunta: null, consulta_url: urlNeutra, consulta: null, carpetas: false, ahora: ahora.toISOString(), mover_archivos: { deshacer: true, destinos: [...grupos.keys()], previas: Object.fromEntries(vuelta.deshacer.map((d) => [d.id, d.a])) } },
    };
  }
  // «Deshaz» / «recupera la tarea del banco» : vuelve a pendiente lo que el usuario quitó por WhatsApp; las citas vuelven solas a Calendar
  const deshacer = comando || elegida || confirmacion || contexto.pedirNombre === true || contexto.esperaNombre === true ? null : interpretarDeshacer(contexto.mensaje);
  if (deshacer) {
    const r = elegirParaDeshacer(deshacer, contexto.quitados, ahora);
    if (r.texto) return ayudaFija([r.texto], 'deshacer');
    const lista = (xs) => xs.map(encodeURIComponent).join(',');
    // Recuperar algo de un proyecto cerrado no lo reabre solo (el trigger mira el proyecto, no el estado): se reabre aquí
    const proyectos = [...new Set(r.items.map((x) => x.proyecto).filter((p) => typeof p === 'string' && p))];
    return {
      peticiones: [
        marcarMensaje({ procesado: true, error: null }),
        peticion('recuperar lo quitado', 'PATCH', `/items?id=in.(${lista(r.items.map((x) => x.id))})`, { estado: 'pendiente', quitado_en: null }, 'return=representation'),
        ...(proyectos.length > 0 ? [peticion('reabrir proyectos', 'PATCH', `/proyectos?nombre=in.(${proyectos.map((p) => encodeURIComponent(`"${p.replace(/"/g, '')}"`)).join(',')})&estado=neq.activo`, { estado: 'activo' }, 'return=minimal')] : []),
      ],
      meta: { ok: true, error: null, intencion: 'deshacer', avisos: [], respuesta_usuario: '', pregunta: null, consulta_url: urlNeutra, consulta: null, carpetas: false, ahora: ahora.toISOString() },
    };
  }
  const filasMem = filasDeMemoria(contexto.memoria);
  const olvidarIds = (ids, cerrarPregunta) => {
    const vivos = ids.filter((id) => filasMem.some((m) => m.id === id && !esNombreSecretaria(m)));
    if (vivos.length === 0) return ayudaFija(['Eso ya no está en mi memoria.']);
    return {
      peticiones: [
        ...(cerrarPregunta && contexto.pendienteId ? [peticion('cerrar pregunta anterior', 'PATCH', `/mensajes?id=eq.${encodeURIComponent(contexto.pendienteId)}`, { pregunta_pendiente: false }, 'return=minimal')] : []),
        marcarMensaje({ procesado: true, error: null }),
        ...vivos.map((id) => peticion('olvidar un dato', 'POST', '/rpc/olvidar_memoria', { p_id: id }, 'return=representation')),
      ],
      meta: { ok: true, error: null, intencion: 'olvidar_memoria', avisos: [], respuesta_usuario: '', pregunta: null, consulta_url: urlNeutra, consulta: null, carpetas: false, ahora: ahora.toISOString() },
    };
  };
  if (comando?.tipo === 'memoria' && comando.accion === 'ver') return ayudaFija([textoMemoria(filasMem, comando.pista === true)]);
  const filasHor = filasDeHorario(contexto.horario);
  if (comando?.tipo === 'horario' && comando.accion === 'ver') return ayudaFija([textoMiHorario(filasHor, comando.pista === true)]);
  if (comando?.tipo === 'horario' && comando.accion === 'quitar') {
    const bloque = filasHor[comando.n - 1];
    if (!bloque) return ayudaFija([`No tengo el bloque número ${comando.n}.\n\n${textoMiHorario(filasHor, true)}`]);
    return {
      peticiones: [marcarMensaje({ procesado: true, error: null }), peticion('quitar un bloque del horario', 'POST', '/rpc/quitar_horario', { p_id: bloque.id }, 'return=representation')],
      meta: { ok: true, error: null, intencion: 'quitar_horario', avisos: [], respuesta_usuario: '', pregunta: null, consulta_url: urlNeutra, consulta: null, carpetas: false, ahora: ahora.toISOString() },
    };
  }
  if (comando?.tipo === 'memoria' && comando.accion === 'olvidar') {
    const arg = String(comando.arg ?? '').trim();
    // «/forget 2»: el número de la lista, sin preguntar (lo que se olvida se dice tal cual)
    if (/^\d{1,3}$/.test(arg)) {
      const fila = filasMem[Number(arg) - 1];
      if (!fila) return ayudaFija([`No tengo el dato número ${arg}.\n\n${textoMemoria(filasMem, true)}`]);
      if (esNombreSecretaria(fila)) return ayudaFija([TEXTO_NOMBRE_NO_SE_OLVIDA]);
      return olvidarIds([fila.id], false);
    }
    // Con palabras: se busca y se pregunta antes (con la lista de lo que se olvidaría)
    const encontrados = buscarEnMemoria(filasMem, arg);
    const olvidables = encontrados.filter((m) => !esNombreSecretaria(m));
    if (olvidables.length === 0) {
      return ayudaFija([encontrados.length > 0 ? TEXTO_NOMBRE_NO_SE_OLVIDA : `No encuentro nada en mi memoria sobre «${limpiarTxt(arg).slice(0, 60)}».`]);
    }
    const lineas = olvidables.map((m) => `${filasMem.indexOf(m) + 1}. ${lineaMemoria(m)}`);
    const texto = olvidables.length === 1
      ? `¿Olvido esto?\n${lineas[0]}`
      : `Encuentro esto:\n${lineas.join('\n')}\n¿Lo olvido todo? Si es solo uno, /forget y su número.`;
    const turno = JSON.stringify({ intencion: 'aclarar', motivo: 'confirmar_memoria', origen: 'codigo', olvidar: olvidables.map((m) => m.id), pregunta: texto, items: [], respuesta_usuario: texto });
    return {
      peticiones: [marcarMensaje({ procesado: true, error: null, pregunta: texto, pregunta_pendiente: true, hilo: [{ rol: 'user', texto: contexto.mensaje }, { rol: 'model', texto: turno }] })],
      meta: { ok: true, error: null, intencion: 'aclarar', avisos: [], respuesta_usuario: texto, pregunta: texto, consulta_url: urlNeutra, consulta: null, carpetas: false, ahora: ahora.toISOString() },
    };
  }
  const sinPregunta = comando || contexto.pedirNombre === true || contexto.esperaNombre === true ? null : siNoSinPregunta(contexto.mensaje, contexto.hiloPrevio);
  if (sinPregunta) return ayudaFija([sinPregunta]);
  // «No» a una oferta de la charla: no se apunta nada
  if (!comando && contexto.pedirNombre !== true && contexto.esperaNombre !== true && respuestaOferta(contexto.mensaje, contexto.hiloPrevio)) {
    return {
      peticiones: [
        ...(contexto.pendienteId ? [peticion('cerrar pregunta anterior', 'PATCH', `/mensajes?id=eq.${encodeURIComponent(contexto.pendienteId)}`, { pregunta_pendiente: false }, 'return=minimal')] : []),
        marcarMensaje({ procesado: true, error: null }),
      ],
      meta: { ok: true, error: null, intencion: 'descartar', avisos: [], respuesta_usuario: TEXTO_OFERTA_NO, respuesta_fija: true, pregunta: null, consulta_url: urlNeutra, consulta: null, carpetas: false, ahora: ahora.toISOString() },
    };
  }
  // Respuesta a «¿Te aviso … para ir a comprar?»: no, una hora (alarma «Ir a comprar») o «sí» sin hora (se pregunta)
  const avisoResp = comando || contexto.pedirNombre === true || contexto.esperaNombre === true ? null : respuestaAvisoCompra(contexto.mensaje, contexto.hiloPrevio);
  if (avisoResp?.tipo === 'no') {
    return {
      peticiones: [
        ...(contexto.pendienteId ? [peticion('cerrar pregunta anterior', 'PATCH', `/mensajes?id=eq.${encodeURIComponent(contexto.pendienteId)}`, { pregunta_pendiente: false }, 'return=minimal')] : []),
        marcarMensaje({ procesado: true, error: null }),
      ],
      meta: { ok: true, error: null, intencion: 'descartar', avisos: [], respuesta_usuario: 'Vale, sin aviso.', respuesta_fija: true, pregunta: null, consulta_url: urlNeutra, consulta: null, carpetas: false, ahora: ahora.toISOString() },
    };
  }
  if (avisoResp?.tipo === 'sin_hora') {
    const texto = `¿A qué hora te aviso ${avisoResp.etiqueta || 'ese día'}?`;
    return {
      peticiones: [
        ...(contexto.pendienteId ? [peticion('cerrar pregunta anterior', 'PATCH', `/mensajes?id=eq.${encodeURIComponent(contexto.pendienteId)}`, { pregunta_pendiente: false }, 'return=minimal')] : []),
        marcarMensaje({ procesado: true, error: null, pregunta: texto, pregunta_pendiente: true, hilo: [{ rol: 'user', texto: contexto.mensaje }, { rol: 'model', texto: turnoAvisoCompra({ dia: avisoResp.dia, etiqueta: avisoResp.etiqueta }, texto) }] }),
      ],
      meta: { ok: true, error: null, intencion: 'aclarar', avisos: [], respuesta_usuario: texto, pregunta: texto, consulta_url: urlNeutra, consulta: null, carpetas: false, ahora: ahora.toISOString() },
    };
  }
  if (avisoResp?.tipo === 'hora') {
    const [a, b, c] = avisoResp.dia.split('-').map(Number);
    resp = respuestaDeAtajo({ intencion: 'guardar', items: [{ tipo: 'tarea', titulo: 'Ir a comprar', recordar_en: madridAUtc(a, b, c, avisoResp.hora, avisoResp.min).toISOString(), confianza: 1 }] });
  }
  // «Tarea» suelto que llega tarde a una pregunta ya resuelta: ya está (mismo tipo) o se convierte (otro tipo), sin el modelo
  const suelto = comando || contexto.pedirNombre === true || contexto.esperaNombre === true ? null : tipoSuelto(contexto.mensaje, contexto.hiloPrevio, contexto.reciente, ahora);
  if (suelto?.igual) return ayudaFija([textoYaApuntado(suelto)]);
  if (suelto) resp = respuestaDeAtajo({ intencion: 'corregir', correccion: { item_ids: [suelto.ref], convertir_a: suelto.pedido, cambios: {} } });
  if (comando?.tipo === 'atajo') resp = respuestaDeAtajo(comando.datos);
  // Archivo con pie que es solo una ruta («Fotos/Viajes»): se archiva sin el modelo
  const carpetaSuelta = comando || elegida || confirmacion || suelto || contexto.pedirNombre === true || contexto.esperaNombre === true ? null : interpretarCarpetaSuelta(contexto.mensaje, contexto.archivosCitados);
  if (carpetaSuelta) resp = respuestaDeAtajo({ intencion: 'archivar', archivos: { refs: carpetaSuelta.refs, carpeta: carpetaSuelta.ruta, nombre: null } });
  // La carpeta elegida en «¿Dónde la guardo?»: se archiva ahí sin volver a preguntar (los archivos se buscan por su id: sus referencias cambian)
  let carpetaConfirmada = null;
  if (carpetaResp?.tipo === 'elegida') {
    const refDeArchivo = new Map(Object.entries(archivos.refs ?? {}).map(([r, id]) => [id, r]));
    const refsElegidos = carpetaResp.archivos.map((id) => refDeArchivo.get(id)).filter(Boolean);
    if (refsElegidos.length === 0) {
      return {
        peticiones: [...(contexto.pendienteId ? [peticion('cerrar pregunta anterior', 'PATCH', `/mensajes?id=eq.${encodeURIComponent(contexto.pendienteId)}`, { pregunta_pendiente: false }, 'return=minimal')] : []), marcarMensaje({ procesado: true, error: null })],
        meta: { ok: true, error: null, intencion: 'archivar', avisos: [], respuesta_usuario: 'Esos archivos ya no están en Entrada.', respuesta_fija: true, pregunta: null, consulta_url: urlNeutra, consulta: null, carpetas: false, ahora: ahora.toISOString() },
      };
    }
    resp = respuestaDeAtajo({ intencion: 'archivar', archivos: { refs: refsElegidos, carpeta: carpetaResp.ruta, nombre: carpetaResp.nombre } });
    carpetaConfirmada = carpetaResp.ruta;
  }
  const sinAtajo = comando || elegida || confirmacion || suelto || carpetaSuelta || carpetaResp || contexto.pedirNombre === true || contexto.esperaNombre === true;
  // «Ponlo en Budapest» sin citar nada, justo después de mandar fotos: el último lote 
  const ultimoLote = sinAtajo || (contexto.archivosCitados ?? []).length > 0 ? null : archivarUltimoLote(contexto.mensaje, contexto.loteReciente);
  if (ultimoLote) resp = respuestaDeAtajo({ intencion: 'archivar', archivos: { refs: ultimoLote.refs, carpeta: ultimoLote.ruta, nombre: null } });
  // «Mueve las fotos de Budapest a Viajes/Budapest» : cambia su carpeta y «Sincronizar Drive» las mueve en unos segundos. Va antes que
  // mover carpetas: dice «las fotos de» o «los archivos de», que es más concreto
  const rutasConocidas = (contexto.carpetasConocidas ?? []).map((c) => c.ruta);
  // «Mueve <nombre del archivo> a Notas» : un archivo concreto, ya guardado o no
  const unArchivo = sinAtajo || ultimoLote ? null : interpretarMoverArchivoNombre(contexto.mensaje);
  // «Mueve esos archivos a X» / «muévelos a X» : los últimos que movió o guardó la secretaria
  const esos = sinAtajo || ultimoLote || unArchivo ? null : interpretarMoverEsos(contexto.mensaje, rutasConocidas);
  const moverArch = sinAtajo || ultimoLote ? null : unArchivo ?? (esos ? { esos: true, destino: esos.destino } : null) ?? interpretarMoverArchivos(contexto.mensaje, rutasConocidas) ?? interpretarMoverContenido(contexto.mensaje, rutasConocidas);
  // «Mete la carpeta Viajes dentro de Fotos» o «mueve Budapest a Viajes»: se reconoce por código, sin el modelo
  const moverOrden = sinAtajo || ultimoLote || moverArch ? null : interpretarMoverCarpeta(contexto.mensaje, rutasConocidas);
  if (moverOrden) resp = respuestaDeAtajo({ intencion: 'mover_carpeta', mover_carpeta: moverOrden });
  if (moverArch) resp = respuestaDeAtajo({ intencion: 'mover_archivos', mover_archivos: moverArch });
  if (!comando && pideBorrarTodo(contexto.mensaje)) resp = respuestaDeAtajo({ intencion: 'cancelar', cancelar: { filtro: {} } });
  const variasSecciones = comando || elegida || confirmacion || suelto ? null : borrarSecciones(contexto.mensaje);
  if (variasSecciones) resp = respuestaDeAtajo({ intencion: 'cancelar', cancelar: { filtros: variasSecciones } });
  // «Borra la cita» cuando solo hay una (o ninguna): por código, sin el modelo
  const concreto = comando || elegida || confirmacion || contexto.pedirNombre === true ? null : quitarConcreto(contexto.mensaje, pendientes);
  if (concreto?.ninguno) return ayudaFija([concreto.ninguno], 'cancelar');
  if (concreto?.id) {
    const refDe = new Map(Object.entries(refs).map(([r, id]) => [id, r]));
    if (refDe.has(concreto.id)) resp = respuestaDeAtajo({ intencion: 'cancelar', cancelar: { item_ids: [refDe.get(concreto.id)] } });
  }
  if (elegida) resp = respuestaDeAtajo({ intencion: 'cancelar', cancelar: { filtro: elegida } });
  if (confirmacion?.tipo === 'no') {
    return {
      peticiones: [
        ...(contexto.pendienteId ? [peticion('cerrar pregunta anterior', 'PATCH', `/mensajes?id=eq.${encodeURIComponent(contexto.pendienteId)}`, { pregunta_pendiente: false }, 'return=minimal')] : []),
        marcarMensaje({ procesado: true, error: null }),
      ],
      meta: { ok: true, error: null, intencion: 'descartar', avisos: [], respuesta_usuario: 'Vale, no quito nada.', respuesta_fija: true, pregunta: null, consulta_url: urlNeutra, consulta: null, carpetas: false, ahora: ahora.toISOString() },
    };
  }
  if (confirmacion?.tipo === 'si' && confirmacion.accion === 'olvidar') return olvidarIds(confirmacion.ids, true);
  if (confirmacion?.tipo === 'si' && confirmacion.accion === 'papelera') {
    // Borrar en Drive confirmado: se cierra la pregunta y se leen otra vez el árbol y los archivos registrados. «Preparar papelera»
    // comprueba con ellos cada id antes de mandarlo a la papelera (una carpeta tiene que colgar de Secretaria y no ser Entrada ni
    // Notas; un archivo tiene que estar registrado) y «Resultado» cuenta lo que de verdad se hizo.
    return {
      peticiones: [
        ...(contexto.pendienteId ? [peticion('cerrar pregunta anterior', 'PATCH', `/mensajes?id=eq.${encodeURIComponent(contexto.pendienteId)}`, { pregunta_pendiente: false }, 'return=minimal')] : []),
        marcarMensaje({ procesado: true, error: null }),
      ],
      meta: { ok: true, error: null, intencion: 'borrar_drive', avisos: [], respuesta_usuario: '', pregunta: null, consulta_url: urlNeutra, consulta: null, carpetas: true, papelera: confirmacion.papelera, ahora: ahora.toISOString() },
    };
  }
  if (confirmacion?.tipo === 'si') {
    // Los ids del lote son reales; el cancelar los quiere con sus referencias cortas (lo que ya no está pendiente se queda fuera)
    const refDe = new Map(Object.entries(refs).map(([r, id]) => [id, r]));
    resp = respuestaDeAtajo({ intencion: confirmacion.accion, [confirmacion.accion]: { item_ids: confirmacion.ids.map((id) => refDe.get(id)).filter(Boolean) } });
  }
  // «¿Cuáles hay?» ante la pregunta de un nombre repetido: se contesta con las que existen y la pregunta sigue abierta (no se cierra)
  const titulosRepetidos = comando ? null : pideListarRepetidos(contexto.mensaje, contexto.hiloPrevio);
  if (titulosRepetidos) {
    const existentes = parecidasA(titulosRepetidos, pendientes);
    const texto = existentes.length > 0
      ? `Esto es lo que ya tienes:\n${existentes.map((e) => `• ${lineaExistente(e)}`).join('\n')}\n¿La cambio o añado otra con el mismo nombre?`
      : 'Ya no encuentro nada parecido pendiente. Dime otra vez lo que quieres apuntar.';
    return {
      peticiones: [marcarMensaje({ procesado: true, error: null })],
      meta: { ok: true, error: null, intencion: 'consultar', avisos: [], respuesta_usuario: texto, respuesta_fija: true, pregunta: null, consulta_url: urlNeutra, consulta: null, carpetas: false, ahora: ahora.toISOString() },
    };
  }
  // Aplazar respondiendo a un aviso («10 minutos más»): se convierte en el corregir equivalente y sigue el camino normal (validación,
  // solapes de las citas, reabrir la alarma ya sonada…)
  const aplazamiento = comando ? null : interpretarAplazamiento(contexto.mensaje, contexto.citados, ahora);
  if (aplazamiento) resp = respuestaDeAtajo({ intencion: 'corregir', correccion: { item_ids: [aplazamiento.ref], cambios: aplazamiento.cambios } });

  // La primera pregunta de la secretaria es su nombre: mientras no tenga uno (y no se le acabe de preguntar), cualquier mensaje se contesta
  // con esa pregunta, sin mirar lo que diga el modelo (que no se ha usado para nada). El mensaje original queda guardado, sin procesar.
  if (contexto.pedirNombre === true && comando?.tipo !== 'atajo' && !aplazamiento) {
    if (typeof contexto.mensaje !== 'string' || contexto.mensaje === '') throw new Error('Planificar: falta el texto del mensaje para guardar la pregunta del nombre');
    const texto = TEXTO_PEDIR_NOMBRE;
    const turnoModelo = JSON.stringify({
      intencion: 'aclarar', items: [], consulta: null, correccion: null, completar: null, memoria_nueva: null,
      pregunta: texto, respuesta_usuario: texto, motivo: 'pedir_nombre', dias: [],
    });
    return {
      peticiones: [
        ...(contexto.pendienteId ? [peticion('cerrar pregunta anterior', 'PATCH', `/mensajes?id=eq.${encodeURIComponent(contexto.pendienteId)}`, { pregunta_pendiente: false }, 'return=minimal')] : []),
        marcarMensaje({
          procesado: true, error: null, pregunta: texto, pregunta_pendiente: true,
          hilo: [{ rol: 'user', texto: contexto.mensaje }, { rol: 'model', texto: turnoModelo }],
        }),
      ],
      meta: { ok: true, error: null, intencion: 'aclarar', avisos: [], respuesta_usuario: texto, pregunta: texto, bloqueo: 'pedir_nombre', consulta_url: urlNeutra, consulta: null, carpetas: false, ahora: ahora.toISOString() },
    };
  }

  const { texto, error } = textoDeRespuesta(resp);
  if (error) return conError(`Error del modelo: ${error}`, { intencion: null });

  let validado;
  try {
    validado = validarRespuesta(texto, config, refs, archivos.refs ?? {}, { esperaNombre: contexto.esperaNombre === true });
  } catch (e) {
    if (!(e instanceof ErrorValidacion)) throw e;
    // El modelo devolvió algo que no encaja: no se hace nada y se contesta «no te he entendido» (Resultado). No es un fallo del flujo:
    // el mensaje queda procesado, con el motivo anotado para poder revisarlo (supabase/comprobaciones/ver-errores.sql).
    const motivo = `Respuesta no válida: ${e.message}. Texto recibido: ${texto.slice(0, MAX_TEXTO_ERROR)}`;
    return {
      peticiones: [marcarMensaje({ procesado: true, error: motivo })],
      meta: { ok: false, no_entendido: true, error: motivo, intencion: null, avisos: [], respuesta_usuario: '', pregunta: null, consulta_url: urlNeutra, consulta: null },
    };
  }

  const { datos, avisos } = validado;
  // El modelo no sabe que se pueden mover carpetas y archivos: si lo niega en una pregunta («No puedo mover carpetas en Drive. ¿Quieres que…?»,
  // no se deja la pregunta abierta y se contesta cómo pedirlo
  if (datos.intencion === 'aclarar' && typeof datos.pregunta === 'string' && (DICE_QUE_NO_MUEVE.test(datos.pregunta) || DICE_QUE_NO_MUEVE_ARCHIVOS.test(datos.pregunta))) {
    avisos.push('el modelo dijo que no puede mover carpetas o archivos: se le corrige');
    datos.respuestaUsuario = datos.pregunta;
    datos.pregunta = null;
    datos.intencion = 'charla';
  }
  // Carpetas pedidas que ya existen con otra escritura («viajes» cuando hay «Viajes»): se piden como están 
  if (datos.intencion === 'crear_carpeta' && Array.isArray(datos.rutasNuevas)) {
    datos.rutasNuevas = [...new Set(datos.rutasNuevas.map((r) => revisarCarpetaPedida(r, contexto.carpetasConocidas ?? []).ruta))];
  }
  // Sin seguridad no se apunta nada (regla 5 del prompt, ahora también por código): si algo de lo que iba a guardar tiene una confianza baja,
  // se pregunta en vez de guardar, enseñando lo que se ha entendido. La respuesta vuelve al modelo con el hilo.
  const dudosos = datos.intencion === 'guardar' ? datos.items.filter((it) => typeof it.confianza === 'number' && it.confianza < UMBRAL_CONFIANZA) : [];
  if (dudosos.length > 0) {
    avisos.push(`confianza baja (${dudosos.map((it) => it.confianza).join(', ')}): se pregunta en vez de guardar`);
    const lineas = datos.items.slice(0, 5).map((it) => `• ${NOMBRE_TIPO[it.tipo] ?? it.tipo}: «${limpiarTxt(it.titulo)}»`);
    datos.intencion = 'aclarar';
    datos.pregunta = `No estoy segura de haberte entendido. He entendido esto:\n${lineas.join('\n')}\n¿Es así?`;
    datos.items = [];
    datos.archivos = null;
    datos.memoriaNueva = null; // de un mensaje que no se ha entendido no se recuerda nada
    datos.nombreUsuario = null;
  }
  const meta = {
    ok: true,
    error: null,
    intencion: datos.intencion,
    avisos,
    respuesta_usuario: datos.respuestaUsuario,
    pregunta: datos.pregunta,
    consulta_url: urlNeutra,
    consulta: null,
    carpetas: false,
    ahora: ahora.toISOString(),
    ...(datos.nombreNuevo ? { nombre_nuevo: datos.nombreNuevo, tras_pregunta_nombre: contexto.esperaNombre === true } : {}),
  };

  // Tope de la memoria: un dato NUEVO (un término que no existe) no se guarda si ya hay MAX_MEMORIA; cambiar uno que existe, sí
  if (datos.memoriaNueva) {
    const norma = (t) => String(t).trim().toLowerCase();
    const existe = filasMem.some((m) => norma(m.termino) === norma(datos.memoriaNueva.termino));
    const fijo = [NOMBRE_TERMINO, NOMBRE_USUARIO].includes(sinAcentos(datos.memoriaNueva.termino));
    if (!existe && !fijo && filasMem.length >= MAX_MEMORIA) {
      avisos.push(`memoria llena (${filasMem.length}): no se guarda «${datos.memoriaNueva.termino}»`);
      meta.memoria_llena = datos.memoriaNueva.termino;
      if (datos.intencion === 'recordar') {
        meta.respuesta_usuario = textoMemoriaLlena(datos.memoriaNueva.termino);
        meta.respuesta_fija = true;
      }
      datos.memoriaNueva = null;
    }
  }

  const cerrarAnterior = () =>
    peticion('cerrar pregunta anterior', 'PATCH', `/mensajes?id=eq.${encodeURIComponent(contexto.pendienteId)}`, { pregunta_pendiente: false }, 'return=minimal');

  // La compra: lo que sea comprar cosas va a la lista de la compra, y si el mensaje dice un día se pregunta si se avisa ese día.
  // No aplica a la respuesta a la propia pregunta del aviso (avisoResp).
  const esCompra = !avisoResp && ES_COMPRA.test(sinSignos(contexto.mensaje ?? ''));
  const diaCompra = esCompra ? diaDeCompra(contexto.mensaje, ahora) : null;
  const antesDeCompra = datos.intencion === 'guardar' ? datos.items.length : 0;
  if (esCompra && datos.intencion === 'guardar') datos.items = aListaDeCompra(datos.items, avisos);
  const pasoALista = datos.intencion === 'guardar' && datos.items.length !== antesDeCompra || (datos.intencion === 'guardar' && avisos.some((a) => a.includes('pasa a la lista de la compra')));
  const huboCompra = datos.intencion === 'guardar' && datos.items.some((it) => it.tipo === 'lista' && it.lista === LISTA_COMPRA);
  // Sin repetidos en las listas
  const repetidosLista = datos.intencion === 'guardar' ? quitarRepetidosDeLista(datos.items, pendientes) : { items: [], repetidos: [] };
  if (datos.intencion === 'guardar') {
    datos.items = repetidosLista.items;
    if (repetidosLista.repetidos.length > 0) avisos.push(`ya estaban en la lista: ${repetidosLista.repetidos.map((r) => r.titulo).join(', ')}`);
  }
  if (datos.intencion === 'guardar' && (pasoALista || repetidosLista.repetidos.length > 0)) {
    const nombreLista = datos.items.find((it) => it.tipo === 'lista')?.lista ?? repetidosLista.repetidos[0]?.lista ?? LISTA_COMPRA;
    meta.respuesta_usuario = textoCompraGuardada(datos.items, repetidosLista.repetidos, nombreLista);
    meta.confirmacion_codigo = true;
  }
  // Sección 61: ya no se pregunta «¿te aviso para ir a comprar?». La compra va a su lista, con día o sin él.

  // Ayuda: lo pidió con palabras que no son un comando («no sé cómo usarte»). Se enseña la lista de comandos y no se toca nada (la pregunta pendiente sigue abierta).
  if (datos.intencion === 'ayuda') return ayudaFija([TEXTO_AYUDA]);

  // Descartar: el usuario rechaza lo que la pregunta anterior proponía. No se guarda ni se cambia nada.
  if (datos.intencion === 'descartar') {
    const respuesta = contexto.pendienteId ? datos.respuestaUsuario.trim() || 'Vale, no hago nada.' : 'No hay nada pendiente que cancelar.';
    return {
      peticiones: [...(contexto.pendienteId ? [cerrarAnterior()] : []), marcarMensaje({ procesado: true, error: null })],
      meta: { ...meta, respuesta_usuario: respuesta },
    };
  }

  // Horario fijo: se guarda cada bloque (uno por día); el mismo bloque repetido no se duplica (restricción única)
  if (datos.intencion === 'horario') {
    const nuevos = datos.horarioNuevo.filter((n) => !filasHor.some((b) => b.dia_semana === n.dia_semana && hhmm(b.hora_inicio) === n.hora_inicio && hhmm(b.hora_fin) === n.hora_fin && sinAcentos(b.titulo) === sinAcentos(n.titulo)));
    if (filasHor.length + nuevos.length > MAX_HORARIO) {
      const texto = `Tu horario está lleno (${MAX_HORARIO} bloques). Quita alguno con /horario quitar y su número.`;
      return { peticiones: [marcarMensaje({ procesado: true, error: null })], meta: { ...meta, respuesta_usuario: texto, respuesta_fija: true } };
    }
    return {
      peticiones: [
        ...(contexto.pendienteId ? [cerrarAnterior()] : []),
        ...(nuevos.length > 0 ? [peticion('guardar el horario fijo', 'POST', '/horario_fijo?on_conflict=titulo_norm,dia_semana,hora_inicio,hora_fin', nuevos, 'resolution=ignore-duplicates,return=representation')] : []),
        marcarMensaje({ procesado: true, error: null }),
      ],
      meta: { ...meta, horario_nuevo: datos.horarioNuevo, horario_ya_estaba: nuevos.length === 0 },
    };
  }

  // Borrar carpetas o archivos de Drive: aquí no se borra nada. Se leen el árbol de carpetas y los archivos registrados y
  // «Resultado» enseña la lista de lo que se mandaría a la papelera y deja la pregunta abierta; con el «sí» se manda (más abajo, por código).
  // Es una orden nueva: no contesta ni cierra otra pregunta abierta.
  if (datos.intencion === 'borrar_drive') {
    if (!datos.borrarDrive) {
      return { peticiones: [marcarMensaje({ procesado: true, error: null })], meta: { ...meta, respuesta_usuario: TEXTO_QUE_BORRAR_DRIVE, respuesta_fija: true } };
    }
    return {
      peticiones: [marcarMensaje({ procesado: true, error: null })],
      meta: { ...meta, respuesta_usuario: '', carpetas: true, borrar_drive: datos.borrarDrive },
    };
  }

  // Mover una carpeta dentro de otra : aquí no se mueve nada. «Revisar Drive» la busca en el árbol real y decide si se puede; si sí,
  // «Mover en Drive» la mueve y «Anotar movimiento» reescribe las rutas de la base de datos. Es una orden nueva: no cierra otra pregunta abierta.
  // Juntar : una sola carpeta que se mete donde YA hay una igual o parecida («mueve Budapest a Viajes» y existe «Viajes/Budapest»).
  // Lo que se quiere es juntarlas: se mueve lo que tiene guardado a la que ya existe (mover_archivos) en vez de rechazarlo.
  const fusion = datos.intencion === 'mover_carpeta' ? fusionDeCarpetas(datos.moverCarpeta, contexto.carpetasConocidas ?? []) : null;
  if (fusion) {
    avisos.push(`«${fusion.origen}» se junta con «${fusion.destino}», que ya existe`);
    datos.intencion = 'mover_archivos';
    datos.moverArchivos = { origen: fusion.origen, destino: fusion.destino, solo_fotos: false };
    meta.intencion = 'mover_archivos';
  }
  if (datos.intencion === 'mover_carpeta') {
    return {
      peticiones: [marcarMensaje({ procesado: true, error: null })],
      meta: { ...meta, respuesta_usuario: '', carpetas: true, mover_carpeta: datos.moverCarpeta },
    };
  }
  // Mover fotos o archivos ya guardados : cambia su carpeta y «Sincronizar Drive» los mueve en unos segundos
  // Un archivo concreto por su nombre : se cambia su carpeta (y deja de estar pendiente si lo estaba); «Sincronizar Drive» lo mueve.
  // Si la carpeta no existe pero se parece a otra, se pregunta como al archivar.
  if (datos.intencion === 'mover_archivos' && (datos.moverArchivos.nombre || datos.moverArchivos.esos)) {
    const ma = datos.moverArchivos;
    const fija = (texto, extra = {}) => ({ peticiones: [marcarMensaje({ procesado: true, error: null, ...extra })], meta: { ...meta, respuesta_usuario: texto, respuesta_fija: true } });
    // Cuáles: «esos» son los últimos que movió o guardó la secretaria 
    const ids = ma.esos ? (contexto.movidosRecientes?.ids ?? []) : [];
    if (ma.esos && ids.length === 0) return fija('No sé a qué archivos te refieres. Dime su nombre o la carpeta en la que están: «mueve las fotos de Budapest a Viajes».');
    // El destino, como al archivar: si no existe pero se parece a una sola carpeta, se propone esa («sí» la hace)
    const dest = revisarCarpetaPedida(ma.destino, contexto.carpetasConocidas ?? []);
    const existe = (contexto.carpetasConocidas ?? []).some((c) => sinAcentos(c.ruta) === sinAcentos(dest.ruta));
    const que = ma.esos ? 'esos archivos' : ma.todos ? `todos los archivos «${ma.nombre}»` : ma.nombre;
    if (!existe && dest.parecidas?.length === 1) {
      const texto = `No tengo «${limpiarTxt(dest.ruta)}». ¿${ma.esos || ma.todos ? 'Los' : 'Lo'} paso a «${limpiarTxt(dest.parecidas[0])}»?`;
      return fija(texto, { pregunta: texto, pregunta_pendiente: true, hilo: [{ rol: 'user', texto: contexto.mensaje }, { rol: 'model', texto: turnoSugerencia(`mueve ${que} a ${dest.parecidas[0]}`, texto) }] });
    }
    if (!existe && dest.parecidas?.length > 1) return fija(`No tengo «${limpiarTxt(dest.ruta)}». Se parecen: ${dest.parecidas.slice(0, 4).map((x) => `«${limpiarTxt(x)}»`).join(', ')}. Dime la carpeta exacta.`);
    if (sinAcentos(dest.ruta.split('/')[0]) === 'entrada') return fija('Entrada es para lo que aún no tiene sitio: elige otra carpeta.');
    const cambio = { carpeta_destino: dest.ruta, estado: 'asignado' };
    // Dónde estaba cada archivo (para «déjalo como estaba»); los que no tenían carpeta (Entrada) no se pueden devolver así
    const previasDe = (lista) => Object.fromEntries(lista.map((id) => [id, (contexto.archivosConocidos ?? []).find((a) => a.id === id)?.carpeta ?? null]).filter(([, c]) => typeof c === 'string' && c !== ''));
    if (ma.esos) {
      return {
        peticiones: [marcarMensaje({ procesado: true, error: null }), peticion(`mover esos archivos a ${dest.ruta}`, 'PATCH', `/archivos?id=in.(${ids.map(encodeURIComponent).join(',')})&eliminado_at=is.null`, cambio, 'return=representation')],
        meta: { ...meta, respuesta_usuario: '', mover_archivos: { esos: true, destino: dest.ruta, previas: previasDe(ids) } },
      };
    }
    // Varios archivos con el mismo nombre (fotos del mismo minuto, antes de la sección 76): se pregunta antes de mover los dos
    const iguales = (contexto.archivosConocidos ?? []).filter((a) => a.nombre === ma.nombre);
    if (iguales.length > 1 && !ma.todos) {
      const donde = [...new Set(iguales.map((a) => a.carpeta ?? (a.estado === 'pendiente' ? 'Entrada' : null)).filter(Boolean))];
      const texto = `Hay ${iguales.length} archivos que se llaman «${limpiarTxt(ma.nombre)}»${donde.length ? ` (en ${donde.map((d) => `«${limpiarTxt(d)}»`).join(' y ')})` : ''}. ¿Muevo los ${iguales.length} a «${limpiarTxt(dest.ruta)}»?`;
      return fija(texto, { pregunta: texto, pregunta_pendiente: true, hilo: [{ rol: 'user', texto: contexto.mensaje }, { rol: 'model', texto: turnoSugerencia(`mueve todos los archivos «${ma.nombre}» a ${dest.ruta}`, texto) }] });
    }
    // Uno solo conocido: por su id (más preciso que el nombre); si no está entre los recientes, por el nombre exacto
    const filtro = iguales.length === 1 && !ma.todos ? `id=eq.${encodeURIComponent(iguales[0].id)}` : `nombre=eq.${encodeURIComponent(ma.nombre)}`;
    return {
      peticiones: [marcarMensaje({ procesado: true, error: null }), peticion(`mover el archivo ${ma.nombre} a ${dest.ruta}`, 'PATCH', `/archivos?${filtro}&eliminado_at=is.null`, cambio, 'return=representation')],
      meta: { ...meta, respuesta_usuario: '', mover_archivos: { nombre: ma.nombre, destino: dest.ruta, previas: previasDe(iguales.map((a) => a.id)) } },
    };
  }
  if (datos.intencion === 'mover_archivos') {
    const plan = planMoverArchivos(datos.moverArchivos, contexto.carpetasConocidas ?? []);
    if (plan.texto) {
      const abierta = plan.sugerencia ? { pregunta: plan.texto, pregunta_pendiente: true, hilo: [{ rol: 'user', texto: contexto.mensaje }, { rol: 'model', texto: turnoSugerencia(plan.sugerencia, plan.texto) }] } : {};
      return { peticiones: [marcarMensaje({ procesado: true, error: null, ...abierta })], meta: { ...meta, respuesta_usuario: plan.texto, respuesta_fija: true } };
    }
    const soloFotos = datos.moverArchivos.solo_fotos ? '&tipo_mime=like.image/*' : '';
    // La carpeta de origen se apunta para vaciarla (base de datos 1.5): «Sincronizar Drive» la manda a la papelera cuando compruebe EN DRIVE
    // que se ha quedado vacía (ni archivos ni carpetas). No si el destino está dentro de ella, ni Entrada ni Notas (lo decide la base de datos).
    const dentroDelOrigen = sinAcentos(plan.destino).startsWith(`${sinAcentos(plan.origen)}/`);
    return {
      peticiones: [
        marcarMensaje({ procesado: true, error: null }),
        ...plan.cambios.map((c) => peticion(`mover archivos de ${c.de} a ${c.a}`, 'PATCH', `/archivos?carpeta_destino=eq.${encodeURIComponent(c.de)}&eliminado_at=is.null${soloFotos}`, { carpeta_destino: c.a }, 'return=representation')),
        ...(dentroDelOrigen ? [] : [peticion(`pedir vaciar ${plan.origen}`, 'POST', '/rpc/pedir_vaciar_carpeta', { p_ruta: plan.origen }, 'return=representation')]),
      ],
      meta: { ...meta, respuesta_usuario: '', mover_archivos: { origen: plan.origen, destino: plan.destino, solo_fotos: datos.moverArchivos.solo_fotos, juntar: Boolean(fusion), vuelta: Object.fromEntries(plan.cambios.map((c) => [c.a, `${plan.origen}${c.de.slice(plan.origen.length)}`])), vaciar: dentroDelOrigen ? [] : [plan.origen] } },
    };
  }

  const sinTocarNada = (texto) => ({
    peticiones: [...(contexto.pendienteId ? [cerrarAnterior()] : []), marcarMensaje({ procesado: true, error: null })],
    meta: { ...meta, respuesta_usuario: texto, respuesta_fija: true },
  });
  const porId = new Map(pendientes.map((r) => [r.id, r]));

  // Mover una alarma o una cita a una hora que ya ha pasado no sirve para nada: se dice y no se toca nada. En las citas solo se comprueba
  // si es la del aviso al que se responde (corregir a mano la hora de una cita pasada, para que conste, sigue valiendo).
  // Las fechas y el tipo actuales de lo pendiente (y de las alarmas ya sonadas), por id real: de ahí salen las fechas al cambiar de tipo
  const fechasPorId = new Map(Object.entries(contexto.fechas ?? {}).map(([ref, f]) => [refs[ref], f]).filter(([id]) => id));
  const titulosPorId = new Map([...pendientes.map((r) => [r.id, r.titulo]), ...Object.entries(contexto.fechas ?? {}).map(([ref, f]) => [refs[ref], f.titulo])].filter(([id, t]) => id && t));
  // Cambiar de tipo (alarma, cita, tarea): si falta la hora, se pregunta (entra en la cadena de bloqueos de más abajo)
  const bloqueoConversion = aplicarConversion({ datos, fechas: fechasPorId, titulos: titulosPorId });
  if (datos.intencion === 'corregir' && !bloqueoConversion) {
    const citadosIds = new Set((contexto.citados ?? []).map((x) => refs[x.ref]).filter(Boolean));
    let pasada = null;
    for (const id of datos.correccion.ids) {
      const propios = datos.correccion.porId?.[id];
      const cam = { ...datos.correccion.cambios, ...(propios ?? {}) };
      if (esFecha(cam.recordar_en) && Date.parse(cam.recordar_en) <= ahora.getTime()) pasada = cam.recordar_en;
      else if (esFecha(cam.fecha_inicio) && Date.parse(cam.fecha_inicio) <= ahora.getTime() && (citadosIds.has(id) || propios)) pasada = cam.fecha_inicio;
      if (pasada) break;
    }
    if (pasada) {
      return sinTocarNada(`Esa hora ya ha pasado (${fmtDiaCorto.format(new Date(pasada))}, ${fmtHoraCorta.format(new Date(pasada))}). ¿Qué otra hora?`);
    }
  }

  // Cancelar o completar: el filtro se convierte aquí en ids. Nada que tocar (p. ej. "borra lo del proyecto X" y no hay nada): se
  // dice y no se toca nada.
  let selIds = [];
  if (datos.seleccion) {
    const sel = datos.seleccion;
    // «Borra todo» (cancelar sin decir qué) quita todo lo pendiente, también lo de los proyectos; varias secciones, la unión de todas 
    const todo = datos.intencion === 'cancelar' && sel.filtro && !sel.filtro.tipo && !sel.filtro.lista && !sel.filtro.proyecto;
    if (todo && pendientes.length === 0) return sinTocarNada('No tienes nada pendiente que borrar.');
    if (todo) selIds = pendientes.map((r) => r.id);
    else if (sel.filtros) selIds = [...new Set(sel.filtros.flatMap((f) => resolverFiltro(f, pendientes).map((r) => r.id)))];
    else selIds = sel.filtro ? resolverFiltro(sel.filtro, pendientes).map((r) => r.id) : sel.ids;
    if (sel.filtro) meta.filtro = sel.filtro;
    if (selIds.length === 0) {
      return sinTocarNada(datos.intencion === 'cancelar' ? 'No encuentro nada pendiente que cancelar con eso.' : 'No encuentro nada pendiente que marcar como hecho con eso.');
    }
    if (datos.seleccion.filtro && pendientes.length >= MAX_PENDIENTES_VISTOS) avisos.push(`Solo se han mirado los ${MAX_PENDIENTES_VISTOS} elementos pendientes más recientes`);
  }

  // Proyectos: crear uno que ya existe no hace nada; cerrar uno que no existe se dice. Cerrar quita (archiva) lo que tenga pendiente.
  const proyectosTodos = config.proyectos ?? [];
  if (datos.intencion === 'proyecto') {
    const existe = proyectosTodos.find((p) => sinAcentos(p) === sinAcentos(datos.proyecto.nombre)) ?? null;
    const activo = existe && (config.proyectos_activos ?? proyectosTodos).some((p) => sinAcentos(p) === sinAcentos(existe));
    if (datos.proyecto.accion === 'crear' && activo) return sinTocarNada(`El proyecto «${limpiarTxt(existe)}» ya existe.`);
    if (datos.proyecto.accion === 'cerrar' && !existe) {
      const lista = (config.proyectos_activos ?? proyectosTodos).map((p) => `«${limpiarTxt(p)}»`).join(', ');
      return sinTocarNada(`No tengo ningún proyecto «${limpiarTxt(datos.proyecto.nombre)}».${lista ? ` Tus proyectos: ${lista}.` : ''}`);
    }
    if (datos.proyecto.accion === 'cerrar') {
      datos.proyecto.nombre = existe;
      selIds = pendientes.filter((r) => sinAcentos(r.proyecto) === sinAcentos(existe)).map((r) => r.id);
    }
  }

  // Agenda: un solape bloquea siempre; una cita dentro de tu horario fijo pide confirmación. En ambos casos no se escribe ningún item: se
  // guarda la pregunta con su hilo (la respuesta del "modelo" la fabrica este código, con su motivo y los días).
  // Primero los proyectos nuevos (qué se guarda) y después la agenda (cuándo). Lo que el usuario ya aceptó en la pregunta anterior
  // viaja en la nueva, sea del tipo que sea.
  const hiloPrevio = contexto.hiloPrevio ?? [];
  // Las alarmas se convierten antes de comprobar la agenda: no entran en el control de solapes ni piden confirmar el día
  eventosAAlarmas(datos, ahora, meta, contexto.mensaje);
  const bloqueo =
    bloqueoConversion ??
    comprobarProyectos({ datos, config, hiloPrevio }) ??
    comprobarAgenda({ datos, agenda, hiloPrevio, horario: filasHor }) ??
    null; // Quitar, completar o cerrar un proyecto ya no se confirma (archivar es recuperable), ni se pregunta por repetidos o por la sección
  if (bloqueo) {
    if (typeof contexto.mensaje !== 'string' || contexto.mensaje === '') {
      throw new Error('Planificar: falta el texto del mensaje para guardar el hilo de la pregunta');
    }
    const previas = confirmacionesDelHilo(hiloPrevio);
    const turnoModelo = JSON.stringify({
      intencion: 'aclarar', items: [], consulta: null, correccion: null, completar: null, memoria_nueva: null,
      pregunta: bloqueo.texto, respuesta_usuario: bloqueo.texto, motivo: bloqueo.motivo,
      dias: [...new Set([...previas.dias, ...(bloqueo.dias ?? [])])],
      proyectos: [...new Set([...previas.proyectos, ...(bloqueo.proyectos ?? []).map(sinAcentos)])],
      lotes: [...previas.lotes, ...(bloqueo.lotes ?? [])],
      repetidos: [...new Set([...previas.repetidos, ...(bloqueo.repetidos ?? [])])],
      horario: [...new Set([...previas.horario, ...(bloqueo.horario ?? [])])],
    });
    return {
      peticiones: [
        ...(contexto.pendienteId ? [cerrarAnterior()] : []),
        marcarMensaje({
          procesado: true, error: null, pregunta: bloqueo.texto, pregunta_pendiente: true,
          hilo: [...hiloPrevio, { rol: 'user', texto: contexto.mensaje }, { rol: 'model', texto: turnoModelo }],
        }),
      ],
      meta: { ...meta, intencion: 'aclarar', pregunta: bloqueo.texto, respuesta_usuario: bloqueo.texto, bloqueo: bloqueo.motivo },
    };
  }

  // Archivar en una carpeta que no existe pero se parece a otra («Budapest» y ya hay «Viajes/Budapest»): se pregunta dónde . Si ya
  // existe con otra escritura, se usa la suya. Si el usuario acaba de elegir crearla, no se vuelve a preguntar.
  if (datos.intencion === 'archivar' && datos.archivos) {
    const rev = revisarCarpetaPedida(datos.archivos.carpeta, contexto.carpetasConocidas ?? []);
    const confirmada = carpetaConfirmada !== null && sinAcentos(carpetaConfirmada) === sinAcentos(datos.archivos.carpeta);
    if (rev.parecidas && !confirmada) {
      if (typeof contexto.mensaje !== 'string' || contexto.mensaje === '') throw new Error('Planificar: falta el texto del mensaje para guardar la pregunta de la carpeta');
      const ids = datos.archivos.refs.map((r) => archivos.refs[r]).filter((x) => typeof x === 'string');
      const texto = textoCarpetaParecida(rev.ruta, rev.parecidas, ids.length);
      const turno = JSON.stringify({ intencion: 'aclarar', motivo: 'carpeta_parecida', origen: 'codigo', opciones: rev.parecidas, nueva: rev.ruta, archivos: ids, nombre: datos.archivos.nombre ?? null, pregunta: texto, items: [], respuesta_usuario: texto });
      return {
        peticiones: [
          ...(contexto.pendienteId ? [cerrarAnterior()] : []),
          marcarMensaje({ procesado: true, error: null, pregunta: texto, pregunta_pendiente: true, hilo: [{ rol: 'user', texto: contexto.mensaje }, { rol: 'model', texto: turno }] }),
        ],
        meta: { ...meta, intencion: 'aclarar', pregunta: texto, respuesta_usuario: texto, bloqueo: 'carpeta_parecida' },
      };
    }
    datos.archivos.carpeta = rev.ruta;
  }

  const peticiones = [];
  if (datos.intencion === 'guardar') {
    // Recordatorios cortos (tareas con recordar_en): no van al calendario ni al control de solapes. Una hora que ya ha pasado no se
    // puede avisar: se guarda la tarea sin aviso y se dice. Los demás salen en la meta, para decirle al usuario cuándo se le avisará.
    const pasados = [];
    const recordatorios = [];
    datos.items = datos.items.map((it) => {
      if (it.tipo !== 'tarea' || !esFecha(it.recordar_en)) return it;
      if (Date.parse(it.recordar_en) <= ahora.getTime()) {
        pasados.push(it.titulo);
        return { ...it, recordar_en: null };
      }
      recordatorios.push({ titulo: it.titulo, recordar_en: new Date(Date.parse(it.recordar_en)).toISOString() });
      return it;
    });
    if (recordatorios.length > 0) meta.recordatorios = recordatorios;
    const nuevos = proyectosNuevos(datos, config);
    if (nuevos.length > 0) meta.proyectos_nuevos = nuevos;
    if (pasados.length > 0) meta.recordatorios_pasados = pasados;
    const filas = datos.items.map((it) => aFila(it, mensajeId, ahora, config));
    // Con archivos que cuelgan del item (uno solo, validado), el item y el enlace de los archivos van en UNA petición a la función
    // guardar_con_archivos, dentro de una transacción. Varias peticiones no sirven: "Escribir en Supabase" las lanza
    // a la vez y el enlace llegaba a veces antes de que el item existiera (error de clave foránea).
    // Sin nada que guardar (todo estaba ya en la lista) no se escribe nada
    if (!datos.archivos && filas.length > 0) peticiones.push(peticion('guardar items', 'POST', '/items', filas, 'return=representation'));
    // Horario de cada evento guardado, para decírselo al usuario en la confirmación: así la hora de fin que se asume cuando no
    // la dice (una hora) no pasa en silencio
    const eventos = datos.items
      .filter((it) => it.tipo === 'evento' && esFecha(it.fecha_inicio))
      .map((it) => {
        const { ini, fin } = intervalo(it.fecha_inicio, it.fecha_fin);
        return { titulo: it.titulo, inicio: new Date(ini).toISOString(), fin: new Date(fin).toISOString(), minutos: Math.round((fin - ini) / 60000) };
      });
    if (eventos.length > 0) meta.eventos = eventos;
    if (datos.archivos) {
      const nombres = nombresNuevos(datos.archivos.refs, archivos.info ?? {}, { titulo: datos.items[0].titulo, nombre: datos.archivos.nombre });
      // La función cuelga los archivos del item, quita cualquier carpeta pedida antes (ahora la decide el item) y, si no se pide
      // nada, conserva su nombre. Si algún archivo no existe, no crea nada.
      peticiones.push(
        peticion(
          'guardar item con archivos',
          'POST',
          '/rpc/guardar_con_archivos',
          // El item solo existe para colgar los archivos que se acaban de clasificar: no es nada pendiente y nace "hecho".
          // Así no sale en "qué tengo pendiente"; sus archivos siguen saliendo en "dame los archivos".
          { p_item: { ...filas[0], estado: 'hecho' }, p_archivos: datos.archivos.refs.map((r, i) => ({ id: archivos.refs[r], nombre: nombres[i] ?? null })) },
          'return=representation',
        ),
      );
    }
  }
  if (datos.intencion === 'archivar') {
    const nombres = nombresNuevos(datos.archivos.refs, archivos.info ?? {}, { nombre: datos.archivos.nombre });
    datos.archivos.refs.forEach((r, i) =>
      peticiones.push(
        peticion(`archivar ${r} en ${datos.archivos.carpeta}`, 'PATCH', `/archivos?id=eq.${encodeURIComponent(archivos.refs[r])}`, { carpeta_destino: datos.archivos.carpeta, estado: 'asignado', ...(nombres[i] ? { nombre: nombres[i] } : {}) }, 'return=representation'),
      ),
    );
  }
  if (datos.intencion === 'carpetas') meta.carpetas = true;
  // Crear carpetas vacías: se apuntan en carpetas_pedidas y el flujo "Sincronizar Drive" las crea (un nivel por pasada). Pedir otra vez
  // una carpeta ya pedida la vuelve a marcar como pendiente, así se recrea una que se hubiera borrado a mano en Drive.
  if (datos.intencion === 'crear_carpeta') {
    peticiones.push(
      peticion(
        `pedir ${datos.rutasNuevas.length === 1 ? 'la carpeta' : 'las carpetas'} ${datos.rutasNuevas.join(', ')}`,
        'POST',
        '/carpetas_pedidas?on_conflict=ruta',
        datos.rutasNuevas.map((ruta) => ({ ruta, drive_pendiente: true, eliminada_at: null })),
        'resolution=merge-duplicates,return=representation',
      ),
    );
    meta.carpetas_pedidas = datos.rutasNuevas;
  }
  // Cancelar pasa el item a "archivado": deja de salir en consultas y en la agenda y libera el hueco. No se borra de la base de datos
  // (se puede recuperar) y el flujo "Sincronizar Calendar" borra su evento de Calendar.
  if (datos.intencion === 'cancelar') {
    const ids = selIds.map(encodeURIComponent).join(',');
    peticiones.push(peticion('cancelar items', 'PATCH', `/items?id=in.(${ids})`, { estado: 'archivado', quitado_en: ahora.toISOString() }, 'return=representation'));
  }
  if (datos.intencion === 'proyectos') meta.listar_proyectos = true;
  // Crear: upsert por nombre sin mayúsculas (si existía cerrado, se reabre). Cerrar: el proyecto pasa a cerrado y lo pendiente, a archivado.
  // Las dos peticiones de cerrar no dependen una de otra (cambiar el estado del proyecto no toca sus items).
  if (datos.intencion === 'proyecto') {
    const { accion, nombre } = datos.proyecto;
    meta.proyecto = { accion, nombre, quitados: accion === 'cerrar' ? selIds.length : 0 };
    if (accion === 'crear') {
      peticiones.push(peticion(`crear el proyecto ${nombre}`, 'POST', '/proyectos?on_conflict=nombre_norm', { nombre, estado: 'activo' }, 'resolution=merge-duplicates,return=representation'));
    } else {
      peticiones.push(peticion(`cerrar el proyecto ${nombre}`, 'PATCH', `/proyectos?nombre=eq.${encodeURIComponent(nombre)}`, { estado: 'cerrado' }, 'return=representation'));
      if (selIds.length > 0) {
        peticiones.push(peticion(`quitar lo pendiente de ${nombre}`, 'PATCH', `/items?id=in.(${selIds.map(encodeURIComponent).join(',')})`, { estado: 'archivado', quitado_en: ahora.toISOString() }, 'return=representation'));
      }
    }
  }
  // Los archivos se filtran en "Resultado" (sin patrones de búsqueda con datos del modelo): aquí solo se lee la lista, de cualquier
  // estado (también los ya clasificados) y con el item del que cuelgan, que decide su carpeta.
  if (datos.intencion === 'ver_archivos') {
    meta.consulta_url = `${base}/archivos?select=nombre,drive_file_id,drive_url,created_at,tipo_mime,carpeta_destino,estado,items(tipo)&eliminado_at=is.null&order=created_at.desc&limit=1000`;
    meta.consulta_archivos = datos.filtroArchivos;
  }
  if (datos.memoriaNueva) {
    peticiones.push(
      peticion('guardar memoria', 'POST', '/memoria?on_conflict=termino_norm', datos.memoriaNueva, 'resolution=merge-duplicates,return=representation'),
    );
    if (datos.intencion !== 'recordar') meta.memoria_nueva = datos.memoriaNueva;
    if (datos.nombreUsuario) meta.nombre_usuario = datos.nombreUsuario;
  }
  // Charla: no se escribe nada; la respuesta es la del modelo, sin promesas de haber hecho algo
  if (datos.intencion === 'charla') meta.respuesta_usuario = textoCharla(datos.respuestaUsuario, Boolean(datos.memoriaNueva));
  if (datos.intencion === 'corregir') {
    // Añadir al contenido va por la función anadir_contenido, que concatena en la base de datos; el resto de cambios, con un
    // PATCH. No dependen uno del otro (anadir_contenido nunca va junto a contenido).
    const { anadir_contenido: anadir, ...comunes } = datos.correccion.cambios;
    // Una alarma que ya sonó (quedó «hecha») vuelve a estar pendiente si se le da otra hora o se cambia de tipo: solo las del aviso citado o las
    // recientes (contexto.reabribles); nunca otra cosa hecha.
    const reabribles = new Set(contexto.reabribles ?? []);
    const porIdCambios = datos.correccion.porId ?? null;
    const lista = (xs) => xs.map(encodeURIComponent).join(',');
    // Sin cambio de tipo, un solo PATCH para todos. Con él, un PATCH por elemento: cada uno lleva sus fechas
    const grupos = porIdCambios ? datos.correccion.ids.map((id) => ({ ids: [id], cambios: { ...comunes, ...porIdCambios[id] } })) : [{ ids: datos.correccion.ids, cambios: comunes }];
    for (const g of grupos) {
      const reabrir = g.ids.filter((id) => reabribles.has(id) && (esFecha(g.cambios.recordar_en) || porIdCambios));
      const normales = g.ids.filter((id) => !reabrir.includes(id));
      if (Object.keys(g.cambios).length > 0 && normales.length > 0) peticiones.push(peticion('corregir items', 'PATCH', `/items?id=in.(${lista(normales)})`, g.cambios, 'return=representation'));
      if (reabrir.length > 0) peticiones.push(peticion('reabrir alarma', 'PATCH', `/items?id=in.(${lista(reabrir)})`, { ...g.cambios, estado: 'pendiente' }, 'return=representation'));
    }
    // La confirmación de una hora nueva o de un cambio de tipo la redacta Resultado con lo guardado (no con lo que diga el modelo)
    if (datos.correccion.convertir) meta.conversion = datos.correccion.convertir;
    else if (['recordar_en', 'fecha_inicio', 'fecha_fin'].some((k) => esFecha(comunes[k]))) meta.hora_movida = true;
    if (anadir) peticiones.push(peticion('añadir al contenido', 'POST', '/rpc/anadir_contenido', { p_ids: datos.correccion.ids, p_texto: anadir }, 'return=representation'));
    const nuevos = proyectosNuevos(datos, config);
    if (nuevos.length > 0) meta.proyectos_nuevos = nuevos;
  }
  if (datos.intencion === 'completar') {
    const ids = selIds.map(encodeURIComponent).join(',');
    peticiones.push(peticion('completar items', 'PATCH', `/items?id=in.(${ids})`, { estado: 'hecho', quitado_en: ahora.toISOString() }, 'return=representation'));
  }
  if (datos.intencion === 'consultar') {
    const q = datos.consulta;
    meta.consulta_url = urlConsulta(base, q);
    // Con todo el detalle si lo pide el atajo o si el mensaje lo dice («qué tengo pendiente completo», «dámelo todo entero»)
    const completo = q.completo || pideCompleto(contexto.mensaje);
    meta.consulta = { tipo: q.tipo, vista: q.vista, lista: q.lista, proyecto: q.proyecto, buscar: q.buscar, completo, estado: q.estado, con_rango: Boolean(q.desde || q.hasta), rango_texto: textoRango(q, ahora), limite: MAX_FILAS_CONSULTA };
  }
  const cuerpoMensaje = { procesado: true, error: null };
  // Una charla que termina ofreciendo apuntar algo («¿quieres que te lo apunte como tarea?») deja la oferta abierta, con el hilo, para que el
  // «sí» siguiente sepa de qué se habla
  if (datos.intencion === 'charla' && !datos.memoriaNueva && meta.respuesta_usuario !== TEXTO_CHARLA_SEGURO && esOfertaDeApuntar(meta.respuesta_usuario)) {
    if (typeof contexto.mensaje !== 'string' || contexto.mensaje === '') throw new Error('Planificar: falta el texto del mensaje para guardar la oferta');
    const turnoOferta = JSON.stringify({ intencion: 'charla', items: [], consulta: null, correccion: null, completar: null, memoria_nueva: null, respuesta_usuario: meta.respuesta_usuario, motivo: 'oferta', origen: 'codigo' });
    Object.assign(cuerpoMensaje, {
      pregunta: meta.respuesta_usuario,
      pregunta_pendiente: true,
      hilo: [...(contexto.hiloPrevio ?? []), { rol: 'user', texto: contexto.mensaje }, { rol: 'model', texto: turnoOferta }],
    });
  }
  if (datos.intencion === 'aclarar') {
    // La pregunta queda esperando respuesta, con el hilo hasta ella para devolvérselo al modelo cuando llegue
    if (typeof contexto.mensaje !== 'string' || contexto.mensaje === '') {
      throw new Error('Planificar: falta el texto del mensaje para guardar el hilo de la pregunta');
    }
    Object.assign(cuerpoMensaje, {
      pregunta: datos.pregunta,
      pregunta_pendiente: true,
      hilo: [...(contexto.hiloPrevio ?? []), { rol: 'user', texto: contexto.mensaje }, { rol: 'model', texto: sinMarcaDeCodigo(texto) }],
    });
  }
  if (meta.aviso_compra && datos.intencion === 'guardar') {
    // Se apunta lo de la compra y la pregunta del aviso queda abierta (con el día en el hilo, para resolver la respuesta por código)
    const { pregunta: texto, ...aviso } = meta.aviso_compra;
    Object.assign(cuerpoMensaje, {
      pregunta: texto,
      pregunta_pendiente: true,
      hilo: [...(contexto.hiloPrevio ?? []), { rol: 'user', texto: contexto.mensaje }, { rol: 'model', texto: turnoAvisoCompra(aviso, texto) }],
    });
  }
  peticiones.push(marcarMensaje(cuerpoMensaje));

  // La pregunta anterior queda contestada en cuanto este mensaje se procesa bien (si falló, sigue abierta para reintentar)
  if (contexto.pendienteId) {
    peticiones.unshift(peticion('cerrar pregunta anterior', 'PATCH', `/mensajes?id=eq.${encodeURIComponent(contexto.pendienteId)}`, { pregunta_pendiente: false }, 'return=minimal'));
  }
  return { peticiones, meta };
}

// --- Pegamento con n8n ---
const config = $('Configuración').first().json.config;
const mensajeId = $('Guardar mensaje').first().json.id;
if (!mensajeId) throw new Error('Planificar: "Guardar mensaje" no devolvió el id del mensaje');

// Referencias cortas (i1, i2…) → ids reales, tal como las vio el modelo en "Construir petición"
const construccion = $('Construir petición').first().json;
const refs = construccion.refs ?? {};

// La conversación: este mensaje (los mensajes seguidos ya juntados por el flujo de WhatsApp), la pregunta anterior que contesta (si la
// hay) y el hilo guardado hasta ella
const contexto = {
  // Si el mensaje acepta una propuesta concreta de la secretaria , se procesa la orden propuesta como si la hubiera escrito
  mensaje: typeof construccion.mensaje_efectivo === 'string' && construccion.mensaje_efectivo !== '' ? construccion.mensaje_efectivo : $('Entrada').first().json.mensaje,
  // Demasiados mensajes seguidos (lo decide el flujo de WhatsApp): no se procesa nada y se contesta con su aviso
  avisoDemasiados: $('Entrada').first().json.demasiados === true ? String($('Entrada').first().json.aviso_demasiados ?? '') : '',
  pendienteId: construccion.pendiente_id ?? null,
  hiloPrevio: construccion.hilo_previo ?? [],
  pedirNombre: construccion.pedir_nombre === true,
  esperaNombre: construccion.espera_nombre === true,
  nombreSecretaria: typeof construccion.nombre_secretaria === 'string' ? construccion.nombre_secretaria : null,
  // La memoria permanente con sus ids (para /memory y /forget) y el tope
  memoria: Array.isArray(construccion.memoria_filas) ? construccion.memoria_filas : [],
  // El horario fijo
  horario: Array.isArray(construccion.horario) ? construccion.horario : [],
  quitados: Array.isArray(construccion.quitados) ? construccion.quitados : [],
  // El aviso de alarma o cita al que responde el usuario (referencias cortas) y las alarmas ya sonadas que se pueden reabrir (ids reales)
  citados: Array.isArray(construccion.avisos_citados) ? construccion.avisos_citados : [],
  reabribles: Array.isArray(construccion.reabribles) ? construccion.reabribles : [],
  // Tipo y fechas de lo pendiente y de las alarmas ya sonadas, por referencia corta: de ahí salen las fechas al cambiar de tipo
  fechas: construccion.fechas && typeof construccion.fechas === 'object' ? construccion.fechas : {},
  // El pendiente más nuevo (referencia corta y cuándo se apuntó): para un «tarea» suelto que llega tarde (tipoSuelto)
  reciente: construccion.reciente && typeof construccion.reciente === 'object' ? construccion.reciente : null,
  // Referencias (a1…) de los archivos a los que se refiere este mensaje: su pie o la respuesta a su confirmación
  archivosCitados: Array.isArray(construccion.archivos_citados) ? construccion.archivos_citados.filter((r) => typeof r === 'string' && Object.prototype.hasOwnProperty.call(construccion.refs_archivos ?? {}, r)) : [],
  // El último lote de archivos sin sitio y las carpetas conocidas 
  loteReciente: Array.isArray(construccion.lote_reciente) ? construccion.lote_reciente.filter((r) => typeof r === 'string' && Object.prototype.hasOwnProperty.call(construccion.refs_archivos ?? {}, r)) : [],
  carpetasConocidas: Array.isArray(construccion.carpetas_conocidas) ? construccion.carpetas_conocidas.filter((c) => c && typeof c.ruta === 'string') : [],
  // Los últimos archivos que movió o guardó la secretaria («mueve esos archivos a X») y los archivos recientes por nombre 
  movidosRecientes: construccion.movidos_recientes && Array.isArray(construccion.movidos_recientes.ids)
    ? {
        ids: construccion.movidos_recientes.ids.filter((x) => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x)).slice(0, 50),
        // «Déjalo como estaba» 
        ultimo: construccion.movidos_recientes.ultimo === true,
        deshacer: Array.isArray(construccion.movidos_recientes.deshacer) ? construccion.movidos_recientes.deshacer.filter((d) => d && /^[0-9a-f-]{36}$/i.test(d.id ?? '') && typeof d.de === 'string' && typeof d.a === 'string') : [],
        vaciar: Array.isArray(construccion.movidos_recientes.vaciar) ? construccion.movidos_recientes.vaciar.filter((r) => typeof r === 'string') : [],
      }
    : null,
  archivosConocidos: Array.isArray(construccion.archivos_conocidos) ? construccion.archivos_conocidos.filter((a) => a && typeof a.id === 'string' && typeof a.nombre === 'string') : [],
};

// La agenda (eventos y tareas con fecha límite pendientes) llega con las referencias cortas; aquí se pasan a ids reales
const agenda = (construccion.agenda ?? []).filter((a) => Object.prototype.hasOwnProperty.call(refs, a.id)).map((a) => ({ ...a, id: refs[a.id] }));

// Referencias cortas de los archivos recibidos (a1, a2…) -> ids reales, con su nombre actual
const archivos = { refs: construccion.refs_archivos ?? {}, info: construccion.archivos_info ?? {} };

// Los proyectos que existen (todos, para reconocer uno cerrado; y los activos, que son los que vio el modelo)
const resumenProyectos = Array.isArray(construccion.proyectos) ? construccion.proyectos : [];
const configPlan = {
  ...config,
  proyectos: resumenProyectos.map((p) => p.nombre).filter((n) => typeof n === 'string'),
  proyectos_activos: resumenProyectos.filter((p) => p.estado === 'activo').map((p) => p.nombre).filter((n) => typeof n === 'string'),
};

// Los elementos pendientes que vio el modelo, con ids reales: para resolver "todas las tareas" y nombrar lo que se va a tocar
const pendientes = (construccion.pendientes ?? []).filter((r) => Object.prototype.hasOwnProperty.call(refs, r.id)).map((r) => ({ ...r, id: refs[r.id] }));

// Si "¿Hace falta el modelo?" se lo saltó (comando o frase fija), lo que llega es la salida de "Construir petición": no hay respuesta del modelo
const llegada = $input.first().json;
const resp = llegada?.saltar_modelo === true ? { error: 'no se llamó al modelo y el mensaje no es un comando' } : llegada;
const plan = planificar({ resp, mensajeId, config: configPlan, ahora: new Date(), refs, contexto, agenda, archivos, pendientes });
// Preguntas que el usuario ya había visto y ha dejado sin contestar al escribir otra cosa: se cierran (no se apunta nada de
// ellas) y Resultado se lo dice antes de la respuesta. Las decide «Construir petición».
const ignoradas = (Array.isArray(construccion.preguntas_ignoradas) ? construccion.preguntas_ignoradas : [])
  .filter((q) => q && typeof q.id === 'string' && /^[0-9a-f-]{36}$/i.test(q.id) && q.id !== construccion.pendiente_id);
// La propuesta aceptada queda contestada (las órdenes que se ejecutan por código no siempre cierran la pregunta anterior)
if (construccion.sugerencia_aceptada === true && typeof construccion.pendiente_id === 'string' && /^[0-9a-f-]{36}$/i.test(construccion.pendiente_id) && !plan.peticiones.some((p) => p.etiqueta === 'cerrar pregunta anterior')) {
  plan.peticiones.unshift({ etiqueta: 'cerrar pregunta anterior', metodo: 'PATCH', url: `${config.supabase_url.replace(/\/+$/, '')}/rest/v1/mensajes?id=eq.${construccion.pendiente_id}`, cuerpo: { pregunta_pendiente: false }, prefer: 'return=minimal' });
}
if (ignoradas.length > 0) {
  plan.peticiones.unshift({ etiqueta: 'cerrar preguntas sin contestar', metodo: 'PATCH', url: `${config.supabase_url.replace(/\/+$/, '')}/rest/v1/mensajes?id=in.(${ignoradas.map((q) => q.id).join(',')})`, cuerpo: { pregunta_pendiente: false }, prefer: 'return=minimal' });
  // Las ofertas de la charla se cierran sin decir nada (no era una pregunta que hubiera que contestar)
  plan.meta.preguntas_ignoradas = ignoradas.filter((q) => q.silenciosa !== true).map((q) => String(q.pregunta ?? ''));
}
return plan.peticiones.map((p) => ({ json: { ...p, meta: plan.meta } }));
