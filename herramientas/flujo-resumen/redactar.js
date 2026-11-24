// Nodo "Redactar resumen": convierte lo pendiente en UN mensaje de WhatsApp y construye el cuerpo exacto de la petición a Meta.
//
// - Si el último mensaje tuyo es de hace menos de VENTANA_HORAS, la ventana de 24 h de Meta sigue abierta: se envía el resumen
//   completo como texto libre.
// - Si no, NO se envía nada (sin plantillas; Meta solo admite plantillas fuera de la ventana). Ese día
//   no hay resumen; «qué tengo pendiente» devuelve lo mismo cuando quieras.
// - Con la ventana abierta se envía siempre, aunque no haya nada ("No tienes nada pendiente").
// - Se redacta con código, nunca con el modelo: formato idéntico cada día y sin coste.
//
// Las funciones de formato de la lista (limpiar, dia, hora, bloqueArchivos, formatearLista…) son copia de las de
// herramientas/flujo/resultado.js; probar-resumen.js comprueba que dan el mismo texto que ellas.

const config = $('Configuración').first().json.config;
const LIMITE_MENSAJE = 3800; // WhatsApp admite 4096 caracteres por mensaje; margen para no rozarlo
// Viajes: de viaje en un sitio con otra hora (nodo «Leer viaje»), las horas se escriben en la de allí y
// se dice al final. Sin viaje, sin la base de datos al día (la lectura falla) o con la misma hora que en España, todo como siempre
const ZONA_ESPANA = 'Europe/Madrid';
// «Leer viaje» lee viajes_vigentes (base de datos): el tramo actual y los próximos. El ACTUAL es el que ya empezó (sin «desde» o con «desde»
// ya llegado en su zona). Con la función antigua (viaje_actual) llega solo el actual y vale igual
const diaDe = (zona, fecha) => new Intl.DateTimeFormat('en-CA', { timeZone: zona, year: 'numeric', month: '2-digit', day: '2-digit' }).format(fecha);
const TRAMOS = (() => {
  try {
    return $('Leer viaje').all().map((x) => x.json).filter((r) => r && typeof r.zona === 'string' && typeof r.pais === 'string' && !r.cerrado_at && (() => { try { diaDe(r.zona, new Date()); return true; } catch (e) { return false; } })());
  } catch (e) {
    return [];
  }
})();
const empezado = (t) => !t.desde || String(t.desde).slice(0, 10) <= diaDe(t.zona, new Date());
const VIAJE_ACTUAL = TRAMOS.filter(empezado).sort((a, b) => String(a.desde ?? '').localeCompare(String(b.desde ?? ''))).at(-1) ?? null;
const VIAJE = (() => {
  try {
    const v = VIAJE_ACTUAL;
    if (!v) return null;
    const reloj = (z) => new Intl.DateTimeFormat('en-GB', { timeZone: z, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
    return reloj(v.zona) === reloj(ZONA_ESPANA) ? null : { zona: v.zona, lugar: (/\(([^)]+)\)\s*$/.exec(v.pais) || [null, v.pais])[1] };
  } catch (e) {
    return null;
  }
})();
const ZONA = VIAJE ? VIAJE.zona : ZONA_ESPANA;

// Los caracteres de formato de WhatsApp en un título romperían la negrita o la cursiva
const limpiar = (s) => String(s ?? '').replace(/[*_~`]/g, '').replace(/\s+/g, ' ').trim();

const fmtDia = new Intl.DateTimeFormat('es-ES', { timeZone: ZONA, weekday: 'short', day: 'numeric', month: 'short' });
const fmtDiaLargo = new Intl.DateTimeFormat('es-ES', { timeZone: ZONA, weekday: 'long', day: 'numeric', month: 'short' });
const fmtHora = new Intl.DateTimeFormat('es-ES', { timeZone: ZONA, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const fmtClave = new Intl.DateTimeFormat('en-CA', { timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit' });

// Un DÍA fijo (fecha límite: las 23:59 de Madrid, o una fecha sin hora) es ese día del calendario de España en cualquier zona (como en resultado.js)
const fmtDiaMadrid = new Intl.DateTimeFormat('es-ES', { timeZone: ZONA_ESPANA, weekday: 'short', day: 'numeric', month: 'short' });
const fmtClaveMadrid = new Intl.DateTimeFormat('en-CA', { timeZone: ZONA_ESPANA, year: 'numeric', month: '2-digit', day: '2-digit' });
const fmtHoraMadrid = new Intl.DateTimeFormat('es-ES', { timeZone: ZONA_ESPANA, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const esDiaFijo = (iso) => (typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(iso)) || fmtHoraMadrid.format(new Date(iso)) === '23:59';
function dia(iso) {
  const p = Object.fromEntries((esDiaFijo(iso) ? fmtDiaMadrid : fmtDia).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.day} ${p.month}`.replace(/\./g, '');
}
function diaLargo(fecha) {
  const p = Object.fromEntries(fmtDiaLargo.formatToParts(fecha).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.day} ${p.month}`.replace(/\./g, '');
}
const hora = (iso) => {
  return fmtHora.format(new Date(iso));
};
// Las alarmas, a su hora y en su zona, con el sitio entre paréntesis si no es Madrid (igual que en resultado.js)
const zonaDeAlarma = (r) => {
  const z = typeof r?.zona_alarma === 'string' && r.zona_alarma !== '' ? r.zona_alarma : 'Europe/Madrid';
  try {
    new Intl.DateTimeFormat('es-ES', { timeZone: z });
    return z;
  } catch (e) {
    return 'Europe/Madrid';
  }
};
function diaAlarma(r) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('es-ES', { timeZone: zonaDeAlarma(r), weekday: 'short', day: 'numeric', month: 'short' }).formatToParts(new Date(r.recordar_en)).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.day} ${p.month}`.replace(/\./g, '');
}
// Las citas también: a su hora y en su zona, con el sitio al final si no es Madrid (igual que en resultado.js)
const diaEnZona = (r, iso) => diaAlarma({ ...r, recordar_en: iso });
// Estando fuera, se anota si sale alguna alarma o cita de España (sin país) para aclararlo al final
let usoSinPais = false;
const horaEnZona = (r, iso) => {
  if (zonaDeAlarma(r) === 'Europe/Madrid') usoSinPais = true;
  return new Intl.DateTimeFormat('es-ES', { timeZone: zonaDeAlarma(r), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
};
const sitioDe = (r) => (zonaDeAlarma(r) === 'Europe/Madrid' ? '' : ` (${limpiar(r.lugar_alarma || zonaDeAlarma(r))})`);
function horaAlarma(r) {
  const z = zonaDeAlarma(r);
  if (z === 'Europe/Madrid') usoSinPais = true;
  const h = new Intl.DateTimeFormat('es-ES', { timeZone: z, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(r.recordar_en));
  return z === 'Europe/Madrid' ? h : `${h} (${limpiar(r.lugar_alarma || z)})`;
}
// Día natural en Madrid (o en la zona del viaje), "2026-10-12": sirve para comparar "es hoy" sin líos de zona horaria
const claveDia = (iso) => (esDiaFijo(iso) ? fmtClaveMadrid : fmtClave).format(new Date(iso));

const minuscula1 = (s) => (s.length > 1 && s[0] === s[0].toUpperCase() && s[1] === s[1].toLowerCase() ? s[0].toLowerCase() + s.slice(1) : s);
const mayuscula1 = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

const porFecha = (campo) => (a, b) => {
  if (!a[campo] && !b[campo]) return 0;
  if (!a[campo]) return 1;
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

const MAX_ARCHIVOS_LISTA = 15;
function bloqueArchivos(archivos) {
  if (!archivos.length) return null;
  const enlace = (f) => (typeof f.drive_url === 'string' && f.drive_url ? `\n  ${f.drive_url}` : '');
  const lineas = archivos.slice(0, MAX_ARCHIVOS_LISTA).map((f) => `• ${limpiar(f.nombre)}${enlace(f)}`);
  if (archivos.length > MAX_ARCHIVOS_LISTA) lineas.push(`… y ${archivos.length - MAX_ARCHIVOS_LISTA} más`);
  return `*Archivos sin clasificar*\n${lineas.join('\n')}`;
}

// Bloques de texto (uno por sección) de lo pendiente que no es de hoy. Sin "No tienes nada pendiente": eso lo decide quien llama.
function bloquesDeLista(rows, archivos) {
  // Alarma = tarea con hora de aviso y sin fecha límite: sección propia (igual que en «qué tengo pendiente»)
  const esAlarma = (r) => r.tipo === 'tarea' && r.recordar_en && !r.fecha_limite;
  const alarmas = rows.filter(esAlarma).sort(porFecha('recordar_en'));
  const sinAlarmas = rows.filter((r) => !esAlarma(r));
  // Las tareas y notas de un proyecto van aparte de lo cotidiano, como en «qué tengo pendiente»
  const deProyecto = sinAlarmas.filter((r) => r.proyecto && (r.tipo === 'tarea' || r.tipo === 'nota'));
  const cotidiano = sinAlarmas.filter((r) => !deProyecto.includes(r));
  const resto = cotidiano;
  const tareas = resto.filter((r) => r.tipo === 'tarea').sort(porFecha('fecha_limite'));
  const eventos = resto.filter((r) => r.tipo === 'evento').sort(porFecha('fecha_inicio'));
  const notas = resto.filter((r) => r.tipo === 'nota');
  const listas = resto.filter((r) => r.tipo === 'lista');
  const bloques = [];

  if (alarmas.length) {
    bloques.push(`*Alarmas*\n${alarmas.map((r) => `• 🔔 ${limpiar(r.titulo)}, ${diaAlarma(r)}, ${horaAlarma(r)}`).join('\n')}`);
  }
  if (tareas.length) {
    bloques.push(`*Tareas*\n${tareas.map((r) => `• ${limpiar(r.titulo)}${r.fecha_limite ? ` (${dia(r.fecha_limite)})` : ''}`).join('\n')}`);
  }
  if (deProyecto.length) {
    // Cada proyecto con su título y una viñeta por tarea o nota (nada de todo junto y con punto y coma), igual que en «qué tengo pendiente»
    const grupos = agrupar(deProyecto, (r) => limpiar(r.proyecto));
    const partes = [...grupos.keys()].sort((a, b) => a.localeCompare(b, 'es')).map((nombre) => {
      const lineas = grupos.get(nombre).slice().sort(porFecha('fecha_limite')).map((r) => `• ${r.tipo === 'nota' ? '📝 ' : ''}${limpiar(r.titulo)}${r.fecha_limite ? ` (${dia(r.fecha_limite)})` : ''}`);
      return `📁 *${nombre}*\n${lineas.join('\n')}`;
    });
    bloques.push(`*Proyectos*\n${partes.join('\n')}`);
  }
  if (eventos.length) {
    const lineas = eventos.map((r) => {
      const cuando = r.fecha_inicio ? `, ${diaEnZona(r, r.fecha_inicio)}, ${horaEnZona(r, r.fecha_inicio)}${sitioDe(r)}` : '';
      return `• ${limpiar(r.titulo)}${cuando}${r.proyecto ? ` [${limpiar(r.proyecto)}]` : ''}`;
    });
    bloques.push(`*Citas*\n${lineas.join('\n')}`);
  }
  if (notas.length) {
    bloques.push(`*Pensamientos*\n${notas.map((r) => `• ${limpiar(r.titulo)}`).join('\n')}`);
  }
  if (listas.length) {
    const grupos = agrupar(listas, (r) => limpiar(r.lista) || 'sin nombre');
    for (const nombre of [...grupos.keys()].sort((a, b) => a.localeCompare(b, 'es'))) {
      const elementos = grupos.get(nombre).map((r) => limpiar(r.titulo));
      bloques.push(`*Lista de ${nombre}*\n• ${mayuscula1(elementos.map(minuscula1).join(', '))}`);
    }
  }
  const deArchivos = bloqueArchivos(archivos);
  if (deArchivos) bloques.push(deArchivos);
  return bloques;
}

// --- Viajes: copia EXACTA de planificar.js (offsetZona, difConEspana, textoDiferencia; lo comprueba probar-resumen.js) ---
function offsetZona(zona, fecha) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: zona, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(fecha);
  const g = (t) => Number(p.find((x) => x.type === t).value);
  return Math.round((Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'), g('second')) - fecha.getTime()) / 60000);
}
const difConEspana = (zona, fecha) => offsetZona(zona, fecha) - offsetZona(ZONA_ESPANA, fecha);
function textoDiferencia(minutos) {
  if (minutos === 0) return 'la misma hora que en España';
  const a = Math.abs(minutos);
  const h = Math.floor(a / 60);
  const m = a % 60;
  const cant = m === 0 ? (h === 1 ? 'una hora' : `${h} horas`) : h === 0 ? `${m} minutos` : `${h === 1 ? 'una hora' : `${h} horas`} y ${m === 30 ? 'media' : `${m} minutos`}`;
  return `${cant} ${minutos < 0 ? 'menos' : 'más'} que en España`;
}

// --- Pegamento con n8n ---
const filasDe = (nombre, validar) => $(nombre).all().map((x) => x.json).filter((r) => r && validar(r));
const itemsLeidos = filasDe('Leer pendientes', (r) => typeof r.tipo === 'string' && typeof r.titulo === 'string');
const archivos = filasDe('Leer archivos', (r) => typeof r.nombre === 'string' && typeof r.created_at === 'string');
// El viaje activo (base de datos). La lectura no corta el resumen si falla (sin la base de datos al día): entonces no hay viaje
const viaje = VIAJE_ACTUAL;
// El día antes de un viaje planeado: «✈️ Mañana te vas a Japón…» y lo que tienes esos días
const proximo = TRAMOS.filter((t) => !empezado(t)).find((t) => String(t.desde).slice(0, 10) === diaDe(t.zona, new Date(Date.now() + 86400000)));
const ultimo = filasDe('Leer último mensaje', (r) => typeof r.created_at === 'string').map((r) => new Date(r.created_at)).filter((d) => !Number.isNaN(d.getTime()))[0];

const para = String($env.WHATSAPP_NUMERO_PERMITIDO ?? '').replace(/\D/g, '');
if (!para) throw new Error('Redactar resumen: falta WHATSAPP_NUMERO_PERMITIDO en el entorno de n8n');

const ahora = new Date();
const hoyClave = claveDia(ahora.toISOString());

// Eventos ya terminados: no cuentan (como en la consulta normal)
const rows = itemsLeidos.filter((r) => !(r.tipo === 'evento' && new Date(r.fecha_fin ?? r.fecha_inicio ?? '9999-12-31') < ahora));

// «Hoy» de cada cita, en SU zona: hoy allí
const hoyEn = (z) => new Intl.DateTimeFormat('en-CA', { timeZone: z, year: 'numeric', month: '2-digit', day: '2-digit' });
const esDeHoy = (r) => hoyEn(zonaDeAlarma(r)).format(new Date(r.fecha_inicio)) === hoyEn(zonaDeAlarma(r)).format(ahora);
const hoyEventos = rows.filter((r) => r.tipo === 'evento' && r.fecha_inicio && esDeHoy(r)).sort(porFecha('fecha_inicio'));
const hoyTareas = rows.filter((r) => r.tipo === 'tarea' && r.fecha_limite && claveDia(r.fecha_limite) === hoyClave).sort(porFecha('fecha_limite'));
const atrasadas = rows.filter((r) => r.tipo === 'tarea' && r.fecha_limite && claveDia(r.fecha_limite) < hoyClave).sort(porFecha('fecha_limite'));
const yaMostrados = new Set([...hoyEventos, ...hoyTareas, ...atrasadas]);
const resto = rows.filter((r) => !yaMostrados.has(r));

// --- Texto completo ---
const cabecera = `Buenos días. Esto es lo que tienes (${diaLargo(ahora)}):`;
const bloques = [];
if (hoyEventos.length || hoyTareas.length) {
  bloques.push(`*Hoy*\n${[...hoyEventos.map((r) => `• ${limpiar(r.titulo)}, ${horaEnZona(r, r.fecha_inicio)}${sitioDe(r)}`), ...hoyTareas.map((r) => `• ${limpiar(r.titulo)} (entrega hoy)`)].join('\n')}`);
}
if (atrasadas.length) {
  bloques.push(`*Atrasado*\n${atrasadas.map((r) => `• ${limpiar(r.titulo)} (era ${dia(r.fecha_limite)})`).join('\n')}`);
}
bloques.push(...bloquesDeLista(resto, archivos));

// De viaje sin fecha de vuelta y con otra hora: se recuerda dónde está (el usuario no sabía hasta cuándo; con fecha, vuelve sola a la de España)
const difViaje = viaje && !viaje.hasta ? difConEspana(viaje.zona, ahora) : 0;
const lineaViaje = difViaje !== 0 ? `🌍 Sigues en ${viaje.pais} (${textoDiferencia(difViaje)}). Cuando vuelvas, dime «he vuelto».` : '';
const lineaProximo = (() => {
  if (!proximo) return '';
  const desde = String(proximo.desde).slice(0, 10);
  const hasta = proximo.hasta ? String(proximo.hasta).slice(0, 10) : null;
  const fechaLarga = (f) => new Intl.DateTimeFormat('es-ES', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${f}T12:00:00Z`)).replace(/[.,]/g, '');
  let dif = 0;
  try {
    dif = difConEspana(proximo.zona, new Date(`${desde}T12:00:00Z`));
  } catch (e) {
    dif = 0;
  }
  const lugar = (/\(([^)]+)\)\s*$/.exec(proximo.pais) || [null, proximo.pais])[1];
  // Un viaje sin destino: «Mañana te vas de viaje»
  const destino = proximo.pais === 'Viaje sin destino' ? 'de viaje' : `a ${limpiar(lugar)}`;
  let linea = `✈️ Mañana te vas ${destino}${hasta ? ` (hasta el ${fechaLarga(hasta)})` : ''}${dif ? `: allí es ${textoDiferencia(dif)}` : ''}.`;
  if (hasta) {
    const borde = (f, h) => Date.parse(`${f}T${h}Z`) - offsetZona(proximo.zona, new Date(`${f}T12:00:00Z`)) * 60000;
    const ini = borde(desde, '00:00:00');
    const fin = borde(hasta, '23:59:59');
    const esos = rows
      .map((r) => ({ r, iso: r.tipo === 'evento' ? r.fecha_inicio : r.tipo === 'tarea' && r.recordar_en && !r.fecha_limite ? r.recordar_en : null }))
      .filter((x) => x.iso && Date.parse(x.iso) >= ini && Date.parse(x.iso) <= fin)
      .sort((a, b) => Date.parse(a.iso) - Date.parse(b.iso))
      .slice(0, 10)
      .map(({ r, iso }) => (r.tipo === 'evento' ? `• 📅 ${limpiar(r.titulo)}, ${diaEnZona(r, iso)}, ${horaEnZona(r, iso)}${sitioDe(r)}` : `• 🔔 ${limpiar(r.titulo)}, ${diaAlarma(r)}, ${horaAlarma(r)}`));
    linea += esos.length ? ` Esos días tienes:\n${esos.join('\n')}` : ' Esos días no tienes citas ni alarmas.';
  }
  return linea;
})();
let texto;
if (bloques.length === 0) {
  texto = 'Buenos días. No tienes nada pendiente.';
} else {
  // Un solo mensaje: si no cabe, se corta por secciones y se avisa
  const AVISO = '… Hay más: escríbeme «qué tengo pendiente».';
  let cuerpo = cabecera;
  let omitidos = 0;
  for (const b of bloques) {
    if (omitidos === 0 && `${cuerpo}\n\n${b}`.length <= LIMITE_MENSAJE - AVISO.length - 2) cuerpo = `${cuerpo}\n\n${b}`;
    else omitidos += 1;
  }
  if (omitidos > 0 && cuerpo === cabecera) cuerpo = `${cabecera}\n\n${bloques[0].slice(0, LIMITE_MENSAJE - AVISO.length - cabecera.length - 10).trimEnd()}`;
  texto = omitidos > 0 ? `${cuerpo}\n\n${AVISO}` : cuerpo;
}
if (VIAJE && usoSinPais) texto += '\n(Lo que no lleva país va en hora de España.)';
if (lineaViaje) texto = texto.replace(/^(Buenos días\.[^\n]*)/, `$1\n${lineaViaje}`);
if (lineaProximo) texto = texto.replace(/^(Buenos días\.[^\n]*(?:\n🌍[^\n]*)?)/, `$1\n${lineaProximo}`);

// --- Ventana de 24 h: solo texto libre ---
const ventanaMs = config.ventana_horas * 3600 * 1000;
const ventanaAbierta = Boolean(ultimo) && ahora.getTime() - ultimo.getTime() < ventanaMs;
// Con la ventana cerrada Meta solo admitiría una plantilla, y no se usan: ese día no se manda el resumen (no es un fallo)
if (!ventanaAbierta) return [];

const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to: para };
return [{ json: { modo: 'texto', cuerpo: { ...base, type: 'text', text: { preview_url: false, body: texto } }, texto_completo: texto } }];
