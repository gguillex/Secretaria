// Pruebas sin red ni coste del flujo "Resumen diario" (flujos/resumen-diario.json).
// Ejecuta el código real de herramientas/flujo-resumen/*.js con entradas simuladas y un reloj fijo.
// Uso: node herramientas/probar-resumen.js

const fs = require('fs');
const path = require('path');
const { construirFlujo } = require('./generar-resumen.js');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const leer = (...p) => fs.readFileSync(path.join(__dirname, ...p), 'utf8').replace(/\r\n/g, '\n');
const CODIGO_CONFIG = leer('flujo-resumen', 'configuracion.js');
const CODIGO_REDACTAR = leer('flujo-resumen', 'redactar.js');

let pasan = 0;
const fallan = [];
function afirmar(nombre, condicion, detalle) {
  if (condicion) pasan += 1;
  else {
    fallan.push(nombre);
    console.log(`  FALLA: ${nombre}${detalle ? `\n         ${detalle}` : ''}`);
  }
}

// Reloj fijo: solo cambia "new Date()" sin argumentos y Date.now()
const RealDate = Date;
async function conHora(iso, fn) {
  const fijo = new RealDate(iso).getTime();
  class Fija extends RealDate {
    constructor(...a) {
      if (a.length === 0) super(fijo);
      else super(...a);
    }
    static now() {
      return fijo;
    }
  }
  globalThis.Date = Fija;
  try {
    return await fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

const CONFIG = { supabase_url: 'https://abc.supabase.co', phone_number_id: '123456789012345', graph_version: 'v25.0', ventana_horas: 23 };

function simular(nodos) {
  return (nombre) => {
    if (nombre === 'Configuración') return { first: () => ({ json: { config: nodos.config ?? CONFIG } }) };
    if (!(nombre in nodos)) throw new Error(`Node "${nombre}" hasn't been executed`);
    const items = nodos[nombre].map((json) => ({ json }));
    return { all: () => items, first: () => items[0] };
  };
}
async function correr(codigo, { nodos = {}, env = { WHATSAPP_NUMERO_PERMITIDO: '34600111222' } } = {}) {
  const fn = new AsyncFunction('$input', '$', '$env', codigo);
  const salida = await fn({ all: () => [], first: () => undefined }, simular(nodos), env);
  return salida.map((x) => x.json);
}
async function lanza(nombre, promesa, trozo) {
  try {
    await promesa;
    afirmar(nombre, false, 'debía lanzar un error y no lo hizo');
  } catch (e) {
    afirmar(nombre, String(e.message).includes(trozo), `error recibido: ${e.message}`);
  }
}

// "Ahora": lunes 12 de octubre de 2026, 7:00 en Madrid (+02:00)
const AHORA = '2026-10-12T05:00:00.000Z';
let n = 0;
const item = (o) => ({ id: `id-${++n}`, estado: 'pendiente', contenido: null, lista: null, fecha_inicio: null, fecha_fin: null, fecha_limite: null, ...o });
const DENTISTA = item({ tipo: 'evento', titulo: 'Dentista', fecha_inicio: '2026-10-12T08:00:00+00:00', fecha_fin: '2026-10-12T09:00:00+00:00' }); // hoy 10:00
const REUNION = item({ tipo: 'evento', titulo: 'Reunión', fecha_inicio: '2026-10-13T08:00:00+00:00', fecha_fin: '2026-10-13T09:00:00+00:00' }); // mañana
const AYER = item({ tipo: 'evento', titulo: 'Evento de ayer', fecha_inicio: '2026-10-11T08:00:00+00:00', fecha_fin: '2026-10-11T09:00:00+00:00' });
const T_HOY = item({ tipo: 'tarea', titulo: 'Entregar informe', fecha_limite: '2026-10-12T15:00:00+00:00' });
const T_ATRASADA = item({ tipo: 'tarea', titulo: 'Pagar seguro', fecha_limite: '2026-10-09T10:00:00+00:00' });
const T_FUTURA = item({ tipo: 'tarea', titulo: 'Renovar DNI', fecha_limite: '2026-10-20T10:00:00+00:00' });
const NOTA = item({ tipo: 'nota', titulo: 'Idea', contenido: 'Probar el nuevo gimnasio' });
const LISTA = ['Huevos', 'Leche', 'Café'].map((t) => item({ tipo: 'lista', titulo: t, lista: 'compra' }));
const ARCH = [
  { id: 'a1', nombre: 'foto-1.jpg', drive_url: 'https://drive.google.com/file/d/AAA/view', created_at: '2026-10-11T18:30:00+00:00' },
  { id: 'a2', nombre: 'presupuesto.pdf', drive_url: 'https://drive.google.com/file/d/BBB/view', created_at: '2026-10-11T19:00:00+00:00' },
];
const TODO = [DENTISTA, REUNION, AYER, T_HOY, T_ATRASADA, T_FUTURA, NOTA, ...LISTA];
const ULT_RECIENTE = [{ created_at: '2026-10-11T20:00:00+00:00' }]; // hace 9 h: ventana abierta
const ULT_ANTIGUO = [{ created_at: '2026-10-10T20:00:00+00:00' }]; // hace 33 h: ventana cerrada

const redactar = (items, archivos, ultimo, extra = {}) =>
  conHora(AHORA, () => correr(CODIGO_REDACTAR, { nodos: { 'Leer pendientes': items, 'Leer archivos': archivos, 'Leer último mensaje': ultimo, ...extra.nodos }, env: extra.env }));

async function main() {
  console.log('Modo texto (ventana abierta)');
  {
    const [r] = await redactar(TODO, ARCH, ULT_RECIENTE);
    const c = r.cuerpo;
    afirmar('modo texto', r.modo === 'texto' && c.type === 'text' && c.messaging_product === 'whatsapp', JSON.stringify(c));
    afirmar('va al número permitido, solo dígitos', c.to === '34600111222');
    const t = c.text.body;
    afirmar('saluda con el día en Madrid', t.startsWith('Buenos días. Esto es lo que tienes (lunes 12 oct):'), t.split('\n')[0]);
    afirmar('Hoy: el evento de hoy con su hora en Madrid', t.includes('*Hoy*\n• Dentista, 10:00'), t);
    afirmar('Hoy: la tarea con entrega hoy', t.includes('• Entregar informe (entrega hoy)'));
    afirmar('Atrasado: la tarea vencida', t.includes('*Atrasado*\n• Pagar seguro (era vie 9 oct)'), t);
    afirmar('lo de hoy no se repite en las listas', t.split('Dentista').length === 2 && t.split('Entregar informe').length === 2 && t.split('Pagar seguro').length === 2);
    afirmar('el evento de ayer no sale', !t.includes('Evento de ayer'));
    afirmar('citas próximas', t.includes('*Citas*\n• Reunión, mar 13 oct, 10:00'), t);
    afirmar('tarea futura con su fecha', t.includes('• Renovar DNI (mar 20 oct)'));
    afirmar('notas', t.includes('*Pensamientos*\n• Idea\n'));
    afirmar('lista de la compra', t.includes('*Lista de compra*\n• Huevos, leche, café'));
    const [rp] = await redactar([...TODO, { tipo: 'tarea', titulo: 'Llamar al casero', proyecto: 'Mudanza' }, { tipo: 'nota', titulo: 'Idea caja', proyecto: 'Mudanza' }], ARCH, ULT_RECIENTE);
    const tp = rp.cuerpo.text.body;
    afirmar('proyectos: aparte de las tareas cotidianas, una línea por proyecto', tp.includes('*Proyectos*\n📁 *Mudanza*\n• Llamar al casero\n• 📝 Idea caja') && !/\*Tareas\*[^*]*casero/.test(tp), tp);
    afirmar('archivos sin clasificar con enlace', t.includes('*Archivos sin clasificar*\n• foto-1.jpg\n  https://drive.google.com/file/d/AAA/view') && t.includes('presupuesto.pdf'), t);
    afirmar('cabe en un mensaje', t.length <= 3800);
  }

  console.log('Mismo formato que la consulta normal');
  {
    const fuente = leer('flujo', 'resultado.js');
    const ini = fuente.indexOf('const LIMITE_MENSAJE');
    const fin = fuente.indexOf('// --- Lista de carpetas');
    afirmar('se localiza el bloque de formato en resultado.js', ini >= 0 && fin > ini);
    // Contenido del propio repositorio leído del disco (nunca datos del usuario): new Function es seguro aquí
    const { formatearLista } = new Function(`${fuente.slice(ini, fin)}\nreturn { formatearLista };`)();
    const [r] = await redactar(TODO, ARCH, ULT_RECIENTE);
    const resto = TODO.filter((x) => ![DENTISTA, T_HOY, T_ATRASADA].includes(x));
    // El resumen no lleva el « …» de «tiene más detalle» ni su nota final: es solo el titular
    const esperado = (await conHora(AHORA, () => formatearLista(resto, { estado: 'pendiente', con_rango: false }, new Date(), ARCH))).filter((b) => !b.startsWith('(…)')).map((b) => b.replace(/ …$/gm, ''));
    afirmar('las secciones de debajo son idénticas a las de «qué tengo pendiente»', r.cuerpo.text.body.endsWith(`\n\n${esperado.join('\n\n')}`), `esperado:\n${esperado.join('\n\n')}\n\nobtenido:\n${r.cuerpo.text.body}`);
  }

  console.log('Ventana cerrada: no se envía nada (sin plantillas)');
  {
    for (const [nombre, ultimo] of [['último mensaje de hace 33 h', ULT_ANTIGUO], ['nunca ha escrito', [{}]]]) {
      const r = await redactar(TODO, ARCH, ultimo);
      afirmar(`${nombre}: no devuelve nada, así que no se envía ni plantilla ni texto`, r.length === 0, JSON.stringify(r));
    }
    const justo = (horas) => [{ created_at: new RealDate(new RealDate(AHORA).getTime() - horas * 3600 * 1000).toISOString() }];
    afirmar('hace 22 h 59 min: aún texto', (await redactar(TODO, ARCH, justo(22.98)))[0].modo === 'texto');
    afirmar('hace 23 h 01 min: ya no se envía nada', (await redactar(TODO, ARCH, justo(23.02))).length === 0);
    afirmar('una fecha de último mensaje ilegible cuenta como ventana cerrada', (await redactar(TODO, ARCH, [{ created_at: 'no es fecha' }])).length === 0);
    afirmar('con la ventana cerrada tampoco falla si no hay nada pendiente', (await redactar([{}], [{}], ULT_ANTIGUO)).length === 0);
    afirmar('el código ya no contiene ninguna plantilla', !CODIGO_REDACTAR.includes('template') && !CODIGO_REDACTAR.includes('resumenCompacto') && !CODIGO_CONFIG.includes('PLANTILLA'));
  }

  console.log('Hoy según la hora de Madrid');
  {
    const casi = item({ tipo: 'tarea', titulo: 'Casi mañana', fecha_limite: '2026-10-12T22:30:00+00:00' }); // 00:30 del 13 en Madrid
    const apenas = item({ tipo: 'tarea', titulo: 'Recién hoy', fecha_limite: '2026-10-11T22:30:00+00:00' }); // 00:30 del 12 en Madrid
    const [r] = await redactar([casi, apenas], [], ULT_RECIENTE);
    const t = r.cuerpo.text.body;
    afirmar('00:30 del día 12 en Madrid es hoy; 00:30 del 13, no', t.includes('*Hoy*\n• Recién hoy (entrega hoy)') && !t.includes('Casi mañana (entrega hoy)') && t.includes('• Casi mañana (mar 13 oct)'), t);
  }

  console.log('Nada pendiente');
  {
    const [a] = await redactar([{}], [{}], ULT_RECIENTE);
    afirmar('texto: se envía igualmente', a.cuerpo.text.body === 'Buenos días. No tienes nada pendiente.', a.cuerpo.text?.body);
    const [c] = await redactar([], ARCH, ULT_RECIENTE);
    afirmar('solo archivos en Entrada: se avisa', c.cuerpo.text.body.includes('*Archivos sin clasificar*') && !c.cuerpo.text.body.includes('No tienes nada pendiente'));
    const [d] = await redactar([AYER], [], ULT_RECIENTE);
    afirmar('solo un evento ya pasado: nada pendiente', d.cuerpo.text.body === 'Buenos días. No tienes nada pendiente.');
  }

  console.log('Mucho contenido y errores');
  {
    const muchas = Array.from({ length: 500 }, (_, i) => item({ tipo: 'nota', titulo: `Nota ${i}`, contenido: 'x'.repeat(120) }));
    const [r] = await redactar([T_HOY, ...muchas], ARCH, ULT_RECIENTE);
    const t = r.cuerpo.text.body;
    afirmar('si no cabe, un solo mensaje de menos de 3.800 caracteres con aviso', t.length <= 3800 && t.endsWith('«qué tengo pendiente».') && t.includes('*Hoy*'), `${t.length}`);
    await lanza('sin número permitido, falla con un mensaje claro', redactar(TODO, ARCH, ULT_RECIENTE, { env: {} }), 'WHATSAPP_NUMERO_PERMITIDO');
    const [x] = await redactar([{ tipo: 'nota' }, { titulo: 'sin tipo' }, ...TODO], ARCH, ULT_RECIENTE);
    afirmar('filas incompletas se ignoran', x.modo === 'texto' && x.cuerpo.text.body.includes('• Dentista, 10:00'));
  }

  console.log('Configuración');
  {
    await lanza('con los valores de ejemplo, avisa de qué falta', correr(CODIGO_CONFIG), 'SUPABASE_URL');
    const buena = CODIGO_CONFIG.replace('TU-PROYECTO', 'abcdefghijk').replace('TU-PHONE-NUMBER-ID', '123456789012345');
    const [r] = await correr(buena);
    afirmar('con valores válidos devuelve la configuración', r.config.supabase_url === 'https://abcdefghijk.supabase.co' && !('nombre_plantilla' in r.config) && !('max_parametro' in r.config) && r.config.ventana_horas === 23, JSON.stringify(r));
    await lanza('rechaza una ventana de más de 24 h', correr(buena.replace('VENTANA_HORAS = 23', 'VENTANA_HORAS = 30')), 'VENTANA_HORAS');
  }

  console.log('Estructura del flujo');
  {
    const f = construirFlujo();
    const por = Object.fromEntries(f.nodes.map((x) => [x.name, x]));
    const trabajo = f.nodes.filter((x) => !x.type.endsWith('stickyNote'));
    afirmar('9 nodos de trabajo', trabajo.length === 9, String(trabajo.length));
    const lv = por['Leer viaje'];
    afirmar('Leer viaje: RPC viajes_vigentes entre Leer último mensaje y Redactar, una vez, y su fallo NO para el resumen (sin la base de datos al día no hay viaje)', lv.parameters.url.endsWith('/rest/v1/rpc/viajes_vigentes') && lv.parameters.method === 'POST' && lv.executeOnce === true && lv.alwaysOutputData === true && lv.onError === 'continueRegularOutput' && f.connections['Leer último mensaje'].main[0][0].node === 'Leer viaje' && f.connections['Leer viaje'].main[0][0].node === 'Redactar resumen');
    afirmar('zona Europe/Madrid', f.settings.timezone === 'Europe/Madrid');
    const regla = por['Cada día a las 7:00'].parameters.rule.interval[0];
    afirmar('programación: cada día a las 7:00', regla.field === 'days' && regla.daysInterval === 1 && regla.triggerAtHour === 7 && regla.triggerAtMinute === 0 && por['Cada día a las 7:00'].typeVersion === 1.4);
    const ids = new Set(f.nodes.map((x) => x.id));
    afirmar('ids únicos', ids.size === f.nodes.length);
    const destinos = Object.values(f.connections).flatMap((c) => c.main.flat().map((d) => d.node));
    afirmar('todas las conexiones apuntan a nodos que existen', destinos.every((d) => d in por) && Object.keys(f.connections).every((o) => o in por));
    // Recorrido: desde cada disparador se llega hasta Enviar WhatsApp pasando por las tres lecturas y la redacción
    const sigue = (nombre, vistos = []) => (nombre === 'Enviar WhatsApp' ? [vistos.concat(nombre)] : (f.connections[nombre]?.main.flat() ?? []).flatMap((d) => sigue(d.node, vistos.concat(nombre))));
    for (const d of ['Cada día a las 7:00', 'Disparador manual']) {
      const ruta = sigue(d)[0] ?? [];
      afirmar(`${d} llega a Enviar WhatsApp por las lecturas y la redacción`, ['Configuración', 'Leer pendientes', 'Leer archivos', 'Leer último mensaje', 'Redactar resumen', 'Enviar WhatsApp'].every((x) => ruta.includes(x)), ruta.join(' > '));
    }
    for (const nom of ['Leer pendientes', 'Leer archivos', 'Leer último mensaje']) {
      const x = por[nom];
      afirmar(`${nom}: GET a Supabase con credencial, una vez, con salida aunque no haya filas y SIN ocultar fallos`, x.parameters.method === 'GET' && x.parameters.nodeCredentialType === 'supabaseApi' && x.executeOnce === true && x.alwaysOutputData === true && x.onError === undefined);
    }
    afirmar('items pendientes: lee las columnas que usa el formato y filtra por estado', por['Leer pendientes'].parameters.url.includes('select=id,tipo,titulo,contenido,lista,estado,fecha_inicio,fecha_fin,fecha_limite,recordar_en,zona_alarma,lugar_alarma,proyecto') && por['Leer pendientes'].parameters.url.includes('estado=eq.pendiente'));
    afirmar('archivos: solo los pendientes', por['Leer archivos'].parameters.url.includes('/rest/v1/archivos?select=id,nombre,drive_url,created_at&estado=eq.pendiente'));
    afirmar('último mensaje: solo ids de WhatsApp, el más reciente', por['Leer último mensaje'].parameters.url.includes('wa_message_id=like.wamid.*') && por['Leer último mensaje'].parameters.url.includes('order=created_at.desc&limit=1'));
    const e = por['Enviar WhatsApp'];
    afirmar('Enviar: POST a Graph con Header Auth y el cuerpo ya construido', e.parameters.method === 'POST' && e.parameters.url.includes('graph.facebook.com') && e.parameters.authentication === 'genericCredentialType' && e.parameters.genericAuthType === 'httpHeaderAuth' && e.parameters.jsonBody === '={{ JSON.stringify($json.cuerpo) }}');
    afirmar('Enviar: reintenta y NO oculta el fallo (la ejecución queda en rojo)', e.retryOnFail === true && e.onError === undefined);
    afirmar('las credenciales no van dentro del JSON', !JSON.stringify(f).match(/EAA[A-Za-z0-9]{20,}/));
    const actual = JSON.stringify(f, null, 2) + '\n';
    const enDisco = fs.existsSync(path.join(__dirname, '..', 'flujos', 'resumen-diario.json')) ? leer('..', 'flujos', 'resumen-diario.json') : null;
    afirmar('flujos/resumen-diario.json está al día (si no, ejecuta node herramientas/generar-resumen.js)', enDisco === actual);
  }

  console.log('Viajes');
  {
    const cuerpoDe = async (viaje, items = TODO, archivos = ARCH) => (await redactar(items, archivos, ULT_RECIENTE, { nodos: { 'Leer viaje': viaje } }))[0].cuerpo.text.body;
    const sin = await cuerpoDe([{ id: 'v', pais: 'Portugal', zona: 'Europe/Lisbon', hasta: null, cerrado_at: null }]);
    afirmar('de viaje sin fecha de vuelta: la segunda línea recuerda dónde está', sin.split('\n')[1] === '🌍 Sigues en Portugal (una hora menos que en España). Cuando vuelvas, dime «he vuelto».' && sin.startsWith('Buenos días. Esto es lo que tienes'), sin.split('\n').slice(0, 3).join(' | '));
    const conFecha = await cuerpoDe([{ id: 'v', pais: 'Portugal', zona: 'Europe/Lisbon', hasta: '2026-10-20', cerrado_at: null }]);
    afirmar('con fecha de vuelta: no se recuerda (vuelve sola a la hora de España)', !conFecha.includes('🌍'));
    afirmar('en un sitio con la misma hora (Francia): no se recuerda', !(await cuerpoDe([{ id: 'v', pais: 'Francia', zona: 'Europe/Paris', hasta: null }])).includes('🌍'));
    afirmar('sin viaje, o sin la base de datos al día (la lectura falla): el resumen de siempre', !(await cuerpoDe([{}])).includes('🌍') && !(await cuerpoDe([{ error: { message: 'HTTP 404' } }])).includes('🌍'));
    const nada = await cuerpoDe([{ id: 'v', pais: 'Japón', zona: 'Asia/Tokyo', hasta: null }], [{}], [{}]);
    afirmar('aunque no tengas nada pendiente, se recuerda dónde estás', nada.startsWith('Buenos días. No tienes nada pendiente.\n🌍 Sigues en Japón (7 horas más que en España)'), nada);
    // Tramo 2: las horas de hoy en la de allí y la línea de la zona al final
    const ny = await cuerpoDe([{ id: 'v', pais: 'Estados Unidos (Nueva York)', zona: 'America/New_York', hasta: '2026-10-20' }], [DENTISTA]);
    afirmar('en Nueva York, el dentista puesto en España sale a las 10:00 sin paréntesis y sin línea final', ny.includes('• Dentista, 10:00') && !ny.includes('🕒') && ny.startsWith('Buenos días. Esto es lo que tienes (lunes 12 oct)'), ny);
    const nyZ = await cuerpoDe([{ id: 'v', pais: 'Estados Unidos (Nueva York)', zona: 'America/New_York', hasta: '2026-10-20' }], [{ ...DENTISTA, fecha_inicio: '2026-10-12T14:00:00+00:00', fecha_fin: '2026-10-12T15:00:00+00:00', zona_alarma: 'America/New_York', lugar_alarma: 'Nueva York' }]);
    afirmar('una cita puesta en Nueva York sale «10:00 (Nueva York)» en «Hoy»', nyZ.includes('• Dentista, 10:00 (Nueva York)'), nyZ);
    const sinHoras = await cuerpoDe([{ id: 'v', pais: 'Portugal', zona: 'Europe/Lisbon', hasta: '2026-10-20' }], [{}], [{}]);
    afirmar('sin horas en el mensaje, sin la línea de la zona', !sinHoras.includes('🕒'), sinHoras);
    const tareaFecha = await cuerpoDe([{ id: 'v', pais: 'Estados Unidos (Nueva York)', zona: 'America/New_York', hasta: '2026-10-20' }], [item({ tipo: 'tarea', titulo: 'Pagar', fecha_limite: '2026-10-15' })], [{}]);
    afirmar('una fecha sin hora (fecha límite) no se corre al día anterior en América', tareaFecha.includes('jue 15 oct'), tareaFecha);
    // las alarmas, a su hora y en su zona, con el sitio si no es Madrid; sin línea de citas si no hay citas
    const alarmaPT = item({ tipo: 'tarea', titulo: 'Avión', recordar_en: '2026-10-13T18:00:00+00:00', zona_alarma: 'Europe/Lisbon', lugar_alarma: 'Portugal' });
    const alarmaES = item({ tipo: 'tarea', titulo: 'Llamar a mamá', recordar_en: '2026-10-13T15:00:00+00:00' });
    const conAlarmas = await cuerpoDe([{ id: 'v', pais: 'Japón', zona: 'Asia/Tokyo', hasta: '2026-10-20' }], [alarmaPT, alarmaES], [{}]);
    afirmar('alarmas: la de Portugal «19:00 (Portugal)» y la de España «17:00» sin paréntesis, aunque estés en Japón; sin línea de citas', conAlarmas.includes('• 🔔 Avión, mar 13 oct, 19:00 (Portugal)') && conAlarmas.includes('• 🔔 Llamar a mamá, mar 13 oct, 17:00') && !conAlarmas.includes('🕒'), conAlarmas);
    // el día antes de un viaje planeado, el aviso y lo que tienes esos días (el reloj de las pruebas es el lunes 12 de octubre, 7:00)
    const conPlan = await cuerpoDe([{ id: 'p', pais: 'Japón', zona: 'Asia/Tokyo', desde: '2026-10-13', hasta: '2026-10-20', cerrado_at: null }], [DENTISTA, item({ tipo: 'evento', titulo: 'Reunión', fecha_inicio: '2026-10-14T08:00:00+00:00', fecha_fin: '2026-10-14T09:00:00+00:00' })], [{}]);
    afirmar('el día antes, «✈️ Mañana te vas a Japón (hasta el …): allí es … Esos días tienes: • 📅 Reunión…»; el viaje planeado no cuenta como actual', conPlan.includes('✈️ Mañana te vas a Japón (hasta el mar 20 oct): allí es 7 horas más que en España. Esos días tienes:\n• 📅 Reunión, mié 14 oct, 10:00') && !conPlan.includes('🌍') && conPlan.includes('• Dentista, 10:00'), conPlan);
    const sinPlan = await cuerpoDe([{ id: 'p', pais: 'Japón', zona: 'Asia/Tokyo', desde: '2026-10-16', hasta: '2026-10-20', cerrado_at: null }], [DENTISTA], [{}]);
    afirmar('… otro día no dice nada del viaje', !sinPlan.includes('✈️'), sinPlan);
    afirmar('estando fuera, el resumen aclara que lo que no lleva país va en hora de España', conAlarmas.endsWith('(Lo que no lleva país va en hora de España.)'), conAlarmas);
    afirmar('… en España, no', !(await cuerpoDe([{}], [item({ tipo: 'tarea', titulo: 'Llamar', recordar_en: '2026-10-13T15:00:00+00:00' })], [{}])).includes('Lo que no lleva país'));
    // Las funciones del viaje son copia exacta de las de planificar.js
    const plan = leer('flujo', 'planificar.js');
    const trozo = (fuente) => { const i = fuente.indexOf('function offsetZona(zona, fecha) {'); return fuente.slice(i, fuente.indexOf('// «Estoy en Portugal», «me voy a Nueva York', i)); };
    afirmar('offsetZona, difConEspana y textoDiferencia son copia exacta de planificar.js', trozo(plan).length > 200 && trozo(plan) === (() => { const i = CODIGO_REDACTAR.indexOf('function offsetZona(zona, fecha) {'); return CODIGO_REDACTAR.slice(i, CODIGO_REDACTAR.indexOf('\n// --- Pegamento con n8n', i)); })());
  }

  console.log(`\n${pasan} pruebas correctas, ${fallan.length} fallos.`);
  if (fallan.length) {
    console.log(fallan.map((x) => ` - ${x}`).join('\n'));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
