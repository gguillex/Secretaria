// Nodo "Redactar aviso": convierte el fallo de otro flujo (lo que entrega el Error Trigger) en UN aviso corto de WhatsApp.
//
// - Un fallo que se repite cada minuto (Calendar o Drive) no manda un mensaje por minuto: como mucho un aviso por flujo cada
//   ENFRIAMIENTO_MIN minutos y MAX_AVISOS_DIA al día. Lo que se calló se cuenta en el siguiente aviso ("se repitió N veces").
//   El estado se guarda en el almacén del propio flujo ($getWorkflowStaticData), que solo persiste en ejecuciones de producción.
// - El mensaje de un error puede arrastrar una URL o un token: se quitan las cadenas largas sin espacios y se recorta.
// - Devuelve el cuerpo del mensaje de texto libre. No hay plantilla de reserva (sin plantillas): si la
//   ventana de 24 h de Meta está cerrada, Meta lo rechaza y el fallo solo se ve en n8n (la ejecución de este flujo queda en rojo).
//
// Formato del Error Trigger (documentación de n8n): { execution: { id, url, error: { message, stack }, lastNodeExecuted, mode },
// workflow: { id, name } }. Si falla el disparador del propio flujo: { trigger: { error: { message, node, … }, mode }, workflow }.

const config = $('Configuración').first().json.config;
// El fallo se lee del propio Error Trigger y NO de la entrada de este nodo: entre los dos va "Configuración", que sustituye los datos por
// su configuración (caso real: el aviso llegaba sin el flujo ni la causa porque se leía la configuración como si fuera el fallo).
const datos = $('Error Trigger').first().json ?? {};
const ZONA = 'Europe/Madrid';

const textoLimpio = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
// Cadenas largas sin espacios (tokens, ids, URL con parámetros): no deben viajar por WhatsApp
const sinSecretos = (s) => s.replace(/[A-Za-z0-9_\-+=\/.:?&%]{32,}/g, '…');
const recortar = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

const para = String($env.WHATSAPP_NUMERO_PERMITIDO ?? '').replace(/\D/g, '');
if (!para) throw new Error('Redactar aviso: falta WHATSAPP_NUMERO_PERMITIDO en el entorno de n8n');

const flujo = recortar(sinSecretos(textoLimpio(datos.workflow?.name)) || 'un flujo', 60);
const exe = datos.execution ?? {};
const errTrigger = datos.trigger?.error ?? {};
const mensaje = recortar(sinSecretos(textoLimpio(exe.error?.message ?? errTrigger.message ?? errTrigger.cause?.message)) || 'sin detalle', 220);
const nodoBruto = exe.lastNodeExecuted ?? (typeof errTrigger.node === 'string' ? errTrigger.node : errTrigger.node?.name);
const nodo = recortar(sinSecretos(textoLimpio(nodoBruto)), 60);
const idEjecucion = /^[A-Za-z0-9_-]{1,40}$/.test(String(exe.id ?? '')) ? String(exe.id) : '';

// --- Límites: enfriamiento por flujo y tope diario ---
const estado = $getWorkflowStaticData('global');
estado.ultimos = estado.ultimos && typeof estado.ultimos === 'object' ? estado.ultimos : {};
const ahora = Date.now();
const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ahora));
if (!estado.dia || estado.dia.fecha !== hoy) estado.dia = { fecha: hoy, enviados: 0 };

// --- Errores de red en flujos que se repiten solos: se toleran hasta que duren TOLERANCIA_RED_MIN minutos ---
// Un episodio sigue abierto mientras el siguiente fallo de red llegue en menos de HUECO_EPISODIO_MIN minutos del anterior.
const HUECO_EPISODIO_MIN = 15;
// También un error interno del servicio (500 de Google: «The service was not able to process your request»):
// pasajero como los demás; si dura 30 minutos, avisa igual.
const ERROR_DE_RED = /timed out|timeout|bad gateway|gateway time-?out|service unavailable|\b50[0234]\b|internal server error|internal error|backend ?error|not able to process your request|econnreset|econnrefused|etimedout|enotfound|eai_again|socket hang up/i;
let minutosConRed = 0;
if (ERROR_DE_RED.test(mensaje) && (config.flujos_periodicos ?? []).includes(flujo) && config.tolerancia_red_min > 0) {
  estado.red = estado.red && typeof estado.red === 'object' ? estado.red : {};
  let ep = estado.red[flujo];
  if (!ep || ahora - ep.ultimo > HUECO_EPISODIO_MIN * 60000) ep = estado.red[flujo] = { desde: ahora, ultimo: ahora };
  ep.ultimo = ahora;
  minutosConRed = Math.round((ahora - ep.desde) / 60000);
  if (minutosConRed < config.tolerancia_red_min) return []; // lo recoge el ciclo siguiente: aún no es una caída
}

const previo = estado.ultimos[flujo];
if (previo && ahora - previo.t < config.enfriamiento_min * 60000) {
  previo.repetidos = (previo.repetidos ?? 0) + 1;
  return []; // el mismo flujo ya avisó hace poco
}
if (estado.dia.enviados >= config.max_avisos_dia) return []; // tope diario alcanzado

const repetidos = previo?.repetidos ?? 0;
estado.ultimos[flujo] = { t: ahora, repetidos: 0 };
estado.dia.enviados += 1;

const partes = [`⚠️ Fallo en «${flujo}»${nodo ? ` (nodo «${nodo}»)` : ''}: ${mensaje}.`];
if (idEjecucion) partes.push(`Ejecución ${idEjecucion}.`);
if (minutosConRed > 0) partes.push(`Lleva ${minutosConRed} min fallando por la red.`);
if (repetidos > 0) partes.push(`Se repitió ${repetidos} ${repetidos === 1 ? 'vez' : 'veces'} desde el último aviso.`);
const texto = recortar(partes.join(' ').replace(/\.\./g, '.'), 900);

const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to: para };
return [
  {
    json: {
      texto,
      cuerpo_texto: { ...base, type: 'text', text: { preview_url: false, body: texto } },
    },
  },
];
