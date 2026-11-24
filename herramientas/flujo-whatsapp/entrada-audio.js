// Nodo "Entrada del audio": devuelve los audios ya transcritos (los de "Leer transcripción" que salieron bien) tal como los espera la cola:
// mensaje, wa_message_id, tipo_entrada y contexto_id. (No hay eco de lo entendido.)

const transcritos = $('Leer transcripción')
  .all()
  .map((x) => x.json)
  .filter((j) => j && j.ok === true && typeof j.mensaje === 'string' && typeof j.wa_message_id === 'string');

return transcritos.map((j) => ({ json: { ok: true, mensaje: j.mensaje, wa_message_id: j.wa_message_id, tipo_entrada: 'audio', contexto_id: j.contexto_id || '' } }));
