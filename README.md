# Secretaria personal por WhatsApp

[![Pruebas](https://github.com/gguillex/Secretaria/actions/workflows/pruebas.yml/badge.svg)](https://github.com/gguillex/Secretaria/actions/workflows/pruebas.yml)
[![Licencia: MIT](https://img.shields.io/badge/licencia-MIT-blue.svg)](LICENSE)
![Versión 1.5.0](https://img.shields.io/badge/versión-1.5.0-informational)
![n8n 2.41.6](https://img.shields.io/badge/n8n-2.41.6-EA4B71)
![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933)
![Gemini](https://img.shields.io/badge/IA-Gemini-4285F4)
![Supabase](https://img.shields.io/badge/BD-Supabase-3ECF8E)

Un contacto de WhatsApp al que le mandas texto, notas de voz, fotos y documentos, y que lo entiende y lo guarda donde corresponde:
las citas en Google Calendar, los archivos en Google Drive y las tareas, listas y notas en una base de datos que puedes consultar desde
el propio chat. Te avisa de lo que se acerca, te manda un resumen cada mañana y vigila que todo siga funcionando.

Pensado para **una sola persona**: tú. Corre en un servidor pequeño propio, con n8n, Gemini y Supabase.

**Índice:** [Qué hace](#qué-hace) · [Ejemplos](#ejemplos) · [Cómo está hecha](#cómo-está-hecha) · [Qué necesitas](#qué-necesitas) ·
[Instalación](#instalación) · [Estructura](#estructura-del-repositorio) · [Desarrollo](#desarrollo) · [Seguridad](#seguridad) ·
[Límites](#límites-conocidos) · [Versiones](#versiones) · [Licencia](#licencia)

## Qué hace

- **Entiende y guarda** mensajes de texto, audios (los transcribe), fotos y documentos. Los mensajes que llegan a la vez se juntan en uno.
- **Agenda:** citas en Google Calendar, sin solapes, con aviso por WhatsApp antes de empezar.
- **Alarmas** («recuérdame a las 18:30…»), con avisos 1 hora antes, 30 minutos antes y a la hora. **Respondiendo a un aviso** se aplaza
  o se mueve («10 minutos más», «muévela a las 20:00»).
- **Tareas, listas, notas y proyectos**, con consultas en lenguaje natural («qué tengo hoy», «qué alarmas tengo», «qué apunté del
  casero») y comandos (`/help`, `/today`, `/pending`, `/files`, `/memory`…). Los listados van con titulares cortos; «completo» enseña el detalle.
- **Cambiar de tipo** algo ya guardado («ponla como alarma», «pásalo a cita», «que sea una tarea»): lo hace el código, que mueve las
  fechas y solo confirma lo que de verdad quedó guardado.
- **Quitar sin dar vueltas, y deshacer:** «borra las alarmas y las tareas» quita varias secciones a la vez y te dice lo que ha quitado,
  sin pedir confirmación; «borra todo» solo pregunta qué sección. Si te equivocas, «deshaz» recupera lo último que quitaste y
  «recupera la tarea del banco» algo concreto (hasta 24 horas después).
- **Archivos:** los organiza en carpetas de Drive a petición («guárdala en Fotos/Viajes») y te los devuelve por WhatsApp. También
  borra carpetas y archivos («borra la carpeta Fotos/Viajes», «vacía la carpeta Facturas»): enseña la lista y solo los manda a la
  papelera de Drive (recuperable unos 30 días) si le dices que sí. Mueve carpetas dentro de otras («mete la carpeta Viajes dentro
  de Fotos», también varias a la vez o creando el destino) y mueve archivos ya guardados («mueve las fotos de Budapest a
  Viajes/Budapest», «mueve todo lo de Notas a Viajes», un archivo por su nombre). La carpeta que se queda vacía va a la papelera
  (nunca `Entrada` ni `Notas`), «déjalo como estaba» lo devuelve todo a su sitio y no crea una carpeta casi igual a otra que ya existe.
  Una foto con la ruta como pie de texto se archiva sin preguntar, y varias fotos seguidas reciben un solo aviso.
- **Memoria:** recuerda lo que le cuentas que dura («Emma es mi hermana», «vivo en Granada») y cómo quieres que te
  llame («llámame Ana»). `/memory` enseña lo que recuerda (hasta 50 datos) y `/forget 2` olvida el segundo; si se lo pides con palabras
  («olvida lo de Emma»), pregunta antes.
- **Horario fijo semanal** («trabajo los viernes de 16 a 20»): si apuntas una cita que cae dentro, pregunta antes. `/horario` lo
  enseña y `/horario quitar N` quita un bloque.
- **La compra:** lo que sea comprar va a la lista de la compra aunque digas un día, sin repetir lo que ya está.
- **Charla breve:** a un saludo o un «gracias» contesta con naturalidad, sin guardar nada. Si ofrece apuntar algo («¿quieres que lo
  apunte como tarea?»), tu «sí» posterior sabe de qué hablabais.
- **Entiende lo que acabas de decir:** ve tus últimos mensajes y lo que contestó, así que «no, quiero que…» se entiende; y si
  propone algo («¿Paso los archivos de Budapest a Viajes/Budapest?»), basta con «sí» o con repetir la orden a medias.
- **Contestar a una respuesta concreta:** si respondes citando cualquiera de sus mensajes (también con un audio), entiende a cuál
  te refieres.
- **Órdenes con tus palabras, al momento:** «dame todo», «ver mis ideas», «dame la jerarquía» o «dame los proyectos» (también por
  voz) se resuelven sin llamar al modelo, como los comandos.
- **Pocas preguntas:** solo pregunta cuando falta un dato (¿a qué hora?, ¿alarma, cita o tarea?), cuando una cita choca con otra o
  con tu horario fijo, o antes de borrar en Drive. Las respuestas son cortas y sin relleno.
- **Todo en orden:** contesta textos, audios, fotos y documentos en el orden en que llegaron; si mandas varios seguidos, cada
  respuesta cita el mensaje al que contesta.
- **No deja preguntas en el aire:** si te pregunta algo («¿La apunto igualmente?») y le mandas otra cosa sin contestar, no hace
  nada con lo anterior y te lo dice antes de atender lo nuevo.
- **Resumen diario** a las 7:00 (con los proyectos en viñetas) y recordatorio de archivos sin clasificar.
- **No adivina:** si no entiende un mensaje o no está segura, pregunta o te dice que no te ha entendido, en vez de guardar algo mal.
  El aviso de fallos solo llega cuando falla algo de verdad, y dice qué mensaje era.
- **Vigilancia:** refleja lo que cambias a mano en Calendar y Drive, y te avisa (por WhatsApp y por correo) si algo se atasca o se cae.

## Ejemplos

| Le escribes | Qué hace |
|---|---|
| «dentista el jueves a las 10» | Crea la cita en Google Calendar (una hora, sin solapes) y te avisa por WhatsApp 30 minutos antes. |
| «recuérdame en 20 minutos sacar la ropa» | Pone una alarma: aviso a la hora, sin pasar por el calendario. |
| «compra: leche, huevos y pan» | Lo añade a la lista de la compra. |
| «para el proyecto Mudanza: llamar al casero» | Crea la tarea dentro del proyecto (si el proyecto se parece a otro, pregunta). |
| «qué tengo hoy» · «qué alarmas tengo» | Te lo lista al momento, sin llamar al modelo. |
| «ponla como alarma mañana a las 9» (sobre una tarea) | La convierte en alarma y confirma solo lo que de verdad quedó guardado. |
| Una foto, y luego le respondes «guárdala en Fotos/Viajes» | La sube a `Entrada/` de Drive y la mueve a esa carpeta. |
| Una nota de voz | La transcribe y la trata como si la hubieras escrito. |
| «borra las alarmas y las tareas» · «deshaz» | Quita las dos secciones y te dice lo que ha quitado; «deshaz» lo recupera. |
| «mete la carpeta Viajes dentro de Fotos» | Mueve la carpeta de Drive con todo lo de dentro. |
| «borra la carpeta Fotos/Viajes» | Enseña lo que se borraría y, si dices «sí», lo manda a la papelera de Drive. |
| «para que lo sepas: Emma es mi hermana» · `/memory` | Lo recuerda para entender lo que le pidas después; `/memory` lo enseña. |
| «trabajo los viernes de 16 a 20» · `/horario` | Lo guarda como horario fijo; si luego apuntas una cita que cae dentro, pregunta antes. |
| «mañana compra pan y leche» | Lo apunta en la lista de la compra, sin repetir lo que ya estaba. |

## Cómo está hecha

```
WhatsApp ──► Meta Cloud API ──► Tailscale Funnel ──► n8n (Docker, Hetzner) ──┬──► Gemini (entiende el mensaje)
                                                                             ├──► Supabase (Postgres)
                                                                             └──► Google Calendar y Drive
```

| Pieza | Papel |
|---|---|
| **n8n** `2.41.6` (Docker) | 14 flujos: el que procesa cada mensaje y los automáticos. En un servidor Hetzner CAX11 con Ubuntu 24.04. |
| **Tailscale Funnel** | Dirección pública fija con HTTPS. Publica solo `/webhook`; el editor de n8n se abre por túnel SSH. |
| **Gemini** (`gemini-3.8-flash`) | Clasifica el mensaje y transcribe los audios. La llamada vive en un solo nodo HTTP; el modelo es una constante. |
| **Supabase** (Postgres, UE) | Mensajes, elementos, memoria, archivos y estado. RLS activado y sin acceso público. |
| **Google Calendar y Drive** | Destino de citas y archivos, sincronizados mediante «bandejas de salida» marcadas por *triggers*. |
| **Meta WhatsApp Cloud API** | Entrada y salida de mensajes, con firma verificada y un solo número permitido. |

El modelo nunca escribe SQL ni URLs: devuelve valores de listas cerradas que el código valida, y las respuestas las redacta el código.
Detalle y motivos: [`docs/arquitectura.md`](docs/arquitectura.md).

## Qué necesitas

- Un servidor pequeño con Linux (el manual usa un **Hetzner CAX11**, unos 7 €/mes) y un ordenador desde el que entrar por SSH.
- Cuentas gratuitas en **GitHub**, **Netlify**, **Tailscale**, **Supabase** y **Healthchecks.io** (opcional).
- Una cuenta de **Google** (Calendar, Drive, Google Cloud y la API de Gemini, de prepago) y una de **Facebook** para Meta for Developers.
- Un número de **WhatsApp** propio desde el que escribirle. Meta da gratis el número de la secretaria.
- Unas horas para seguir el manual la primera vez.

## Instalación

Todo, paso a paso y desde cero (cuentas, páginas de privacidad para Google y Meta, servidor, túnel, base de datos y pruebas):
**[`docs/manual-instalacion.md`](docs/manual-instalacion.md)**. En resumen:

1. Publica las páginas de inicio y privacidad de [`paginas/`](paginas/) en Netlify (gratis, conectado a tu copia del repositorio).
2. Prepara Google (Calendar, Drive, OAuth y Gemini), Supabase y la app de WhatsApp en Meta.
3. En el servidor: `git clone`, `bash herramientas/servidor/instalar-docker.sh`, `bash herramientas/servidor/preparar-servidor.sh`,
   rellena `.env`, activa Tailscale Funnel y `docker compose up -d`.
4. Base de datos: ejecuta [`supabase/instalar.sql`](supabase/instalar.sql) (un solo archivo) y comprueba con
   [`supabase/comprobar-instalacion.sql`](supabase/comprobar-instalacion.sql).
5. En n8n crea las cinco credenciales con sus nombres exactos y ejecuta `bash herramientas/servidor/importar-flujos.sh`: los 14 flujos
   llegan con cada nodo enlazado a su credencial. Publícalos y registra el webhook en Meta.

Coste orientativo: el servidor (unos 7 €/mes) y Gemini de prepago (pocos dólares al mes con uso personal). El resto es gratuito.

## Estructura del repositorio

```
docs/              Manual de instalación y arquitectura.
flujos/            Los 14 flujos de n8n, listos para importar (generados: no se editan a mano).
herramientas/      Código de cada nodo (flujo*/), generadores (generar-*.js) y pruebas sin red (probar-*.js).
  servidor/        Scripts del servidor: instalar Docker, preparar, importar flujos, vigilancia, copias y restauración.
  copias/          Restaurar una copia de n8n en Windows con Docker Desktop.
paginas/           Páginas de inicio y de privacidad que publica Netlify (las exigen Google y Meta).
netlify.toml       Le dice a Netlify que publique solo paginas/.
prompts/           El prompt del clasificador.
supabase/          Instalación de la base de datos, su comprobación y consultas útiles.
docker-compose.yml n8n con versión fijada, registros rotados y la clave de cifrado leída de secretos/.
.env.example       Plantilla de variables de entorno (secretos de WhatsApp e identificadores).
```

## Desarrollo

Solo hace falta Node.js 20 o superior, sin dependencias que instalar. Las pruebas no usan red ni gastan nada, y GitHub Actions las
pasa en cada cambio con Node 20, 22 y 24, comprobando además que los flujos de `flujos/` están al día con su código.

```
npm test          # todas las baterías de pruebas
npm run generar   # regenera los flujos de flujos/ a partir de herramientas/ y prompts/
```

El código de cada nodo se cambia en `herramientas/flujo*/` y se regenera; un cambio hecho a mano en un JSON de `flujos/` se pierde.
Después, en el servidor: `git pull`, `bash herramientas/servidor/importar-flujos.sh` y volver a publicar los flujos.

## Seguridad

- Ningún secreto en el repositorio: el `.env` y `secretos/` están en `.gitignore`; las claves de las APIs solo viven cifradas en n8n.
- La clave de cifrado de n8n se lee de un archivo de solo lectura, no del entorno.
- Solo el webhook es público y está protegido por la firma de Meta y por el número permitido; el servidor solo acepta SSH con clave.
- Las copias de seguridad contienen credenciales cifradas y datos personales: se guardan fuera del repositorio.

> **Nunca ejecutes `docker compose down -v`:** borra el volumen con todos los flujos y credenciales de n8n. La carpeta del proyecto
> debe llamarse `Secretaria` (el volumen se llama `secretaria_n8n_data` por ella).

## Límites conocidos

- **Ventana de 24 horas de WhatsApp:** sin plantillas aprobadas por Meta, solo puede escribirte si tú le escribiste en las últimas
  24 horas. Si un día no le dices nada, el resumen y los avisos de ese día esperan.
- **El modelo puede equivocarse al clasificar:** el código valida la forma, no la intención. Cada respuesta dice qué se ha guardado,
  para corregirlo («no, era el jueves»).
- **Sin copia automática de Supabase:** los datos que solo viven ahí (tareas, notas, memoria) no tienen copia salvo que la hagas tú.
- Más detalle en [`docs/arquitectura.md`](docs/arquitectura.md#límites-conocidos).

## Versiones

Los cambios de cada versión, y qué hacer para actualizar una instalación existente, están en [`CHANGELOG.md`](CHANGELOG.md).

## Licencia

[MIT](LICENSE): puedes usarlo, copiarlo y modificarlo libremente, manteniendo el aviso de copyright. Se ofrece tal cual, sin garantías:
cada persona que lo monte es responsable de sus claves, sus datos y el coste de los servicios que use.
