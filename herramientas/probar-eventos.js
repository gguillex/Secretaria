// Pruebas sin red ni coste del flujo "Avisos de eventos" (flujos/avisos-eventos.json).
// Ejecuta el código real de herramientas/flujo-eventos/*.js con entradas simuladas y un reloj fijo.
// Uso: node herramientas/probar-eventos.js

const fs = require('fs');
const { credencialesSoloPorNombre } = require('./comun/importacion');
const path = require('path');
const { construirFlujo } = require('./generar-eventos.js');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const leer = (...p) => fs.readFileSync(path.join(__dirname, ...p), 'utf8').replace(/\r\n/g, '\n');
const CODIGO_CONFIG = leer('flujo-eventos', 'configuracion.js');
const CODIGO_FILTRAR = leer('flujo-eventos', 'filtrar.js');
const CODIGO_REDACTAR = leer('flujo-eventos', 'redactar.js');
const CODIGO_REGISTRO = leer('flujo-eventos', 'registrar-aviso.js');

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

const CONFIG = { supabase_url: 'https://abc.supabase.co', phone_number_id: '123456789012345', graph_version: 'v26.0', ventana_horas: 23, max_avisos: 10 };

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

// "Ahora": lunes 12 de octubre de 2026, 9:30 en Madrid (+02:00)
const AHORA = '2026-10-12T07:30:00.000Z';
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U3 = '33333333-3333-4333-8333-333333333333';
const fila = (o) => ({ id: U1, tipo: 'evento', estado: 'pendiente', titulo: 'Dentista', fecha_inicio: '2026-10-12T08:00:00+00:00', aviso_whatsapp_en: '2026-10-12T07:30:00+00:00', aviso_whatsapp_enviado_at: null, ...o });
const filtrar = (filas) => conHora(AHORA, () => correr(CODIGO_FILTRAR, { input: filas }));
const redactar = (eventos, ultimo, extra = {}) =>
  conHora(AHORA, () => correr(CODIGO_REDACTAR, { nodos: { 'Filtrar avisos': [{ eventos }], 'Leer último mensaje': ultimo, ...extra.nodos }, env: extra.env }));

const RECIENTE = [{ created_at: '2026-10-12T05:00:00+00:00' }]; // hace 2 h 30 min
const ANTIGUO = [{ created_at: '2026-10-10T20:00:00+00:00' }]; // hace más de 24 h

async function main() {
  console.log('Configuración');
  {
    const ok = async (c = CODIGO_CONFIG) => correr(c.replace('https://TU-PROYECTO.supabase.co', 'https://abc.supabase.co').replace('TU-PHONE-NUMBER-ID', '123456789012345'));
    const [r] = await ok();
    afirmar('con la URL y el número puestos devuelve la configuración', r.config.supabase_url === 'https://abc.supabase.co' && r.config.phone_number_id === '123456789012345' && r.config.graph_version === 'v26.0' && r.config.ventana_horas === 23 && r.config.max_avisos === 10);
    await lanza('sin poner la URL de Supabase, lanza un error', correr(CODIGO_CONFIG), 'SUPABASE_URL');
    await lanza('sin poner el Phone number ID, lanza un error', correr(CODIGO_CONFIG.replace('https://TU-PROYECTO.supabase.co', 'https://abc.supabase.co')), 'PHONE_NUMBER_ID');
    await lanza('una ventana de más de 24 h se rechaza', ok(CODIGO_CONFIG.replace('VENTANA_HORAS = 23', 'VENTANA_HORAS = 30')), 'VENTANA_HORAS');
  }

  console.log('Filtrar avisos');
  {
    const [ok] = await filtrar([fila()]);
    afirmar('un aviso vencido de un evento futuro pasa', ok.eventos.length === 1 && ok.eventos[0].id === U1 && ok.eventos[0].titulo === 'Dentista');
    afirmar('sin filas no queda nada (el flujo termina)', (await filtrar([{}])).length === 0 && (await filtrar([])).length === 0);
    afirmar('un aviso que aún no ha llegado a su hora no pasa', (await filtrar([fila({ aviso_whatsapp_en: '2026-10-12T07:31:00+00:00' })])).length === 0);
    afirmar('un aviso ya enviado no pasa', (await filtrar([fila({ aviso_whatsapp_enviado_at: '2026-10-12T07:29:00+00:00' })])).length === 0);
    afirmar('un evento que ya empezó no pasa', (await filtrar([fila({ fecha_inicio: '2026-10-12T07:00:00+00:00' })])).length === 0);
    afirmar('un evento hecho o archivado no pasa', (await filtrar([fila({ estado: 'hecho' }), fila({ estado: 'archivado' })])).length === 0);
    afirmar('algo que no es un evento no pasa', (await filtrar([fila({ tipo: 'tarea' })])).length === 0);
    afirmar('un id que no es un UUID no pasa', (await filtrar([fila({ id: "1; drop table items" })])).length === 0);
    afirmar('un título vacío no pasa', (await filtrar([fila({ titulo: '  ' })])).length === 0);
    afirmar('sin aviso programado no pasa', (await filtrar([fila({ aviso_whatsapp_en: null })])).length === 0);
    const varios = await filtrar([fila({ id: U2, titulo: 'B', fecha_inicio: '2026-10-12T09:00:00+00:00' }), fila({ id: U3, titulo: 'A', fecha_inicio: '2026-10-12T08:30:00+00:00' })]);
    afirmar('varios avisos salen ordenados por hora de inicio', varios[0].eventos.map((e) => e.titulo).join() === 'A,B');
    afirmar('hay un tope de avisos por pasada', (await conHora(AHORA, () => correr(CODIGO_FILTRAR, { input: [fila({ id: U1 }), fila({ id: U2 }), fila({ id: U3 })], nodos: { config: { ...CONFIG, max_avisos: 2 } } })))[0].eventos.length === 2);
  }

  console.log('Redactar aviso');
  {
    const [r] = await redactar([{ id: U1, titulo: 'Dentista', fecha_inicio: '2026-10-12T08:00:00+00:00' }], RECIENTE);
    const c = r.cuerpo;
    const [pt] = await redactar([{ id: U1, titulo: 'Dentista', fecha_inicio: '2026-10-12T08:00:00+00:00', zona_alarma: 'Europe/Lisbon', lugar_alarma: 'Portugal' }], RECIENTE);
    afirmar('una cita puesta en hora de Portugal: su hora y su sitio; una de España, sin paréntesis', pt.texto === '⏰ *Dentista* empieza a las 09:00 Portugal (en 30 min).' && r.texto === '⏰ *Dentista* empieza a las 10:00 (en 30 min).', `${pt.texto} | ${r.texto}`);
    afirmar('con la ventana abierta, texto libre al número permitido', c.type === 'text' && c.messaging_product === 'whatsapp' && c.to === '34600111222' && c.text.preview_url === false, JSON.stringify(c));
    afirmar('un solo evento: título, hora de Madrid y minutos que faltan', r.texto === '⏰ *Dentista* empieza a las 10:00 (en 30 min).', r.texto);
    afirmar('lleva los ids y la marca de enviado con la hora actual', r.ids.join() === U1 && r.marca.aviso_whatsapp_enviado_at === AHORA);
    const [v] = await redactar([{ id: U1, titulo: 'Dentista', fecha_inicio: '2026-10-12T08:00:00+00:00' }, { id: U2, titulo: 'Revisión', fecha_inicio: '2026-10-12T09:00:00+00:00' }], RECIENTE);
    afirmar('varios eventos: una lista en un solo mensaje', v.texto === '⏰ *Estos eventos van a empezar*\n• 10:00 Dentista (en 30 min)\n• 11:00 Revisión (en 1 h 30 min)' && v.ids.length === 2, v.texto);
    const [l] = await redactar([{ id: U1, titulo: '*Dentista* _grave_', fecha_inicio: '2026-10-12T08:00:00+00:00' }], RECIENTE);
    afirmar('los caracteres de formato del título no rompen el mensaje', l.texto === '⏰ *Dentista grave* empieza a las 10:00 (en 30 min).', l.texto);
    const [h] = await redactar([{ id: U1, titulo: 'Cena', fecha_inicio: '2026-10-12T15:00:00+00:00' }], RECIENTE);
    afirmar('más de hora y media: horas y minutos', h.texto.includes('(en 7 h 30 min)'), h.texto);
    const [e] = await redactar([{ id: U1, titulo: 'Comida', fecha_inicio: '2026-10-12T09:30:00+00:00' }], RECIENTE);
    afirmar('horas exactas: sin minutos', e.texto.includes('(en 2 h)'), e.texto);
    afirmar('con la ventana cerrada no se envía nada', (await redactar([{ id: U1, titulo: 'Dentista', fecha_inicio: '2026-10-12T08:00:00+00:00' }], ANTIGUO)).length === 0);
    afirmar('sin ningún mensaje tuyo guardado tampoco se envía', (await redactar([{ id: U1, titulo: 'Dentista', fecha_inicio: '2026-10-12T08:00:00+00:00' }], [{}])).length === 0);
    await lanza('sin el número permitido en el entorno, lanza un error', redactar([{ id: U1, titulo: 'Dentista', fecha_inicio: '2026-10-12T08:00:00+00:00' }], RECIENTE, { env: {} }), 'WHATSAPP_NUMERO_PERMITIDO');
    const largo = await redactar(Array.from({ length: 50 }, (_, i) => ({ id: U1, titulo: 'x'.repeat(200) + i, fecha_inicio: '2026-10-12T08:00:00+00:00' })), RECIENTE);
    afirmar('el mensaje nunca supera el límite de WhatsApp', largo[0].texto.length <= 3800);
  }

  console.log('Registro del aviso');
  {
    const reg = await correr(CODIGO_REGISTRO, { input: [{ messages: [{ id: 'wamid.HBgLcita=' }] }], nodos: { 'Redactar aviso': [{ ids: ['0a1b2c3d-0000-4000-8000-000000000001', '0a1b2c3d-0000-4000-8000-000000000002'] }] } });
    afirmar('anota el id del aviso con cada evento, como cita', reg.length === 1 && reg[0].cuerpo.length === 2 && reg[0].cuerpo.every((c) => c.wa_message_id === 'wamid.HBgLcita=' && c.tipo === 'cita'), JSON.stringify(reg));
    const sinId = await correr(CODIGO_REGISTRO, { input: [{}], nodos: { 'Redactar aviso': [{ ids: ['0a1b2c3d-0000-4000-8000-000000000001'] }] } });
    afirmar('sin un id de Meta no anota nada', sinId.length === 0);
  }

  console.log('Flujo generado');
  {
    const flujo = construirFlujo();
    const texto = JSON.stringify(flujo);
    const nombres = flujo.nodes.map((n) => n.name);
    const por = (n) => flujo.nodes.find((x) => x.name === n);
    afirmar('11 nodos de trabajo y 4 notas', flujo.nodes.filter((n) => n.type !== 'n8n-nodes-base.stickyNote').length === 11 && flujo.nodes.length === 15, String(flujo.nodes.length));
    afirmar('Enviar WhatsApp sigue al marcado y, en paralelo, al registro del aviso (que no detiene el flujo)', flujo.connections['Enviar WhatsApp'].main[0].map((d) => d.node).join() === 'Marcar avisados,Preparar registro del aviso' && flujo.nodes.find((n) => n.name === 'Guardar aviso enviado').onError === 'continueRegularOutput');
    afirmar('nombres e ids únicos', new Set(nombres).size === nombres.length && new Set(flujo.nodes.map((n) => n.id)).size === flujo.nodes.length);
    afirmar('las conexiones solo nombran nodos existentes', Object.entries(flujo.connections).every(([o, c]) => nombres.includes(o) && c.main[0].every((d) => nombres.includes(d.node))));
    afirmar('sin claves dentro: las credenciales solo se referencian por nombre', credencialesSoloPorNombre(flujo) && !/sb_secret_|AIza|EAA/.test(texto));
    afirmar('zona horaria de Madrid', flujo.settings.timezone === 'Europe/Madrid');
    afirmar('el JSON sobrevive a un ida y vuelta', JSON.stringify(JSON.parse(texto)) === texto);
    const sch = por('Cada minuto');
    afirmar('se dispara cada minuto', sch.type === 'n8n-nodes-base.scheduleTrigger' && sch.parameters.rule.interval[0].field === 'minutes' && sch.parameters.rule.interval[0].minutesInterval === 1);
    {
      const cadena = ['Configuración', 'Leer avisos vencidos', 'Filtrar avisos', 'Leer último mensaje', 'Redactar aviso', 'Enviar WhatsApp', 'Marcar avisados'];
      afirmar('cadena: Configuración, lectura, filtro, último mensaje, redacción, envío y marcado', cadena.slice(0, -1).every((n, i) => flujo.connections[n].main[0][0].node === cadena[i + 1]));
      afirmar('Leer avisos vencidos lee la zona de cada cita (base de datos)', flujo.nodes.find((n) => n.name === 'Leer avisos vencidos').parameters.url.includes('select=id,tipo,titulo,estado,fecha_inicio,zona_alarma,lugar_alarma,'));
    }
    afirmar('los dos disparadores entran por Configuración', flujo.connections['Cada minuto'].main[0][0].node === 'Configuración' && flujo.connections['Disparador manual'].main[0][0].node === 'Configuración');
    const leerAv = por('Leer avisos vencidos');
    afirmar('Leer avisos vencidos: solo eventos pendientes, aviso vencido, sin enviar y por empezar', ['tipo=eq.evento', 'estado=eq.pendiente', 'aviso_whatsapp_en=lte.', 'aviso_whatsapp_enviado_at=is.null', 'fecha_inicio=gt.'].every((t) => leerAv.parameters.url.includes(t)) && leerAv.alwaysOutputData === true && leerAv.parameters.method === 'GET');
    const envio = por('Enviar WhatsApp');
    afirmar('Enviar WhatsApp: sin onError (si Meta rechaza queda en rojo y no se marca) y credencial de cabecera', envio.onError === undefined && envio.parameters.genericAuthType === 'httpHeaderAuth' && envio.parameters.url.includes('graph_version') && envio.parameters.method === 'POST');
    const marcar = por('Marcar avisados');
    afirmar('Marcar avisados: PATCH que solo toca avisos programados y sin enviar, con reintentos', marcar.parameters.method === 'PATCH' && marcar.parameters.url.includes('aviso_whatsapp_en=not.is.null') && marcar.parameters.url.includes('aviso_whatsapp_enviado_at=is.null') && marcar.parameters.url.includes('tipo=eq.evento') && marcar.retryOnFail === true && marcar.maxTries === 3);
    afirmar('nodos Supabase con credencial predefinida', ['Leer avisos vencidos', 'Leer último mensaje', 'Marcar avisados'].every((n) => por(n).parameters.nodeCredentialType === 'supabaseApi'));
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
