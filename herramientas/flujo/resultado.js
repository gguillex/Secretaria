// Nodo "Resultado": lo que se le diría al usuario y el estado de la ejecución.
// Más adelante, "mensajes" es lo que se envía por WhatsApp (un mensaje por elemento).
//
// - Si algo falla (ok = false), se responde con un mensaje honesto; nunca lo que dijo el modelo,
//   que podría prometer algo que no se ha hecho ("Voy a mirar…").
// - carpetas: el árbol de Secretaria/ en Drive se redacta aquí con código (ver arbolDeCarpetas).
// - consultar: la lista se redacta aquí con código (en la consulta general, con los archivos sin clasificar) (formato siempre idéntico y sin coste de modelo).
//   Solo se muestra lo pendiente; los eventos pasados se ocultan salvo que se pida un rango de fechas.

// === Textos que puedes cambiar a mano ===
// Título que sale encima del árbol
const TITULO_CARPETAS = '*Carpetas en Drive*';
// ========================================

const LIMITE_MENSAJE = 3800; // WhatsApp admite 4096 caracteres por mensaje; margen para no rozarlo
const MENSAJE_FALLO = 'No he podido procesar ese mensaje. Lo he guardado para revisarlo.';
// Cita el mensaje que falló para que el usuario sepa cuál fue: «compra leche y pan para…». Varias líneas son varios
// mensajes seguidos juntados: cada uno entre comillas (hasta 3). Sin texto, el mensaje genérico de siempre.
function citarMensajes(texto) {
  const lineas = String(texto ?? '').replace(/[*_~`]/g, '').split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (lineas.length === 0) return { cita: '', varios: false };
  const corto = (l) => `«${l.length > 50 ? `${l.slice(0, 50).trimEnd()}…` : l}»`;
  return { cita: lineas.slice(0, 3).map(corto).join(' + ') + (lineas.length > 3 ? ` y ${lineas.length - 3} más` : ''), varios: lineas.length > 1 };
}
const textoFallo = (texto) => {
  const { cita, varios } = citarMensajes(texto);
  return cita ? `No he podido procesar ${varios ? 'estos mensajes' : 'este mensaje'}: ${cita}. Lo he guardado para revisarlo.` : MENSAJE_FALLO;
};
const MAX_ERROR_GUARDADO = 1000; // tope de lo que se anota en mensajes.error
// Cuando el modelo devuelve algo que no encaja: no es un fallo del flujo, es que no ha entendido el mensaje
const TEXTO_NO_ENTENDIDO = 'No te he entendido, no he hecho nada. ¿Me lo dices de otra forma?';

const textoError = (e) => (typeof e === 'string' ? e : (e?.message ?? JSON.stringify(e)));

// Los caracteres de formato de WhatsApp en un título romperían la negrita o la cursiva
const limpiar = (s) => String(s ?? '').replace(/[*_~`]/g, '').replace(/\s+/g, ' ').trim();

const fmtDia = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', weekday: 'short', day: 'numeric', month: 'short' });
const fmtHora = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

const fmtClave = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' });
const claveDia = (iso) => fmtClave.format(new Date(iso));

function dia(iso) {
  const p = Object.fromEntries(fmtDia.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.day} ${p.month}`.replace(/\./g, '');
}
const hora = (iso) => fmtHora.format(new Date(iso));

// "Huevos, leche, café": en una lista de la compra, solo la primera en mayúscula (salvo siglas)
const minuscula1 = (s) => (s.length > 1 && s[0] === s[0].toUpperCase() && s[1] === s[1].toLowerCase() ? s[0].toLowerCase() + s.slice(1) : s);
const mayuscula1 = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

const porFecha = (campo) => (a, b) => {
  if (!a[campo] && !b[campo]) return 0;
  if (!a[campo]) return 1; // sin fecha, al final
  if (!b[campo]) return -1;
  return new Date(a[campo]) - new Date(b[campo]);
};

function agrupar(filas, clave) {
  const mapa = new Map();
  for (const f of filas) {
    const k = clave(f);
    if (!mapa.has(k)) mapa.set(k, []);
    mapa.get(k).push(f);
  }
  return mapa;
}

// Archivos recibidos y todavía sin clasificar, con su enlace de Drive. Solo se enseñan en la consulta general (sin filtros):
// es lo que responde a "¿tengo alguna foto pendiente?" al día siguiente.
const MAX_ARCHIVOS_LISTA = 15;
function bloqueArchivos(archivos) {
  if (!archivos.length) return null;
  const enlace = (f) => (typeof f.drive_url === 'string' && f.drive_url ? `\n  ${f.drive_url}` : '');
  const lineas = archivos.slice(0, MAX_ARCHIVOS_LISTA).map((f) => `• ${limpiar(f.nombre)}${enlace(f)}`);
  if (archivos.length > MAX_ARCHIVOS_LISTA) lineas.push(`… y ${archivos.length - MAX_ARCHIVOS_LISTA} más`);
  return `*Archivos sin clasificar*\n${lineas.join('\n')}`;
}

// Detalle de un elemento detrás del título: los listados llevan SOLO el título.
//   - Si el elemento tiene más contexto guardado (su contenido), el título acaba en « …» y se explica cómo pedirlo.
//   - Con «completo» (o «entero», o /pending completo) sale el contenido entero. Nunca sale lo que escribió el usuario palabra por palabra:
//     al juntar varias cosas en un mensaje salían bloques idénticos con el mensaje entero.
const DETALLE_LARGO = 1000;
const TEXTO_HAY_MAS = '(…) Di «completo» para ver todo.';
function detalle(r, largo, marcas) {
  const titulo = limpiar(r.titulo);
  const c = limpiar(r.contenido) === titulo ? '' : limpiar(r.contenido);
  if (!c) return '';
  if (largo === DETALLE_LARGO) return `: ${c.length > largo ? `${c.slice(0, largo)}…` : c}`;
  if (marcas) marcas.hay = true;
  return ' …';
}

// Devuelve la lista de bloques de texto (uno por sección)
function formatearLista(filas, consulta, ahora, archivos = []) {
  let rows = filas.filter((r) => r && typeof r.tipo === 'string' && typeof r.titulo === 'string');
  if (consulta.estado === 'pendiente' && !consulta.con_rango) {
    rows = rows.filter((r) => !(r.tipo === 'evento' && new Date(r.fecha_fin ?? r.fecha_inicio ?? '9999-12-31') < ahora));
  }
  // «Qué tareas tengo»: las alarmas (tareas con hora de aviso y sin fecha límite) tienen su propia lista y no se mezclan
  if (consulta.vista === 'tareas') rows = rows.filter((r) => !(r.tipo === 'tarea' && r.recordar_en && !r.fecha_limite));

  const hayFiltros = Boolean(consulta.tipo || consulta.vista || consulta.lista || consulta.proyecto || consulta.buscar || consulta.con_rango);
  const deArchivos = !hayFiltros && consulta.estado === 'pendiente' ? bloqueArchivos(archivos) : null;
  if (rows.length === 0) {
    if (deArchivos) return [deArchivos];
    // Sin filtros: nada pendiente. Solo un rango de fechas («qué tengo hoy»): nada en esas fechas. Con tipo o lista: nada con esos criterios.
    if (consulta.estado === 'pendiente' && !hayFiltros) return ['No tienes nada pendiente.'];
    if (consulta.estado === 'pendiente' && consulta.con_rango && !consulta.tipo && !consulta.lista && !consulta.proyecto && !consulta.buscar) {
      // Con el día dicho con palabras y avisando de que lo que no tiene fecha no sale
      const cuando = typeof consulta.rango_texto === 'string' && consulta.rango_texto ? consulta.rango_texto : 'en esas fechas';
      const frase = cuando.startsWith('hoy') || cuando.startsWith('mañana') ? `${cuando.charAt(0).toUpperCase()}${cuando.slice(1)} no tienes nada con fecha.` : `No tienes nada con fecha ${cuando}.`;
      return [`${frase} Lo que no tiene fecha sale con /pending.`];
    }
    // «Qué alarmas / citas / tareas / pensamientos / listas tengo» sin nada: se dice con la palabra que usó
    if (consulta.estado === 'pendiente' && !consulta.con_rango && !consulta.lista && !consulta.proyecto && !consulta.buscar) {
      if (consulta.vista === 'alarmas') return ['No tienes ninguna alarma pendiente.'];
      if (consulta.vista === 'tareas' || consulta.tipo === 'tarea') return ['No tienes tareas pendientes.'];
      if (consulta.tipo === 'evento') return ['No tienes ninguna cita pendiente.'];
      if (consulta.tipo === 'nota') return ['No tienes ningún pensamiento guardado.'];
      if (consulta.tipo === 'lista') return ['No tienes ninguna lista.'];
    }
    if (consulta.buscar) return [`No encuentro nada sobre «${limpiar(consulta.buscar)}».`];
    if (consulta.proyecto) return [`No tienes nada pendiente en el proyecto «${limpiar(consulta.proyecto)}».`];
    return ['No encuentro nada con esos criterios.'];
  }
  const largo = consulta.completo ? DETALLE_LARGO : 0;
  const marcas = { hay: false };
  // Las citas y alarmas de un proyecto siguen en su sección (importa la hora) con el proyecto entre corchetes
  const dePro = (r) => (r.proyecto ? ` [${limpiar(r.proyecto)}]` : '');

  // Alarma = tarea con hora de aviso y sin fecha límite (los recordatorios cortos): sección propia
  const esAlarma = (r) => r.tipo === 'tarea' && r.recordar_en && !r.fecha_limite;
  const alarmas = rows.filter(esAlarma).sort(porFecha('recordar_en'));
  const sinAlarmas = rows.filter((r) => !esAlarma(r));
  // Lo de los proyectos (tareas y notas) va aparte de lo cotidiano
  const deProyecto = sinAlarmas.filter((r) => r.proyecto && (r.tipo === 'tarea' || r.tipo === 'nota'));
  const cotidiano = sinAlarmas.filter((r) => !deProyecto.includes(r));
  const resto = cotidiano;
  const tareas = resto.filter((r) => r.tipo === 'tarea').sort(porFecha('fecha_limite'));
  const eventos = resto.filter((r) => r.tipo === 'evento').sort(porFecha('fecha_inicio'));
  const notas = resto.filter((r) => r.tipo === 'nota');
  const listas = resto.filter((r) => r.tipo === 'lista');

  const bloques = [];

  if (alarmas.length) {
    bloques.push(`*Alarmas*\n${alarmas.map((r) => `• 🔔 ${limpiar(r.titulo)}, ${dia(r.recordar_en)}, ${hora(r.recordar_en)}${dePro(r)}${detalle(r, largo, marcas)}`).join('\n')}`);
  }

  if (tareas.length) {
    bloques.push(`*Tareas*\n${tareas.map((r) => `• ${limpiar(r.titulo)}${r.fecha_limite ? ` (${dia(r.fecha_limite)})` : ''}${detalle(r, largo, marcas)}`).join('\n')}`);
  }

  if (deProyecto.length) {
    const grupos = agrupar(deProyecto, (r) => limpiar(r.proyecto));
    const partes = [...grupos.keys()].sort((a, b) => a.localeCompare(b, 'es')).map((nombre) => {
      const lista = grupos.get(nombre).slice().sort(porFecha('fecha_limite'));
      const lineas = lista.map((r) => `• ${r.tipo === 'nota' ? '📝 ' : ''}${limpiar(r.titulo)}${r.fecha_limite ? ` (${dia(r.fecha_limite)})` : ''}${detalle(r, largo, marcas)}`);
      return `📁 *${nombre}*\n${lineas.join('\n')}`;
    });
    bloques.push(`*Proyectos*\n${partes.join('\n')}`);
  }

  if (eventos.length) {
    const lineas = eventos.map((r) => {
      const cuando = r.fecha_inicio ? `, ${dia(r.fecha_inicio)}, ${hora(r.fecha_inicio)}` : '';
      return `• ${limpiar(r.titulo)}${cuando}${dePro(r)}${detalle(r, largo, marcas)}`;
    });
    bloques.push(`*Citas*\n${lineas.join('\n')}`);
  }

  if (notas.length) {
    bloques.push(`*Pensamientos*\n${notas.map((r) => `• ${limpiar(r.titulo)}${detalle(r, largo, marcas)}`).join('\n')}`);
  }

  if (listas.length) {
    const grupos = agrupar(listas, (r) => limpiar(r.lista) || 'sin nombre');
    for (const nombre of [...grupos.keys()].sort((a, b) => a.localeCompare(b, 'es'))) {
      const elementos = grupos.get(nombre).map((r) => limpiar(r.titulo));
      bloques.push(`*Lista de ${nombre}*${grupos.get(nombre).some((r) => r.proyecto) ? ` [${limpiar(grupos.get(nombre).find((r) => r.proyecto).proyecto)}]` : ''}\n• ${mayuscula1(elementos.map(minuscula1).join(', '))}`);
    }
  }

  if (deArchivos) bloques.push(deArchivos);
  if (marcas.hay) bloques.push(TEXTO_HAY_MAS);
  return bloques;
}

// --- Lista de carpetas (intención "carpetas") ---
// El árbol de Secretaria/ leído de Drive (tres niveles, un listado por nivel) con el número de archivos de cada carpeta,
// redactado con código. Se para con un error claro si un listado falla o si Drive devuelve más de una página: con el árbol
// incompleto se enseñaría una jerarquía falsa.
const NIVELES_ARBOL = 3;
const claveCarpeta = (s) => String(s).normalize('NFC').toLowerCase();

function arbolDeCarpetas({ niveles, raizId, filas }) {
  const hijos = new Map();
  for (let i = 0; i < NIVELES_ARBOL; i++) {
    const r = niveles[i];
    if (!r || !(r.statusCode >= 200 && r.statusCode < 300) || !Array.isArray(r.body?.files)) {
      return { error: `No se pudo leer el nivel ${i + 1} de carpetas de Drive (${r?.error ? textoError(r.error) : `HTTP ${r?.statusCode}`})` };
    }
    if (r.body.nextPageToken) return { error: `Drive devolvió más de una página de carpetas en el nivel ${i + 1}` };
    for (const f of r.body.files) {
      for (const p of Array.isArray(f.parents) ? f.parents : []) {
        if (!hijos.has(p)) hijos.set(p, []);
        hijos.get(p).push({ id: f.id, name: f.name });
      }
    }
  }
  // Archivos por carpeta: los movidos, por su carpeta_id; los pendientes (nunca movidos) están en Entrada
  const entrada = (hijos.get(raizId) || []).find((c) => claveCarpeta(c.name) === 'entrada');
  const cuenta = new Map();
  for (const f of filas) {
    if (!f || typeof f !== 'object') continue;
    const donde = typeof f.carpeta_id === 'string' && f.carpeta_id ? f.carpeta_id : f.estado === 'pendiente' ? entrada?.id : null;
    if (donde) cuenta.set(donde, (cuenta.get(donde) ?? 0) + 1);
  }
  const lineas = ['Secretaria'];
  const pintar = (padre, prefijo, nivel) => {
    const lista = (hijos.get(padre) || []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name), 'es') || String(a.id).localeCompare(String(b.id)));
    lista.forEach((c, i) => {
      const ultimo = i === lista.length - 1;
      const n = cuenta.get(c.id);
      lineas.push(`${prefijo}${ultimo ? '└─ ' : '├─ '}${limpiar(c.name)}${n ? ` (${n})` : ''}`);
      if (nivel < NIVELES_ARBOL) pintar(c.id, prefijo + (ultimo ? '   ' : '│  '), nivel + 1);
    });
  };
  pintar(raizId, '', 1);
  if (lineas.length === 1) return { texto: 'Todavía no hay carpetas dentro de Secretaria.' };
  return {
    texto: [TITULO_CARPETAS, `\`\`\`\n${lineas.join('\n')}\n\`\`\``].filter((t) => t !== '').join('\n'),
  };
}

// --- Borrar en Drive (intención "borrar_drive") ---
// Al pedirlo, «Revisar Drive» propone qué se mandaría a la papelera y aquí se enseña con la pregunta; con el «sí», «Revisar Drive» comprueba
// cada cosa otra vez, «Mandar a la papelera» la manda y aquí se cuenta lo que de verdad pasó (con lo que respondió Drive).
const MAX_LINEAS_DRIVE = 15;
const TEXTO_RECUPERAR = 'Se recupera de la papelera de Drive durante unos 30 días.';
function lineasConTope(lineas) {
  return lineas.length > MAX_LINEAS_DRIVE ? [...lineas.slice(0, MAX_LINEAS_DRIVE), `… y ${lineas.length - MAX_LINEAS_DRIVE} más`] : lineas;
}
// Devuelve { texto } para contestar sin más o { texto, papelera } con la pregunta de confirmación
function textoPropuestaDrive(p) {
  if (!p || typeof p !== 'object') return { texto: 'No he podido revisar tus carpetas de Drive.', error: 'Revisar Drive no devolvió la propuesta', fallo: true };
  if (p.ambiguas) return { texto: `Hay varias carpetas con ese nombre:\n${p.ambiguas.map((r) => `• ${limpiar(r)}`).join('\n')}\n¿Cuál?` };
  if (p.no_encontrada) return { texto: `No encuentro la carpeta «${limpiar(p.no_encontrada)}» en Drive.` };
  if (p.protegida) return { texto: `No borro «${limpiar(p.protegida)}»: la uso yo para ordenar tus cosas. Dime una subcarpeta o «borra los archivos de ${limpiar(p.protegida)}».` };
  if (p.demasiados) return { texto: `Son ${p.demasiados} archivos sueltos y borro 50 como mucho. Borra la carpeta entera o hazlo desde Drive.` };
  if (p.vacia) return { texto: `No tengo archivos registrados en «${limpiar(p.vacia)}».` };
  const objetivos = Array.isArray(p.objetivos) ? p.objetivos : [];
  if (objetivos.length === 0) return { texto: 'No encuentro esos archivos.' };
  const lineas = [];
  for (const o of objetivos) {
    if (o.tipo === 'carpeta') {
      lineas.push(`📁 ${limpiar(o.nombre)} (la carpeta entera)`);
      for (const r of o.subcarpetas ?? []) lineas.push(`   📁 ${limpiar(r)}`);
      for (const r of o.archivos ?? []) lineas.push(`   • ${limpiar(r)}`);
    } else lineas.push(`• ${limpiar(o.nombre)}`);
  }
  const conCarpeta = objetivos.some((o) => o.tipo === 'carpeta');
  const texto = [
    'Voy a mandar a la papelera de Drive:',
    ...lineasConTope(lineas),
    conCarpeta ? 'Se va con todo lo que tenga dentro, también lo que subiste a mano.' : '',
    TEXTO_RECUPERAR,
    objetivos.length === 1 && !conCarpeta ? '¿Lo mando a la papelera?' : '¿Lo mando todo a la papelera?',
  ].filter(Boolean).join('\n');
  return { texto, papelera: objetivos.map((o) => ({ tipo: o.tipo, id: o.id, nombre: o.nombre })) };
}
function motivoDrive(r) {
  if (!r) return 'no hubo respuesta de Drive';
  if (r.error) return `error de Drive (${textoError(r.error)})`;
  if (r.statusCode === 404) return 'ya no existe en Drive';
  if (r.statusCode === 403) return 'Drive no me deja (sin permiso)';
  return `error de Drive (HTTP ${r.statusCode})`;
}
// Mover carpetas dentro de otra . plan: lo que decidió «Revisar Drive» (mover_plan); creado: la salida de «Crear en Drive» (null si no hacía falta);
// preparados, movidos y anotados: las salidas de «Preparar movimientos» (las que llevan mover), «Mover en Drive» y «Anotar movimiento», en el mismo orden.
// Los rechazos no tocan nada y se dicen con una frase cada uno; los fallos de Drive o de la base de datos avisan.
function textoMover({ plan, creado, preparados, movidos, anotados }) {
  const r = plan ?? {};
  const lista = (rutas) => (rutas ?? []).map((x) => `• ${limpiar(x)}`).join('\n');
  const frase = (e) => {
    switch (e.error) {
      case 'arbol':
        return 'No he podido leer tus carpetas de Drive y no he movido nada. Inténtalo en un rato.';
      case 'origen_no_encontrado':
      case 'destino_no_encontrado':
        return `No encuentro la carpeta «${limpiar(e.nombre)}» en Drive.`;
      case 'origen_ambiguo':
      case 'destino_ambiguo':
        return `Hay varias carpetas con ese nombre:\n${lista(e.rutas)}\nDime la ruta completa.`;
      case 'protegida':
        return `No muevo «${limpiar(e.ruta)}»: la uso yo para ordenar tus cosas.`;
      case 'dentro_de_si':
        return `No puedo meter «${limpiar(e.ruta)}» dentro de sí misma.`;
      case 'anidada':
        return `«${limpiar(e.ruta)}» ya va dentro de otra de las que mueves.`;
      case 'ya_esta':
        return `«${limpiar(e.origen)}» ya está dentro de «${limpiar(e.destino)}».`;
      case 'choque':
        return `Ya hay una carpeta «${limpiar(e.nombre)}» dentro de «${limpiar(e.destino)}». ¿Paso los archivos de «${limpiar(e.ruta ?? e.nombre)}» a «${limpiar(e.destino)}/${limpiar(e.nombre)}»?`;
      case 'parecida':
        return `Dentro de «${limpiar(e.destino)}» ya está «${limpiar(e.parecida)}», que se parece a «${limpiar(e.nombre)}». ¿Paso los archivos de «${limpiar(e.ruta ?? e.nombre)}» a «${limpiar(e.parecida)}»?`;
      case 'profundidad':
        return `Así quedaría en «${limpiar(e.ruta)}», a más de 3 niveles. Prueba con otro destino.`;
      default:
        return 'No he podido mover esa carpeta.';
    }
  };
  const fallo = (texto, error) => ({ texto, error, fallo: true });
  if (r.error_global) {
    const e = r.error_global;
    if (e.error === 'arbol') return fallo(frase(e), e.detalle);
    if (!['pedido', 'destino_ambiguo', 'destino_no_encontrado', 'profundidad'].includes(e.error)) return fallo(frase(e), `mover_carpeta: ${JSON.stringify(e).slice(0, 200)}`);
    return e.error === 'pedido' ? fallo(frase(e), 'mover_carpeta: pedido sin origen o destino') : { texto: frase(e) };
  }
  const rechazos = (r.rechazos ?? []).map(frase);
  // Con UNA sola carpeta igual o parecida en el destino (y nada más), la propuesta de juntarlas queda abierta: «sí» la hace 
  const juntables = (r.rechazos ?? []).filter((e) => e.error === 'choque' || e.error === 'parecida');
  const sugerencia = juntables.length === 1 && (r.rechazos ?? []).length === 1
    ? `mueve los archivos de ${juntables[0].ruta ?? juntables[0].nombre} a ${juntables[0].error === 'choque' ? `${juntables[0].destino}/${juntables[0].nombre}` : juntables[0].parecida}`
    : null;
  const previstos = (preparados ?? []).filter((x) => x && x.mover);
  if (previstos.length === 0) {
    if (r.crear && !(creado && !creado.error && creado.statusCode >= 200 && creado.statusCode < 300)) {
      return fallo(`Drive no me ha dejado crear la carpeta «${limpiar(r.crear.nombre)}» (${motivoDrive(creado)}). No he movido nada.`, `Crear en Drive: ${motivoDrive(creado)}`);
    }
    return rechazos.length ? { texto: rechazos.join('\n'), ...(sugerencia ? { sugerencia } : {}) } : fallo('No he podido mover esa carpeta.', 'Revisar Drive no devolvió movimientos ni rechazos');
  }
  const hechos = [];
  const fallos = [];
  const sinAnotar = [];
  previstos.forEach((p, i) => {
    const m = p.mover;
    const mv = (movidos ?? [])[i];
    if (!(mv && !mv.error && mv.statusCode >= 200 && mv.statusCode < 300)) {
      fallos.push(`«${limpiar(m.nombre)}» (${motivoDrive(mv)})`);
      return;
    }
    hechos.push(m);
    const an = (anotados ?? [])[i];
    if (!an || an.error) sinAnotar.push(an?.error ? textoError(an.error) : 'sin respuesta');
  });
  const partes = [];
  if (hechos.length === 1) {
    partes.push(`Hecho: «${limpiar(hechos[0].ruta_origen)}» está ahora en «${limpiar(hechos[0].ruta_destino)}».`);
  } else if (hechos.length > 1) {
    const destino = limpiar(r.crear ? r.crear.ruta : hechos[0].ruta_destino.split('/').slice(0, -1).join('/'));
    partes.push(`${r.crear ? `He creado «${destino}» y he metido` : `He metido en «${destino}»`}:\n${hechos.map((h) => `• ${limpiar(h.nombre)}`).join('\n')}`);
  }
  if (hechos.length === 1 && r.crear) partes[0] = `He creado «${limpiar(r.crear.ruta)}» y he metido dentro «${limpiar(hechos[0].nombre)}».`;
  if (fallos.length) partes.push(`Drive no me ha dejado mover ${fallos.join(', ')}.`);
  partes.push(...rechazos);
  const omitidos = (anotados ?? []).reduce((n, a) => n + (Number(a && a.omitidos) || 0), 0);
  if (omitidos > 0) partes.push(`${omitidos} ruta${omitidos === 1 ? '' : 's'} no encajaba${omitidos === 1 ? '' : 'n'} y se ha${omitidos === 1 ? '' : 'n'} dejado como estaba${omitidos === 1 ? '' : 'n'}.`);
  if (sinAnotar.length) partes.push(`No he podido anotarlo en la base de datos (Vigilar Drive lo avisará como movido a mano): ${sinAnotar[0]}`);
  const error = fallos.length ? `Mover en Drive: ${fallos.join(', ')}` : sinAnotar.length ? `Anotar movimiento: ${sinAnotar[0]}` : '';
  return error ? { texto: partes.join('\n'), error, fallo: true } : { texto: partes.join('\n') };
}
// revisados: la salida de «Revisar Drive»; mandados: la de «Mandar a la papelera» (mismo orden); marcado: la de «Marcar borrado»
function textoPapelera({ revisados, mandados, marcado }) {
  const primero = revisados[0] ?? {};
  if (primero.error) return { texto: 'No he podido leer tus carpetas de Drive y no he borrado nada. Inténtalo en un rato.', error: primero.error, fallo: true };
  const hechos = [];
  const fallidos = [];
  let fallo = false; // un 403 o un 404 son una respuesta de Drive; sin respuesta o un 5xx, un fallo del flujo
  revisados.forEach((it, i) => {
    if (!it.papelera) return;
    const r = mandados[i];
    const nombre = `${it.papelera.tipo === 'carpeta' ? '📁 ' : ''}${limpiar(it.papelera.nombre)}`;
    if (r && r.statusCode >= 200 && r.statusCode < 300 && !r.error) hechos.push(nombre);
    else {
      fallidos.push(`• ${nombre}: ${motivoDrive(r)}`);
      if (!r || r.error || !(r.statusCode >= 400 && r.statusCode < 500)) fallo = true;
    }
  });
  const rechazados = (Array.isArray(primero.rechazados) ? primero.rechazados : []).map((x) => `• ${limpiar(x.nombre)}: ${limpiar(x.motivo)}`);
  const no = [...fallidos, ...rechazados];
  const bloques = [];
  if (hechos.length > 0) bloques.push(['🗑️ En la papelera de Drive:', ...lineasConTope(hechos.map((h) => `• ${h}`)), TEXTO_RECUPERAR].join('\n'));
  if (no.length > 0) bloques.push([hechos.length > 0 ? 'Esto no he podido mandarlo:' : 'No he borrado nada:', ...lineasConTope(no)].join('\n'));
  if (bloques.length === 0) bloques.push('No había nada que borrar.');
  let error = null;
  if (fallidos.length > 0) error = `No se pudo mandar a la papelera: ${fallidos.join(' | ')}`;
  else if (hechos.length > 0 && (!marcado || marcado.error)) {
    error = `Mandado a la papelera, pero no se pudo anotar en la base de datos (Vigilar Drive lo avisará como borrado a mano): ${marcado?.error ? textoError(marcado.error) : 'sin respuesta'}`;
    fallo = true;
  }
  return { texto: bloques.join('\n\n'), error, fallo };
}

// --- Ver los archivos (intención "ver_archivos") ---
// Todos los archivos, de cualquier estado, agrupados por la carpeta donde están, con su enlace de Drive. Los filtros (carpeta,
// tipo, solo pendientes) se aplican aquí, sin patrones de búsqueda con datos del modelo. La carpeta de un archivo es la que pidió
// el usuario ("guárdala en…"); si no, Notas si cuelga de un elemento (como en el flujo de Drive); y si no, Entrada.
const MAX_ARCHIVOS_VER = 40;
const sinTildes = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

function rutaDeArchivo(f) {
  if (typeof f.carpeta_destino === 'string' && f.carpeta_destino !== '') return f.carpeta_destino;
  if (f.items && typeof f.items === 'object') return 'Notas';
  return 'Entrada';
}

// Los archivos que cumplen el filtro, con su carpeta (ruta), en el orden en que llegan (los más recientes primero)
function filtrarArchivos(filas, filtro) {
  const f0 = filtro && typeof filtro === 'object' ? filtro : {};
  const objetivo = f0.carpeta ? sinTildes(f0.carpeta) : null;
  const archivos = filas
    .filter((f) => f && typeof f.nombre === 'string')
    .map((f) => ({ ...f, ruta: rutaDeArchivo(f) }))
    .filter((f) => {
      if (objetivo && !(sinTildes(f.ruta) === objetivo || sinTildes(f.ruta).startsWith(`${objetivo}/`))) return false;
      if (f0.tipo === 'imagen' && !String(f.tipo_mime ?? '').startsWith('image/')) return false;
      if (f0.tipo === 'documento' && String(f.tipo_mime ?? '').startsWith('image/')) return false;
      if (f0.solo_pendientes && f.estado !== 'pendiente') return false;
      return true;
    });
  return { archivos, hayFiltro: Boolean(objetivo || f0.tipo || f0.solo_pendientes) };
}

const TEXTO_SIN_ARCHIVOS = (hayFiltro) =>
  hayFiltro ? 'No tengo archivos con esos criterios.' : 'Todavía no has guardado ningún archivo.';

// --- Mandar los archivos por WhatsApp (ver_archivos con enviar: true) ---
// Se mandan como máximo MAX_ARCHIVOS_ENVIO (20), los más recientes que encajen, agrupados por carpeta. Aquí solo se decide CUÁLES y qué decir: el flujo de WhatsApp
// los baja de Drive y los sube a Meta (comprobando tipo y tamaño de cada uno; si no se pueden mandar, manda el enlace).
const MAX_ARCHIVOS_ENVIO = 20;
const ID_DRIVE = /^[A-Za-z0-9_-]{10,100}$/;

function archivosParaEnviar(filas, filtro) {
  const { archivos, hayFiltro } = filtrarArchivos(filas, filtro);
  // Sin id de Drive válido no se puede bajar el archivo: no cuenta (el id se valida otra vez al mandarlo)
  const enviables = archivos.filter((f) => typeof f.drive_file_id === 'string' && ID_DRIVE.test(f.drive_file_id));
  if (enviables.length === 0) {
    return { mensajes: [TEXTO_SIN_ARCHIVOS(hayFiltro)], envios: [] };
  }
  // Si hay más que el tope, se cogen los más recientes y DESPUÉS se agrupan por carpeta (mismo orden que en las listas): el flujo de
  // WhatsApp escribe el nombre de cada carpeta, en negrita, antes de sus archivos.
  const recientes = enviables.slice(0, MAX_ARCHIVOS_ENVIO);
  const rutas = [...new Set(recientes.map((f) => f.ruta))].sort((a, b) => a.localeCompare(b, 'es'));
  const elegidos = rutas.flatMap((ruta) => recientes.filter((f) => f.ruta === ruta));
  const de = rutas.length > 1 ? ` de ${rutas.length} carpetas` : '';
  const intro =
    enviables.length > elegidos.length
      ? `Hay ${enviables.length} archivos. Te mando los ${elegidos.length} más recientes${de}:`
      : elegidos.length === 1
        ? 'Aquí tienes el archivo:'
        : `Te mando ${elegidos.length} archivos${de}:`;
  return {
    mensajes: [intro],
    envios: elegidos.map((f) => ({ drive_file_id: f.drive_file_id, nombre: f.nombre, tipo_mime: typeof f.tipo_mime === 'string' ? f.tipo_mime : '', ruta: f.ruta })),
  };
}

function formatearArchivos(filas, filtro) {
  const f0 = filtro && typeof filtro === 'object' ? filtro : {};
  const { archivos, hayFiltro } = filtrarArchivos(filas, f0);
  if (archivos.length === 0) return [TEXTO_SIN_ARCHIVOS(hayFiltro)];
  const mostrados = archivos.slice(0, MAX_ARCHIVOS_VER);
  const grupos = new Map();
  for (const f of mostrados) {
    if (!grupos.has(f.ruta)) grupos.set(f.ruta, []);
    grupos.get(f.ruta).push(f);
  }
  const rutas = [...grupos.keys()].sort((a, b) => a.localeCompare(b, 'es'));
  const bloques = rutas.map((ruta) => {
    const lista = grupos.get(ruta);
    const lineas = lista.map((f) => {
      const enlace = typeof f.drive_url === 'string' && f.drive_url ? `\n  ${f.drive_url}` : '';
      return `• ${limpiar(f.nombre)}${enlace}`;
    });
    return `*${limpiar(ruta)}* (${lista.length})\n${lineas.join('\n')}`;
  });
  if (archivos.length > MAX_ARCHIVOS_VER) {
    bloques.push(`… y ${archivos.length - MAX_ARCHIVOS_VER} más.`);
  }
  return bloques;
}

// Confirmación de lo que se acaba de guardar, redactada con las filas que devolvió la base de datos : corta y siempre igual, sin
// depender de lo que diga el modelo. Las citas y las alarmas ya las dicen `Horario:` y `🔔`, así que aquí solo van el resto. Devuelve null si
// las filas no traen título (otros caminos, p. ej. guardar con archivos): entonces se conserva la frase del modelo.
const esFilaAlarma = (r) => r.tipo === 'tarea' && Boolean(r.recordar_en) && !r.fecha_limite;
function textoGuardado(filas) {
  const con = (Array.isArray(filas) ? filas : []).filter((r) => r && typeof r.titulo === 'string' && typeof r.tipo === 'string');
  if (con.length === 0) return null;
  const lineas = [];
  const listas = new Map();
  for (const r of con) {
    if (r.tipo === 'evento' || esFilaAlarma(r)) continue;
    if (r.tipo === 'lista') {
      const nombre = r.lista || 'compra';
      listas.set(nombre, [...(listas.get(nombre) ?? []), limpiar(r.titulo)]);
    } else if (r.tipo === 'nota') lineas.push(`📝 ${limpiar(r.titulo)}`);
    else lineas.push(`✅ ${limpiar(r.titulo)}${r.fecha_limite ? ` (para ${dia(r.fecha_limite)})` : ''}`);
  }
  for (const [nombre, titulos] of listas) lineas.push(`🛒 ${nombre.toLowerCase() === 'compra' ? 'Lista de la compra' : `Lista «${limpiar(nombre)}»`}: ${titulos.join(', ')}.`);
  return lineas.join('\n');
}

// Horario de los eventos que se acaban de guardar. La duración por defecto (una hora) ya se da por conocida: no se avisa.
function textoHorario(eventos) {
  if (!Array.isArray(eventos) || eventos.length === 0) return '';
  const partes = eventos.map((e) => `${limpiar(e.titulo)}, ${dia(e.inicio)}, de ${hora(e.inicio)} a ${hora(e.fin)}`);
  return `Horario: ${partes.join('; ')}.`;
}

// Recordatorios cortos recién guardados (tareas con hora de aviso). Se dice cuándo se avisará y con qué antelación: el sistema avisa 1 hora
// antes, 30 minutos antes y a la hora (los mismos tiempos que la configuración del flujo «Recordatorios»); los que ya no tienen sentido
// (la hora de aviso ya pasó) no se prometen. Una hora que ya había pasado se dice aparte.
const AVISOS_RECORDATORIO_MIN = [60, 30, 0];
const TEXTO_ANTELACION = { 60: '1 hora antes', 30: '30 minutos antes', 0: 'a la hora' };
function textoRecordatorios(recordatorios, pasados, ahora) {
  const lineas = [];
  const hoyClave = claveDia(ahora.toISOString());
  // «Mañana» por calendario, no sumando 24 h: el domingo del cambio de hora (25 de octubre) dura 25 horas y el de marzo, 23
  const [yH, mH, dH] = hoyClave.split('-').map(Number);
  const mananaClave = new Date(Date.UTC(yH, mH - 1, dH + 1)).toISOString().slice(0, 10);
  for (const r of Array.isArray(recordatorios) ? recordatorios : []) {
    const inicio = Date.parse(r.recordar_en);
    if (Number.isNaN(inicio)) continue;
    const cuando = claveDia(r.recordar_en) === hoyClave ? 'hoy' : claveDia(r.recordar_en) === mananaClave ? 'mañana' : dia(r.recordar_en);
    lineas.push(`🔔 ${limpiar(r.titulo)}: ${cuando} a las ${hora(r.recordar_en)}.`);
  }
  for (const t of Array.isArray(pasados) ? pasados : []) lineas.push(`⚠️ La hora de «${limpiar(t)}» ya ha pasado: lo he guardado como tarea, sin aviso.`);
  return lineas.join('\n');
}

// Alarmas y citas a las que se acaba de cambiar la hora (corregir, también al aplazar respondiendo a un aviso). Se redacta con lo que
// devolvió la base de datos (la hora de verdad guardada), no con lo que diga el modelo. Una alarma dice qué avisos quedan por llegar.
function textoHoraMovida(filas, ahora) {
  const lineas = [];
  for (const r of Array.isArray(filas) ? filas : []) {
    if (r.tipo === 'tarea' && typeof r.recordar_en === 'string' && !Number.isNaN(Date.parse(r.recordar_en))) {
      lineas.push(`Alarma cambiada.\n${textoRecordatorios([{ titulo: r.titulo, recordar_en: r.recordar_en }], [], ahora)}`);
    } else if (r.tipo === 'evento' && typeof r.fecha_inicio === 'string' && !Number.isNaN(Date.parse(r.fecha_inicio))) {
      const fin = typeof r.fecha_fin === 'string' && !Number.isNaN(Date.parse(r.fecha_fin)) ? ` a ${hora(r.fecha_fin)}` : '';
      lineas.push(`📅 Cita «${limpiar(r.titulo)}» cambiada: ${dia(r.fecha_inicio)}, ${fin ? 'de' : 'a las'} ${hora(r.fecha_inicio)}${fin}.`);
    }
  }
  return lineas.join('\n');
}

// Cambio de tipo (alarma, cita o tarea): se confirma con lo que devolvió la base de datos y solo si de verdad quedó así. Si una fila no tiene
// la forma que se pidió, se dice (antes la confirmación era la frase del modelo y a veces decía «hecho» sin haber cambiado nada).
const ARTICULO_TIPO = { alarma: 'una alarma', cita: 'una cita', tarea: 'una tarea' };
// Un dato duradero que se guardó en la memoria junto a otra cosa: se dice, con lo que de verdad se guarda
function textoRecuerdo(meta) {
  const m = meta.memoria_nueva;
  if (!m || typeof m.termino !== 'string' || typeof m.significado !== 'string') return '';
  if (typeof meta.nombre_usuario === 'string') return `A partir de ahora te llamaré ${limpiar(meta.nombre_usuario)}.`;
  return `📌 Lo recordaré: ${limpiar(m.termino)}: ${limpiar(m.significado)}.`;
}
const textoLlena = (meta) =>
  typeof meta.memoria_llena === 'string' ? `Tengo la memoria llena (50 datos) y no he guardado «${limpiar(meta.memoria_llena)}». Olvida alguno con /forget.` : '';

function textoConversion(a, filas, ahora) {
  const lineas = [];
  const fallidas = [];
  for (const r of Array.isArray(filas) ? filas : []) {
    const titulo = limpiar(r.titulo);
    const pendiente = r.estado === undefined || r.estado === 'pendiente';
    if (a === 'alarma' && r.tipo === 'tarea' && r.recordar_en && !r.fecha_limite && pendiente) {
      lineas.push(`Hecho: «${titulo}» ahora es ${ARTICULO_TIPO[a]}.\n${textoRecordatorios([{ titulo: r.titulo, recordar_en: r.recordar_en }], [], ahora)}`);
    } else if (a === 'cita' && r.tipo === 'evento' && r.fecha_inicio && pendiente) {
      const fin = typeof r.fecha_fin === 'string' && !Number.isNaN(Date.parse(r.fecha_fin)) ? ` a ${hora(r.fecha_fin)}` : '';
      lineas.push(`📅 «${titulo}» ahora es ${ARTICULO_TIPO[a]}: ${dia(r.fecha_inicio)}, ${fin ? 'de' : 'a las'} ${hora(r.fecha_inicio)}${fin}.`);
    } else if (a === 'tarea' && r.tipo === 'tarea' && !r.recordar_en && pendiente) {
      lineas.push(`✅ «${titulo}» ahora es ${ARTICULO_TIPO[a]}${r.fecha_limite ? ` (para ${dia(r.fecha_limite)})` : ''}.`);
    } else fallidas.push(titulo);
  }
  return { texto: lineas.join('\n'), fallidas };
}

// Confirmación de las carpetas pedidas sin archivos ("crea la carpeta Proyectos dentro de Trabajo"). Las crea el flujo "Sincronizar
// Drive", un nivel por minuto: se dice que tardan un poco para que el usuario no la busque al instante.
function textoCarpetasPedidas(rutas) {
  const nombres = rutas.map((r) => `«${limpiar(r)}»`);
  return rutas.length === 1
    ? `Carpeta ${nombres[0]} pedida.`
    : `Carpetas pedidas: ${nombres.join(', ')}.`;
}

// Lista de proyectos ("¿qué proyectos tengo?", /projects): los activos con lo pendiente de cada uno y, aparte, los cerrados. Con código.
function textoProyectos(proyectos) {
  const lista = (Array.isArray(proyectos) ? proyectos : []).filter((p) => p && typeof p.nombre === 'string' && limpiar(p.nombre) !== '');
  const activos = lista.filter((p) => p.estado === 'activo');
  const cerrados = lista.filter((p) => p.estado !== 'activo');
  if (activos.length === 0 && cerrados.length === 0) {
    return 'Todavía no tienes proyectos.';
  }
  const pend = (n) => (n === 1 ? '1 pendiente' : n > 0 ? `${n} pendientes` : 'nada pendiente');
  const partes = [];
  if (activos.length) partes.push(`*Proyectos*\n${activos.map((p) => `📁 ${limpiar(p.nombre)} (${pend(p.pendientes)})`).join('\n')}`);
  else partes.push('No tienes proyectos activos.');
  if (cerrados.length) partes.push(`Cerrados: ${cerrados.map((p) => limpiar(p.nombre)).join(', ')}.`);
  return partes.join('\n\n');
}

// Confirmación de cancelar o completar, con los títulos de lo que de verdad se ha cambiado (no lo que dijo el modelo)
const MAX_TITULOS_CONFIRMACION = 10;
function textoSeleccion(intencion, filas) {
  const titulos = filas.map((f) => limpiar(f.titulo)).filter(Boolean);
  const verbo = intencion === 'cancelar' ? (titulos.length === 1 ? 'Quitado' : 'Quitados') : titulos.length === 1 ? 'Marcado como hecho' : 'Marcados como hechos';
  const visibles = titulos.slice(0, MAX_TITULOS_CONFIRMACION).map((t) => `«${t}»`);
  const mas = titulos.length > MAX_TITULOS_CONFIRMACION ? ` y ${titulos.length - MAX_TITULOS_CONFIRMACION} más` : '';
  return titulos.length > 3 ? `${verbo} ${titulos.length} elementos: ${visibles.join(', ')}${mas}.` : `${verbo}: ${visibles.join(', ')}.`;
}

// Confirmación de «deshaz»: con los títulos de lo que de verdad se ha recuperado
function textoRecuperado(filas) {
  const titulos = filas.map((f) => limpiar(f.titulo)).filter(Boolean);
  const visibles = titulos.slice(0, MAX_TITULOS_CONFIRMACION).map((t) => `«${t}»`);
  const mas = titulos.length > MAX_TITULOS_CONFIRMACION ? ` y ${titulos.length - MAX_TITULOS_CONFIRMACION} más` : '';
  return titulos.length > 3 ? `Recuperados ${titulos.length} elementos: ${visibles.join(', ')}${mas}.` : `${titulos.length === 1 ? 'Recuperado' : 'Recuperados'}: ${visibles.join(', ')}.`;
}

// Une los bloques en mensajes que no pasen del límite; un bloque enorme se parte por líneas
function partir(bloques, limite = LIMITE_MENSAJE) {
  const mensajes = [];
  let actual = '';
  const anadir = (texto) => {
    if (!actual) actual = texto;
    else if (`${actual}\n\n${texto}`.length <= limite) actual += `\n\n${texto}`;
    else {
      mensajes.push(actual);
      actual = texto;
    }
  };
  for (const b of bloques) {
    if (b.length <= limite) {
      anadir(b);
      continue;
    }
    let parte = '';
    for (const linea of b.split('\n')) {
      if (parte && `${parte}\n${linea}`.length > limite) {
        anadir(parte);
        parte = linea;
      } else parte = parte ? `${parte}\n${linea}` : linea;
    }
    if (parte) anadir(parte);
  }
  if (actual) mensajes.push(actual);
  return mensajes;
}

function resolver({ meta, escrituras, lecturas, ahora, niveles = [], raizId = '', archivosPendientes = [], proyectos = [], mensaje = '', drive = {}, etiquetas = [] }) {
  const MENSAJE_FALLO = textoFallo(mensaje); // sombrea al de arriba: dice qué mensaje falló
  // Pedir que se vacíe una carpeta es un extra (base de datos 1.5): si falla (por ejemplo, sin actualizar la base de datos a la 1.5), lo demás sigue bien y no se avisa de un fallo
  // (también anular un vaciado al deshacer un movimiento)
  const esExtra = (i) => typeof etiquetas[i] === 'string' && etiquetas[i].startsWith('pedir vaciar ');
  const erroresEscritura = escrituras.map((e, i) => (esExtra(i) ? null : e?.error)).filter(Boolean).map(textoError);
  const filasEscritas = escrituras.filter((e) => e && typeof e.id === 'string');
  const avisos = [...(meta.avisos ?? [])];
  let error = meta.error ?? null;
  // fallo_flujo: solo lo que de verdad ha fallado (el modelo no respondió, Supabase o Drive dieron error). Es lo que hace saltar el aviso de
  // fallos en el flujo de WhatsApp. «No te he entendido» o «no he encontrado nada que cambiar» se anotan (error) pero no son un fallo.
  let falloFlujo = false;
  let mensajes;
  let envios = []; // archivos que el flujo de WhatsApp debe mandar después del texto (ver_archivos con enviar)
  let preguntaDrive = null; // la confirmación de borrar en Drive: se guarda como pregunta abierta (anotacion)

  if (!meta.ok) {
    if (meta.no_entendido) mensajes = [TEXTO_NO_ENTENDIDO];
    else {
      falloFlujo = true;
      mensajes = [MENSAJE_FALLO];
    }
  } else if (erroresEscritura.length) {
    error = erroresEscritura[0];
    falloFlujo = true;
    mensajes = [MENSAJE_FALLO];
  } else if (Array.isArray(meta.mensajes_fijos) && meta.mensajes_fijos.length > 0) {
    // Ayuda y comandos (/help, /manual…): textos fijos, cada uno ya cabe en un mensaje de WhatsApp
    mensajes = meta.mensajes_fijos;
  } else if (meta.intencion === 'consultar') {
    const erroresLectura = lecturas.map((e) => e?.error).filter(Boolean).map(textoError);
    if (erroresLectura.length) {
      error = `Error al leer la consulta: ${erroresLectura[0]}`;
      falloFlujo = true;
      mensajes = [MENSAJE_FALLO];
    } else {
      const filas = lecturas.filter((r) => r && typeof r.tipo === 'string');
      mensajes = partir(formatearLista(filas, meta.consulta, ahora, archivosPendientes));
      if (filas.length >= meta.consulta.limite) {
        avisos.push(`Se muestran solo los ${meta.consulta.limite} items más recientes`);
        mensajes[mensajes.length - 1] += `\n\n(Solo los ${meta.consulta.limite} más recientes)`;
      }
    }
  } else if (meta.intencion === 'carpetas') {
    // "Contar archivos" puede fallar sin que importe: sin recuentos, el árbol se enseña igual
    const arbol = arbolDeCarpetas({ niveles, raizId, filas: lecturas.filter((r) => r && !r.error) });
    if (arbol.error) {
      error = arbol.error;
      falloFlujo = true;
      mensajes = ['No he podido leer tus carpetas de Drive.'];
    } else {
      mensajes = partir([arbol.texto]);
    }
  } else if (meta.intencion === 'borrar_drive' && Array.isArray(meta.papelera)) {
    const r = textoPapelera({ revisados: drive.revisados ?? [], mandados: drive.mandados ?? [], marcado: drive.marcado ?? null });
    mensajes = [r.texto];
    if (r.error) error = r.error;
    if (r.fallo) falloFlujo = true;
  } else if (meta.intencion === 'borrar_drive' && meta.borrar_drive) {
    const revisado = (drive.revisados ?? [])[0] ?? {};
    const r = revisado.error ? { texto: 'No he podido leer tus carpetas de Drive.', error: revisado.error, fallo: true } : textoPropuestaDrive(revisado.propuesta);
    mensajes = [r.texto];
    if (r.error) error = r.error;
    if (r.fallo) falloFlujo = true;
    if (r.papelera) {
      preguntaDrive = {
        pregunta: r.texto,
        pregunta_pendiente: true,
        hilo: [
          { rol: 'user', texto: mensaje || '(borrar en Drive)' },
          { rol: 'model', texto: JSON.stringify({ intencion: 'aclarar', motivo: 'confirmar_drive', origen: 'codigo', papelera: r.papelera, pregunta: r.texto }) },
        ],
      };
    }
  } else if (meta.intencion === 'mover_carpeta' && meta.mover_carpeta) {
    const r = textoMover({ plan: (drive.revisados ?? [])[0]?.mover_plan, creado: drive.creado ?? null, preparados: drive.preparados ?? [], movidos: drive.movidos ?? [], anotados: drive.anotados ?? [] });
    mensajes = [r.texto];
    if (r.error) error = r.error;
    if (r.fallo) falloFlujo = true;
    // La propuesta de juntarlas queda abierta 
    if (r.sugerencia) {
      preguntaDrive = {
        pregunta: r.texto,
        pregunta_pendiente: true,
        hilo: [
          { rol: 'user', texto: mensaje || '(mover carpeta)' },
          { rol: 'model', texto: JSON.stringify({ intencion: 'aclarar', motivo: 'sugerencia', origen: 'codigo', orden: r.sugerencia, pregunta: r.texto, items: [], respuesta_usuario: r.texto }) },
        ],
      };
    }
  } else if (meta.intencion === 'ver_archivos') {
    const erroresLectura = lecturas.map((e) => e?.error).filter(Boolean).map(textoError);
    if (erroresLectura.length) {
      error = `Error al leer los archivos: ${erroresLectura[0]}`;
      falloFlujo = true;
      mensajes = [MENSAJE_FALLO];
    } else {
      if (meta.consulta_archivos?.enviar === true) {
        const r = archivosParaEnviar(lecturas, meta.consulta_archivos);
        mensajes = partir(r.mensajes);
        envios = r.envios;
      } else {
        mensajes = partir(formatearArchivos(lecturas, meta.consulta_archivos));
      }
    }
  } else if (meta.intencion === 'horario' && !meta.respuesta_fija) {
    // Horario fijo: lo que se pidió guardar, agrupado por franja («viernes y lunes de 16:00 a 20:00: Trabajo»)
    const DIAS = ['', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
    const grupos = new Map();
    for (const b of Array.isArray(meta.horario_nuevo) ? meta.horario_nuevo : []) {
      const k = `${b.hora_inicio}|${b.hora_fin}|${b.titulo}`;
      if (!grupos.has(k)) grupos.set(k, { ...b, dias: [] });
      grupos.get(k).dias.push(DIAS[b.dia_semana]);
    }
    const lineas = [...grupos.values()].map((g) => `• ${g.dias.join(', ').replace(/, ([^,]*)$/, ' y $1')} de ${g.hora_inicio} a ${g.hora_fin}: ${limpiar(g.titulo)}`);
    mensajes = [meta.horario_ya_estaba
      ? `Eso ya estaba en tu horario fijo:\n${lineas.join('\n')}`
      : `🗓️ Horario apuntado:\n${lineas.join('\n')}`];
  } else if (meta.intencion === 'quitar_horario') {
    const DIAS = ['', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
    const q = escrituras.find((e) => e && e.borrado === true && typeof e.titulo === 'string');
    mensajes = [q ? `🗑️ Quitado de tu horario: ${DIAS[q.dia_semana] ?? ''} de ${q.hora_inicio} a ${q.hora_fin}: ${limpiar(q.titulo)}.` : 'Ese bloque ya no estaba en tu horario.'];
  } else if (meta.intencion === 'olvidar_memoria') {
    // Lo que de verdad se borró (olvidar_memoria devuelve el dato); si ya no estaba, se dice
    const borrados = escrituras.filter((e) => e && e.borrado === true && typeof e.termino === 'string');
    mensajes = [borrados.length > 0 ? `🗑️ Olvidado:\n${borrados.map((e) => `• ${limpiar(e.termino)}: ${limpiar(e.significado)}`).join('\n')}` : 'Eso ya no estaba en mi memoria.'];
  } else if (meta.respuesta_fija) {
    // Planificar ya decidió la respuesta y no escribió nada (nada que cancelar, un proyecto que ya existe…): no es un fallo
    mensajes = [meta.respuesta_usuario];
  } else if (meta.intencion === 'proyectos') {
    mensajes = partir([textoProyectos(proyectos)]);
  } else if (meta.intencion === 'proyecto') {
    const p = meta.proyecto ?? {};
    if (filasEscritas.length === 0 && p.accion === 'cerrar') {
      // Cerrar uno que no existe (o ya cerrado) no es un fallo: no había nada que cerrar
      error = 'No se cerró ningún proyecto';
      mensajes = [`No encuentro ningún proyecto abierto que se llame «${limpiar(p.nombre)}».`];
    } else if (filasEscritas.length === 0) {
      error = 'No se pudo crear el proyecto';
      falloFlujo = true;
      mensajes = [MENSAJE_FALLO];
    } else if (p.accion === 'crear') {
      mensajes = [`Proyecto «${limpiar(p.nombre)}» creado.`];
    } else {
      const n = p.quitados ?? 0;
      mensajes = [`Proyecto «${limpiar(p.nombre)}» cerrado${n > 0 ? ` y ${n === 1 ? 'quitada su cosa pendiente' : `quitadas sus ${n} cosas pendientes`}` : ''}.`];
    }
  } else if (meta.intencion === 'crear_carpeta') {
    const rutas = Array.isArray(meta.carpetas_pedidas) ? meta.carpetas_pedidas : [];
    if (rutas.length === 0 || filasEscritas.length === 0) {
      error = 'No se registró ninguna carpeta pedida';
      falloFlujo = true;
      mensajes = [MENSAJE_FALLO];
    } else {
      mensajes = [textoCarpetasPedidas(rutas)];
    }
  } else if (meta.intencion === 'mover_archivos' && meta.mover_archivos?.deshacer) {
    // «Déjalo como estaba» 
    const n = filasEscritas.length;
    const destinos = [...new Set(filasEscritas.map((f) => f.carpeta_destino).filter(Boolean))];
    mensajes = n === 0
      ? ['Esos archivos ya no están, no he podido devolverlos.']
      : [`Hecho, como estaba: ${n === 1 ? 'el archivo vuelve' : `${n} archivos vuelven`} a ${destinos.map((d) => `«${limpiar(d)}»`).join(' y ') || 'su carpeta'}. En unos segundos ${n === 1 ? 'estará' : 'estarán'} en Drive.`];
  } else if (meta.intencion === 'mover_archivos' && meta.mover_archivos?.esos) {
    // «Mueve esos archivos a X» 
    const n = filasEscritas.length;
    mensajes = n === 0 ? ['Esos archivos ya no están.'] : [`Hecho: ${n === 1 ? 'el archivo' : `${n} archivos`} a «${limpiar(meta.mover_archivos.destino)}». En unos segundos ${n === 1 ? 'estará' : 'estarán'} en Drive.`];
  } else if (meta.intencion === 'mover_archivos' && meta.mover_archivos?.nombre) {
    // Un archivo concreto por su nombre 
    const m = meta.mover_archivos;
    const n = filasEscritas.length;
    mensajes = n === 0
      ? [`No tengo ningún archivo que se llame «${limpiar(m.nombre)}».`]
      : [`Hecho: ${n === 1 ? `«${limpiar(m.nombre)}»` : `${n} archivos «${limpiar(m.nombre)}»`} a «${limpiar(m.destino)}». En unos segundos estará en Drive.`];
  } else if (meta.intencion === 'mover_archivos' && meta.mover_archivos) {
    // Mover las fotos o los archivos de una carpeta a otra : lo que de verdad cambió de carpeta en la base de datos
    const m = meta.mover_archivos;
    const n = filasEscritas.length;
    const que = m.solo_fotos ? (n === 1 ? 'foto' : 'fotos') : n === 1 ? 'archivo' : 'archivos';
    // Si la carpeta de origen quedó apuntada para vaciarla (base de datos 1.5), se dice; si no (sin actualizar la base de datos a la 1.5, recién creada o es Entrada o Notas), cómo borrarla
    const apuntada = escrituras.some((e) => e && e.pedida === true);
    // Entrada y Notas no se borran aunque se queden vacías: no se sugiere borrarlas 
    const protegida = /^(?:entrada|notas)$/i.test(String(m.origen ?? '').trim());
    const vaciar = protegida
      ? ''
      : apuntada
        ? `Cuando «${limpiar(m.origen)}» se quede vacía, la mando a la papelera.`
        : `Si «${limpiar(m.origen)}» se queda vacía: «borra la carpeta ${limpiar(m.origen)}».`;
    mensajes = n === 0
      ? [`No tengo ${m.solo_fotos ? 'fotos guardadas' : 'archivos guardados'} en «${limpiar(m.origen)}».`]
      : m.juntar
        ? [`Ya había «${limpiar(m.destino)}», así que he juntado ahí lo de «${limpiar(m.origen)}» (${n} ${que}). En unos segundos estará en Drive.${vaciar ? `\n${vaciar}` : ''}`]
        : [`Hecho: ${n} ${que} de «${limpiar(m.origen)}» a «${limpiar(m.destino)}». En unos segundos estarán en Drive.${vaciar ? `\n${vaciar}` : ''}`];
  } else if (meta.intencion === 'deshacer') {
    mensajes = filasEscritas.length === 0 ? ['No he podido recuperar nada.'] : [textoRecuperado(filasEscritas)];
    if (filasEscritas.length === 0) error = 'La recuperación no afectó a ningún item';
  } else if (['corregir', 'completar', 'archivar', 'cancelar'].includes(meta.intencion) && filasEscritas.length === 0) {
    error = 'La actualización no afectó a ningún item';
    mensajes = ['No he encontrado nada que cambiar.'];
  } else if (meta.intencion === 'corregir' && meta.conversion) {
    const c = textoConversion(meta.conversion, filasEscritas, ahora);
    if (c.fallidas.length > 0) {
      error = `El cambio a ${meta.conversion} no quedó aplicado: ${c.fallidas.join(', ')}`;
      mensajes = [`No he podido dejar ${c.fallidas.map((t) => `«${t}»`).join(', ')} como ${meta.conversion}. Dime la hora.`];
    } else mensajes = [c.texto];
  } else if (meta.intencion === 'aclarar') {
    mensajes = [[textoRecuerdo(meta), textoLlena(meta), meta.pregunta].filter(Boolean).join('\n')];
  } else if (meta.intencion === 'cancelar' || meta.intencion === 'completar') {
    mensajes = [textoSeleccion(meta.intencion, filasEscritas)];
  } else {
    // Un nombre nuevo para la secretaria lo confirma el código, con el nombre ya validado (no lo que diga el modelo)
    // Igual con el nombre del usuario: cómo quiere que se le llame
    const guardado = meta.intencion === 'guardar' && !meta.confirmacion_codigo ? textoGuardado(filasEscritas) : null;
    const confirmacion = guardado !== null ? guardado : meta.intencion === 'recordar' && typeof meta.nombre_nuevo === 'string'
      ? `Vale, me llamo ${limpiar(meta.nombre_nuevo)}.`
      : meta.intencion === 'recordar' && typeof meta.nombre_usuario === 'string'
        ? `De acuerdo: a partir de ahora te llamaré ${limpiar(meta.nombre_usuario)}.`
        : (meta.respuesta_usuario ?? '').trim() || 'Hecho.';
    // Al guardar eventos, el horario sale de los datos guardados (no de lo que diga el modelo); al cambiar la hora de una alarma o una
    // cita, también (sustituye a la frase del modelo)
    const movida = meta.intencion === 'corregir' && meta.hora_movida ? textoHoraMovida(filasEscritas, ahora) : '';
    const horario = meta.intencion === 'guardar' ? textoHorario(meta.eventos) : '';
    const recordatorios = meta.intencion === 'guardar' ? textoRecordatorios(meta.recordatorios, meta.recordatorios_pasados, ahora) : '';
    // Si algo de lo pedido pasó a alarma (empieza antes de las 02:00 de mañana) lo dice el código, no el modelo (que habría hablado de
    // una cita en el calendario): la confirmación se compone con los datos guardados y se explica por qué no está en el calendario.
    const alarmas = meta.intencion === 'guardar' && Array.isArray(meta.alarmas) ? meta.alarmas : [];
    const nota = alarmas.length > 0 ? 'Como es para las próximas horas, lo he puesto como alarma y no en el calendario.' : '';
    const nuevos = Array.isArray(meta.proyectos_nuevos) && meta.proyectos_nuevos.length > 0
      ? `${meta.proyectos_nuevos.length === 1 ? 'Proyecto nuevo' : 'Proyectos nuevos'}: ${meta.proyectos_nuevos.map((p) => `«${limpiar(p)}»`).join(', ')}.`
      : '';
    const recuerdo = meta.intencion === 'recordar' ? '' : [textoRecuerdo(meta), textoLlena(meta)].filter(Boolean).join('\n');
    mensajes = [(alarmas.length > 0 ? [recordatorios, horario, nota, nuevos, recuerdo] : [movida || confirmacion, horario, recordatorios, nuevos, recuerdo]).filter(Boolean).join('\n') || 'Hecho.'];
    // La compra con un día: tras apuntarlo, la pregunta del aviso (queda abierta en el mensaje)
    if (meta.intencion === 'guardar' && meta.aviso_compra?.pregunta && error === null) mensajes.push(meta.aviso_compra.pregunta);
  }

  // Constancia en la base de datos: si Planificar ya dejó el motivo en el mensaje (meta.ok falso) no hace falta repetirlo; en
  // cambio, un fallo POSTERIOR (escritura o lectura) solo lo conoce este nodo y, sin esto, el mensaje quedaría como procesado
  // y sin error. Una escritura fallida lo marca además como no procesado.
  // La confirmación de borrar en Drive se guarda aquí (Planificar no sabía qué había en las carpetas): la pregunta queda abierta con su lista.
  // Los archivos que se acaban de mover o guardar quedan anotados en el hilo del mensaje : «mueve esos archivos a X» los encuentra
  const archivosTocados = ['mover_archivos', 'archivar'].includes(meta.intencion) && meta.ok && error === null
    ? filasEscritas.filter((e) => typeof e.drive_file_id === 'string' && /^[0-9a-f-]{36}$/i.test(e.id)).map((e) => e.id).slice(0, 50)
    : [];
  // Y de dónde salió cada uno, para «déjalo como estaba» : por id (previas) o por la carpeta nueva (vuelta: nueva → anterior)
  const ma = meta.mover_archivos ?? {};
  const previas = ma.previas && typeof ma.previas === 'object' ? ma.previas : {};
  const vueltaPor = ma.vuelta && typeof ma.vuelta === 'object' ? ma.vuelta : {};
  const deshacerMov = meta.intencion === 'mover_archivos'
    ? filasEscritas
        .filter((e) => archivosTocados.includes(e.id))
        .map((e) => ({ id: e.id, a: e.carpeta_destino, de: previas[e.id] ?? vueltaPor[e.carpeta_destino] ?? null }))
        .filter((d) => typeof d.de === 'string' && typeof d.a === 'string' && d.de !== d.a)
    : [];
  const vaciarMov = Array.isArray(ma.vaciar) && escrituras.some((e) => e && e.pedida === true) ? ma.vaciar.filter((r) => typeof r === 'string') : [];
  const nota = { intencion: 'movidos', motivo: 'movidos', origen: 'codigo', ids: archivosTocados, ...(deshacerMov.length > 0 ? { deshacer: deshacerMov } : {}), ...(vaciarMov.length > 0 ? { vaciar: vaciarMov } : {}) };
  const anotacion = meta.ok && error !== null
    ? { error: String(error).slice(0, MAX_ERROR_GUARDADO), ...(erroresEscritura.length > 0 ? { procesado: false } : {}) }
    : preguntaDrive ?? (archivosTocados.length > 0
      ? { hilo: [{ rol: 'user', texto: String(mensaje || '(archivos)').slice(0, 500) }, { rol: 'model', texto: JSON.stringify(nota) }] }
      : null);

  // Preguntas que el usuario dejó sin contestar al escribir otra cosa: se cerraron sin hacer nada y se le dice ANTES de la respuesta
  const ignoradas = Array.isArray(meta.preguntas_ignoradas) ? meta.preguntas_ignoradas.filter((p) => typeof p === 'string' && p.trim() !== '') : [];
  if (ignoradas.length > 0) mensajes.unshift(textoPreguntasIgnoradas(ignoradas));

  return {
    ok: error === null,
    intencion: meta.intencion,
    respuesta_usuario: mensajes.join('\n\n'),
    mensajes,
    avisos,
    error,
    fallo_flujo: falloFlujo,
    errores_escritura: erroresEscritura,
    anotacion,
    envios_archivos: envios,
  };
}

// «No contestaste a «¿…?», así que no he hecho nada con eso.» (una por pregunta, recortadas a una línea)
function textoPreguntasIgnoradas(preguntas) {
  const corta = (p) => {
    const t = String(p).replace(/\s+/g, ' ').trim();
    return t.length > 120 ? `${t.slice(0, 120).trimEnd()}…` : t;
  };
  if (preguntas.length === 1) return `No contestaste a «${corta(preguntas[0])}», así que no he hecho nada con eso.`;
  return `No contestaste a estas preguntas, así que no he hecho nada con ellas:\n${preguntas.map((p) => `• «${corta(p)}»`).join('\n')}`;
}

// --- Pegamento con n8n ---
const meta = $('Planificar').first().json.meta;
// Los listados de Drive solo se ejecutan con la intención "carpetas": en el resto, el nodo no ha corrido y pedirlo lanza un error
const nivel = (nombre) => {
  try {
    return $(nombre).first().json;
  } catch (e) {
    return null;
  }
};
// Todos los items de un nodo, o [] si no se ejecutó en este mensaje
const todos = (nombre) => {
  try {
    return $(nombre).all().map((i) => i.json);
  } catch (e) {
    return [];
  }
};
// Archivos sin clasificar (los lee el nodo "Leer archivos", que siempre corre antes que el modelo)
let archivosPendientes = [];
try {
  archivosPendientes = $('Leer archivos').all().map((i) => i.json).filter((r) => r && r.estado === 'pendiente' && typeof r.nombre === 'string' && typeof r.created_at === 'string');
} catch (e) {
  archivosPendientes = [];
}
// Los proyectos: los calcula "Construir petición" (corre siempre antes que el modelo)
let construccion = {};
try {
  construccion = $('Construir petición').first().json ?? {};
} catch (e) {
  construccion = {};
}
// El texto que se procesó (los mensajes seguidos ya juntados, uno por línea): para decir cuál falló
let textoProcesado = '';
try {
  textoProcesado = $('Entrada').first().json.mensaje ?? '';
} catch (e) {
  textoProcesado = '';
}
const salida = resolver({
  meta,
  mensaje: textoProcesado,
  archivosPendientes,
  proyectos: construccion.proyectos ?? [],
  escrituras: $('Escribir en Supabase').all().map((i) => i.json),
  // Qué era cada escritura (mismo orden): para no tomar por un fallo el de un extra
  etiquetas: $('Planificar').all().map((i) => i.json.etiqueta),
  // Con la rama de carpetas, lo que llega es lo de Drive (Revisar Drive, Marcar borrado): los archivos contados se leen de su nodo
  lecturas: meta.carpetas ? todos('Contar archivos') : $input.all().map((i) => i.json),
  drive: { revisados: todos('Revisar Drive'), mandados: todos('Mandar a la papelera'), marcado: nivel('Marcar borrado'), creado: nivel('Crear en Drive'), preparados: todos('Preparar movimientos'), movidos: todos('Mover en Drive'), anotados: todos('Anotar movimiento') },
  ahora: meta.ahora ? new Date(meta.ahora) : new Date(),
  niveles: meta.carpetas ? ['Listar nivel 1', 'Listar nivel 2', 'Listar nivel 3'].map(nivel) : [],
  raizId: meta.carpetas ? $('Configuración').first().json.config.carpeta_raiz_id : '',
});
return [{ json: salida }];
