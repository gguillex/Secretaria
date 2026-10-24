-- Solo lee: qué versión de la base de datos tienes instalada. Úsala antes de actualizar para saber qué scripts de supabase/ te faltan.
-- Termina con una tabla: cada versión de la base de datos y si está (true) o falta (false). Si la última que sale en true es la 1.0, ejecuta
-- actualizar-1.1.sql, después actualizar-1.2.sql después actualizar-1.4.sql y después actualizar-1.5.sql; si es la 1.1, desde actualizar-1.2.sql; si es la 1.2, 
-- actualizar-1.4.sql y después actualizar-1.5.sql (la 1.3 no cambió la base de datos); si es la 1.4, solo actualizar-1.5.sql. Con todas en
-- true, está al día.
select * from (values
  ('1.0', 'instalación base (tabla avisos_enviados)', to_regclass('public.avisos_enviados') is not null),
  ('1.1', 'borrar en Drive y olvidar la memoria (marcar_borrado_drive y olvidar_memoria)',
    to_regprocedure('public.marcar_borrado_drive(text[])') is not null and to_regprocedure('public.olvidar_memoria(uuid)') is not null),
  ('1.2', 'horario fijo y orden de llegada (tablas horario_fijo y llegadas)',
    to_regclass('public.horario_fijo') is not null and to_regclass('public.llegadas') is not null),
  ('1.4', 'respuestas citadas, deshaz, un aviso por varios archivos y mover carpetas (función mover_carpeta_drive)',
    to_regprocedure('public.mover_carpeta_drive(text, text, text, text)') is not null and to_regprocedure('public.reclamar_confirmacion_archivos(integer, integer)') is not null),
  ('1.5', 'Drive cada 10 segundos con turno y vaciar carpetas (tablas turnos y carpetas_vaciar)',
    to_regclass('public.turnos') is not null and to_regclass('public.carpetas_vaciar') is not null)
) as t(version, que_mira, instalada)
order by version;
