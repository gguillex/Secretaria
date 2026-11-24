// Nodo "Filtrar recordatorios": de las tareas con hora de aviso que devolvió Supabase decide, para cada una, qué aviso toca ahora.
//
// Los avisos son (por defecto) 1 hora antes, 30 minutos antes y a la hora. Cada aviso se manda una sola vez: los ya enviados están en
// recordatorio_avisos. Un aviso «vence» cuando llega su hora; si el recordatorio se creó (o se cambió de hora) DESPUÉS de esa hora,
// no vence nunca (no se avisa tarde de lo que no se prometió). Si varios vencen a la vez (el flujo estuvo parado, o la ventana de 24 h
// estaba cerrada) se anuncia solo el más cercano a la hora y los demás se dan por enviados.
// Cada fila se revalida (uuid, pendiente, título y hora válidos). Si no queda nada devuelve [] y el flujo termina.

const config = $('Configuración').first().json.config;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ms = (s) => (typeof s === 'string' ? Date.parse(s) : NaN);
const ahora = Date.now();

const salida = [];
for (const r of $input.all().map((i) => i.json)) {
  if (!r || typeof r.id !== 'string' || !ID.test(r.id) || r.estado !== 'pendiente') continue;
  if (typeof r.titulo !== 'string' || r.titulo.trim() === '') continue;
  const inicio = ms(r.recordar_en);
  if (Number.isNaN(inicio)) continue;
  const enviados = Array.isArray(r.recordatorio_avisos) ? r.recordatorio_avisos.filter((m) => Number.isInteger(m)) : [];
  const cambio = ms(r.updated_at);

  const vencidos = config.avisos_min.filter((m) => {
    const hora = inicio - m * 60000;
    return !enviados.includes(m) && hora <= ahora && (Number.isNaN(cambio) || hora >= cambio);
  });
  if (vencidos.length === 0) continue;

  const aviso = Math.min(...vencidos); // el más cercano a la hora
  salida.push({
    id: r.id,
    titulo: r.titulo.trim(),
    recordar_en: r.recordar_en,
    // La zona de la alarma (base de datos): el aviso escribe la hora en ella
    zona_alarma: typeof r.zona_alarma === 'string' && r.zona_alarma !== '' ? r.zona_alarma : null,
    lugar_alarma: typeof r.lugar_alarma === 'string' && r.lugar_alarma !== '' ? r.lugar_alarma : null,
    aviso,
    atrasado: aviso === 0 && ahora - inicio > config.margen_atrasado_min * 60000,
    avisos_nuevos: [...new Set([...enviados, ...vencidos])].sort((a, b) => b - a),
    hecho: vencidos.includes(0),
  });
}

salida.sort((a, b) => ms(a.recordar_en) - ms(b.recordar_en));
if (salida.length === 0) return [];
return [{ json: { recordatorios: salida.slice(0, config.max_por_mensaje) } }];
