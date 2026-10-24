-- Comprobación de la instalación (solo lee: no cambia nada). Ejecútala después de instalar.sql.
-- Resultado esperado: 10 filas, todas con ok = true. Si alguna sale false, no sigas: la columna "detalle" dice qué falta.

with
tablas_esperadas(nombre) as (
  values ('mensajes'), ('items'), ('memoria'), ('archivos'), ('carpetas_pedidas'), ('drive_arbol'), ('registro_drive'),
         ('vigilantes_estado'), ('registro_calendar'), ('proyectos'), ('turno'), ('avisos_enviados'), ('horario_fijo'), ('llegadas'),
         ('turnos'), ('carpetas_vaciar'), ('carpetas_creadas')
),
funciones_esperadas(nombre) as (
  values ('guardar_con_archivos'), ('salud_sistema'), ('resumen_proyectos'),
         ('reclamar_mensajes'), ('liberar_turno'), ('anadir_contenido'), ('contexto_avisos'),
         ('marcar_borrado_drive'), ('olvidar_memoria'), ('quitar_horario'),
         ('registrar_llegadas'), ('turno_respuesta'), ('marcar_contestados'), ('llegada_perdida'),
         ('reclamar_confirmacion_archivos'), ('mover_carpeta_drive'),
         ('tomar_turno'), ('soltar_turno'), ('carpetas_conocidas'), ('pedir_vaciar_carpeta'), ('carpetas_por_vaciar'), ('vaciado_hecho')
),
tablas as (
  select c.relname as nombre, c.relrowsecurity as rls
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
),
funciones as (
  select p.oid, p.proname as nombre
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
),
disparadores as (
  select t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and not t.tgisinternal
)
select 1 as paso, 'existen las 17 tablas' as comprobacion,
       (select count(*) from tablas_esperadas e where e.nombre in (select nombre from tablas)) = 17 as ok,
       coalesce((select string_agg(e.nombre, ', ') from tablas_esperadas e where e.nombre not in (select nombre from tablas)), '') as detalle
union all
select 2, 'RLS activado en todas las tablas',
       not exists (select 1 from tablas where not rls),
       coalesce((select string_agg(nombre, ', ') from tablas where not rls), '')
union all
select 3, 'anon y authenticated sin permisos sobre las tablas',
       not exists (select 1 from tablas t, (values ('anon'), ('authenticated')) r(rol)
                   where has_table_privilege(r.rol, 'public.' || t.nombre, 'select, insert, update, delete')),
       ''
union all
select 4, 'service_role puede leer y escribir (lo usa n8n)',
       not exists (select 1 from tablas t where not has_table_privilege('service_role', 'public.' || t.nombre, 'select, insert, update, delete')),
       coalesce((select string_agg(nombre, ', ') from tablas t
                 where not has_table_privilege('service_role', 'public.' || t.nombre, 'select, insert, update, delete')), '')
union all
select 5, 'existen las 22 funciones que llama n8n',
       (select count(*) from funciones_esperadas e where e.nombre in (select nombre from funciones)) = 22,
       coalesce((select string_agg(e.nombre, ', ') from funciones_esperadas e where e.nombre not in (select nombre from funciones)), '')
union all
select 6, 'solo service_role ejecuta esas funciones',
       not exists (select 1 from funciones f, (values ('anon'), ('authenticated')) r(rol)
                   where f.nombre in (select nombre from funciones_esperadas) and has_function_privilege(r.rol, f.oid, 'execute'))
       and not exists (select 1 from funciones f
                       where f.nombre in (select nombre from funciones_esperadas) and not has_function_privilege('service_role', f.oid, 'execute')),
       ''
union all
select 7, 'existen los 9 disparadores',
       (select count(*) from disparadores) = 9,
       (select count(*) from disparadores)::text || ' encontrados'
union all
select 8, 'la fila del turno de la cola existe',
       (select count(*) from public.turno) = 1,
       ''
union all
select 9, 'la base de datos está vacía (instalación nueva)',
       (select count(*) from public.mensajes) = 0 and (select count(*) from public.items) = 0,
       ''
union all
select 10, 'la función de salud responde',
       (select public.salud_sistema() is not null),
       ''
order by paso;
