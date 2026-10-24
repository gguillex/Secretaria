// Nodo "Configuración": todo lo que se toca a mano está aquí y en ningún otro nodo.
// Los demás nodos leen estos valores con $('Configuración').first().json.config

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
const MODELO = 'gemini-3.8-flash';
// Project URL de Supabase (Integrations > Data API), sin /rest/v1 al final. No es un secreto.
const SUPABASE_URL = delEntorno('SUPABASE_URL', 'https://TU-PROYECTO.supabase.co');
// ID de la carpeta "Secretaria" de Drive (el último trozo de su URL). Solo lo usa la lista de carpetas. No es un secreto.
const CARPETA_RAIZ_ID = delEntorno('DRIVE_CARPETA_RAIZ_ID', 'TU-ID-DE-SECRETARIA');
// Cuánto «piensa» el modelo antes de contestar: es lo que más tarda. Vacío ('') = no se envía nada y Gemini usa su valor
// por defecto. Para que conteste antes: 'low' o 'minimal'. El campo y sus valores están verificados en el esquema oficial de la API
// (generationConfig.thinkingConfig.thinkingLevel: MINIMAL, LOW, MEDIUM, HIGH; «MINIMAL: little to no thinking»); NO probado con tu
// modelo: si Gemini no lo acepta, el mensaje falla con un error claro y basta con volver a ''. Puede bajar la calidad: mídelo con la
// evaluación (su NIVEL_RAZONAMIENTO) antes de dejarlo puesto.
const NIVEL_RAZONAMIENTO = '';
// Versión del prompt: 'v12' o 'v13' (sabe mover carpetas y archivos, contesta más corto y usa la conversación reciente).
const VERSION_PROMPT = 'v13';
// Minutos que un item espera un archivo que lo acompañe ("te mando un documento con la nota")
const ESPERA_MIN = 15;
// Minutos que una pregunta de la secretaria espera respuesta. Pasado ese tiempo, un mensaje nuevo ya no se
// interpreta como su respuesta (así no se le atribuyen mensajes que no tienen nada que ver).
const CADUCIDAD_MIN = 30;
// Memoria de la conversación: cuántos mensajes anteriores tuyos, con lo que se te contestó, ve el modelo para entender una
// corrección («no, quiero que…»). Solo los de los últimos MEMORIA_MIN minutos. 0 = apagada. Más mensajes = más texto que leer
// para Gemini (algo más lento y caro).
const MEMORIA_MENSAJES = 5;
const MEMORIA_MIN = 120;
// ==================================

if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(SUPABASE_URL) || SUPABASE_URL.includes('TU-PROYECTO')) {
  throw new Error('Configuración: pon tu Project URL de Supabase en SUPABASE_URL (https://<ref>.supabase.co, sin /rest/v1). Va en el .env del servidor (SUPABASE_URL=…, y después docker compose up -d)');
}
if (!/^[A-Za-z0-9_-]{10,100}$/.test(CARPETA_RAIZ_ID) || CARPETA_RAIZ_ID.includes('TU-ID')) {
  throw new Error('Configuración: pon el ID de la carpeta Secretaria de Drive en CARPETA_RAIZ_ID (el último trozo de su URL). Va en el .env del servidor (DRIVE_CARPETA_RAIZ_ID=…, y después docker compose up -d)');
}
if (!['v12', 'v13'].includes(VERSION_PROMPT)) {
  throw new Error("Configuración: VERSION_PROMPT debe ser 'v12' o 'v13'");
}
if (!['', 'minimal', 'low', 'medium', 'high'].includes(NIVEL_RAZONAMIENTO)) {
  throw new Error("Configuración: NIVEL_RAZONAMIENTO debe ser '', 'minimal', 'low', 'medium' o 'high'");
}
if (!Number.isFinite(ESPERA_MIN) || ESPERA_MIN <= 0) {
  throw new Error('Configuración: ESPERA_MIN debe ser un número positivo');
}
if (!Number.isFinite(CADUCIDAD_MIN) || CADUCIDAD_MIN <= 0) {
  throw new Error('Configuración: CADUCIDAD_MIN debe ser un número positivo');
}
if (!Number.isInteger(MEMORIA_MENSAJES) || MEMORIA_MENSAJES < 0 || MEMORIA_MENSAJES > 10) {
  throw new Error('Configuración: MEMORIA_MENSAJES debe ser un entero de 0 a 10');
}
if (!Number.isFinite(MEMORIA_MIN) || MEMORIA_MIN <= 0) {
  throw new Error('Configuración: MEMORIA_MIN debe ser un número positivo');
}

return [
  {
    json: {
      config: {
        modelo: MODELO,
        nivel_razonamiento: NIVEL_RAZONAMIENTO,
        supabase_url: SUPABASE_URL.replace(/\/+$/, ''),
        carpeta_raiz_id: CARPETA_RAIZ_ID,
        espera_min: ESPERA_MIN,
        caducidad_min: CADUCIDAD_MIN,
        version_prompt: VERSION_PROMPT,
        memoria_mensajes: MEMORIA_MENSAJES,
        memoria_min: MEMORIA_MIN,
      },
    },
  },
];
