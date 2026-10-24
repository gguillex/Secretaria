// Nodo "Decidir vaciado" : con lo que contestó Drive al listar el contenido de cada carpeta («Mirar si está vacía», en el mismo orden
// que «Preparar vaciado»), deja pasar SOLO las que están vacías de verdad (ni archivos ni carpetas, tampoco lo subido a mano). Las que tienen algo
// se quedan pendientes (la base de datos las cierra a los 30 minutos); si Drive falla, se reintenta en la pasada siguiente.

function decidirVaciado(preparados, listados) {
  const salida = [];
  preparados.forEach((p, i) => {
    const r = listados[i] ?? {};
    const ok = !r.error && r.statusCode >= 200 && r.statusCode < 300 && Array.isArray(r.body?.files);
    if (ok && r.body.files.length === 0 && !r.body.nextPageToken) salida.push({ json: { vaciar: p.vaciar } });
  });
  return salida;
}

// --- Pegamento con n8n ---
return decidirVaciado($('Preparar vaciado').all().map((i) => i.json), $input.all().map((i) => i.json));
