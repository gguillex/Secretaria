// Nodo "Preparar": deja un item por cada cosa pendiente de hacer en Drive, primero los archivos y después las carpetas pedidas.
// Los archivos primero porque "Leer padres" devuelve una respuesta por item, en el mismo orden, y solo los archivos la usan.
// "Leer pendientes" y "Leer carpetas pendientes" devuelven siempre algo (Always Output Data), aunque sea un item vacío:
// aquí se descarta. Si no queda ninguno, devuelve [] y el flujo termina sin tocar Drive. Las dos se leen por su nombre: entre ellas y
// este nodo están «Hay trabajo» y el turno (base de datos 1.5).
// preparar() también la usa «Hay trabajo», para no pedir el turno cuando no hay nada que hacer.

const filas = (items) => items.map((i) => i.json).filter((r) => r && typeof r === 'object');

function preparar(filasArchivos, filasCarpetas) {
  const archivos = filas(filasArchivos).filter((r) => typeof r.id === 'string' && typeof r.drive_file_id === 'string' && r.drive_file_id !== '');
  const carpetas = filas(filasCarpetas).filter((r) => typeof r.id === 'string' && typeof r.ruta === 'string' && r.ruta !== '');
  return [...archivos.map((archivo) => ({ json: { archivo } })), ...carpetas.map((carpeta) => ({ json: { carpeta } }))];
}

// --- Pegamento con n8n ---
return preparar($('Leer pendientes').all(), $('Leer carpetas pendientes').all());
