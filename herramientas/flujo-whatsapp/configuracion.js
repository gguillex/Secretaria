// Nodo "Configuración" del flujo "Secretaria · WhatsApp": lo que se toca a mano está aquí.
// Los demás nodos leen estos valores con $('Configuración').first().json.config
// Los SECRETOS no están aquí: el App Secret, el verify token y el número permitido se leen del entorno de n8n
// (WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN y WHATSAPP_NUMERO_PERMITIDO, definidos en el archivo .env del usuario).
// El token de acceso para enviar va en una credencial de n8n (Header Auth), no aquí.

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
// Identificador del número de WhatsApp desde el que se envía (WhatsApp > API Setup > Phone number ID). No es un secreto.
const PHONE_NUMBER_ID = delEntorno('WHATSAPP_PHONE_NUMBER_ID', 'TU-PHONE-NUMBER-ID');
// Versión de la API Graph de Meta. Meta retira las versiones antiguas: revísala una vez al año.
const GRAPH_VERSION = 'v26.0';
// ID de la carpeta "Entrada" de Drive (Secretaria/Entrada): el último trozo de su URL en Drive. No es un secreto.
const ENTRADA_FOLDER_ID = delEntorno('DRIVE_ENTRADA_ID', 'TU-ID-DE-ENTRADA');
// Tamaño máximo de un archivo adjunto, en MB (n8n lo mantiene en memoria; Meta admite hasta 100 MB en documentos)
const LIMITE_ADJUNTO_MB = 25;
// Modelo de Gemini que transcribe los audios (el mismo que clasifica; es una constante fácil de cambiar). La llamada va en el nodo
// "Transcribir audio" con la credencial Header Auth de Gemini, la misma del nodo "Modelo" del flujo principal.
const MODELO_TRANSCRIPCION = 'gemini-3.8-flash';
// Tamaño máximo de un audio, en MB. Gemini admite 20 MB por petición en total y el audio viaja en base64 (+33 %).
const LIMITE_AUDIO_MB = 10;
// Cola de mensajes . Segundos que se espera tras cada mensaje de texto o audio por si llegan más seguidos: los que lleguen
// en ese rato se procesan JUNTOS, como un solo mensaje. Se paga en CADA respuesta. Con 0 no se espera: el orden de llegada lo sigue
// garantizando el turno (un mensaje que llega mientras se contesta otro espera su turno y se procesa a continuación), pero los que llegan
// de golpe se procesan uno a uno en vez de juntos. Entre 0 y 30.
const ESPERA_AGRUPAR_S = 0;
// Minutos que vale el turno de una ejecución (procesar y mandar la respuesta); si muere sin soltarlo, caduca solo. Mientras, un mensaje
// nuevo vuelve a pedir turno cada ESPERA_TURNO_S segundos. Debe cubrir lo que tarda el modelo en el peor caso (3 intentos).
const TURNO_MIN = 10;
const ESPERA_TURNO_S = 2;
// Aviso de varios archivos (base de datos 1.4). Segundos que se espera tras guardar un archivo por si llegan más seguidos: la última
// ejecución de la tanda manda UN solo mensaje con todos los nombres en vez de uno por archivo. Se paga en CADA archivo (con 1 solo, el aviso
// tarda estos segundos más). 0 = un aviso por archivo, como antes (y no hace falta la base de datos 1.4). Entre 0 y 15.
const ESPERA_ARCHIVOS_S = 4;
// ==================================

if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(SUPABASE_URL) || SUPABASE_URL.includes('TU-PROYECTO')) {
  throw new Error('Configuración: pon tu Project URL de Supabase en SUPABASE_URL (https://<ref>.supabase.co, sin /rest/v1). Va en el .env del servidor (SUPABASE_URL=…, y después docker compose up -d)');
}
if (!/^\d{8,20}$/.test(PHONE_NUMBER_ID)) {
  throw new Error('Configuración: pon el Phone number ID de WhatsApp en PHONE_NUMBER_ID (solo dígitos). Va en el .env del servidor (WHATSAPP_PHONE_NUMBER_ID=…, y después docker compose up -d)');
}
if (!/^v\d+\.\d+$/.test(GRAPH_VERSION)) {
  throw new Error('Configuración: GRAPH_VERSION debe tener la forma v26.0');
}
if (!/^[A-Za-z0-9_-]{10,100}$/.test(ENTRADA_FOLDER_ID) || ENTRADA_FOLDER_ID.includes('TU-ID')) {
  throw new Error('Configuración: pon el ID de la carpeta Entrada de Drive en ENTRADA_FOLDER_ID (el último trozo de su URL). Va en el .env del servidor (DRIVE_ENTRADA_ID=…, y después docker compose up -d)');
}
if (!Number.isFinite(LIMITE_ADJUNTO_MB) || LIMITE_ADJUNTO_MB < 1 || LIMITE_ADJUNTO_MB > 100) {
  throw new Error('Configuración: LIMITE_ADJUNTO_MB debe estar entre 1 y 100');
}
if (!/^[a-z0-9][a-z0-9.-]{2,60}$/.test(MODELO_TRANSCRIPCION)) {
  throw new Error('Configuración: MODELO_TRANSCRIPCION no parece un nombre de modelo de Gemini');
}
if (!Number.isFinite(LIMITE_AUDIO_MB) || LIMITE_AUDIO_MB < 1 || LIMITE_AUDIO_MB > 14) {
  throw new Error('Configuración: LIMITE_AUDIO_MB debe estar entre 1 y 14');
}
if (!Number.isInteger(ESPERA_AGRUPAR_S) || ESPERA_AGRUPAR_S < 0 || ESPERA_AGRUPAR_S > 30) {
  throw new Error('Configuración: ESPERA_AGRUPAR_S debe ser un número entero entre 0 y 30');
}
if (!Number.isInteger(TURNO_MIN) || TURNO_MIN < 1 || TURNO_MIN > 60) {
  throw new Error('Configuración: TURNO_MIN debe ser un número entero entre 1 y 60');
}
if (!Number.isInteger(ESPERA_TURNO_S) || ESPERA_TURNO_S < 2 || ESPERA_TURNO_S > 60) {
  throw new Error('Configuración: ESPERA_TURNO_S debe ser un número entero entre 2 y 60');
}

if (!Number.isInteger(ESPERA_ARCHIVOS_S) || ESPERA_ARCHIVOS_S < 0 || ESPERA_ARCHIVOS_S > 15) {
  throw new Error('Configuración: ESPERA_ARCHIVOS_S debe ser un número entero entre 0 y 15');
}

return [
  {
    json: {
      config: {
        supabase_url: SUPABASE_URL.replace(/\/+$/, ''),
        phone_number_id: PHONE_NUMBER_ID,
        graph_version: GRAPH_VERSION,
        entrada_id: ENTRADA_FOLDER_ID,
        limite_adjunto_mb: LIMITE_ADJUNTO_MB,
        modelo_transcripcion: MODELO_TRANSCRIPCION,
        limite_audio_mb: LIMITE_AUDIO_MB,
        espera_agrupar_s: ESPERA_AGRUPAR_S,
        turno_min: TURNO_MIN,
        espera_turno_s: ESPERA_TURNO_S,
        espera_archivos_s: ESPERA_ARCHIVOS_S,
        // «Quieto»: si se guardó otro archivo hace menos que esto, aún están llegando más (siempre menos que la espera: el último de la tanda ve su propio archivo ya «quieto»)
        quieto_archivos_s: Math.max(0, ESPERA_ARCHIVOS_S - 1),
        // Vueltas de espera antes de rendirse: algo más que lo que tarda en caducar el turno
        max_esperas_turno: Math.ceil((TURNO_MIN * 60) / ESPERA_TURNO_S) + 6,
      },
    },
  },
];
