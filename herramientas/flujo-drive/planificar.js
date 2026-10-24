// Nodo "Planificar": decide qué petición hace falta en Drive para cada archivo pendiente.
// La lógica está en planificarAcciones (comun.js); aquí solo se leen los nodos anteriores.

/*__COMUN__*/

// --- Pegamento con n8n ---
const config = $('Configuración').first().json.config;
const preparados = $('Preparar').all().map((i) => i.json);
const archivos = preparados.filter((p) => p.archivo).map((p) => p.archivo);
const carpetas = preparados.filter((p) => p.carpeta).map((p) => p.carpeta);
// "Leer padres" devuelve la respuesta completa, un item por item preparado y en el mismo orden: los archivos van primero,
// así que sus respuestas son las primeras (las de las carpetas pedidas no se usan)
const padres = $('Leer padres').all().map((i) => i.json);
// Un listado por nivel de carpetas (hijas de la raíz, de esas y de esas): cada uno con la respuesta completa
const niveles = ['Listar nivel 1', 'Listar nivel 2', 'Listar nivel 3'].map((nodo) => $(nodo).first().json);
// Las carpetas creadas en las pasadas de los últimos 60 s (base de datos 1.5): sin actualizar la base de datos a la 1.5 la lectura falla y no hay ninguna
let recientes = [];
try {
  recientes = $('Leer carpetas creadas').all().map((i) => i.json).filter((r) => r && typeof r.drive_id === 'string');
} catch (e) {
  recientes = [];
}

let plan;
try {
  plan = planificarAcciones({ archivos, carpetas, padres, raizId: config.carpeta_raiz_id, niveles, recientes });
} catch (e) {
  // Sin el árbol de carpetas completo no se hace nada: crear carpetas "que faltan" podría duplicar las que existen
  throw new Error(`Sincronizar Drive: ${e.message} (revisa la credencial de Google Drive y CARPETA_RAIZ_ID)`);
}
const { acciones, fallos } = plan;

// Un fallo aislado se reintenta al minuto siguiente. Si no se puede hacer NADA, se avisa con un error.
if (fallos.length > 0 && acciones.length === 0) {
  throw new Error(`Sincronizar Drive: ${fallos.length} fallo(s) y ninguna acción posible. ${fallos.slice(0, 3).join(' | ')}`);
}

return acciones.map((a) => ({ json: a }));
