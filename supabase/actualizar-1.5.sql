-- Actualización de la base de datos a la versión 1.5. Solo si ya tenías instalada la 1.4: una instalación nueva usa instalar.sql, que ya
-- lo incluye. Si vienes de una versión anterior, ejecuta antes, en orden, los actualizar-1.X.sql que te falten (consultas/ver-version.sql
-- te dice cuál tienes).
-- Ejecútala UNA vez en el SQL Editor de Supabase; si algo falla, no se aplica nada (una sola transacción).
--   - Un turno para «Sincronizar Drive» (tabla turnos, funciones tomar_turno y soltar_turno): ahora se ejecuta cada 10 segundos y dos
--     ejecuciones no deben crear la misma carpeta a la vez.
--   - carpetas_conocidas(): las carpetas que existen o se han pedido, para no crear una parecida a otra que ya existe.
--   - Vaciar la carpeta que se queda vacía al mover sus archivos a otra (tablas carpetas_vaciar y carpetas_creadas, funciones
--     pedir_vaciar_carpeta, carpetas_por_vaciar y vaciado_hecho). Nunca Entrada ni Notas.
-- No toca tus datos. Después, comprueba con comprobar-instalacion.sql (10 filas con ok = true) y mira la versión con consultas/ver-version.sql.
-- Para deshacerla, la reversión está al final, comentada.

begin;

do $$
begin
  if to_regprocedure('public.mover_carpeta_drive(text, text, text, text)') is null then
    raise exception 'No encuentro la versión 1.4: ejecuta antes actualizar-1.4.sql';
  end if;
  if to_regclass('public.turnos') is not null then
    raise exception 'Esta actualización ya está aplicada: no la repitas';
  end if;
end;
$$;

-- Un turno por nombre («sincronizar_drive»). hasta: cuándo caduca; token: quién lo tiene
create table public.turnos (
  nombre text primary key check (btrim(nombre) <> '' and length(nombre) <= 60),
  hasta timestamptz not null,
  token uuid not null,
  updated_at timestamptz not null default now()
);
alter table public.turnos enable row level security;
comment on table public.turnos is 'Turnos con caducidad para que dos ejecuciones del mismo flujo no trabajen a la vez. Solo los usa service_role.';

create function public.tomar_turno(p_nombre text, p_segundos integer)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_token uuid := gen_random_uuid();
  v_tomado uuid;
begin
  if p_nombre is null or btrim(p_nombre) = '' or length(p_nombre) > 60 then
    raise exception 'tomar_turno: falta el nombre del turno';
  end if;
  if p_segundos is null or p_segundos < 5 or p_segundos > 600 then
    raise exception 'tomar_turno: la duración del turno va de 5 a 600 segundos';
  end if;
  -- Atómico: si dos llamadas llegan a la vez, la segunda espera al bloqueo de la fila y, al releerla, el turno ya no está caducado
  insert into public.turnos as t (nombre, hasta, token)
  values (p_nombre, now() + make_interval(secs => p_segundos), v_token)
  on conflict (nombre) do update
     set hasta = excluded.hasta, token = excluded.token, updated_at = now()
   where t.hasta < now()
  returning t.token into v_tomado;
  if v_tomado is null then
    return jsonb_build_object('turno', false);
  end if;
  return jsonb_build_object('turno', true, 'token', v_tomado);
end;
$$;

create function public.soltar_turno(p_nombre text, p_token uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_n integer;
begin
  -- Solo quien lo tiene lo suelta (si su turno caducó y lo tomó otra ejecución, no se toca)
  update public.turnos
     set hasta = now() - interval '1 second', updated_at = now()
   where nombre = p_nombre and token = p_token and hasta >= now();
  get diagnostics v_n = row_count;
  return jsonb_build_object('soltado', v_n > 0);
end;
$$;

-- Las carpetas conocidas: una fila por ruta (tal como está escrita), con de dónde sale y cuántos archivos clasificados tiene
create function public.carpetas_conocidas()
returns jsonb
language sql
stable
set search_path = ''
as $$
  with rutas as (
    select d.ruta, 'drive'::text as origen, 0 as n
      from public.drive_arbol d
     where d.tipo = 'carpeta' and d.eliminado_at is null and btrim(d.ruta) <> ''
    union all
    select p.ruta, 'pedida', 0
      from public.carpetas_pedidas p
     where p.eliminada_at is null and btrim(p.ruta) <> ''
    union all
    select a.carpeta_destino, 'archivos', count(*)::int
      from public.archivos a
     where a.carpeta_destino is not null and a.eliminado_at is null and btrim(a.carpeta_destino) <> ''
     group by a.carpeta_destino
  ),
  juntas as (
    select r.ruta,
           bool_or(r.origen = 'drive') as en_drive,
           bool_or(r.origen = 'pedida') as pedida,
           coalesce(sum(r.n) filter (where r.origen = 'archivos'), 0)::int as archivos
      from rutas r
     group by r.ruta
     order by r.ruta
     limit 2000
  )
  select coalesce(jsonb_agg(jsonb_build_object('ruta', j.ruta, 'en_drive', j.en_drive, 'pedida', j.pedida, 'archivos', j.archivos) order by j.ruta), '[]'::jsonb)
    from juntas j;
$$;

revoke all on function public.tomar_turno(text, integer) from public, anon, authenticated;
revoke all on function public.soltar_turno(text, uuid) from public, anon, authenticated;
revoke all on function public.carpetas_conocidas() from public, anon, authenticated;
grant execute on function public.tomar_turno(text, integer) to service_role;
grant execute on function public.soltar_turno(text, uuid) to service_role;
grant execute on function public.carpetas_conocidas() to service_role;
grant select, insert, update, delete on public.turnos to service_role;

comment on function public.tomar_turno(text, integer) is 'Toma el turno con ese nombre durante p_segundos si nadie lo tiene: { turno: true, token } o { turno: false }. Solo service_role.';
comment on function public.soltar_turno(text, uuid) is 'Suelta el turno si el token es el de quien lo tomó y no ha caducado. Solo service_role.';
comment on function public.carpetas_conocidas() is 'Rutas de carpeta conocidas (foto de Drive, carpetas pedidas y carpetas de archivos clasificados), con cuántos archivos tiene cada una. Solo service_role.';

create table public.carpetas_vaciar (
  id uuid primary key default gen_random_uuid(),
  ruta text not null check (btrim(ruta) <> ''),
  carpeta_id text not null check (btrim(carpeta_id) <> ''),
  pedida_at timestamptz not null default now(),
  hecha_at timestamptz,
  resultado text check (resultado in ('papelera', 'no_vacia', 'no_existe'))
);
alter table public.carpetas_vaciar enable row level security;
-- Una sola petición abierta por carpeta
create unique index carpetas_vaciar_abierta_idx on public.carpetas_vaciar (carpeta_id) where hecha_at is null;
comment on table public.carpetas_vaciar is 'Carpetas que se mandan a la papelera cuando se queden vacías tras mover sus archivos. Solo service_role.';

create table public.carpetas_creadas (
  drive_id text primary key check (btrim(drive_id) <> ''),
  padre_id text not null check (btrim(padre_id) <> ''),
  nombre text not null check (btrim(nombre) <> ''),
  creada_at timestamptz not null default now()
);
alter table public.carpetas_creadas enable row level security;
create index carpetas_creadas_creada_at_idx on public.carpetas_creadas (creada_at);
comment on table public.carpetas_creadas is 'Carpetas que acaba de crear «Sincronizar Drive»: la pasada siguiente las tiene en cuenta aunque Drive aún no las liste.';

create function public.pedir_vaciar_carpeta(p_ruta text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_id text;
  v_n integer;
begin
  if not public.ruta_carpeta_valida(p_ruta) then
    return jsonb_build_object('pedida', false, 'motivo', 'ruta');
  end if;
  -- Nunca Entrada ni Notas (las usa la secretaria para ordenar)
  if lower(p_ruta) in ('entrada', 'notas') then
    return jsonb_build_object('pedida', false, 'motivo', 'protegida');
  end if;
  select count(*), min(d.drive_id) into v_n, v_id
    from public.drive_arbol d
   where d.tipo = 'carpeta' and d.eliminado_at is null and lower(d.ruta) = lower(p_ruta);
  -- Sin la carpeta en la foto (creada hace menos de 5 minutos) o con dos iguales: no se pide (no se sabe cuál es)
  if v_n <> 1 then
    return jsonb_build_object('pedida', false, 'motivo', case when v_n = 0 then 'no_en_la_foto' else 'ambigua' end);
  end if;
  insert into public.carpetas_vaciar (ruta, carpeta_id) values (p_ruta, v_id)
  on conflict (carpeta_id) where hecha_at is null do update set pedida_at = now();
  return jsonb_build_object('pedida', true);
end;
$$;

create function public.carpetas_por_vaciar(p_espera_s integer)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v jsonb;
begin
  if p_espera_s is null or p_espera_s < 0 or p_espera_s > 600 then
    raise exception 'carpetas_por_vaciar: la espera va de 0 a 600 segundos';
  end if;
  -- Las de hace más de 30 minutos ya no se vaciarán solas (tenían algo más): se cierran
  update public.carpetas_vaciar
     set hecha_at = now(), resultado = 'no_vacia'
   where hecha_at is null and pedida_at < now() - interval '30 minutes';
  select coalesce(jsonb_agg(jsonb_build_object('id', v.id, 'carpeta_id', v.carpeta_id, 'ruta', v.ruta) order by v.pedida_at), '[]'::jsonb) into v
    from (
      select c.id, c.carpeta_id, c.ruta, c.pedida_at
        from public.carpetas_vaciar c
       where c.hecha_at is null
         and c.pedida_at <= now() - make_interval(secs => p_espera_s)
         -- Segunda barrera: Entrada y Notas nunca se vacían, aunque estén vacías
         and lower(c.ruta) not in ('entrada', 'notas')
         -- Ningún archivo registrado sigue dentro (los que se están moviendo apuntan a ella hasta que se mueven)
         and not exists (select 1 from public.archivos a where a.eliminado_at is null and a.carpeta_id = c.carpeta_id)
       order by c.pedida_at
       limit 5
    ) v;
  return v;
end;
$$;

create function public.vaciado_hecho(p_id uuid, p_resultado text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_fila public.carpetas_vaciar%rowtype;
begin
  if p_resultado not in ('papelera', 'no_vacia', 'no_existe') then
    raise exception 'vaciado_hecho: resultado no válido';
  end if;
  update public.carpetas_vaciar set hecha_at = now(), resultado = p_resultado
   where id = p_id and hecha_at is null
  returning * into v_fila;
  if not found then
    return jsonb_build_object('anotado', false);
  end if;
  -- En la papelera (o ya no existía): se anota como borrada SOLO la carpeta, para que Vigilar Drive no lo avise como hecho a mano. Nada de lo
  -- que la foto tenga dentro (son restos de lo que se movió a otra carpeta: Drive ha dicho que está vacía)
  if p_resultado in ('papelera', 'no_existe') then
    update public.drive_arbol
       set eliminado_at = now(), updated_at = now()
     where drive_id = v_fila.carpeta_id and eliminado_at is null;
    update public.carpetas_pedidas
       set eliminada_at = now(), drive_pendiente = false
     where carpeta_id = v_fila.carpeta_id and eliminada_at is null;
  end if;
  return jsonb_build_object('anotado', true, 'ruta', v_fila.ruta);
end;
$$;

revoke all on function public.vaciado_hecho(uuid, text) from public, anon, authenticated;
grant execute on function public.vaciado_hecho(uuid, text) to service_role;
comment on function public.vaciado_hecho(uuid, text) is 'Anota el resultado de vaciar una carpeta y, si fue a la papelera, marca como borrada SOLO esa carpeta en la foto del árbol. Solo service_role.';

revoke all on function public.pedir_vaciar_carpeta(text) from public, anon, authenticated;
revoke all on function public.carpetas_por_vaciar(integer) from public, anon, authenticated;
revoke all on function public.vaciado_hecho(uuid, text) from public, anon, authenticated;
grant execute on function public.pedir_vaciar_carpeta(text) to service_role;
grant execute on function public.carpetas_por_vaciar(integer) to service_role;
grant execute on function public.vaciado_hecho(uuid, text) to service_role;
grant select, insert, update, delete on public.carpetas_vaciar to service_role;
grant select, insert, update, delete on public.carpetas_creadas to service_role;

comment on function public.pedir_vaciar_carpeta(text) is 'Apunta una carpeta para mandarla a la papelera cuando se quede vacía (no Entrada ni Notas). Solo service_role.';
comment on function public.carpetas_por_vaciar(integer) is 'Las carpetas apuntadas sin archivos registrados dentro, pedidas hace más de p_espera_s segundos; cierra las de más de 30 minutos. Solo service_role.';
comment on function public.vaciado_hecho(uuid, text) is 'Anota el resultado de vaciar una carpeta y, si fue a la papelera, la marca como borrada en la foto del árbol. Solo service_role.';

revoke all on table public.carpetas_creadas from anon, authenticated;
revoke all on table public.carpetas_vaciar from anon, authenticated;
revoke all on table public.turnos from anon, authenticated;

commit;

-- ===========================================================================
-- REVERSIÓN (comentada; solo si hay que volver a la 1.4). Antes, vuelve a importar los flujos de la 1.4: los de la 1.5 llaman a estas
-- funciones.
-- ===========================================================================
-- begin;
-- drop function public.vaciado_hecho(uuid, text);
-- drop function public.carpetas_por_vaciar(integer);
-- drop function public.pedir_vaciar_carpeta(text);
-- drop table public.carpetas_creadas;
-- drop table public.carpetas_vaciar;
-- drop function public.carpetas_conocidas();
-- drop function public.soltar_turno(text, uuid);
-- drop function public.tomar_turno(text, integer);
-- drop table public.turnos;
-- commit;
