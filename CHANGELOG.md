# Cambios

Formato: cada versión dice qué cambia para quien la usa y qué hay que hacer para actualizar una instalación existente.

## 1.5.0 · 2026-10-24

### Novedades

- **Mover archivos con tus palabras:** «mueve las fotos de Budapest a Viajes/Budapest», «mueve todo lo de Notas a Viajes», un archivo por
  su nombre («mueve 2026-10-23 1504 · WhatsApp.jpg a Notas») o «mueve esos archivos» (los del último movimiento o guardado). Se reconoce
  por código, sin el modelo (con la v12) o con él (v13), también por voz.
- **La carpeta que se queda vacía va a la papelera** al mover todos sus archivos (solo si Drive confirma que no queda nada, ni lo subido a
  mano). Nunca `Entrada` ni `Notas`.
- **«Déjalo como estaba»:** justo después de mover archivos los devuelve a su carpeta y anula el vaciado.
- **Propuestas con «sí»:** si dice «Ya hay una carpeta «Budapest» dentro de «Viajes». ¿Paso los archivos de «Budapest» a
  «Viajes/Budapest»?», basta con «sí» o con repetir el principio de la orden («mueve los archivos»).
- **No duplica carpetas:** al archivar o mover lee las carpetas que existen; si la pedida se parece a otra («viaje Roma» y
  «Viajes/Roma»), pregunta en vez de crear una casi igual, y escribe la ruta tal como ya existe.
- **Memoria de la conversación:** el modelo ve tus últimos mensajes (5, de las dos últimas horas) y lo que se te contestó, para entender
  «no, quiero que…». Se ajusta con `MEMORIA_MENSAJES` y `MEMORIA_MIN` en la configuración del flujo principal (0 la apaga).
- **Un solo aviso para varias fotos seguidas**, ahora activado (`ESPERA_ARCHIVOS_S = 4`; con 0 vuelve un aviso por archivo).
- **Prompt v13** (nuevo, en `prompts/clasificador-v13.md`): el modelo sabe mover carpetas y archivos, contesta más corto y entiende la
  conversación reciente. Es el que se usa por defecto. No está medido con la evaluación del clasificador frente a la v12; si ves que
  clasifica peor, pon `VERSION_PROMPT = 'v12'` en la configuración del flujo principal, genera e importa de nuevo.
- **Fotos con nombre único:** fecha, hora y un sufijo corto, para que dos del mismo minuto no se llamen igual.

### Cambios

- **Sincronizar Drive se ejecuta cada 10 segundos** (antes cada minuto): una carpeta pedida o una foto archivada se ve antes en Drive. Un
  turno en la base de datos evita que dos ejecuciones creen la misma carpeta, y las ejecuciones correctas no se guardan en n8n (serían
  más de 8.000 al día).
- «Mueve todo lo de X a Y» ya no devuelve el mismo ejemplo fijo cuando no lo entiende; la respuesta a «¿puedes mover…?» es corta.
- Arreglo: al vaciar una carpeta ya no llega un falso «♻️ Recuperaste el archivo… de la papelera».
- «La carpeta de viajes» se entiende como «Viajes».

### Para actualizar desde la 1.4

**La base de datos cambia** (tres tablas y seis funciones), así que el orden importa:

1. Haz una copia de n8n (parte 15 del manual).
2. En el SQL Editor de Supabase, ejecuta [`supabase/actualizar-1.5.sql`](supabase/actualizar-1.5.sql) **una vez**. Después, ejecuta
   `supabase/comprobar-instalacion.sql` (10 filas con `ok = true`) y `supabase/consultas/ver-version.sql` (debe decir 1.5).
3. En el servidor: `git pull`, `bash herramientas/servidor/importar-flujos.sh` y vuelve a publicar los flujos (parte 11.5 del manual).
   La base de datos va **antes** que los flujos: **sin el paso 2, «Sincronizar Drive» falla** (necesita la función del turno) y no se
   crean carpetas ni se mueven archivos.

Si vienes de la 1.3 o anterior, ejecuta antes, en orden, los `actualizar-1.X.sql` que te falten (`ver-version.sql` te dice cuál tienes).
Las instalaciones nuevas usan `supabase/instalar.sql`, que ya incluye todo.

## 1.4.0 · 2026-10-23

### Novedades

- **Deshacer:** quitar o completar anota cuándo. «Deshaz» recupera lo último que quitaste (lo de la última orden, hasta 24 horas
  después) y «recupera la tarea del banco» algo concreto. Si era de un proyecto cerrado, lo reabre.
- **Mover carpetas:** «mete la carpeta Viajes dentro de Fotos», por texto o por voz, una o varias a la vez, y creando la carpeta de
  destino si no existe. Se mueve con todo lo de dentro; `Entrada` y `Notas` no se mueven.
- **Foto o documento con la ruta de pie de texto** («Fotos/Viajes»): se archiva sin preguntar. Una respuesta que es solo la ruta
  también.
- **Contestar citando cualquier respuesta** de la secretaria (también con un audio): sabe a cuál te refieres.
- **La oferta de la charla se recuerda:** si contesta «¿quieres que lo apunte como tarea?» y dices «sí» o «apúntalo», sabe de qué
  hablabais.
- **Órdenes de lectura con tus palabras, sin modelo:** «dame todo», «ver mis ideas», «dame la jerarquía», «dame los proyectos»…, con
  sinónimos, erratas, muletillas y también por voz.
- **Un solo aviso para varios archivos** (opcional, `ESPERA_ARCHIVOS_S` en la configuración del flujo de WhatsApp; por defecto 0 = un
  aviso por archivo).

### Cambios

- **Menos preguntas.** Ya no pregunta por un día con otras cosas, por un nombre repetido, por quitar en bloque ni «¿te aviso para ir a
  comprar?»; lo hace y dice lo que ha hecho. Sigue preguntando lo que falta (la hora, ¿alarma, cita o tarea?), el solape real con
  otra cita, el choque con el horario fijo y el borrado en Drive.
- **Borrar varias secciones a la vez** («borra las alarmas y las tareas») sin confirmación; «borra todo» solo pregunta qué sección.
- **Respuestas más cortas y sin relleno.** Se quita el «🎙️ Entendí: …» de los audios, la nota al pie de la jerarquía de carpetas, las
  explicaciones entre paréntesis y las fechas de recepción de los listados de archivos.
- **La confirmación de lo guardado** («Apuntado: …») la redacta el código, y «mañana» se calcula por calendario (no sumando 24 horas):
  funciona bien el día del cambio de hora. Hay pruebas para el cambio de hora.
- **Sin esperas fijas:** los mensajes se contestan en cuanto se pueden (`ESPERA_AGRUPAR_S = 0`); la cola y el orden de llegada siguen.
- **Menos avisos falsos:** un error de red de un flujo automático no avisa hasta llevar 30 minutos seguidos (`TOLERANCIA_RED_MIN`), y
  tres lecturas más reintentan si falla la red.
- Nueva consulta `supabase/consultas/ver-tiempos.sql`: cuánto tarda en contestar cada mensaje.
- Los flujos que más cambian son «Procesar mensaje» (de 31 a 40 nodos de trabajo) y «WhatsApp» (de 72 a 76); el resto, poco.

### Para actualizar desde la 1.3

**La base de datos cambia**, así que el orden importa:

1. Haz una copia de n8n (parte 15 del manual).
2. En el SQL Editor de Supabase, ejecuta [`supabase/actualizar-1.4.sql`](supabase/actualizar-1.4.sql) **una vez**. Añade cuatro
   columnas (`mensajes.respuesta_wa_ids`, `mensajes.respuesta_texto`, `items.quitado_en`, `archivos.confirmado_at`) y dos funciones
   (`reclamar_confirmacion_archivos` y `mover_carpeta_drive`); no toca tus datos. Después ejecuta
   `supabase/comprobar-instalacion.sql` (10 filas con `ok = true`) y `supabase/consultas/ver-version.sql` (debe decir 1.4).
3. En el servidor: `git pull`, `bash herramientas/servidor/importar-flujos.sh` y vuelve a publicar los flujos (parte 11.5 del manual).
   La base de datos va **antes** que los flujos: **sin el paso 2 fallan** «Deshacer», citar una respuesta y mover carpetas, y el flujo de
   WhatsApp deja de anotar lo que contesta.

Si vienes de una versión anterior a la 1.3, ejecuta antes, en orden, los `actualizar-1.X.sql` que te falten (`ver-version.sql` te dice
cuál tienes). Las instalaciones nuevas usan `supabase/instalar.sql`, que ya incluye todo.

## 1.3.0 · 2026-10-20

### Cambios

- **No deja preguntas en el aire:** si te pregunta algo («¿La apunto igualmente?») y le mandas otra cosa sin contestar, no hace nada
  con lo anterior y te lo dice antes de atender lo nuevo («Como no me contestaste a «…», no he hecho nada con eso»). Antes cualquier
  mensaje que no pareciera una orden se tomaba como la respuesta.
- **Qué contesta a cada pregunta:** una confirmación sí/no solo la contesta un sí, un no o un cambio corto con día u hora; «¿alarma,
  cita o tarea?» solo una de esas palabras.
- **«Qué tengo hoy» sin nada** dice qué día ha mirado y que lo que no tiene fecha (tareas, listas…) no sale ahí, con un recordatorio
  de `/pending`. Antes decía «No tienes nada pendiente en esas fechas», y parecía un error.

### Para actualizar desde la 1.2

La base de datos **no cambia**. En el servidor: `git pull`, `bash herramientas/servidor/importar-flujos.sh` y vuelve a publicar los
flujos (parte 11.5 del manual). Si importas solo uno de los dos flujos, cerrar las preguntas sin contestar no funciona: necesita el
flujo de WhatsApp y el principal nuevos.

## 1.2.0 · 2026-10-19

### Novedades

- **Horario fijo semanal** («trabajo los viernes de 16 a 20»): si apuntas una cita que cae dentro, pregunta antes de apuntarla.
  `/horario` lo enseña y `/horario quitar N` quita un bloque. Si no das horas exactas, pregunta de qué hora a qué hora.
- **Todo se contesta en el orden de llegada**, también fotos, documentos y audios: «texto, foto, texto» recibe tres respuestas en ese
  orden. Si mandas varios mensajes seguidos, cada respuesta cita el mensaje al que contesta.
- **La compra:** lo que sea comprar va a la lista de la compra aunque digas un día («mañana compra pan»), y pregunta si te avisa ese
  día para ir a comprar («a las 18» crea la alarma; «no», nada).
- **Listas sin repetidos:** lo que ya está pendiente en la misma lista no se vuelve a apuntar; la respuesta dice qué ya estaba.

### Cambios

- «Borra la cita», «quita la alarma de la ropa»: si solo hay una que encaje, la quita sin preguntar.
- Un «tarea», «cita» o «alarma» suelto que llega justo después de apuntar algo se resuelve sin el modelo (lo deja como está o lo
  convierte).
- El «🎙️ Entendí: …» de un audio sale justo antes de su respuesta.
- Olvidar un dato de la memoria con palabras pide un «sí» o un «no» que se entiende sin el modelo.
- **Más rápido:** las lecturas de Supabase del flujo principal se hacen una sola vez por mensaje (antes podían repetirse por cada
  dato de la memoria).
- Nueva consulta `supabase/consultas/ver-version.sql`: dice qué versión de la base de datos tienes instalada.

### Para actualizar desde la 1.1

1. Haz una copia de n8n (parte 15 del manual).
2. En el SQL Editor de Supabase, ejecuta [`supabase/actualizar-1.2.sql`](supabase/actualizar-1.2.sql) **una vez** y comprueba con
   `supabase/comprobar-instalacion.sql` (10 filas con `ok = true`). Crea dos tablas (`horario_fijo` y `llegadas`) y cambia la
   función de la cola de mensajes; no toca tus datos.
3. En el servidor: `git pull`, `bash herramientas/servidor/importar-flujos.sh` y vuelve a publicar los flujos (parte 11.5 del manual).
   La base de datos va **antes** que los flujos: **sin el paso 2, la secretaria deja de contestar** (el flujo de WhatsApp llama a la
   función de la cola con un parámetro que la 1.1 no tiene).

Si vienes de la 1.0, ejecuta antes `supabase/actualizar-1.1.sql` (y después este). `supabase/consultas/ver-version.sql` te dice cuál
tienes.

## 1.1.0 · 2026-10-19

### Novedades

- **Borrar carpetas y archivos de Drive por WhatsApp** («borra la carpeta Fotos/Viajes», «vacía la carpeta Facturas», «borra la foto
  del DNI»). Enseña la lista de lo que se borraría y solo lo manda a la papelera de Drive (recuperable unos 30 días) si contestas que
  sí. Antes de mandarlo vuelve a comprobar cada carpeta y archivo; `Entrada` y `Notas` no se borran enteras.
- **Memoria de datos duraderos:** recuerda lo que le cuentas que dura («trabajo los viernes por la mañana», «Emma es mi hermana») y
  cómo quieres que te llame («llámame Ana»). `/memory` enseña lo que recuerda (hasta 50 datos) y `/forget N` olvida uno.
- **Charla breve:** contesta a saludos y comentarios con naturalidad, sin guardar nada.

### Cambios

- **No adivina:** si la respuesta del modelo no encaja o su confianza es baja, pregunta o dice «no te he entendido» en vez de guardar
  algo mal.
- **Aviso de fallos más fiable:** solo llega cuando falla de verdad un flujo, Supabase o Google, no cuando no entiende un mensaje.
- **Prompt:** nuevas reglas para la charla, los datos duraderos, el nombre del usuario, borrar en Drive y no prometer lo que el sistema
  no hace.

### Para actualizar desde la 1.0

1. Haz una copia de n8n (parte 15 del manual).
2. En el SQL Editor de Supabase, ejecuta [`supabase/actualizar-1.1.sql`](supabase/actualizar-1.1.sql) **una vez** y comprueba con
   `supabase/comprobar-instalacion.sql` (10 filas con `ok = true`). Añade dos funciones; no toca tablas ni datos.
3. En el servidor: `git pull`, `bash herramientas/servidor/importar-flujos.sh` y vuelve a publicar los flujos (parte 11.5 del manual).
   La base de datos va **antes** que los flujos: sin el paso 2, borrar en Drive y `/forget` fallan.

## 1.0.0 · 2026-10-17

Primera versión publicada: clasificación de texto, audios, fotos y documentos; agenda en Google Calendar sin solapes; alarmas con
avisos; tareas, listas, notas y proyectos; archivos en Google Drive; resumen diario; vigilancia de Calendar y Drive; aviso de fallos
y latido; manual de instalación completo.
