-- Solo lee: qué versión de la base de datos tienes instalada. Úsala antes de actualizar para saber qué scripts de supabase/ te faltan.
-- Termina con una tabla: cada versión de la base de datos y si está (true) o falta (false). Ejecuta, en orden, los actualizar-1.X.sql de las
-- versiones que salgan en false (actualizar-1.1, 1.2, 1.4, 1.5 y 1.7; la 1.3 y la 1.6 no cambiaron la base de datos). Con todas en true,
-- está al día.
select * from (values
  ('1.0', 'instalación base (tabla avisos_enviados)', to_regclass('public.avisos_enviados') is not null),
  ('1.1', 'borrar en Drive y olvidar la memoria (marcar_borrado_drive y olvidar_memoria)',
    to_regprocedure('public.marcar_borrado_drive(text[])') is not null and to_regprocedure('public.olvidar_memoria(uuid)') is not null),
  ('1.2', 'horario fijo y orden de llegada (tablas horario_fijo y llegadas)',
    to_regclass('public.horario_fijo') is not null and to_regclass('public.llegadas') is not null),
  ('1.4', 'respuestas citadas, deshaz, un aviso por varios archivos y mover carpetas (función mover_carpeta_drive)',
    to_regprocedure('public.mover_carpeta_drive(text, text, text, text)') is not null and to_regprocedure('public.reclamar_confirmacion_archivos(integer, integer)') is not null),
  ('1.5', 'Drive cada 10 segundos con turno y vaciar carpetas (tablas turnos y carpetas_vaciar)',
    to_regclass('public.turnos') is not null and to_regclass('public.carpetas_vaciar') is not null),
  ('1.7', 'viajes y zona horaria (tabla viajes y columnas items.zona_alarma y items.carpeta)',
    to_regclass('public.viajes') is not null
    and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'items' and column_name = 'zona_alarma')
    and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'items' and column_name = 'carpeta'))
) as t(version, que_mira, instalada)
order by version;
