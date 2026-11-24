-- Actualización de la base de datos a la versión 1.7. Solo si ya tenías instalada la 1.5 o la 1.6 (la base de datos es la misma en las dos):
-- una instalación nueva usa instalar.sql, que ya lo incluye. Si vienes de una versión anterior, ejecuta antes, en orden, los actualizar-1.X.sql
-- que te falten (consultas/ver-version.sql te dice cuál tienes).
-- Ejecútala UNA vez en el SQL Editor de Supabase; si algo falla, no se aplica nada (una sola transacción).
--   - Viajes y zona horaria: tabla viajes (tramos con país, zona, primer y último día) y las funciones viaje_actual, viajes_vigentes,
--     viaje_empezado, poner_viaje, planear_viaje, viaje_hasta y volver_de_viaje.
--   - La zona de cada alarma y cita: columnas items.zona_alarma y items.lugar_alarma (hora de otro país, «19:00 (Portugal)»).
--   - Notas en carpetas de Drive: columna items.carpeta.
-- No toca tus datos. Después, comprueba con comprobar-instalacion.sql (10 filas con ok = true) y mira la versión con consultas/ver-version.sql.
-- Para deshacerla, la reversión está al final, comentada.

begin;

do $$
begin
  if to_regclass('public.turnos') is null then
    raise exception 'No encuentro la versión 1.5: ejecuta antes actualizar-1.5.sql';
  end if;
  if to_regclass('public.viajes') is not null then
    raise exception 'Esta actualización ya está aplicada: no la repitas';
  end if;
end;
$$;

create table public.viajes (
  id uuid primary key default gen_random_uuid(),
  pais text not null check (char_length(pais) between 1 and 80),
  zona text not null check (char_length(zona) between 1 and 64),
  desde date,
  hasta date,
  created_at timestamptz not null default now(),
  cerrado_at timestamptz
);
comment on table public.viajes is 'Dónde está el usuario cuando viaja (país y zona horaria IANA). Puede haber varios tramos sin cerrar: el actual y los próximos (cerrado_at is null).';


alter table public.viajes enable row level security;
revoke all on table public.viajes from public, anon, authenticated;
grant select, insert, update on table public.viajes to service_role;

comment on column public.viajes.desde is 'Primer día del tramo (fecha del sitio). Vacío = desde que se apuntó.';

-- Puede haber varios tramos sin cerrar (el actual y los próximos)
create index viajes_vigentes_idx on public.viajes (desde) where cerrado_at is null;

-- El tramo que ya ha empezado: desde vacío o ya llegado (en la fecha de su zona)
create function public.viaje_empezado(v public.viajes)
returns boolean
language sql
stable
set search_path = ''
as $$
  select v.desde is null or v.desde <= (now() at time zone v.zona)::date;
$$;

create function public.viaje_actual()
returns setof public.viajes
language plpgsql
set search_path = ''
as $$
begin
  -- Los tramos que ya pasaron su último día se cierran (si hay uno siguiente, pasa a ser el actual; si no, vuelve la hora de España)
  update public.viajes
     set cerrado_at = now()
   where cerrado_at is null
     and hasta is not null
     and (now() at time zone zona)::date > hasta;
  return query
    select * from public.viajes v
     where v.cerrado_at is null and public.viaje_empezado(v)
     order by v.desde desc nulls last, v.created_at desc
     limit 1;
end;
$$;

create function public.viajes_vigentes()
returns setof public.viajes
language plpgsql
set search_path = ''
as $$
begin
  perform public.viaje_actual(); -- cierra lo caducado
  return query
    select * from public.viajes where cerrado_at is null
     order by coalesce(desde, created_at::date), created_at
     limit 10;
end;
$$;

create function public.poner_viaje(p_pais text, p_zona text, p_hasta date default null)
returns setof public.viajes
language plpgsql
set search_path = ''
as $$
declare
  v_comprobar timestamp;
begin
  if p_pais is null or btrim(p_pais) = '' or p_zona is null or btrim(p_zona) = '' then
    raise exception 'poner_viaje: faltan el país o la zona';
  end if;
  v_comprobar := now() at time zone p_zona; -- una zona que no existe da error
  -- Se cierra el tramo actual (los que ya empezaron), no los próximos
  update public.viajes v set cerrado_at = now() where v.cerrado_at is null and public.viaje_empezado(v);
  return query insert into public.viajes (pais, zona, hasta, desde)
    values (btrim(p_pais), btrim(p_zona), p_hasta, (now() at time zone btrim(p_zona))::date) returning *;
end;
$$;

create function public.planear_viaje(p_pais text, p_zona text, p_desde date, p_hasta date default null)
returns setof public.viajes
language plpgsql
set search_path = ''
as $$
declare
  v_comprobar timestamp;
begin
  if p_pais is null or btrim(p_pais) = '' or p_zona is null or btrim(p_zona) = '' or p_desde is null then
    raise exception 'planear_viaje: faltan el país, la zona o el primer día';
  end if;
  if p_hasta is not null and p_hasta < p_desde then
    raise exception 'planear_viaje: el último día es antes del primero';
  end if;
  v_comprobar := now() at time zone p_zona;
  -- Un plan nuevo sustituye a los próximos que empiecen dentro de él (o el mismo día)
  update public.viajes
     set cerrado_at = now()
   where cerrado_at is null and desde is not null and desde >= p_desde and (p_hasta is null or desde <= p_hasta)
     and desde > (now() at time zone zona)::date;
  return query insert into public.viajes (pais, zona, desde, hasta) values (btrim(p_pais), btrim(p_zona), p_desde, p_hasta) returning *;
end;
$$;

create function public.viaje_hasta(p_hasta date)
returns setof public.viajes
language plpgsql
set search_path = ''
as $$
begin
  return query update public.viajes v set hasta = p_hasta where v.cerrado_at is null and public.viaje_empezado(v) returning *;
end;
$$;

create function public.volver_de_viaje()
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_pais text;
begin
  update public.viajes v set cerrado_at = now() where v.cerrado_at is null and public.viaje_empezado(v) returning pais into v_pais;
  return jsonb_build_object('cerrado', v_pais is not null, 'pais', v_pais);
end;
$$;

revoke all on function public.viaje_empezado(public.viajes) from public, anon, authenticated;
revoke all on function public.viajes_vigentes() from public, anon, authenticated;
revoke all on function public.planear_viaje(text, text, date, date) from public, anon, authenticated;
revoke all on function public.viaje_actual() from public, anon, authenticated;
revoke all on function public.poner_viaje(text, text, date) from public, anon, authenticated;
revoke all on function public.viaje_hasta(date) from public, anon, authenticated;
revoke all on function public.volver_de_viaje() from public, anon, authenticated;
grant execute on function public.viaje_empezado(public.viajes) to service_role;
grant execute on function public.viajes_vigentes() to service_role;
grant execute on function public.planear_viaje(text, text, date, date) to service_role;
grant execute on function public.viaje_actual() to service_role;
grant execute on function public.poner_viaje(text, text, date) to service_role;
grant execute on function public.viaje_hasta(date) to service_role;
grant execute on function public.volver_de_viaje() to service_role;
comment on function public.viajes_vigentes() is 'El tramo actual y los próximos (cierra antes los caducados). Solo service_role.';
comment on function public.planear_viaje(text, text, date, date) is 'Un tramo de viaje que empieza otro día; sustituye a los próximos que empiecen dentro de él. Solo service_role.';
comment on function public.viaje_actual() is 'El tramo actual (0 o 1 filas); cierra antes los que pasaron su último día. Con tramos. Solo service_role.';

alter table public.items add column zona_alarma text;
alter table public.items add column lugar_alarma text;

-- Las dos van juntas, y con un tamaño razonable
alter table public.items add constraint items_zona_alarma_check check (
  (zona_alarma is null and lugar_alarma is null)
  or (zona_alarma is not null and lugar_alarma is not null and char_length(zona_alarma) between 1 and 64 and char_length(lugar_alarma) between 1 and 80)
);

comment on column public.items.zona_alarma is 'Zona horaria (IANA) de una alarma puesta en la hora de otro país; null = hora de España.';
comment on column public.items.lugar_alarma is 'Nombre del sitio de esa zona que se enseña entre paréntesis («Portugal»); null = hora de España.';

alter table public.items add column carpeta text;

-- Solo las notas, y con un tamaño razonable
alter table public.items add constraint items_carpeta_check check (
  carpeta is null or (tipo = 'nota' and char_length(carpeta) between 1 and 200)
);

comment on column public.items.carpeta is 'Carpeta de Drive a la que va ligada una nota («Viajes/Budapest»); null = nota suelta (Pensamientos).';

commit;

-- ===========================================================================
-- REVERSIÓN (comentada; solo si hay que volver a la 1.5 o la 1.6). Antes, vuelve a importar los flujos de esa versión: los de la 1.7 leen
-- estas columnas y funciones. Se pierden los viajes guardados, la zona de las alarmas y la carpeta de las notas.
-- ===========================================================================
-- begin;
-- drop function public.volver_de_viaje();
-- drop function public.viaje_hasta(date);
-- drop function public.planear_viaje(text, text, date, date);
-- drop function public.poner_viaje(text, text, date);
-- drop function public.viajes_vigentes();
-- drop function public.viaje_actual();
-- drop function public.viaje_empezado(public.viajes);
-- drop table public.viajes;
-- alter table public.items drop column carpeta, drop column lugar_alarma, drop column zona_alarma;
-- commit;
