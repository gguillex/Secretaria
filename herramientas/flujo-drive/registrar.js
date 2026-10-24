// Nodo "Registrar": convierte la respuesta de Drive de cada acción en la actualización que hay que hacer en
// Supabase. La respuesta llega completa (statusCode, body) porque el nodo de Drive no falla ante errores HTTP.
//
// Cada escritura lleva una condición sobre updated_at (el valor que leyó "Leer pendientes"): si el archivo cambió
// mientras se movía, esa actualización no afecta a ninguna fila y el archivo sigue pendiente.

// --- Pegamento con n8n ---
const config = $('Configuración').first().json.config;
const base = `${config.supabase_url}/rest/v1`;
const plan = $('Planificar').all().map((i) => i.json);
const respuestas = $input.all().map((i) => i.json);

const resumen = (cuerpo) => String(typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo ?? '')).slice(0, 200);

const escrituras = [];
const fallos = [];
let hechas = 0;

respuestas.forEach((r, i) => {
  const p = plan[i];
  const estado = r.statusCode;
  if (!(estado >= 200 && estado < 300)) {
    const motivo = r.error ? String(r.error.message ?? r.error) : `HTTP ${estado} ${resumen(r.body)}`;
    fallos.push(`${p.etiqueta}: ${motivo}`);
    return;
  }
  hechas += 1;
  // Una carpeta creada se anota (base de datos 1.5): la pasada siguiente, 10 s después, la cuenta aunque Drive aún no la liste
  if (p.tipo === 'crear_carpeta') {
    const idNueva = r.body?.id;
    const padre = Array.isArray(p.cuerpo?.parents) ? p.cuerpo.parents[0] : null;
    if (typeof idNueva === 'string' && idNueva !== '' && typeof padre === 'string') {
      escrituras.push({
        json: {
          etiqueta: `anotar carpeta creada ${p.cuerpo.name}`,
          metodo: 'POST',
          url: `${base}/carpetas_creadas?on_conflict=drive_id`,
          cuerpo: { drive_id: idNueva, padre_id: padre, nombre: p.cuerpo.name },
          prefer: 'resolution=merge-duplicates,return=minimal',
        },
      });
    }
    return;
  }

  // Una carpeta pedida que ya existe entera: se limpia su marca y se guarda el id de la última carpeta de la ruta
  if (p.tipo === 'carpeta_lista') {
    escrituras.push({
      json: {
        etiqueta: p.etiqueta,
        metodo: 'PATCH',
        url: `${base}/carpetas_pedidas?id=eq.${encodeURIComponent(p.carpeta_pedida_id)}&updated_at=eq.${encodeURIComponent(p.updated_at)}`,
        cuerpo: { drive_pendiente: false, carpeta_id: p.carpeta_id },
        prefer: 'return=minimal',
      },
    });
    return;
  }

  // "limpiar" y "renombrar" no cambian la carpeta: carpeta_id no se incluye en el cuerpo
  const cuerpo = p.tipo === 'mover' ? { drive_pendiente: false, carpeta_id: p.carpeta_id } : { drive_pendiente: false };
  escrituras.push({
    json: {
      etiqueta: p.etiqueta,
      metodo: 'PATCH',
      url: `${base}/archivos?id=eq.${encodeURIComponent(p.archivo_id)}&updated_at=eq.${encodeURIComponent(p.updated_at)}`,
      cuerpo,
      prefer: 'return=minimal',
    },
  });
});

// Un fallo aislado se reintenta en la pasada siguiente. Si no se ha podido hacer NADA (credencial caducada,
// Drive caído…) se avisa con un error para que la ejecución salga en rojo.
if (fallos.length > 0 && hechas === 0) {
  throw new Error(`Sincronizar Drive: ${fallos.length} fallo(s) y nada hecho. ${fallos.slice(0, 3).join(' | ')}`);
}

// Sin nada que anotar (por ejemplo, solo se crearon carpetas) se manda una escritura que no toca ninguna fila: así «Escribir en Supabase» y
// «Soltar turno» se ejecutan igual y la pasada siguiente (10 s después) no tiene que esperar a que caduque el turno.
if (escrituras.length === 0) {
  escrituras.push({
    json: {
      etiqueta: 'nada que anotar',
      metodo: 'PATCH',
      url: `${base}/carpetas_pedidas?id=eq.00000000-0000-0000-0000-000000000000`,
      cuerpo: { drive_pendiente: false },
      prefer: 'return=minimal',
    },
  });
}

return escrituras;
