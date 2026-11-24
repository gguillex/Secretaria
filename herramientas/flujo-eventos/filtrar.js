// Nodo "Filtrar avisos": de lo que devolvió Supabase se queda solo con los avisos que de verdad hay que enviar ahora.
//
// La consulta ya filtra, pero cada fila se revalida aquí (tipo evento, pendiente, id válido, aviso vencido, aviso sin enviar y
// evento que todavía no ha empezado): un filtro mal construido nunca puede mandar un aviso de un evento pasado o ya avisado.
// Si no queda ninguno devuelve [] y el flujo termina (no se lee ni el último mensaje).

const config = $('Configuración').first().json.config;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ms = (s) => (typeof s === 'string' ? Date.parse(s) : NaN);
const ahora = Date.now();

const eventos = $input
  .all()
  .map((i) => i.json)
  .filter(
    (r) =>
      r &&
      typeof r.id === 'string' &&
      ID.test(r.id) &&
      r.tipo === 'evento' &&
      r.estado === 'pendiente' &&
      typeof r.titulo === 'string' &&
      r.titulo.trim() !== '' &&
      r.aviso_whatsapp_enviado_at == null &&
      ms(r.aviso_whatsapp_en) <= ahora &&
      ms(r.fecha_inicio) > ahora,
  )
  .sort((a, b) => ms(a.fecha_inicio) - ms(b.fecha_inicio))
  .slice(0, config.max_avisos)
  // La zona de la cita (base de datos): el aviso escribe la hora en ella
  .map((r) => ({ id: r.id, titulo: r.titulo, fecha_inicio: r.fecha_inicio, zona_alarma: typeof r.zona_alarma === 'string' && r.zona_alarma !== '' ? r.zona_alarma : null, lugar_alarma: typeof r.lugar_alarma === 'string' && r.lugar_alarma !== '' ? r.lugar_alarma : null }));

if (eventos.length === 0) return [];
return [{ json: { eventos } }];
