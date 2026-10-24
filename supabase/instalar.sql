-- Base de datos de la secretaria: instalación completa en un proyecto de Supabase VACÍO.
--
-- Cómo usarlo (docs/manual-instalacion.md, paso de Supabase):
--   Supabase > SQL Editor > New query > pega este archivo ENTERO (ábrelo en un editor y copia desde aquí, no desde
--   un chat) > Run. Debe terminar en "Success. No rows returned". Después ejecuta supabase/comprobar-instalacion.sql.
--
-- Todo va en una transacción: si algo falla, no se crea nada y se puede volver a ejecutar tal cual.
-- Seguridad: RLS activado en todas las tablas y sin permisos para los roles públicos (anon, authenticated).
-- n8n entra con la clave secreta (rol service_role), que es la única que puede leer y escribir.

begin;

-- Las funciones en SQL se crean antes que las tablas que usan: se comprueban al ejecutarse, no al crearse.
set local check_function_bodies = false;

CREATE TABLE public.items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    mensaje_id uuid,
    tipo text NOT NULL,
    titulo text NOT NULL,
    contenido text,
    estado text DEFAULT 'pendiente'::text NOT NULL,
    fecha_inicio timestamp with time zone,
    fecha_fin timestamp with time zone,
    fecha_limite timestamp with time zone,
    lista text,
    etiquetas text[] DEFAULT '{}'::text[] NOT NULL,
    archivo_url text,
    calendar_event_id text,
    confianza numeric(3,2),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    espera_archivo_hasta timestamp with time zone,
    calendar_pendiente boolean DEFAULT false NOT NULL,
    aviso_whatsapp_en timestamp with time zone,
    aviso_whatsapp_enviado_at timestamp with time zone,
    recordar_en timestamp with time zone,
    recordatorio_avisos smallint[] DEFAULT '{}'::smallint[] NOT NULL,
    proyecto text,
    quitado_en timestamp with time zone,
    CONSTRAINT items_aviso_enviado_implica_aviso CHECK (((aviso_whatsapp_enviado_at IS NULL) OR (aviso_whatsapp_en IS NOT NULL))),
    CONSTRAINT items_estado_check CHECK ((estado = ANY (ARRAY['pendiente'::text, 'hecho'::text, 'archivado'::text]))),
    CONSTRAINT items_tipo_check CHECK ((tipo = ANY (ARRAY['evento'::text, 'tarea'::text, 'lista'::text, 'nota'::text])))
);

COMMENT ON COLUMN public.items.archivo_url IS 'Sin uso: los archivos de un item van en la tabla archivos.';

COMMENT ON COLUMN public.items.espera_archivo_hasta IS 'Hasta cuándo el item espera un archivo que lo acompañe ("te mando un documento con la nota").';

COMMENT ON COLUMN public.items.calendar_pendiente IS 'El evento necesita crearse, actualizarse o borrarse en Google Calendar. Lo activa el trigger items_calendar_pendiente; lo limpia el flujo Sincronizar Calendar.';

COMMENT ON COLUMN public.items.aviso_whatsapp_en IS 'Aviso urgente por WhatsApp (evento del mismo día o aviso en menos de 2 horas desde que se crea). Nulo = sin aviso. Lo calcula el sincronizador.';

COMMENT ON COLUMN public.items.aviso_whatsapp_enviado_at IS 'Cuándo se envió el aviso urgente. Nulo = pendiente de enviar.';

COMMENT ON COLUMN public.items.recordar_en IS 'Hora de un recordatorio corto (solo tareas). El flujo "Recordatorios" avisa por WhatsApp antes y a esa hora. No se sincroniza con Calendar.';

COMMENT ON COLUMN public.items.recordatorio_avisos IS 'Avisos del recordatorio ya enviados, en minutos antes de recordar_en (por ejemplo {60,30,0}). Se vacía si cambia recordar_en.';

COMMENT ON COLUMN public.items.proyecto IS 'Nombre del proyecto al que pertenece (o null). Un trigger lo escribe como en la tabla proyectos y crea el proyecto si no existe.';

CREATE FUNCTION public.anadir_contenido(p_ids uuid[], p_texto text) RETURNS SETOF public.items
    LANGUAGE sql
    SET search_path TO ''
    AS $$
  update public.items
     set contenido = case when contenido is null or btrim(contenido) = '' then btrim(p_texto) else contenido || E'\n' || btrim(p_texto) end
   where id = any (p_ids) and estado = 'pendiente' and btrim(coalesce(p_texto, '')) <> ''
  returning *;
$$;

COMMENT ON FUNCTION public.anadir_contenido(p_ids uuid[], p_texto text) IS 'Añade una línea al contenido de los items pendientes indicados (no lo sustituye). Devuelve los items cambiados.';

CREATE FUNCTION public.contexto_avisos(p_wa_message_id text, p_horas integer DEFAULT 12) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select jsonb_build_object(
    -- Los elementos del aviso citado que siguen vivos (pendientes, o una alarma que ya sonó y quedó hecha)
    'citados', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', i.id, 'tipo', i.tipo, 'titulo', i.titulo, 'estado', i.estado, 'aviso', a.tipo,
          'fecha_inicio', i.fecha_inicio, 'fecha_fin', i.fecha_fin, 'recordar_en', i.recordar_en)
        order by coalesce(i.recordar_en, i.fecha_inicio), i.titulo)
      from public.avisos_enviados a
      join public.items i on i.id = a.item_id
      where nullif(p_wa_message_id, '') is not null
        and a.wa_message_id = p_wa_message_id
        and i.estado in ('pendiente', 'hecho')
    ), '[]'::jsonb),
    -- Alarmas que ya sonaron (aviso «a la hora» enviado) en las últimas p_horas: las 10 más recientes
    'recientes', coalesce((
      select jsonb_agg(jsonb_build_object('id', r.id, 'tipo', r.tipo, 'titulo', r.titulo, 'estado', r.estado, 'recordar_en', r.recordar_en)
        order by r.recordar_en desc)
      from (
        select i.id, i.tipo, i.titulo, i.estado, i.recordar_en
        from public.items i
        where i.tipo = 'tarea' and i.estado = 'hecho' and i.recordar_en is not null
          and 0 = any (i.recordatorio_avisos)
          and i.recordar_en between now() - make_interval(hours => greatest(1, least(coalesce(p_horas, 12), 72))) and now()
        order by i.recordar_en desc
        limit 10
      ) r
    ), '[]'::jsonb)
  );
$$;

COMMENT ON FUNCTION public.contexto_avisos(p_wa_message_id text, p_horas integer) IS 'Para el flujo principal: los elementos del aviso de WhatsApp al que responde el usuario y las alarmas que sonaron hace poco. Solo lee.';

CREATE FUNCTION public.guardar_con_archivos(p_item jsonb, p_archivos jsonb) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  v_item public.items;
  v_total integer;
  v_asignados integer;
  v_estado text;
begin
  if jsonb_typeof(p_item) is distinct from 'object' then
    raise exception 'p_item debe ser un objeto';
  end if;
  if jsonb_typeof(p_archivos) is distinct from 'array' or jsonb_array_length(p_archivos) = 0 then
    raise exception 'p_archivos debe ser una lista con al menos un archivo';
  end if;
  v_total := jsonb_array_length(p_archivos);

  -- Sin estado, pendiente (como hasta ahora). Solo pendiente u hecho: cancelar un item es otra operación.
  v_estado := coalesce(nullif(btrim(p_item ->> 'estado'), ''), 'pendiente');
  if v_estado not in ('pendiente', 'hecho') then
    raise exception 'estado no admitido: % (solo pendiente o hecho)', v_estado;
  end if;

  insert into public.items (
    mensaje_id, tipo, titulo, contenido, estado, fecha_inicio, fecha_fin, fecha_limite, lista,
    etiquetas, confianza, espera_archivo_hasta
  )
  values (
    (p_item ->> 'mensaje_id')::uuid,
    p_item ->> 'tipo',
    p_item ->> 'titulo',
    p_item ->> 'contenido',
    v_estado,
    (p_item ->> 'fecha_inicio')::timestamptz,
    (p_item ->> 'fecha_fin')::timestamptz,
    (p_item ->> 'fecha_limite')::timestamptz,
    p_item ->> 'lista',
    case
      when jsonb_typeof(p_item -> 'etiquetas') = 'array' then array(select jsonb_array_elements_text(p_item -> 'etiquetas'))
      else '{}'::text[]
    end,
    (p_item ->> 'confianza')::numeric,
    (p_item ->> 'espera_archivo_hasta')::timestamptz
  )
  returning * into v_item;

  update public.archivos a
     set item_id = v_item.id,
         carpeta_destino = null,
         estado = 'asignado',
         nombre = coalesce(nullif(btrim(x.nombre), ''), a.nombre)
    from jsonb_to_recordset(p_archivos) as x (id uuid, nombre text)
   where a.id = x.id;
  get diagnostics v_asignados = row_count;

  if v_asignados <> v_total then
    raise exception 'Solo se encontraron % de % archivos: no se guarda nada', v_asignados, v_total;
  end if;

  return to_jsonb(v_item);
end;
$$;

COMMENT ON FUNCTION public.guardar_con_archivos(p_item jsonb, p_archivos jsonb) IS 'Crea un item (pendiente u hecho, según p_item.estado) y le cuelga los archivos dados en una sola transacción. Solo service_role. Devuelve el item.';

CREATE FUNCTION public.items_proyecto_canonico() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  v_nombre text;
begin
  if new.proyecto is null then
    return new;
  end if;
  new.proyecto := btrim(new.proyecto);
  if new.proyecto = '' then
    new.proyecto := null;
    return new;
  end if;
  select nombre into v_nombre from public.proyectos where nombre_norm = lower(new.proyecto);
  if v_nombre is null then
    insert into public.proyectos (nombre) values (new.proyecto) returning nombre into v_nombre;
  elsif new.estado = 'pendiente' then
    -- Algo pendiente en un proyecto cerrado lo vuelve a abrir
    update public.proyectos set estado = 'activo' where nombre = v_nombre and estado <> 'activo';
  end if;
  new.proyecto := v_nombre;
  return new;
end;
$$;

CREATE FUNCTION public.liberar_turno(p_mensaje_id uuid) RETURNS boolean
    LANGUAGE sql
    SET search_path TO ''
    AS $$
  with soltado as (
    update public.turno set mensaje_id = null, hasta = null where id = 1 and mensaje_id = p_mensaje_id returning 1
  )
  select exists (select 1 from soltado);
$$;

COMMENT ON FUNCTION public.liberar_turno(p_mensaje_id uuid) IS 'Suelta el turno si lo tiene ese mensaje. Devuelve si lo tenía.';

CREATE FUNCTION public.marcar_calendar_pendiente() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if tg_op = 'INSERT' then
    if new.tipo = 'evento' then
      new.calendar_pendiente := true;
    end if;
  elsif (new.tipo = 'evento' or new.calendar_event_id is not null)
        and (new.tipo is distinct from old.tipo
             or new.titulo is distinct from old.titulo
             or new.contenido is distinct from old.contenido
             or new.fecha_inicio is distinct from old.fecha_inicio
             or new.fecha_fin is distinct from old.fecha_fin
             or new.estado is distinct from old.estado) then
    new.calendar_pendiente := true;
    if new.tipo is distinct from old.tipo
       or new.fecha_inicio is distinct from old.fecha_inicio
       or new.fecha_fin is distinct from old.fecha_fin
       or new.estado is distinct from old.estado then
      new.aviso_whatsapp_en := null;
      new.aviso_whatsapp_enviado_at := null;
    end if;
  end if;
  return new;
end;
$$;

COMMENT ON FUNCTION public.marcar_calendar_pendiente() IS 'Marca un evento como pendiente de sincronizar con Calendar cuando se crea o cambia algo que se refleja allí. Anula su aviso urgente solo si cambia el tipo, las fechas o el estado.';

CREATE FUNCTION public.marcar_drive_pendiente_archivo() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if tg_op = 'INSERT' then
    if new.item_id is not null or new.carpeta_destino is not null then
      new.drive_pendiente := true;
    end if;
  elsif new.vigilado_at is distinct from old.vigilado_at then
    null;
  elsif (new.item_id is not null and new.item_id is distinct from old.item_id)
        or new.carpeta_destino is distinct from old.carpeta_destino
        or new.nombre is distinct from old.nombre then
    new.drive_pendiente := true;
  end if;
  return new;
end;
$$;

COMMENT ON FUNCTION public.marcar_drive_pendiente_archivo() IS 'Marca un archivo para moverlo o renombrarlo en Drive cuando se le asigna un item, cambia de item, se pide o cambia su carpeta de destino o cambia su nombre. No marca si la escritura cambia vigilado_at (cambio hecho a mano anotado por «Vigilar Drive»).';

CREATE FUNCTION public.normalizar_recordatorio() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  -- Solo las tareas llevan recordatorio
  if new.tipo is distinct from 'tarea' then
    new.recordar_en := null;
  end if;
  -- Otra hora: los avisos ya enviados valían para la anterior
  if tg_op = 'UPDATE' and new.recordar_en is distinct from old.recordar_en then
    new.recordatorio_avisos := '{}';
  end if;
  if new.recordar_en is null then
    new.recordatorio_avisos := '{}';
  end if;
  return new;
end;
$$;

COMMENT ON FUNCTION public.normalizar_recordatorio() IS 'Mantiene la coherencia de los recordatorios: solo las tareas llevan recordar_en y cambiar la hora borra los avisos ya enviados.';

CREATE FUNCTION public.poner_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  new.updated_at := now();
  return new;
end;
$$;

CREATE FUNCTION public.resumen_proyectos() RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select coalesce(jsonb_agg(jsonb_build_object('nombre', p.nombre, 'estado', p.estado, 'pendientes', (
           select count(*) from public.items i where i.proyecto = p.nombre and i.estado = 'pendiente'
         )) order by p.estado = 'cerrado', lower(p.nombre)), '[]'::jsonb)
  from public.proyectos p;
$$;

CREATE FUNCTION public.ruta_carpeta_valida(ruta text) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $_$
  select ruta is not null
    and ruta ~ '^[^/\\[:cntrl:]]{1,60}(/[^/\\[:cntrl:]]{1,60}){0,2}$'
    and ruta !~ '(^|/)\.{1,2}(/|$)'
    and ruta !~ '(^|/)\s'
    and ruta !~ '\s(/|$)';
$_$;

COMMENT ON FUNCTION public.ruta_carpeta_valida(ruta text) IS 'Verdadero si es una ruta de carpeta admitida: de 1 a 3 niveles de 1 a 60 caracteres, sin barra invertida, caracteres de control, "." ni "..", y sin espacios en los extremos de un nivel.';

CREATE FUNCTION public.salud_sistema() RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select jsonb_build_object(
    'ahora', now(),
    'calendar_atascados', (
      select count(*) from public.items
      where calendar_pendiente and updated_at < now() - interval '15 minutes'
    ),
    'drive_atascados', (
      (select count(*) from public.archivos where drive_pendiente and eliminado_at is null and updated_at < now() - interval '30 minutes')
      + (select count(*) from public.carpetas_pedidas where drive_pendiente and eliminada_at is null and updated_at < now() - interval '30 minutes')
    ),
    -- Solo los que no tienen motivo anotado (los fallos con motivo ya se avisaron)
    'mensajes_sin_procesar', (
      select count(*) from public.mensajes
      where not procesado and error is null and created_at between now() - interval '2 hours' and now() - interval '3 minutes'
    ),
    'recordatorios_vencidos', (
      select count(*) from public.items
      where tipo = 'tarea' and estado = 'pendiente' and recordar_en is not null
        and recordar_en < now() - interval '15 minutes'
        and not (0 = any (recordatorio_avisos))
    ),
    'ultimo_mensaje', (select max(created_at) from public.mensajes where wa_message_id like 'wamid.%')
  );
$$;

COMMENT ON FUNCTION public.salud_sistema() IS 'Qué hay atascado ahora mismo (Calendar, Drive, mensajes sin procesar y sin motivo anotado, recordatorios vencidos). La lee el flujo «Latido». Solo lee.';

CREATE TABLE public.archivos (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    item_id uuid,
    mensaje_id uuid,
    drive_file_id text NOT NULL,
    drive_url text NOT NULL,
    nombre text NOT NULL,
    tipo_mime text,
    estado text DEFAULT 'pendiente'::text NOT NULL,
    pregunta_enviada_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    drive_pendiente boolean DEFAULT false NOT NULL,
    carpeta_id text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    carpeta_destino text,
    respuesta_wa_id text,
    eliminado_at timestamp with time zone,
    vigilado_at timestamp with time zone,
    confirmado_at timestamp with time zone,
    CONSTRAINT archivos_carpeta_destino_valida CHECK (((carpeta_destino IS NULL) OR ((carpeta_destino ~ '^[^/\\[:cntrl:]]{1,60}(/[^/\\[:cntrl:]]{1,60}){0,2}$'::text) AND (carpeta_destino !~ '(^|/)\.{1,2}(/|$)'::text) AND (carpeta_destino !~ '(^|/)\s'::text) AND (carpeta_destino !~ '\s(/|$)'::text)))),
    CONSTRAINT archivos_carpeta_implica_asignado CHECK (((carpeta_destino IS NULL) OR (estado = 'asignado'::text))),
    CONSTRAINT archivos_estado_check CHECK ((estado = ANY (ARRAY['pendiente'::text, 'asignado'::text]))),
    CONSTRAINT archivos_item_implica_asignado CHECK (((item_id IS NULL) OR (estado = 'asignado'::text))),
    CONSTRAINT archivos_nombre_check CHECK ((btrim(nombre) <> ''::text))
);

COMMENT ON TABLE public.archivos IS 'Archivos recibidos. El contenido vive en Drive; aquí la referencia y su estado (pendiente/asignado).';

COMMENT ON COLUMN public.archivos.pregunta_enviada_at IS 'Nulo = aún no se ha preguntado al usuario por este archivo pendiente.';

COMMENT ON COLUMN public.archivos.drive_pendiente IS 'El archivo necesita moverse de carpeta en Drive. Lo activan los triggers archivos_drive_pendiente e items_drive_pendiente; lo limpia el flujo Sincronizar Drive.';

COMMENT ON COLUMN public.archivos.carpeta_id IS 'Id de la carpeta de Drive donde está ahora el archivo. Nulo = no se sabe.';

COMMENT ON COLUMN public.archivos.updated_at IS 'Última modificación. El sincronizador de Drive escribe con una condición sobre este valor.';

COMMENT ON COLUMN public.archivos.carpeta_destino IS 'Carpeta pedida por el usuario, como ruta bajo Secretaria/ (Fotos, Fotos/Viajes). Si existe, manda sobre la carpeta que saldría del item. Un archivo con carpeta está asignado.';

COMMENT ON COLUMN public.archivos.respuesta_wa_id IS 'Id del mensaje de WhatsApp con el que la secretaria confirmó haber guardado el archivo. El usuario clasifica el archivo respondiendo a ese mensaje.';

COMMENT ON COLUMN public.archivos.eliminado_at IS 'El archivo se borró a mano en Drive (papelera o definitivo). Lo anota el flujo «Vigilar Drive»; la fila no se borra. Nulo = existe.';

COMMENT ON COLUMN public.archivos.vigilado_at IS 'Última vez que «Vigilar Drive» anotó aquí un cambio hecho a mano (mover o renombrar). Mientras cambie con la fila, el trigger de «mover en Drive» no marca el archivo.';

CREATE TABLE public.avisos_enviados (
    wa_message_id text NOT NULL,
    item_id uuid NOT NULL,
    tipo text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT avisos_enviados_tipo_valido CHECK ((tipo = ANY (ARRAY['alarma'::text, 'cita'::text]))),
    CONSTRAINT avisos_enviados_wa_message_id_formato CHECK ((((char_length(wa_message_id) >= 1) AND (char_length(wa_message_id) <= 300)) AND (wa_message_id ~ '^[A-Za-z0-9._=+/-]+$'::text)))
);

COMMENT ON TABLE public.avisos_enviados IS 'Qué alarmas y citas iban en cada aviso de WhatsApp enviado. Sirve para saber a qué elemento se refiere el usuario cuando RESPONDE a un aviso.';

CREATE TABLE public.carpetas_pedidas (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ruta text NOT NULL,
    drive_pendiente boolean DEFAULT true NOT NULL,
    carpeta_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    eliminada_at timestamp with time zone,
    CONSTRAINT carpetas_pedidas_ruta_valida CHECK (public.ruta_carpeta_valida(ruta))
);

COMMENT ON TABLE public.carpetas_pedidas IS 'Carpetas que el usuario ha pedido crear sin mover archivos. El flujo Sincronizar Drive las crea (un nivel por pasada) y limpia drive_pendiente.';

COMMENT ON COLUMN public.carpetas_pedidas.drive_pendiente IS 'La carpeta aún no está comprobada o creada en Drive. Se vuelve a activar si el usuario repite la petición.';

COMMENT ON COLUMN public.carpetas_pedidas.carpeta_id IS 'Id de la carpeta de Drive del último nivel de la ruta, cuando ya existe.';

COMMENT ON COLUMN public.carpetas_pedidas.eliminada_at IS 'La carpeta se borró a mano en Drive. Lo anota «Vigilar Drive». Pedir otra vez la carpeta la vuelve a activar.';

CREATE TABLE public.drive_arbol (
    drive_id text NOT NULL,
    tipo text NOT NULL,
    nombre text NOT NULL,
    padre_id text,
    ruta text NOT NULL,
    origen text DEFAULT 'base'::text NOT NULL,
    visto_at timestamp with time zone DEFAULT now() NOT NULL,
    eliminado_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT drive_arbol_drive_id_check CHECK ((btrim(drive_id) <> ''::text)),
    CONSTRAINT drive_arbol_nombre_check CHECK ((btrim(nombre) <> ''::text)),
    CONSTRAINT drive_arbol_origen_check CHECK ((origen = ANY (ARRAY['base'::text, 'sistema'::text, 'manual'::text]))),
    CONSTRAINT drive_arbol_tipo_check CHECK ((tipo = ANY (ARRAY['carpeta'::text, 'archivo'::text])))
);

COMMENT ON TABLE public.drive_arbol IS 'Foto del árbol de Drive bajo Secretaria/ (carpetas y archivos con su ruta). «Vigilar Drive» la compara con Drive cada 5 minutos para detectar lo que el usuario hace a mano.';

COMMENT ON COLUMN public.drive_arbol.origen IS 'base = ya existía al empezar a vigilar; sistema = lo creó la secretaria; manual = lo creó el usuario.';

COMMENT ON COLUMN public.drive_arbol.eliminado_at IS 'No nulo = ya no está en Drive (papelera o borrado). Si reaparece (se recupera de la papelera) vuelve a nulo.';

CREATE TABLE public.memoria (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    termino text NOT NULL,
    significado text NOT NULL,
    termino_norm text GENERATED ALWAYS AS (lower(btrim(termino))) STORED,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT memoria_significado_check CHECK ((btrim(significado) <> ''::text)),
    CONSTRAINT memoria_termino_check CHECK ((btrim(termino) <> ''::text))
);

COMMENT ON TABLE public.memoria IS 'Términos que el usuario enseña a la secretaria. Se inyecta en cada llamada al modelo. Solo se escribe con confirmación del usuario.';

COMMENT ON COLUMN public.memoria.termino_norm IS 'Columna generada (minúsculas, sin espacios en los extremos). Clave para upsert con on_conflict=termino_norm.';

CREATE TABLE public.mensajes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    wa_message_id text NOT NULL,
    tipo_entrada text NOT NULL,
    texto_original text,
    transcripcion text,
    media_url text,
    procesado boolean DEFAULT false NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    pregunta text,
    hilo jsonb,
    pregunta_pendiente boolean DEFAULT false NOT NULL,
    en_cola boolean DEFAULT false NOT NULL,
    agrupado_en uuid,
    contexto_wa_id text,
    respuesta_wa_ids text[],
    respuesta_texto text,
    CONSTRAINT mensajes_hilo_es_lista CHECK (((hilo IS NULL) OR (jsonb_typeof(hilo) = 'array'::text))),
    CONSTRAINT mensajes_respuesta_texto_corto CHECK (((respuesta_texto IS NULL) OR (char_length(respuesta_texto) <= 1500))),
    CONSTRAINT mensajes_pregunta_pendiente_completa CHECK (((NOT pregunta_pendiente) OR ((pregunta IS NOT NULL) AND (hilo IS NOT NULL)))),
    CONSTRAINT mensajes_tipo_entrada_check CHECK ((tipo_entrada = ANY (ARRAY['texto'::text, 'audio'::text, 'imagen'::text, 'documento'::text])))
);

COMMENT ON COLUMN public.mensajes.pregunta IS 'Pregunta que la secretaria hizo al usuario al procesar este mensaje (intención aclarar).';

COMMENT ON COLUMN public.mensajes.hilo IS 'Conversación hasta la pregunta: lista de turnos {rol: user|model, texto}. Se devuelve al modelo cuando llega la respuesta.';

COMMENT ON COLUMN public.mensajes.pregunta_pendiente IS 'La pregunta espera respuesta. Se cierra al procesar el mensaje siguiente. La caducidad la aplica el flujo al leer.';

COMMENT ON COLUMN public.mensajes.en_cola IS 'Verdadero mientras el mensaje espera a que una ejecución lo reclame (reclamar_mensajes). Solo los de texto y audio del flujo principal.';

COMMENT ON COLUMN public.mensajes.agrupado_en IS 'Mensaje cuya ejecución procesó a este (junto con los que llegaron seguidos). Su resultado y su error están en esa fila.';

CREATE TABLE public.proyectos (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    nombre text NOT NULL,
    nombre_norm text GENERATED ALWAYS AS (lower(nombre)) STORED,
    estado text DEFAULT 'activo'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT proyectos_estado_valido CHECK ((estado = ANY (ARRAY['activo'::text, 'cerrado'::text]))),
    CONSTRAINT proyectos_nombre_valido CHECK (((nombre = btrim(nombre)) AND ((length(nombre) >= 1) AND (length(nombre) <= 60)) AND (nombre !~ '[/\\[:cntrl:]]'::text)))
);

COMMENT ON TABLE public.proyectos IS 'Proyectos del usuario (tareas y notas agrupadas aparte de las cotidianas). items.proyecto apunta a nombre.';

CREATE TABLE public.registro_calendar (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    tipo text NOT NULL,
    event_id text NOT NULL,
    item_id uuid,
    titulo text NOT NULL,
    detalle jsonb DEFAULT '{}'::jsonb NOT NULL,
    notificado_at timestamp with time zone,
    clave text NOT NULL,
    CONSTRAINT registro_calendar_clave_check CHECK ((btrim(clave) <> ''::text)),
    CONSTRAINT registro_calendar_event_id_check CHECK ((btrim(event_id) <> ''::text)),
    CONSTRAINT registro_calendar_tipo_check CHECK ((tipo = ANY (ARRAY['evento_creado'::text, 'evento_eliminado'::text, 'evento_movido'::text, 'evento_renombrado'::text])))
);

COMMENT ON TABLE public.registro_calendar IS 'Historial de cambios hechos a mano en Google Calendar y detectados por «Vigilar Calendar». notificado_at nulo = pendiente de avisar por WhatsApp.';

COMMENT ON COLUMN public.registro_calendar.clave IS 'Única: tipo, id del evento y fecha de última modificación que da Google. Evita registrar dos veces el mismo cambio si el flujo se repite.';

CREATE TABLE public.registro_drive (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    tipo text NOT NULL,
    drive_id text NOT NULL,
    nombre text NOT NULL,
    ruta_antes text,
    ruta_despues text,
    detalle jsonb DEFAULT '{}'::jsonb NOT NULL,
    notificado_at timestamp with time zone,
    clave text NOT NULL,
    CONSTRAINT registro_drive_clave_check CHECK ((btrim(clave) <> ''::text)),
    CONSTRAINT registro_drive_tipo_check CHECK ((tipo = ANY (ARRAY['carpeta_creada'::text, 'carpeta_eliminada'::text, 'carpeta_movida'::text, 'carpeta_renombrada'::text, 'carpeta_restaurada'::text, 'archivo_eliminado'::text, 'archivo_movido'::text, 'archivo_renombrado'::text, 'archivo_restaurado'::text])))
);

COMMENT ON TABLE public.registro_drive IS 'Historial de cambios hechos a mano en Drive y detectados por «Vigilar Drive». notificado_at nulo = pendiente de avisar por WhatsApp.';

COMMENT ON COLUMN public.registro_drive.clave IS 'Única: tipo, id de Drive y estado anterior de la foto. Evita registrar dos veces el mismo cambio si el flujo se repite.';

CREATE TABLE public.turno (
    id smallint DEFAULT 1 NOT NULL,
    mensaje_id uuid,
    hasta timestamp with time zone,
    CONSTRAINT turno_una_fila CHECK ((id = 1))
);

CREATE TABLE public.vigilantes_estado (
    clave text NOT NULL,
    valor jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT vigilantes_estado_clave_check CHECK ((btrim(clave) <> ''::text))
);

COMMENT ON TABLE public.vigilantes_estado IS 'Lo que cada flujo «Vigilar …» recuerda entre pasadas. Para calendar: {"ultima": "<instante de la última pasada correcta>"}.';

ALTER TABLE ONLY public.archivos
    ADD CONSTRAINT archivos_drive_file_id_unico UNIQUE (drive_file_id);

ALTER TABLE ONLY public.archivos
    ADD CONSTRAINT archivos_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.avisos_enviados
    ADD CONSTRAINT avisos_enviados_pkey PRIMARY KEY (wa_message_id, item_id);

ALTER TABLE ONLY public.carpetas_pedidas
    ADD CONSTRAINT carpetas_pedidas_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.carpetas_pedidas
    ADD CONSTRAINT carpetas_pedidas_ruta_unica UNIQUE (ruta);

ALTER TABLE ONLY public.drive_arbol
    ADD CONSTRAINT drive_arbol_pkey PRIMARY KEY (drive_id);

ALTER TABLE ONLY public.items
    ADD CONSTRAINT items_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.memoria
    ADD CONSTRAINT memoria_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.memoria
    ADD CONSTRAINT memoria_termino_norm_unico UNIQUE (termino_norm);

ALTER TABLE ONLY public.mensajes
    ADD CONSTRAINT mensajes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.mensajes
    ADD CONSTRAINT mensajes_wa_message_id_key UNIQUE (wa_message_id);

ALTER TABLE ONLY public.proyectos
    ADD CONSTRAINT proyectos_nombre_norm_unico UNIQUE (nombre_norm);

ALTER TABLE ONLY public.proyectos
    ADD CONSTRAINT proyectos_nombre_unico UNIQUE (nombre);

ALTER TABLE ONLY public.proyectos
    ADD CONSTRAINT proyectos_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.registro_calendar
    ADD CONSTRAINT registro_calendar_clave_key UNIQUE (clave);

ALTER TABLE ONLY public.registro_calendar
    ADD CONSTRAINT registro_calendar_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.registro_drive
    ADD CONSTRAINT registro_drive_clave_key UNIQUE (clave);

ALTER TABLE ONLY public.registro_drive
    ADD CONSTRAINT registro_drive_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.turno
    ADD CONSTRAINT turno_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.vigilantes_estado
    ADD CONSTRAINT vigilantes_estado_pkey PRIMARY KEY (clave);

CREATE INDEX archivos_drive_pendiente_idx ON public.archivos USING btree (updated_at) WHERE drive_pendiente;

CREATE INDEX archivos_item_idx ON public.archivos USING btree (item_id);

CREATE INDEX archivos_pendientes_idx ON public.archivos USING btree (created_at) WHERE (estado = 'pendiente'::text);

CREATE UNIQUE INDEX archivos_respuesta_wa_id_unico ON public.archivos USING btree (respuesta_wa_id) WHERE (respuesta_wa_id IS NOT NULL);

CREATE INDEX archivos_vivos_pendientes_idx ON public.archivos USING btree (created_at) WHERE ((estado = 'pendiente'::text) AND (eliminado_at IS NULL));

CREATE INDEX avisos_enviados_item_id_idx ON public.avisos_enviados USING btree (item_id);

CREATE INDEX carpetas_pedidas_pendientes_idx ON public.carpetas_pedidas USING btree (updated_at) WHERE drive_pendiente;

CREATE INDEX drive_arbol_vivos_idx ON public.drive_arbol USING btree (tipo) WHERE (eliminado_at IS NULL);

CREATE INDEX items_aviso_whatsapp_idx ON public.items USING btree (aviso_whatsapp_en) WHERE ((aviso_whatsapp_en IS NOT NULL) AND (aviso_whatsapp_enviado_at IS NULL));

CREATE UNIQUE INDEX items_calendar_event_id_unico ON public.items USING btree (calendar_event_id) WHERE (calendar_event_id IS NOT NULL);

COMMENT ON INDEX public.items_calendar_event_id_unico IS 'Un evento de Google Calendar corresponde como mucho a un item: un evento creado a mano nunca se importa dos veces.';

CREATE INDEX items_calendar_pendiente_idx ON public.items USING btree (updated_at) WHERE calendar_pendiente;

CREATE INDEX items_espera_archivo_idx ON public.items USING btree (espera_archivo_hasta) WHERE (espera_archivo_hasta IS NOT NULL);

CREATE INDEX items_fecha_limite_idx ON public.items USING btree (fecha_limite) WHERE (tipo = 'tarea'::text);

CREATE INDEX items_lista_idx ON public.items USING btree (lista) WHERE (tipo = 'lista'::text);

CREATE INDEX items_proyecto_idx ON public.items USING btree (proyecto) WHERE (proyecto IS NOT NULL);

CREATE INDEX items_recordar_en_idx ON public.items USING btree (recordar_en) WHERE ((recordar_en IS NOT NULL) AND (estado = 'pendiente'::text));

CREATE INDEX items_tipo_estado_idx ON public.items USING btree (tipo, estado);

CREATE INDEX mensajes_en_cola_idx ON public.mensajes USING btree (created_at) WHERE en_cola;

CREATE INDEX mensajes_pregunta_pendiente_idx ON public.mensajes USING btree (created_at) WHERE pregunta_pendiente;

CREATE INDEX registro_calendar_item_idx ON public.registro_calendar USING btree (item_id);

CREATE INDEX registro_calendar_sin_avisar_idx ON public.registro_calendar USING btree (created_at) WHERE (notificado_at IS NULL);

CREATE INDEX registro_drive_sin_avisar_idx ON public.registro_drive USING btree (created_at) WHERE (notificado_at IS NULL);

CREATE TRIGGER archivos_drive_pendiente BEFORE INSERT OR UPDATE ON public.archivos FOR EACH ROW EXECUTE FUNCTION public.marcar_drive_pendiente_archivo();

CREATE TRIGGER archivos_updated_at BEFORE UPDATE ON public.archivos FOR EACH ROW EXECUTE FUNCTION public.poner_updated_at();

CREATE TRIGGER carpetas_pedidas_updated_at BEFORE UPDATE ON public.carpetas_pedidas FOR EACH ROW EXECUTE FUNCTION public.poner_updated_at();

CREATE TRIGGER items_calendar_pendiente BEFORE INSERT OR UPDATE ON public.items FOR EACH ROW EXECUTE FUNCTION public.marcar_calendar_pendiente();

CREATE TRIGGER items_normalizar_recordatorio BEFORE INSERT OR UPDATE ON public.items FOR EACH ROW EXECUTE FUNCTION public.normalizar_recordatorio();

CREATE TRIGGER items_proyecto_canonico BEFORE INSERT OR UPDATE OF proyecto ON public.items FOR EACH ROW EXECUTE FUNCTION public.items_proyecto_canonico();

CREATE TRIGGER items_updated_at BEFORE UPDATE ON public.items FOR EACH ROW EXECUTE FUNCTION public.poner_updated_at();

CREATE TRIGGER memoria_updated_at BEFORE UPDATE ON public.memoria FOR EACH ROW EXECUTE FUNCTION public.poner_updated_at();

CREATE TRIGGER proyectos_updated_at BEFORE UPDATE ON public.proyectos FOR EACH ROW EXECUTE FUNCTION public.poner_updated_at();

ALTER TABLE ONLY public.archivos
    ADD CONSTRAINT archivos_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.archivos
    ADD CONSTRAINT archivos_mensaje_id_fkey FOREIGN KEY (mensaje_id) REFERENCES public.mensajes(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.avisos_enviados
    ADD CONSTRAINT avisos_enviados_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.items
    ADD CONSTRAINT items_mensaje_id_fkey FOREIGN KEY (mensaje_id) REFERENCES public.mensajes(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.items
    ADD CONSTRAINT items_proyecto_fkey FOREIGN KEY (proyecto) REFERENCES public.proyectos(nombre) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.mensajes
    ADD CONSTRAINT mensajes_agrupado_en_fkey FOREIGN KEY (agrupado_en) REFERENCES public.mensajes(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.registro_calendar
    ADD CONSTRAINT registro_calendar_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id) ON DELETE SET NULL;

ALTER TABLE public.archivos ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.avisos_enviados ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.carpetas_pedidas ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.drive_arbol ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.items ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.memoria ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.mensajes ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.proyectos ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.registro_calendar ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.registro_drive ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.turno ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.vigilantes_estado ENABLE ROW LEVEL SECURITY;

-- ============================================================================================================
-- Funciones que usan las tablas de arriba (van después de ellas porque declaran tipos de fila).

-- Borrar en Drive por WhatsApp: el flujo principal manda a la papelera lo que el usuario ha confirmado y llama a esta función para
-- dejarlo anotado. p_ids son los ids de Drive borrados y los de las carpetas que cuelgan de ellos. Marca como eliminado (sin borrar
-- filas) lo que hay en la foto de «Vigilar Drive» (esos ids y todo lo que cuelga de esas carpetas, por su ruta, para que el vigilante no
-- lo avise como un borrado a mano), los archivos registrados y las carpetas pedidas. Devuelve cuántas filas marcó de cada tabla.
create function public.marcar_borrado_drive(p_ids text[])
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_ids text[] := coalesce(array_remove(p_ids, null), '{}');
  v_carpetas text[];
  v_arbol integer := 0;
  v_archivos integer := 0;
  v_pedidas integer := 0;
begin
  if cardinality(v_ids) = 0 then
    return jsonb_build_object('arbol', 0, 'archivos', 0, 'carpetas_pedidas', 0);
  end if;

  -- Las carpetas afectadas: las de p_ids y todas las que cuelgan de ellas según la foto (por la ruta: «Fotos/Viajes/…» cuelga de
  -- «Fotos/Viajes»; starts_with y no like, porque un nombre con «_» o «%» haría de comodín)
  select coalesce(array_agg(d.drive_id), '{}') into v_carpetas
  from public.drive_arbol d
  where d.tipo = 'carpeta'
    and exists (
      select 1 from public.drive_arbol c
      where c.tipo = 'carpeta' and c.drive_id = any (v_ids)
        and (d.drive_id = c.drive_id or starts_with(d.ruta, c.ruta || '/'))
    );
  v_carpetas := v_carpetas || v_ids;

  update public.drive_arbol d
  set eliminado_at = now(), updated_at = now()
  where d.eliminado_at is null
    and (
      d.drive_id = any (v_ids)
      or exists (
        select 1 from public.drive_arbol c
        where c.tipo = 'carpeta' and c.drive_id = any (v_ids) and starts_with(d.ruta, c.ruta || '/')
      )
    );
  get diagnostics v_arbol = row_count;

  update public.archivos a
  set eliminado_at = now(), drive_pendiente = false
  where a.eliminado_at is null
    and (a.drive_file_id = any (v_ids) or a.carpeta_id = any (v_carpetas));
  get diagnostics v_archivos = row_count;

  update public.carpetas_pedidas p
  set eliminada_at = now(), drive_pendiente = false
  where p.eliminada_at is null and p.carpeta_id = any (v_carpetas);
  get diagnostics v_pedidas = row_count;

  return jsonb_build_object('arbol', v_arbol, 'archivos', v_archivos, 'carpetas_pedidas', v_pedidas);
end;
$$;

comment on function public.marcar_borrado_drive(text[]) is 'Para el flujo principal: anota como eliminado lo que acaba de mandar a la papelera de Drive (foto de Vigilar Drive, archivos y carpetas pedidas, también lo que cuelga de las carpetas). No borra filas.';

-- Olvidar un dato de la memoria permanente («/forget 2»). Devuelve lo que borró ({borrado, termino, significado}) para que la respuesta
-- diga exactamente qué se olvidó. Nunca borra el nombre de la secretaria: eso se cambia, no se olvida.
create function public.olvidar_memoria(p_id uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_fila public.memoria%rowtype;
begin
  delete from public.memoria
  where id = p_id and termino_norm <> 'nombre de la secretaria'
  returning * into v_fila;
  if not found then
    return jsonb_build_object('borrado', false);
  end if;
  return jsonb_build_object('borrado', true, 'termino', v_fila.termino, 'significado', v_fila.significado);
end;
$$;

comment on function public.olvidar_memoria(uuid) is 'Para el flujo principal: borra un dato de la memoria permanente y devuelve cuál. Nunca el nombre de la secretaria.';

-- Horario fijo semanal y orden de llegada de los mensajes (cola de mensajes).
create table public.horario_fijo (
  id uuid primary key default gen_random_uuid(),
  titulo text not null constraint horario_fijo_titulo_valido check (char_length(btrim(titulo)) between 1 and 60),
  -- Para no repetir el mismo bloque («Trabajo» y «trabajo» son el mismo)
  titulo_norm text generated always as (lower(btrim(titulo))) stored,
  -- 1 = lunes … 7 = domingo (ISO 8601, como extract(isodow …))
  dia_semana smallint not null constraint horario_fijo_dia_valido check (dia_semana between 1 and 7),
  hora_inicio time not null,
  hora_fin time not null,
  created_at timestamptz not null default now(),
  constraint horario_fijo_horas_validas check (hora_fin > hora_inicio),
  constraint horario_fijo_unico unique (titulo_norm, dia_semana, hora_inicio, hora_fin)
);

comment on table public.horario_fijo is 'Horario semanal del usuario (trabajo, gimnasio…): un bloque por día. El flujo principal avisa si una cita cae dentro.';

alter table public.horario_fijo enable row level security;
revoke all on table public.horario_fijo from anon, authenticated;

create function public.quitar_horario(p_id uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_fila public.horario_fijo%rowtype;
begin
  delete from public.horario_fijo where id = p_id returning * into v_fila;
  if not found then
    return jsonb_build_object('borrado', false);
  end if;
  return jsonb_build_object('borrado', true, 'titulo', v_fila.titulo, 'dia_semana', v_fila.dia_semana,
    'hora_inicio', to_char(v_fila.hora_inicio, 'HH24:MI'), 'hora_fin', to_char(v_fila.hora_fin, 'HH24:MI'));
end;
$$;

comment on function public.quitar_horario(uuid) is 'Para el flujo principal: borra un bloque del horario fijo y devuelve cuál.';

revoke all on function public.quitar_horario(uuid) from public, anon, authenticated;
grant execute on function public.quitar_horario(uuid) to service_role;

create table public.llegadas (
  wa_message_id text primary key constraint llegadas_id_valido check (char_length(wa_message_id) <= 300 and wa_message_id ~ '^[A-Za-z0-9._=+/-]+$'),
  -- Hora del mensaje según Meta (campo timestamp del webhook, en segundos). Es la que ordena; si falta, la hora de registro.
  enviado_at timestamptz not null,
  -- Orden de registro: desempata los mensajes del mismo segundo
  orden bigint generated always as identity,
  tipo text not null constraint llegadas_tipo_valido check (tipo in ('texto', 'audio', 'imagen', 'documento', 'no_soportado')),
  contestado_at timestamptz,
  created_at timestamptz not null default now()
);

create index llegadas_sin_contestar_idx on public.llegadas (enviado_at, orden) where contestado_at is null;

comment on table public.llegadas is 'Orden de llegada de todos los mensajes (de cualquier tipo), para contestarlos en ese orden. Se vacía sola (2 días).';

alter table public.llegadas enable row level security;
revoke all on table public.llegadas from anon, authenticated;

create function public.registrar_llegadas(p_llegadas jsonb)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_n integer := 0;
begin
  delete from public.llegadas where created_at < now() - interval '2 days';
  if p_llegadas is null or jsonb_typeof(p_llegadas) <> 'array' then
    return 0;
  end if;
  insert into public.llegadas (wa_message_id, enviado_at, tipo)
  select e ->> 'wa_message_id',
         -- El timestamp de Meta son segundos Unix (texto). Uno que no lo parezca, o a más de un día de ahora, no se usa.
         case when (e ->> 'ts') ~ '^[0-9]{9,11}$' and abs(extract(epoch from now()) - (e ->> 'ts')::bigint) < 86400
              then to_timestamp((e ->> 'ts')::bigint) else now() end,
         case when e ->> 'tipo' in ('texto', 'audio', 'imagen', 'documento') then e ->> 'tipo' else 'no_soportado' end
    from jsonb_array_elements(p_llegadas) with ordinality as x(e, n)
   where jsonb_typeof(e) = 'object'
     and char_length(e ->> 'wa_message_id') <= 300 and (e ->> 'wa_message_id') ~ '^[A-Za-z0-9._=+/-]+$'
     and n <= 50
   order by n
  on conflict (wa_message_id) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- Un texto o un audio que se registró pero nunca llegó a la tabla mensajes (falló «Guardar en cola»: Supabase caído, un 5xx) no se va a
-- contestar: deja de hacer esperar a los demás al minuto (un texto entra en la cola en el acto) o a los 5 minutos (un audio entra al acabar
-- de transcribirse, que puede tardar hasta unos 4). Sin esto bloquearía hasta que caducara (TURNO_MIN).
create function public.llegada_perdida(p_wa_message_id text, p_tipo text, p_creado timestamptz)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_tipo in ('texto', 'audio')
     and p_creado < now() - case when p_tipo = 'texto' then interval '1 minute' else interval '5 minutes' end
     and not exists (select 1 from public.mensajes m where m.wa_message_id = p_wa_message_id);
$$;

create function public.marcar_contestados(p_ids text[])
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_n integer := 0;
begin
  update public.llegadas set contestado_at = now()
   where wa_message_id = any (coalesce(p_ids, '{}')) and contestado_at is null;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- Para la respuesta de una foto, un documento, un audio rechazado o un aviso: ¿queda algo ANTERIOR sin contestar? Cuenta también lo que
-- espera en la cola de texto (si no, una foto podría adelantar a un texto anterior que espera su turno); eso no bloquea nada, porque
-- quien tiene el turno de la cola nunca espera aquí y la cola solo espera a lo ANTERIOR. Sin filas registradas para p_ids, 'enviar'.
create function public.turno_respuesta(p_ids text[], p_turno_min integer default 10, p_mismos text[] default '{}')
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_ids text[] := coalesce(p_ids, '{}');
  v_limite timestamptz;
  v_primero record;
  v_ultimo record;
  v_esperar boolean;
  v_despues boolean;
begin
  if p_turno_min is null or p_turno_min < 1 or p_turno_min > 60 then
    raise exception 'turno_respuesta: p_turno_min debe estar entre 1 y 60';
  end if;
  v_limite := now() - make_interval(mins => p_turno_min);
  select enviado_at, orden into v_primero from public.llegadas where wa_message_id = any (v_ids) order by enviado_at, orden limit 1;
  if not found then
    return jsonb_build_object('accion', 'enviar', 'despues', false);
  end if;
  select enviado_at, orden into v_ultimo from public.llegadas where wa_message_id = any (v_ids) order by enviado_at desc, orden desc limit 1;

  select exists (
    select 1 from public.llegadas l
     where l.contestado_at is null and l.created_at > v_limite and not (l.wa_message_id = any (v_ids))
       and not (l.wa_message_id = any (coalesce(p_mismos, '{}')))
       and (l.enviado_at, l.orden) < (v_primero.enviado_at, v_primero.orden)
       and not public.llegada_perdida(l.wa_message_id, l.tipo, l.created_at)
  ) into v_esperar;
  select exists (
    select 1 from public.llegadas l
     where l.contestado_at is null and l.created_at > v_limite and not (l.wa_message_id = any (v_ids))
       and (l.enviado_at, l.orden) > (v_ultimo.enviado_at, v_ultimo.orden)
  ) into v_despues;

  return jsonb_build_object('accion', case when v_esperar then 'esperar' else 'enviar' end, 'despues', v_despues);
end;
$$;

-- Cola de mensajes: ordena por la posición de llegada y espera si hay un mensaje anterior sin contestar.
create function public.reclamar_mensajes(p_mensaje_id uuid, p_turno_min integer default 10, p_mismos text[] default '{}')
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_limite timestamptz;
  v_yo record;
  v_turno public.turno%rowtype;
  v_siguiente record;
  v_mensajes jsonb;
begin
  if p_turno_min is null or p_turno_min < 1 or p_turno_min > 60 then
    raise exception 'reclamar_mensajes: p_turno_min debe estar entre 1 y 60';
  end if;
  v_limite := now() - make_interval(mins => p_turno_min);
  -- Bloquea la fila del turno: dos reclamaciones nunca se cruzan
  select * into v_turno from public.turno where id = 1 for update;

  -- Lo que lleva demasiado en la cola es de una ejecución que murió: no se junta con lo nuevo
  update public.mensajes
     set en_cola = false, error = coalesce(error, 'Se quedó en la cola sin procesar (más de 15 minutos)')
   where en_cola and created_at < now() - interval '15 minutes';

  -- Posición de este mensaje: la de su llegada o, sin ella, su created_at
  select m.id, m.en_cola, m.wa_message_id, coalesce(l.enviado_at, m.created_at) as t, coalesce(l.orden, 0) as o
    into v_yo
    from public.mensajes m left join public.llegadas l on l.wa_message_id = m.wa_message_id
   where m.id = p_mensaje_id;
  if v_yo.id is null then
    raise exception 'reclamar_mensajes: no existe el mensaje %', p_mensaje_id;
  end if;
  if not v_yo.en_cola then
    return jsonb_build_object('accion', 'nada', 'motivo', 'ya_reclamado');
  end if;

  -- Un mensaje ANTERIOR sin contestar que no está en la cola (una foto que se sube, un audio que se transcribe, uno que se procesa):
  -- este espera a que se conteste
  if exists (
    select 1 from public.llegadas l
     where l.contestado_at is null and l.created_at > v_limite and l.wa_message_id <> v_yo.wa_message_id
       and not (l.wa_message_id = any (coalesce(p_mismos, '{}')))
       and (l.enviado_at, l.orden) < (v_yo.t, v_yo.o)
       and not exists (select 1 from public.mensajes m where m.wa_message_id = l.wa_message_id and m.en_cola)
       and not public.llegada_perdida(l.wa_message_id, l.tipo, l.created_at)
  ) then
    return jsonb_build_object('accion', 'esperar', 'motivo', 'anterior_sin_contestar');
  end if;

  -- El primer mensaje POSTERIOR sin contestar que no está en la cola: los de la cola que vienen después de él no se juntan con este
  select l.enviado_at as t, l.orden as o into v_siguiente
    from public.llegadas l
   where l.contestado_at is null and l.created_at > v_limite and l.wa_message_id <> v_yo.wa_message_id
     and not (l.wa_message_id = any (coalesce(p_mismos, '{}')))
     and (l.enviado_at, l.orden) > (v_yo.t, v_yo.o)
     and not exists (select 1 from public.mensajes m where m.wa_message_id = l.wa_message_id and m.en_cola)
     and not public.llegada_perdida(l.wa_message_id, l.tipo, l.created_at)
   order by l.enviado_at, l.orden
   limit 1;

  -- Si ha llegado otro después (sin nada entre medias), lo procesa la ejecución de ese último (que se lleva también este)
  if exists (
    select 1 from public.mensajes m left join public.llegadas l on l.wa_message_id = m.wa_message_id
     where m.en_cola and m.id <> p_mensaje_id
       and (coalesce(l.enviado_at, m.created_at), coalesce(l.orden, 0), m.created_at, m.id) > (v_yo.t, v_yo.o, (select created_at from public.mensajes where id = p_mensaje_id), p_mensaje_id)
       and (v_siguiente.t is null or (coalesce(l.enviado_at, m.created_at), coalesce(l.orden, 0)) < (v_siguiente.t, v_siguiente.o))
  ) then
    return jsonb_build_object('accion', 'nada', 'motivo', 'hay_uno_posterior');
  end if;

  -- Otra ejecución está procesando y su turno no ha caducado
  if v_turno.hasta is not null and v_turno.hasta > now() and v_turno.mensaje_id is distinct from p_mensaje_id then
    return jsonb_build_object('accion', 'esperar');
  end if;

  update public.turno set mensaje_id = p_mensaje_id, hasta = now() + make_interval(mins => p_turno_min) where id = 1;

  -- Se lleva todos los que esperan en la cola hasta este incluido (no hay nada anterior sin contestar fuera de la cola), en el orden en
  -- que llegaron. Los demás quedan como procesados por este.
  with posiciones as (
    select m.id, coalesce(l.enviado_at, m.created_at) as t, coalesce(l.orden, 0) as o
      from public.mensajes m left join public.llegadas l on l.wa_message_id = m.wa_message_id
     where m.en_cola
  ),
  reclamados as (
    update public.mensajes m
       set en_cola = false,
           agrupado_en = p_mensaje_id,
           procesado = case when m.id = p_mensaje_id then m.procesado else true end
      from posiciones p
     where p.id = m.id
       and (p.t, p.o, m.created_at, m.id) <= (v_yo.t, v_yo.o, (select created_at from public.mensajes where id = p_mensaje_id), p_mensaje_id)
    returning m.id, m.wa_message_id, m.tipo_entrada, m.texto_original, m.contexto_wa_id, m.created_at, p.t, p.o
  )
  select jsonb_agg(jsonb_build_object('id', id, 'wa_message_id', wa_message_id, 'tipo_entrada', tipo_entrada, 'texto', texto_original,
                                      'contexto_wa_id', contexto_wa_id, 'created_at', created_at)
                   order by t, o, created_at, id)
    into v_mensajes
    from reclamados;

  return jsonb_build_object('accion', 'procesar', 'mensajes', coalesce(v_mensajes, '[]'::jsonb));
end;
$$;

comment on function public.registrar_llegadas(jsonb) is 'Registra los mensajes recibidos, en orden, para contestarlos en ese orden. Borra los de más de 2 días.';
comment on function public.reclamar_mensajes(uuid, integer, text[]) is 'Cola de mensajes: devuelve {accion: nada|esperar|procesar, mensajes}. nada = ha llegado otro mensaje después (lo procesará esa ejecución, juntándolos) o ya estaba reclamado; esperar = otra ejecución tiene el turno o hay un mensaje anterior sin contestar fuera de la cola; procesar = toma el turno y se lleva, en orden de llegada, los mensajes en cola hasta este. Los que llevan más de 15 minutos en cola se sacan con un error.';
comment on function public.turno_respuesta(text[], integer, text[]) is 'Antes de contestar una foto, un documento o un aviso: {accion: enviar|esperar, despues}. esperar = queda un mensaje anterior sin contestar; despues = hay mensajes posteriores sin contestar (para citar el mensaje al que se responde).';
comment on function public.marcar_contestados(text[]) is 'Anota como contestados esos mensajes. Devuelve cuántos ha marcado.';

revoke all on function public.registrar_llegadas(jsonb) from public, anon, authenticated;
revoke all on function public.llegada_perdida(text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.reclamar_mensajes(uuid, integer, text[]) from public, anon, authenticated;
revoke all on function public.turno_respuesta(text[], integer, text[]) from public, anon, authenticated;
revoke all on function public.marcar_contestados(text[]) from public, anon, authenticated;
grant execute on function public.registrar_llegadas(jsonb) to service_role;
grant execute on function public.llegada_perdida(text, text, timestamptz) to service_role;
grant execute on function public.reclamar_mensajes(uuid, integer, text[]) to service_role;
grant execute on function public.turno_respuesta(text[], integer, text[]) to service_role;
grant execute on function public.marcar_contestados(text[]) to service_role;

-- Respuestas citadas, «deshaz», un solo aviso al guardar varios archivos y mover carpetas (columnas ya incluidas arriba; aquí sus
-- comentarios, índices y funciones).
comment on column public.mensajes.respuesta_wa_ids is 'Ids de WhatsApp de los mensajes con los que la secretaria contestó a este mensaje (para entender a qué se refiere el usuario cuando cita una respuesta).';
comment on column public.mensajes.respuesta_texto is 'Lo que se le contestó al usuario (recortado), para dárselo al modelo cuando cita esa respuesta.';
comment on column public.items.quitado_en is 'Cuándo lo quitó (o completó) el usuario por WhatsApp. Sirve para recuperarlo con «deshaz». Vacío si no lo quitó él o si ya se recuperó.';
comment on column public.archivos.confirmado_at is 'Cuándo se le confirmó al usuario que el archivo se guardó (los avisos de varios archivos se juntan en un solo mensaje). Vacío = aún sin confirmar.';

create index mensajes_respuesta_wa_ids_idx on public.mensajes using gin (respuesta_wa_ids) where respuesta_wa_ids is not null;
create index items_quitado_en_idx on public.items (quitado_en desc) where quitado_en is not null;
create index archivos_sin_confirmar_idx on public.archivos (created_at) where confirmado_at is null;

create function public.reclamar_confirmacion_archivos(p_quieto_s integer default 3, p_ventana_min integer default 10)
returns table (drive_file_id text, nombre text, wa_message_id text)
language plpgsql
set search_path = ''
as $$
begin
  if p_quieto_s is null or p_quieto_s < 0 or p_quieto_s > 60 then
    raise exception 'p_quieto_s debe estar entre 0 y 60';
  end if;
  if p_ventana_min is null or p_ventana_min < 1 or p_ventana_min > 120 then
    raise exception 'p_ventana_min debe estar entre 1 y 120';
  end if;
  -- Si se guardó otro archivo hace menos de p_quieto_s segundos, todavía están llegando más: lo reclamará el último en guardarse
  if exists (
    select 1 from public.archivos a
     where a.confirmado_at is null and a.created_at > now() - make_interval(secs => p_quieto_s)
  ) then
    return;
  end if;
  -- Todos los sin confirmar de la ventana, de una sola vez: dos llamadas a la vez no se llevan el mismo archivo (la segunda espera al bloqueo
  -- de fila y, al reevaluar «confirmado_at is null», ya no encuentra nada)
  return query
    with r as (
      update public.archivos a
         set confirmado_at = now()
       where a.confirmado_at is null
         and a.created_at > now() - make_interval(mins => p_ventana_min)
      returning a.drive_file_id, a.nombre, a.mensaje_id, a.created_at
    )
    select r.drive_file_id, r.nombre, m.wa_message_id
      from r
      left join public.mensajes m on m.id = r.mensaje_id
     order by r.created_at, r.nombre;
end;
$$;

create function public.mover_carpeta_drive(p_id text, p_nuevo_padre_id text, p_ruta_origen text, p_ruta_destino text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_o text := p_ruta_origen;
  v_d text := p_ruta_destino;
  v_arbol integer := 0;
  v_archivos integer := 0;
  v_pedidas integer := 0;
  v_omitidos integer := 0;
begin
  if p_id is null or btrim(p_id) = '' then
    raise exception 'mover_carpeta_drive: falta el id de la carpeta';
  end if;
  if p_nuevo_padre_id is null or btrim(p_nuevo_padre_id) = '' then
    raise exception 'mover_carpeta_drive: falta el id de la carpeta de destino';
  end if;
  if not public.ruta_carpeta_valida(v_o) or not public.ruta_carpeta_valida(v_d) then
    raise exception 'mover_carpeta_drive: ruta no válida (de 1 a 3 niveles, sin barras invertidas ni "..")';
  end if;
  if lower(v_o) = lower(v_d) or starts_with(lower(v_d), lower(v_o) || '/') then
    raise exception 'mover_carpeta_drive: una carpeta no se puede mover dentro de sí misma';
  end if;
  -- Entrada y Notas las usa la secretaria para ordenar: no se mueven
  if lower(v_o) in ('entrada', 'notas') then
    raise exception 'mover_carpeta_drive: Entrada y Notas no se mueven';
  end if;

  -- La foto del árbol: la carpeta (nueva ruta y nuevo padre) y todo lo que cuelga de ella (nueva ruta)
  update public.drive_arbol d
     set ruta = v_d || substr(d.ruta, length(v_o) + 1),
         padre_id = case when d.drive_id = p_id then p_nuevo_padre_id else d.padre_id end,
         updated_at = now()
   where d.eliminado_at is null
     and (d.drive_id = p_id or starts_with(d.ruta, v_o || '/'));
  get diagnostics v_arbol = row_count;

  -- Los archivos clasificados en esa carpeta o dentro. Si la nueva ruta no es válida (más de 3 niveles), se deja y se cuenta
  update public.archivos a
     set carpeta_destino = v_d || substr(a.carpeta_destino, length(v_o) + 1)
   where a.carpeta_destino is not null
     and (a.carpeta_destino = v_o or starts_with(a.carpeta_destino, v_o || '/'))
     and public.ruta_carpeta_valida(v_d || substr(a.carpeta_destino, length(v_o) + 1));
  get diagnostics v_archivos = row_count;
  select v_omitidos + count(*) into v_omitidos
    from public.archivos a
   where a.carpeta_destino is not null
     and (a.carpeta_destino = v_o or starts_with(a.carpeta_destino, v_o || '/'));

  -- Las carpetas pedidas bajo la movida. Una fila eliminada que ya ocupa la ruta nueva se descarta; una viva que ya la ocupa deja a la antigua
  -- como eliminada (la del destino ya representa esa carpeta)
  delete from public.carpetas_pedidas q
   where q.eliminada_at is not null
     and exists (
       select 1 from public.carpetas_pedidas p
        where p.eliminada_at is null and (p.ruta = v_o or starts_with(p.ruta, v_o || '/'))
          and q.ruta = v_d || substr(p.ruta, length(v_o) + 1)
     );
  update public.carpetas_pedidas p
     set eliminada_at = now(), drive_pendiente = false
   where p.eliminada_at is null
     and (p.ruta = v_o or starts_with(p.ruta, v_o || '/'))
     and exists (select 1 from public.carpetas_pedidas q where q.id <> p.id and q.ruta = v_d || substr(p.ruta, length(v_o) + 1));
  update public.carpetas_pedidas p
     set ruta = v_d || substr(p.ruta, length(v_o) + 1)
   where p.eliminada_at is null
     and (p.ruta = v_o or starts_with(p.ruta, v_o || '/'))
     and public.ruta_carpeta_valida(v_d || substr(p.ruta, length(v_o) + 1));
  get diagnostics v_pedidas = row_count;
  select v_omitidos + count(*) into v_omitidos
    from public.carpetas_pedidas p
   where p.eliminada_at is null and (p.ruta = v_o or starts_with(p.ruta, v_o || '/'));

  return jsonb_build_object('arbol', v_arbol, 'archivos', v_archivos, 'carpetas_pedidas', v_pedidas, 'omitidos', v_omitidos);
end;
$$;

comment on function public.mover_carpeta_drive(text, text, text, text) is 'Tras mover una carpeta en Drive, reescribe sus rutas en drive_arbol, archivos.carpeta_destino y carpetas_pedidas. Atómica y sin fallar por rutas que no encajan (las cuenta en omitidos). Solo service_role.';

-- Drive cada 10 segundos con turno, carpetas conocidas y vaciar la carpeta que se queda vacía al mover sus archivos.
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

-- ============================================================================================================
-- Fila única del turno de la cola de mensajes (el flujo de WhatsApp la reclama y la suelta)
insert into public.turno (id) values (1);

-- ============================================================================================================
-- Seguridad. Supabase da por defecto permisos sobre lo que se crea en "public" a anon y authenticated: se quitan.
revoke all on table public.items from anon, authenticated;
revoke all on table public.archivos from anon, authenticated;
revoke all on table public.avisos_enviados from anon, authenticated;
revoke all on table public.carpetas_pedidas from anon, authenticated;
revoke all on table public.drive_arbol from anon, authenticated;
revoke all on table public.memoria from anon, authenticated;
revoke all on table public.mensajes from anon, authenticated;
revoke all on table public.proyectos from anon, authenticated;
revoke all on table public.registro_calendar from anon, authenticated;
revoke all on table public.registro_drive from anon, authenticated;
revoke all on table public.turno from anon, authenticated;
revoke all on table public.vigilantes_estado from anon, authenticated;
revoke all on table public.carpetas_creadas from anon, authenticated;
revoke all on table public.carpetas_vaciar from anon, authenticated;
revoke all on table public.turnos from anon, authenticated;

-- Las funciones solo las puede ejecutar service_role (n8n).
revoke all on function public.guardar_con_archivos(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.guardar_con_archivos(jsonb, jsonb) to service_role;
revoke all on function public.salud_sistema() from public, anon, authenticated;
grant execute on function public.salud_sistema() to service_role;
revoke all on function public.resumen_proyectos() from public, anon, authenticated;
grant execute on function public.resumen_proyectos() to service_role;
revoke all on function public.liberar_turno(uuid) from public, anon, authenticated;
grant execute on function public.liberar_turno(uuid) to service_role;
revoke all on function public.anadir_contenido(uuid[], text) from public, anon, authenticated;
grant execute on function public.anadir_contenido(uuid[], text) to service_role;
revoke all on function public.contexto_avisos(text, integer) from public, anon, authenticated;
grant execute on function public.contexto_avisos(text, integer) to service_role;
revoke all on function public.marcar_borrado_drive(text[]) from public, anon, authenticated;
grant execute on function public.marcar_borrado_drive(text[]) to service_role;
revoke all on function public.olvidar_memoria(uuid) from public, anon, authenticated;
grant execute on function public.olvidar_memoria(uuid) to service_role;
revoke all on function public.reclamar_confirmacion_archivos(integer, integer) from public, anon, authenticated;
grant execute on function public.reclamar_confirmacion_archivos(integer, integer) to service_role;
revoke all on function public.mover_carpeta_drive(text, text, text, text) from public, anon, authenticated;
grant execute on function public.mover_carpeta_drive(text, text, text, text) to service_role;

commit;
