// Nodo "Redactar recordatorio": construye UN mensaje de WhatsApp con los recordatorios que toca avisar y el cuerpo exacto de la petición a Meta,
// más lo necesario para marcarlos como avisados DESPUÉS (solo si Meta acepta el envío).
//
// - Solo se envía como texto libre y solo si la ventana de 24 h de Meta sigue abierta (el último mensaje TUYO es de hace menos de
//   VENTANA_HORAS). Si está cerrada devuelve [] y no se envía nada: no se marca nada y el aviso se reintenta cada minuto; en cuanto
//   vuelvas a escribir sale (como «atrasado» si la hora ya pasó).
// - Se redacta con código, nunca con el modelo.
//
//   un recordatorio:   🔔 En 1 hora: *título* (18:30)     🔔 En 30 minutos: *título* (18:30)     🔔 Ahora: *título*
//                      🔔 Recordatorio atrasado (era a las 18:30): *título*
//   varios:            🔔 *Recordatorios*   y una línea «• En 30 minutos: título (18:30)» por cada uno

const config = $('Configuración').first().json.config;
const LIMITE_MENSAJE = 3800;
const ZONA_ESPANA = 'Europe/Madrid';

const limpiar = (s) => String(s ?? '').replace(/[*_~`]/g, '').replace(/\s+/g, ' ').trim();
// Cada alarma se escribe a su hora y en su zona: las de Madrid sin más («18:30») y las demás con el sitio («19:00 Portugal»),
// estés donde estés. La zona viene de items.zona_alarma (base de datos al día); sin ella, o si no se reconoce, Madrid
const horaDe = (r) => {
  const z = typeof r.zona_alarma === 'string' && r.zona_alarma !== '' ? r.zona_alarma : ZONA_ESPANA;
  try {
    const h = new Intl.DateTimeFormat('es-ES', { timeZone: z, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(r.recordar_en));
    return z === ZONA_ESPANA ? h : `${h} ${limpiar(r.lugar_alarma || z)}`;
  } catch (e) {
    return new Intl.DateTimeFormat('es-ES', { timeZone: ZONA_ESPANA, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(r.recordar_en));
  }
};

// Antelación con palabras: 60 -> "1 hora", 120 -> "2 horas", 30 -> "30 minutos"
function antes(minutos) {
  if (minutos > 0 && minutos % 60 === 0) return minutos === 60 ? 'En 1 hora' : `En ${minutos / 60} horas`;
  return `En ${minutos} minutos`;
}

const recordatorios = $('Filtrar recordatorios').first().json.recordatorios;
const ultimo = $('Leer último mensaje')
  .all()
  .map((x) => x.json)
  .filter((r) => r && typeof r.created_at === 'string')
  .map((r) => new Date(r.created_at))
  .filter((d) => !Number.isNaN(d.getTime()))[0];

const ahora = new Date();
const ventanaAbierta = Boolean(ultimo) && ahora.getTime() - ultimo.getTime() < config.ventana_horas * 3600 * 1000;
if (!ventanaAbierta) return [];

const para = String($env.WHATSAPP_NUMERO_PERMITIDO ?? '').replace(/\D/g, '');
if (!para) throw new Error('Redactar recordatorio: falta WHATSAPP_NUMERO_PERMITIDO en el entorno de n8n');

const titulo = (r) => limpiar(r.titulo);
const una = (r) => {
  if (r.atrasado) return `🔔 Recordatorio atrasado (era a las ${horaDe(r)}): *${titulo(r)}*`;
  if (r.aviso === 0) return `🔔 Ahora: *${titulo(r)}*`;
  return `🔔 ${antes(r.aviso)}: *${titulo(r)}* (${horaDe(r)})`;
};
const linea = (r) => {
  if (r.atrasado) return `• Atrasado (era a las ${horaDe(r)}): ${titulo(r)}`;
  if (r.aviso === 0) return `• Ahora: ${titulo(r)}`;
  return `• ${antes(r.aviso)}: ${titulo(r)} (${horaDe(r)})`;
};

let texto = recordatorios.length === 1 ? una(recordatorios[0]) : `🔔 *Recordatorios*\n${recordatorios.map(linea).join('\n')}`;
if (texto.length > LIMITE_MENSAJE) texto = `${texto.slice(0, LIMITE_MENSAJE - 1).trimEnd()}…`;

return [
  {
    json: {
      cuerpo: { messaging_product: 'whatsapp', recipient_type: 'individual', to: para, type: 'text', text: { preview_url: false, body: texto } },
      texto,
      // Lo que hay que anotar en cada recordatorio DESPUÉS de que Meta acepte el envío
      marcas: recordatorios.map((r) => ({ id: r.id, recordar_en: r.recordar_en, avisos: r.avisos_nuevos, hecho: r.hecho })),
    },
  },
];
