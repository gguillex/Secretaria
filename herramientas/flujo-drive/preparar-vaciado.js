// Nodo "Preparar vaciado" (base de datos 1.5): las carpetas que se pidieron vaciar al mover sus archivos a otra y que ya no tienen ningún
// archivo registrado dentro (lo decide carpetas_por_vaciar()). Un item por carpeta, para mirar en Drive si de verdad está vacía.
// Las carpetas de siempre (Entrada y Notas) NUNCA se vacían, aunque estén vacías: tercera barrera (las otras dos
// están en la base de datos). Sin la base de datos 1.5 la lectura falla y no hay nada que vaciar.

const PROTEGIDA = (ruta) => {
  const r = String(ruta ?? '').trim().toLowerCase();
  return r === '' || r === 'entrada' || r === 'notas';
};
const ID_DRIVE = /^[A-Za-z0-9_-]{10,100}$/;
const ID_FILA = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function prepararVaciado(filas) {
  return filas
    .filter((f) => f && typeof f.id === 'string' && ID_FILA.test(f.id) && typeof f.carpeta_id === 'string' && ID_DRIVE.test(f.carpeta_id) && typeof f.ruta === 'string' && !PROTEGIDA(f.ruta))
    .map((f) => ({ json: { vaciar: { id: f.id, carpeta_id: f.carpeta_id, ruta: f.ruta } } }));
}

// --- Pegamento con n8n ---
return prepararVaciado($input.all().map((i) => i.json));
