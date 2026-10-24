// Nodo "Configuración" del flujo "Sincronizar Drive": todo lo que se toca a mano está aquí.
// Los demás nodos leen estos valores con $('Configuración').first().json.config
// (Es otro flujo de n8n y por eso repite SUPABASE_URL: hay que ponerla en todos los flujos.)

// Los identificadores (no son secretos) se leen del .env del servidor, así se ponen UNA vez para todos los flujos.
// Si una variable no está en el .env, vale lo que esté escrito aquí abajo.
const delEntorno = (clave, porDefecto) => {
  try {
    return String($env[clave] ?? '').trim() || porDefecto;
  } catch (e) {
    return porDefecto;
  }
};

// === Valores fáciles de cambiar ===
// Project URL de Supabase (Integrations > Data API), sin /rest/v1 al final. No es un secreto.
const SUPABASE_URL = delEntorno('SUPABASE_URL', 'https://TU-PROYECTO.supabase.co');
// ID de la carpeta "Secretaria" de Drive: lo que hay en la URL al abrirla (drive.google.com/drive/folders/<ID>).
const CARPETA_RAIZ_ID = delEntorno('DRIVE_CARPETA_RAIZ_ID', 'TU-CARPETA-RAIZ');
// Máximo de archivos que se mueven en cada ejecución (cada 10 segundos)
const LOTE = 20;
// Cuánto dura, como mucho, el turno de una ejecución (base de datos 1.5): si una ejecución muere a medias, las siguientes esperan esto y siguen.
// Una pasada normal tarda pocos segundos y suelta el turno al acabar.
const TURNO_S = 60;
// ==================================

if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(SUPABASE_URL) || SUPABASE_URL.includes('TU-PROYECTO')) {
  throw new Error('Configuración: pon tu Project URL de Supabase en SUPABASE_URL (https://<ref>.supabase.co, sin /rest/v1). Va en el .env del servidor (SUPABASE_URL=…, y después docker compose up -d)');
}
if (!/^[A-Za-z0-9_-]{10,}$/.test(CARPETA_RAIZ_ID) || CARPETA_RAIZ_ID.includes('TU-CARPETA')) {
  throw new Error('Configuración: pon el ID de la carpeta "Secretaria" de Drive en CARPETA_RAIZ_ID (solo letras, números, guion y guion bajo). Va en el .env del servidor (DRIVE_CARPETA_RAIZ_ID=…, y después docker compose up -d)');
}
if (!Number.isInteger(LOTE) || LOTE <= 0) throw new Error('Configuración: LOTE debe ser un entero positivo');
if (!Number.isInteger(TURNO_S) || TURNO_S < 5 || TURNO_S > 600) throw new Error('Configuración: TURNO_S debe ser un entero entre 5 y 600');

return [
  {
    json: {
      config: {
        supabase_url: SUPABASE_URL.replace(/\/+$/, ''),
        carpeta_raiz_id: CARPETA_RAIZ_ID,
        lote: LOTE,
        turno_s: TURNO_S,
      },
    },
  },
];
