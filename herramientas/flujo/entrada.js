// Nodo "Entrada": frontera entre el origen del mensaje y el núcleo del flujo.
// Contrato de salida (lo único que el núcleo espera): mensaje, fecha_actual, wa_message_id, tipo_entrada, contexto_id, recibido_at (o null) y, solo si el flujo de
// WhatsApp juntó demasiados mensajes seguidos, demasiados (true) y aviso_demasiados (el texto con el que se contesta, sin procesar nada). Si el
// mensaje traía varias peticiones , parte (2, 3…) y antes_en_mensaje (lo que se pidió antes en el mismo mensaje, ya hecho).
//
// Dos orígenes:
//   - Llamada desde el flujo "Secretaria · WhatsApp": el nodo "Al ser llamado" trae { mensaje, wa_message_id, tipo_entrada }.
//   - Prueba manual (Disparador manual): se usa MENSAJE y se inventa un wa_message_id con prefijo manual-.

// === Valores fáciles de cambiar (prueba manual) ===
const MENSAJE = 'Dentista el jueves a las 10';
// ==================================================

const TIPOS_ENTRADA = ['texto', 'audio', 'imagen', 'documento']; // los que admite la columna mensajes.tipo_entrada

// "Al ser llamado" no existe o no se ha ejecutado en una prueba manual: n8n lanza un error al consultarlo
let llamada = null;
try {
  llamada = $('Al ser llamado').first().json;
} catch (e) {
  llamada = null;
}

const ahora = DateTime.now().setZone('Europe/Madrid').setLocale('es');
const fecha_actual = ahora.toFormat("cccc d 'de' LLLL yyyy, HH:mm (ZZ)");

if (llamada && typeof llamada === 'object' && Object.keys(llamada).length > 0) {
  const texto = typeof llamada.mensaje === 'string' ? llamada.mensaje.trim() : '';
  if (texto === '') throw new Error('Entrada: la llamada no trae "mensaje"');
  if (typeof llamada.wa_message_id !== 'string' || llamada.wa_message_id.trim() === '') {
    throw new Error('Entrada: la llamada no trae "wa_message_id"');
  }
  const tipo = llamada.tipo_entrada ?? 'texto';
  if (!TIPOS_ENTRADA.includes(tipo)) throw new Error(`Entrada: tipo_entrada "${tipo}" no válido`);
  // Si el usuario respondió (citó) a un mensaje, id de ese mensaje: sirve para saber a qué archivo se refiere. Vacío si no.
  const contexto_id = typeof llamada.contexto_id === 'string' && /^[A-Za-z0-9._=+\/-]{1,300}$/.test(llamada.contexto_id) ? llamada.contexto_id : '';
  const demasiados = llamada.demasiados === true && typeof llamada.aviso_demasiados === 'string' && llamada.aviso_demasiados.trim() !== '';
  // Cuándo llegó (lo da la cola del flujo de WhatsApp): para saber si el usuario había visto una pregunta abierta
  const recibido_at = typeof llamada.recibido_at === 'string' && !Number.isNaN(Date.parse(llamada.recibido_at)) ? llamada.recibido_at : null;
  // Una de varias peticiones del mismo mensaje : cuál es y lo que se pidió antes en él
  const parte = Number.isInteger(llamada.parte) && llamada.parte > 1 && llamada.parte <= 10 ? llamada.parte : null;
  const antes = parte && typeof llamada.antes_en_mensaje === 'string' ? llamada.antes_en_mensaje.trim().slice(0, 500) : '';
  return [{ json: { mensaje: texto, fecha_actual, wa_message_id: llamada.wa_message_id.trim(), tipo_entrada: tipo, contexto_id, recibido_at, ...(demasiados ? { demasiados: true, aviso_demasiados: llamada.aviso_demasiados.trim().slice(0, 500) } : {}), ...(parte ? { parte, antes_en_mensaje: antes } : {}) } }];
}

if (typeof MENSAJE !== 'string' || MENSAJE.trim() === '') {
  throw new Error('Entrada: MENSAJE está vacío');
}

// El sufijo aleatorio evita chocar con wa_message_id (es unique) si se ejecuta dos veces en el mismo milisegundo
const sufijo = Math.random().toString(36).slice(2, 8);

return [
  {
    json: {
      mensaje: MENSAJE.trim(),
      fecha_actual,
      wa_message_id: `manual-${ahora.toMillis()}-${sufijo}`,
      tipo_entrada: 'texto',
      contexto_id: '',
    },
  },
];
