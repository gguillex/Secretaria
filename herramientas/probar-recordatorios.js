// Pruebas sin red ni coste del flujo "Recordatorios" (flujos/recordatorios.json).
// Ejecuta el código real de herramientas/flujo-recordatorios/*.js con entradas simuladas y un reloj fijo.
// Uso: node herramientas/probar-recordatorios.js

const fs = require('fs');
const { credencialesSoloPorNombre } = require('./comun/importacion');
const path = require('path');
const { construirFlujo } = require('./generar-recordatorios.js');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const leer = (...p) => fs.readFileSync(path.join(__dirname, ...p), 'utf8').replace(/\r\n/g, '\n');
const CODIGO_CONFIG = leer('flujo-recordatorios', 'configuracion.js');
const CODIGO_FILTRAR = leer('flujo-recordatorios', 'filtrar.js');
const CODIGO_REDACTAR = leer('flujo-recordatorios', 'redactar.js');
const CODIGO_MARCAS = leer('flujo-recordatorios', 'preparar-marcas.js');
const CODIGO_REGISTRO = leer('flujo-recordatorios', 'registrar-aviso.js');

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

const CONFIG = { supabase_url: 'https://abc.supabase.co', phone_number_id: '123456789012345', graph_version: 'v26.0', avisos_min: [60, 30, 0], ventana_horas: 23, margen_atrasado_min: 15, max_por_mensaje: 10 };

function simular(nodos) {
  return (nombre) => {
    if (nombre === 'Configuración') return { first: () => ({ json: { config: nodos.config ?? CONFIG } }) };
    if (!(nombre in nodos)) throw new Error(`Node "${nombre}" hasn't been executed`);
    const items = nodos[nombre].map((json) => ({ json }));
    return { all: () => items, first: () => items[0] };
  };
}
async function correr(codigo, { input = [], nodos = {}, env = { WHATSAPP_NUMERO_PERMITIDO: '34600111222' } } = {}) {
  const items = input.map((json) => ({ json }));
  const fn = new AsyncFunction('$input', '$', '$env', codigo);
  const salida = await fn({ all: () => items, first: () => items[0] }, simular(nodos), env);
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

// "Ahora": lunes 12 de octubre de 2026, 17:40 en Madrid (+02:00) = 15:40 UTC. El recordatorio de prueba es a las 18:30 (16:30 UTC).
const AHORA = '2026-10-12T15:40:00.000Z';
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U3 = '33333333-3333-4333-8333-333333333333';
const fila = (o) => ({ id: U1, estado: 'pendiente', titulo: 'Sacar la ropa', recordar_en: '2026-10-12T16:30:00+00:00', recordatorio_avisos: [], updated_at: '2026-10-12T15:00:00+00:00', ...o });
const filtrar = (filas, cuando = AHORA, config = CONFIG) => conHora(cuando, () => correr(CODIGO_FILTRAR, { input: filas, nodos: { config } }));
const rec = (o) => ({ id: U1, titulo: 'Sacar la ropa', recordar_en: '2026-10-12T16:30:00+00:00', aviso: 60, atrasado: false, avisos_nuevos: [60], hecho: false, ...o });
const redactar = (recordatorios, ultimo, extra = {}) =>
  conHora(extra.cuando ?? AHORA, () => correr(CODIGO_REDACTAR, { nodos: { 'Filtrar recordatorios': [{ recordatorios }], 'Leer último mensaje': ultimo, ...extra.nodos }, env: extra.env }));
const RECIENTE = [{ created_at: '2026-10-12T15:30:00+00:00' }];
const ANTIGUO = [{ created_at: '2026-10-10T20:00:00+00:00' }];

async function main() {
  console.log('Configuración');
  {
    const ok = async (c = CODIGO_CONFIG) => correr(c.replace('https://TU-PROYECTO.supabase.co', 'https://abc.supabase.co').replace('TU-PHONE-NUMBER-ID', '123456789012345'));
    const [r] = await ok();
    afirmar('con la URL y el número puestos devuelve la configuración, con los avisos de mayor a menor', r.config.supabase_url === 'https://abc.supabase.co' && r.config.phone_number_id === '123456789012345' && r.config.avisos_min.join() === '60,30,0' && r.config.ventana_horas === 23 && r.config.margen_atrasado_min === 15 && r.config.max_por_mensaje === 10, JSON.stringify(r.config));
    await lanza('sin poner la URL de Supabase, lanza un error', correr(CODIGO_CONFIG), 'SUPABASE_URL');
    await lanza('sin poner el Phone number ID, lanza un error', correr(CODIGO_CONFIG.replace('https://TU-PROYECTO.supabase.co', 'https://abc.supabase.co')), 'PHONE_NUMBER_ID');
    const con = (avisos) => ok(CODIGO_CONFIG.replace('AVISOS_MIN = [60, 30, 0]', `AVISOS_MIN = ${avisos}`));
    afirmar('se puede cambiar los avisos (por ejemplo 2 horas, 15 minutos y a la hora)', (await con('[15, 120, 0]'))[0].config.avisos_min.join() === '120,15,0');
    await lanza('los avisos deben incluir el 0 (el aviso «a la hora»)', con('[60, 30]'), 'AVISOS_MIN');
    await lanza('los avisos no pueden repetirse', con('[60, 60, 0]'), 'AVISOS_MIN');
    await lanza('los avisos no pueden estar vacíos ni ser negativos', con('[]'), 'AVISOS_MIN');
    await lanza('los avisos no pueden ser negativos', con('[-5, 0]'), 'AVISOS_MIN');
    await lanza('una ventana de más de 24 h se rechaza', ok(CODIGO_CONFIG.replace('VENTANA_HORAS = 23', 'VENTANA_HORAS = 30')), 'VENTANA_HORAS');
  }

  console.log('Filtrar recordatorios');
  {
    const [a] = await filtrar([fila()]);
    afirmar('a 50 minutos de las 18:30 toca el aviso de 1 hora antes', a.recordatorios.length === 1 && a.recordatorios[0].aviso === 60 && a.recordatorios[0].atrasado === false && a.recordatorios[0].hecho === false && a.recordatorios[0].avisos_nuevos.join() === '60', JSON.stringify(a));
    afirmar('sin filas no queda nada (el flujo termina)', (await filtrar([{}])).length === 0 && (await filtrar([])).length === 0);
    const [z] = await filtrar([fila({ zona_alarma: 'Europe/Lisbon', lugar_alarma: 'Portugal' })]);
    afirmar('la zona de la alarma pasa a la redacción; sin zona, null', z.recordatorios[0].zona_alarma === 'Europe/Lisbon' && z.recordatorios[0].lugar_alarma === 'Portugal' && a.recordatorios[0].zona_alarma === null);
    afirmar('un aviso ya enviado no se repite', (await filtrar([fila({ recordatorio_avisos: [60] })])).length === 0);
    afirmar('todavía no ha llegado el momento del siguiente aviso (30 minutos antes son las 18:00)', (await filtrar([fila({ recordatorio_avisos: [60] })], '2026-10-12T15:59:00.000Z')).length === 0);
    const b = await filtrar([fila({ recordatorio_avisos: [60] })], '2026-10-12T16:00:00.000Z');
    afirmar('a las 18:00 toca el de 30 minutos antes', b[0].recordatorios[0].aviso === 30 && b[0].recordatorios[0].avisos_nuevos.join() === '60,30');
    const c = await filtrar([fila({ recordatorio_avisos: [60, 30] })], '2026-10-12T16:30:00.000Z');
    afirmar('a las 18:30 toca «a la hora» y el recordatorio se da por hecho', c[0].recordatorios[0].aviso === 0 && c[0].recordatorios[0].hecho === true && c[0].recordatorios[0].atrasado === false && c[0].recordatorios[0].avisos_nuevos.join() === '60,30,0');
    const d = await filtrar([fila()], '2026-10-12T16:05:00.000Z');
    afirmar('si venció más de uno a la vez (flujo parado) se anuncia solo el más cercano y todos se dan por enviados', d[0].recordatorios[0].aviso === 30 && d[0].recordatorios[0].avisos_nuevos.join() === '60,30' && d[0].recordatorios[0].hecho === false);
    const e = await filtrar([fila({ recordatorio_avisos: [60, 30] })], '2026-10-12T17:00:00.000Z');
    afirmar('«a la hora» con más de 15 minutos de retraso se marca como atrasado', e[0].recordatorios[0].aviso === 0 && e[0].recordatorios[0].atrasado === true && e[0].recordatorios[0].hecho === true);
    const f = await filtrar([fila({ recordatorio_avisos: [60, 30] })], '2026-10-12T16:45:00.000Z');
    afirmar('con 15 minutos justos de retraso todavía no es atrasado', f[0].recordatorios[0].atrasado === false);
    // Creado tarde: no se avisa tarde de lo que no se prometió
    afirmar('un recordatorio creado a las 17:40 para las 18:30: el aviso de 1 hora antes (17:30) ya no vence nunca', (await filtrar([fila({ updated_at: '2026-10-12T15:40:00+00:00' })])).length === 0);
    const g = await filtrar([fila({ updated_at: '2026-10-12T15:40:00+00:00' })], '2026-10-12T16:00:00.000Z');
    afirmar('y el de 30 minutos antes (18:00) sí vence a su hora', g[0].recordatorios[0].aviso === 30 && g[0].recordatorios[0].avisos_nuevos.join() === '30');
    const h = await filtrar([fila({ recordar_en: '2026-10-12T16:00:00+00:00', updated_at: '2026-10-12T15:40:00+00:00' })], '2026-10-12T16:00:00.000Z');
    afirmar('un recordatorio creado a 20 minutos solo avisa «a la hora»', h[0].recordatorios[0].aviso === 0 && h[0].recordatorios[0].avisos_nuevos.join() === '0' && h[0].recordatorios[0].hecho === true);
    // Revalidación
    afirmar('un recordatorio hecho no se avisa', (await filtrar([fila({ estado: 'hecho' })])).length === 0);
    afirmar('un id que no es un UUID no pasa', (await filtrar([fila({ id: '1; drop table items' })])).length === 0);
    afirmar('un título vacío no pasa', (await filtrar([fila({ titulo: '  ' })])).length === 0);
    afirmar('una hora que no es una fecha no pasa', (await filtrar([fila({ recordar_en: 'pronto' }), fila({ recordar_en: null })])).length === 0);
    afirmar('avisos enviados mal formados no rompen nada', (await filtrar([fila({ recordatorio_avisos: 'x' })]))[0].recordatorios[0].aviso === 60 && (await filtrar([fila({ recordatorio_avisos: [null, 'a', 60] })])).length === 0);
    const varios = await filtrar([fila({ id: U2, titulo: 'Segundo', recordar_en: '2026-10-12T16:40:00+00:00' }), fila({ id: U3, titulo: 'Primero', recordar_en: '2026-10-12T16:20:00+00:00' })]);
    afirmar('varios recordatorios salen ordenados por su hora', varios[0].recordatorios.map((r) => r.titulo).join() === 'Primero,Segundo');
    const topado = await filtrar([fila(), fila({ id: U2 }), fila({ id: U3 })], AHORA, { ...CONFIG, max_por_mensaje: 2 });
    afirmar('hay un tope de recordatorios por mensaje', topado[0].recordatorios.length === 2);
    const otros = await filtrar([fila({ recordar_en: '2026-10-12T16:00:00+00:00' })], '2026-10-12T15:50:00.000Z', { ...CONFIG, avisos_min: [10, 0] });
    afirmar('los avisos salen de la configuración (aquí 10 minutos antes y a la hora)', otros[0].recordatorios[0].aviso === 10 && otros[0].recordatorios[0].avisos_nuevos.join() === '10', JSON.stringify(otros));
  }

  console.log('Redactar recordatorio');
  {
    const [r] = await redactar([rec()], RECIENTE);
    const c = r.cuerpo;
    afirmar('con la ventana abierta, texto libre al número permitido', c.type === 'text' && c.messaging_product === 'whatsapp' && c.to === '34600111222' && c.text.preview_url === false, JSON.stringify(c));
    afirmar('1 hora antes: «En 1 hora» y la hora de Madrid', r.texto === '🔔 En 1 hora: *Sacar la ropa* (18:30)', r.texto);
    const PT = { zona_alarma: 'Europe/Lisbon', lugar_alarma: 'Portugal' };
    const [pt] = await redactar([rec(PT)], RECIENTE);
    afirmar('una alarma puesta en hora de Portugal: su hora y su sitio', pt.texto === '🔔 En 1 hora: *Sacar la ropa* (17:30 Portugal)', pt.texto);
    const [pta] = await redactar([rec({ ...PT, aviso: 0, atrasado: true, hecho: true })], RECIENTE);
    afirmar('… también atrasada', pta.texto === '🔔 Recordatorio atrasado (era a las 17:30 Portugal): *Sacar la ropa*', pta.texto);
    const [mal] = await redactar([rec({ zona_alarma: 'Marte/Olimpo', lugar_alarma: 'Marte' })], RECIENTE);
    afirmar('una zona que no existe: en hora de España, sin romper el aviso', mal.texto === r.texto, mal.texto);
    const [t] = await redactar([rec({ aviso: 30, avisos_nuevos: [60, 30] })], RECIENTE);
    afirmar('30 minutos antes', t.texto === '🔔 En 30 minutos: *Sacar la ropa* (18:30)', t.texto);
    const [n] = await redactar([rec({ aviso: 0, avisos_nuevos: [60, 30, 0], hecho: true })], RECIENTE);
    afirmar('a la hora: «Ahora»', n.texto === '🔔 Ahora: *Sacar la ropa*', n.texto);
    const [a] = await redactar([rec({ aviso: 0, atrasado: true, hecho: true })], RECIENTE);
    afirmar('atrasado: dice a qué hora era', a.texto === '🔔 Recordatorio atrasado (era a las 18:30): *Sacar la ropa*', a.texto);
    const [dos] = await redactar([rec({ aviso: 120 }), rec({ aviso: 90, id: U2 })], RECIENTE);
    afirmar('antelaciones de varias horas o de minutos que no son 30/60 se dicen bien', dos.texto.includes('• En 2 horas: Sacar la ropa (18:30)') && dos.texto.includes('• En 90 minutos: Sacar la ropa (18:30)'), dos.texto);
    const [v] = await redactar([rec({ titulo: 'Uno', aviso: 30 }), rec({ titulo: 'Dos', id: U2, aviso: 0, hecho: true }), rec({ titulo: 'Tres', id: U3, aviso: 0, atrasado: true })], RECIENTE);
    afirmar('varios: un mensaje con una línea por recordatorio', v.texto === '🔔 *Recordatorios*\n• En 30 minutos: Uno (18:30)\n• Ahora: Dos\n• Atrasado (era a las 18:30): Tres', v.texto);
    const [l] = await redactar([rec({ titulo: '*Ropa* _ya_' })], RECIENTE);
    afirmar('los caracteres de formato del título no rompen el mensaje', l.texto === '🔔 En 1 hora: *Ropa ya* (18:30)', l.texto);
    afirmar('las marcas llevan id, hora, avisos y si queda hecho', r.marcas.length === 1 && r.marcas[0].id === U1 && r.marcas[0].recordar_en === '2026-10-12T16:30:00+00:00' && r.marcas[0].avisos.join() === '60' && r.marcas[0].hecho === false && n.marcas[0].hecho === true);
    afirmar('con la ventana cerrada no se envía nada (y no se marca: el aviso espera)', (await redactar([rec()], ANTIGUO)).length === 0);
    afirmar('sin ningún mensaje tuyo guardado tampoco se envía', (await redactar([rec()], [{}])).length === 0);
    afirmar('justo en el límite de 23 h la ventana se considera cerrada', (await redactar([rec()], [{ created_at: '2026-10-11T16:40:00+00:00' }])).length === 0 && (await redactar([rec()], [{ created_at: '2026-10-11T16:41:00+00:00' }])).length === 1);
    await lanza('sin el número permitido en el entorno, lanza un error', redactar([rec()], RECIENTE, { env: {} }), 'WHATSAPP_NUMERO_PERMITIDO');
    const largo = await redactar(Array.from({ length: 10 }, (_, i) => rec({ id: U1, titulo: 'x'.repeat(500) + i })), RECIENTE);
    afirmar('el mensaje nunca supera el límite de WhatsApp', largo[0].texto.length <= 3800);
  }

  console.log('Preparar marcas');
  {
    const marcas = [
      { id: U1, recordar_en: '2026-10-12T16:30:00+00:00', avisos: [60], hecho: false },
      { id: U2, recordar_en: '2026-10-12T16:30:00+00:00', avisos: [60, 30, 0], hecho: true },
    ];
    const m = await correr(CODIGO_MARCAS, { nodos: { 'Redactar recordatorio': [{ marcas }] } });
    afirmar('una petición por recordatorio', m.length === 2);
    afirmar('la URL repite las condiciones: mismo id, tarea, pendiente y misma hora (con el + codificado)', m[0].url === `https://abc.supabase.co/rest/v1/items?id=eq.${U1}&tipo=eq.tarea&estado=eq.pendiente&recordar_en=eq.2026-10-12T16%3A30%3A00%2B00%3A00`, m[0].url);
    afirmar('un aviso intermedio solo anota los avisos enviados', JSON.stringify(m[0].cuerpo) === '{"recordatorio_avisos":[60]}');
    afirmar('el aviso «a la hora» además da el recordatorio por hecho', JSON.stringify(m[1].cuerpo) === '{"recordatorio_avisos":[60,30,0],"estado":"hecho"}');
  }

  console.log('Registro del aviso');
  {
    const marcas = [{ id: '0a1b2c3d-0000-4000-8000-000000000001' }, { id: '0a1b2c3d-0000-4000-8000-000000000002' }, { id: '0a1b2c3d-0000-4000-8000-000000000001' }];
    const reg = await correr(CODIGO_REGISTRO, { input: [{ messages: [{ id: 'wamid.HBgLabc+/=' }] }], nodos: { 'Redactar recordatorio': [{ marcas }] } });
    afirmar('anota el id del aviso con cada recordatorio (sin repetir), como alarma', reg.length === 1 && reg[0].cuerpo.length === 2 && reg[0].cuerpo.every((c) => c.wa_message_id === 'wamid.HBgLabc+/=' && c.tipo === 'alarma') && reg[0].cuerpo[1].item_id === '0a1b2c3d-0000-4000-8000-000000000002', JSON.stringify(reg));
    afirmar('POST a avisos_enviados con on_conflict (un reintento no duplica)', reg[0].url === 'https://abc.supabase.co/rest/v1/avisos_enviados?on_conflict=wa_message_id,item_id');
    const sinId = await correr(CODIGO_REGISTRO, { input: [{ messages: [] }], nodos: { 'Redactar recordatorio': [{ marcas }] } });
    const raro = await correr(CODIGO_REGISTRO, { input: [{ messages: [{ id: 'id con espacios' }] }], nodos: { 'Redactar recordatorio': [{ marcas }] } });
    afirmar('sin un id válido de Meta no anota nada', sinId.length === 0 && raro.length === 0);
    const malos = await correr(CODIGO_REGISTRO, { input: [{ messages: [{ id: 'wamid.x' }] }], nodos: { 'Redactar recordatorio': [{ marcas: [{ id: 'no-es-uuid' }] }] } });
    afirmar('ids que no son uuid se descartan', malos.length === 0);
  }

  console.log('Flujo generado');
  {
    const flujo = construirFlujo();
    const texto = JSON.stringify(flujo);
    const nombres = flujo.nodes.map((n) => n.name);
    const por = (n) => flujo.nodes.find((x) => x.name === n);
    afirmar('12 nodos de trabajo y 4 notas', flujo.nodes.filter((n) => n.type !== 'n8n-nodes-base.stickyNote').length === 12 && flujo.nodes.length === 16, String(flujo.nodes.length));
    const guardarAviso = flujo.nodes.find((n) => n.name === 'Guardar aviso enviado');
    afirmar('Enviar WhatsApp sigue a las marcas y, en paralelo, al registro del aviso (que no detiene el flujo)', flujo.connections['Enviar WhatsApp'].main[0].map((d) => d.node).join() === 'Preparar marcas,Preparar registro del aviso' && flujo.connections['Preparar registro del aviso'].main[0][0].node === 'Guardar aviso enviado' && guardarAviso.onError === 'continueRegularOutput' && guardarAviso.parameters.headerParameters.parameters[0].value === 'resolution=ignore-duplicates,return=minimal');
    afirmar('nombres e ids únicos', new Set(nombres).size === nombres.length && new Set(flujo.nodes.map((n) => n.id)).size === flujo.nodes.length);
    afirmar('las conexiones solo nombran nodos existentes', Object.entries(flujo.connections).every(([o, c]) => nombres.includes(o) && c.main[0].every((d) => nombres.includes(d.node))));
    afirmar('sin claves dentro: las credenciales solo se referencian por nombre', credencialesSoloPorNombre(flujo) && !/sb_secret_|AIza|EAA/.test(texto));
    afirmar('zona horaria de Madrid', flujo.settings.timezone === 'Europe/Madrid');
    afirmar('el JSON sobrevive a un ida y vuelta', JSON.stringify(JSON.parse(texto)) === texto);
    const sch = por('Cada minuto');
    afirmar('se dispara cada minuto', sch.type === 'n8n-nodes-base.scheduleTrigger' && sch.parameters.rule.interval[0].field === 'minutes' && sch.parameters.rule.interval[0].minutesInterval === 1);
    const cadena = ['Configuración', 'Leer recordatorios', 'Filtrar recordatorios', 'Leer último mensaje', 'Redactar recordatorio', 'Enviar WhatsApp', 'Preparar marcas', 'Marcar avisados'];
    afirmar('cadena: Configuración, lectura, filtro, último mensaje, redacción, envío, marcas y marcado', cadena.slice(0, -1).every((n, i) => flujo.connections[n].main[0][0].node === cadena[i + 1]));
    afirmar('Leer recordatorios lee la zona de cada alarma (base de datos)', por('Leer recordatorios').parameters.url.includes('select=id,titulo,estado,recordar_en,zona_alarma,lugar_alarma,recordatorio_avisos,updated_at&'));
    afirmar('los dos disparadores entran por Configuración', flujo.connections['Cada minuto'].main[0][0].node === 'Configuración' && flujo.connections['Disparador manual'].main[0][0].node === 'Configuración');
    const lee = por('Leer recordatorios');
    afirmar('Leer recordatorios: solo tareas pendientes con hora de aviso que ya cae dentro de la antelación máxima', ['tipo=eq.tarea', 'estado=eq.pendiente', 'recordar_en=lte.', 'avisos_min', 'recordatorio_avisos', 'updated_at'].every((t) => lee.parameters.url.includes(t)) && lee.alwaysOutputData === true && lee.parameters.method === 'GET');
    afirmar('Leer recordatorios no pide nada que sea un evento (no toca Calendar)', !lee.parameters.url.includes('tipo=eq.evento') && !JSON.stringify(flujo).includes('googleapis.com/calendar'));
    const envio = por('Enviar WhatsApp');
    afirmar('Enviar WhatsApp: sin onError (si Meta rechaza queda en rojo y no se marca) y credencial de cabecera', envio.onError === undefined && envio.parameters.genericAuthType === 'httpHeaderAuth' && envio.parameters.method === 'POST' && envio.parameters.url.includes('graph_version'));
    const marcar = por('Marcar avisados');
    afirmar('Marcar avisados: PATCH por expresión (una petición por recordatorio), con reintentos y credencial de Supabase', marcar.parameters.method === 'PATCH' && marcar.parameters.url === '={{ $json.url }}' && marcar.parameters.jsonBody === '={{ JSON.stringify($json.cuerpo) }}' && marcar.retryOnFail === true && marcar.maxTries === 3 && marcar.parameters.nodeCredentialType === 'supabaseApi');
    afirmar('nodos Supabase con credencial predefinida', ['Leer recordatorios', 'Leer último mensaje', 'Marcar avisados'].every((n) => por(n).parameters.nodeCredentialType === 'supabaseApi'));
    afirmar('Configuración conserva los marcadores que hay que editar', por('Configuración').parameters.jsCode.includes('TU-PROYECTO') && por('Configuración').parameters.jsCode.includes('TU-PHONE-NUMBER-ID'));
  }

  console.log(`\n${pasan} comprobaciones correctas, ${fallan.length} con fallo.`);
  if (fallan.length) {
    console.log('Fallan:\n- ' + fallan.join('\n- '));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
