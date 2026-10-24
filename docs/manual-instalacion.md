# Manual de instalación, paso a paso

Este manual lleva desde cero (sin cuentas) hasta tener la secretaria contestando por WhatsApp, funcionando sola en un servidor y
avisándote si algo falla. Está escrito para seguirlo **en orden**: cada parte usa datos de las anteriores.

- **Tiempo:** de 3 a 5 horas la primera vez, repartibles en varios días (todo queda guardado entre parte y parte).
- **Coste:** el servidor (unos 7 €/mes) y el modelo de IA (prepago; con uso personal, del orden de 3–5 $/mes). Todo lo demás, gratis.
- **Qué necesitas:** un ordenador (Windows, macOS o Linux), un móvil con WhatsApp, una cuenta de Google, una tarjeta para los dos
  pagos y un **gestor de contraseñas** (Bitwarden, 1Password, KeePassXC…). No hace falta saber programar, pero sí copiar órdenes en una
  terminal con cuidado.

> **Tres reglas que evitan casi todos los problemas**
> 1. **Las claves nunca se pegan en un chat, un correo ni un documento.** Van al gestor de contraseñas y de ahí, solo, a su sitio.
> 2. **Si algo no sale como dice el paso, para.** Copia el mensaje de error exacto y búscalo en [Problemas frecuentes](#16-problemas-frecuentes)
>    antes de reintentar. Reintentar a ciegas suele estropear el siguiente paso.
> 3. **Copia las órdenes de una en una** y comprueba lo que devuelven antes de lanzar la siguiente.

## Índice

1. [Cómo funciona (en un minuto)](#1-cómo-funciona-en-un-minuto)
2. [La hoja de datos](#2-la-hoja-de-datos)
3. [Netlify: páginas de inicio y privacidad](#3-netlify-páginas-de-inicio-y-privacidad)
4. [Google: Calendar y Drive](#4-google-calendar-y-drive)
5. [Google Cloud: acceso a Calendar y Drive (OAuth)](#5-google-cloud-acceso-a-calendar-y-drive-oauth)
6. [Gemini: la clave del modelo](#6-gemini-la-clave-del-modelo)
7. [Supabase: la base de datos](#7-supabase-la-base-de-datos)
8. [Meta: la app de WhatsApp](#8-meta-la-app-de-whatsapp)
9. [Hetzner: el servidor](#9-hetzner-el-servidor)
10. [Tailscale: la dirección pública](#10-tailscale-la-dirección-pública)
11. [n8n: arrancar y configurar](#11-n8n-arrancar-y-configurar)
12. [Conectar WhatsApp con el servidor](#12-conectar-whatsapp-con-el-servidor)
13. [Pruebas por WhatsApp](#13-pruebas-por-whatsapp)
14. [Vigilancia: que te avise si algo cae](#14-vigilancia-que-te-avise-si-algo-cae)
15. [Copias de seguridad](#15-copias-de-seguridad)
16. [Problemas frecuentes](#16-problemas-frecuentes)
17. [Mantenimiento](#17-mantenimiento)

---

## 1. Cómo funciona (en un minuto)

```
Tu móvil ──WhatsApp──► Meta ──webhook HTTPS──► Tailscale Funnel ──► n8n (Docker, servidor Hetzner)
                                                                      │
                     Gemini (entiende el mensaje) ◄───────────────────┤
                     Supabase (base de datos)     ◄───────────────────┤
                     Google Calendar y Drive      ◄───────────────────┘
```

- **Meta (WhatsApp Cloud API)** recibe tus mensajes y se los entrega al servidor; por ahí salen también las respuestas.
- **n8n** ejecuta 14 flujos: el que procesa cada mensaje y los automáticos (sincronizar Calendar y Drive, recordatorios, resumen diario,
  vigilancia…). Corre en Docker en un servidor de **Hetzner**.
- **Tailscale Funnel** da al servidor una dirección pública fija con HTTPS (`https://secretaria.<tu-red>.ts.net`) y publica **solo** la
  ruta `/webhook`. El editor de n8n no es público: se abre desde tu ordenador por un túnel SSH.
- **Gemini** entiende el mensaje y devuelve qué hay que hacer; el código valida eso y escribe en **Supabase**, **Calendar** y **Drive**.

## 2. La hoja de datos

Durante la instalación irás reuniendo estos valores. Crea **ahora** una entrada en tu gestor de contraseñas llamada «Secretaria» y ve
apuntándolos a medida que salgan. Los marcados como secreto no deben salir de ahí.

| Dato | Secreto | Sale en | Se usa en |
|---|---|---|---|
| Dirección de las páginas (`https://<tu-sitio>.netlify.app`) | no | 3.3 | Google (5.2) y Meta (8.5) |
| ID del calendario «Secretaria» | no | 4.1 | `.env` (`GOOGLE_CALENDAR_ID`) |
| ID de la carpeta `Secretaria` de Drive | no | 4.2 | `.env` (`DRIVE_CARPETA_RAIZ_ID`) |
| ID de la carpeta `Secretaria/Entrada` | no | 4.2 | `.env` (`DRIVE_ENTRADA_ID`) |
| ID de cliente y secreto de cliente OAuth de Google | **sí** (el secreto) | 5.4 | credenciales de Google en n8n |
| Clave de la API de Gemini | **sí** | 6 | credencial `Gemini API key` en n8n |
| Contraseña de la base de datos de Supabase | **sí** | 7.1 | solo para copias manuales |
| Project URL de Supabase | no | 7.3 | `.env` (`SUPABASE_URL`) y credencial `Supabase` |
| Clave secreta de Supabase (`sb_secret_…`) | **sí** | 7.3 | credencial `Supabase` en n8n |
| Phone number ID y WhatsApp Business Account ID | no | 8.3 | `.env` (`WHATSAPP_PHONE_NUMBER_ID`) y una orden |
| App Secret de Meta | **sí** | 8.4 | `.env` (`WHATSAPP_APP_SECRET`) |
| Token permanente de Meta (`EAA…`) | **sí** | 8.6 | credencial `WhatsApp token` en n8n |
| Verify token del webhook (lo inventas tú) | **sí** | 8.7 | `.env` (`WHATSAPP_VERIFY_TOKEN`) y Meta |
| IP del servidor | no | 9.3 | SSH |
| Clave de cifrado de n8n | **sí, la más importante** | 9.6 | ya queda en el servidor; guárdala por si hay que restaurar |
| Dirección pública (`https://secretaria.<tu-red>.ts.net/`) | no | 10 | `.env` (`N8N_WEBHOOK_URL`) y Meta |
| Usuario y contraseña de n8n | **sí** | 11.2 | entrar al editor |
| Direcciones de los tres checks de Healthchecks | **sí** | 14 | `.env` y monitor del servidor |

---

## 3. Netlify: páginas de inicio y privacidad

Google (para usar Calendar y Drive en producción) y Meta (para dejar la app de WhatsApp en modo *Live*) exigen una **página de inicio**
y una **política de privacidad** públicas. Se publican gratis en **Netlify**, conectado a tu copia de este repositorio en GitHub:
Netlify publica solo la carpeta [`paginas/`](../paginas/) (lo dice el archivo [`netlify.toml`](../netlify.toml)) y cada vez que
cambias algo en ella y lo subes a GitHub, vuelve a publicarla sola.

### 3.1 Tu copia del repositorio en GitHub

- [ ] Crea una cuenta en <https://github.com> (si no la tienes).
- [ ] Haz tu copia de este repositorio: botón **Fork** arriba a la derecha → **Create fork**. (Si prefieres un repositorio sin relación
      con este: **+ → New repository**, y súbele el contenido con **Add file → Upload files**.)
- [ ] Antes de subir nada tuyo, recuerda que un repositorio público guarda el historial: **nunca** subas el `.env`, claves, tu
      teléfono ni tu correo. Lo que se sube queda en el historial aunque luego lo borres.

### 3.2 Adaptar las dos páginas

Están en [`paginas/`](../paginas/): `index.html` (inicio) y `privacidad.html` (política). En GitHub, abre cada una y pulsa el lápiz
(**Edit this file**):

- [ ] Pon **tu nombre** donde dice «Guillermo Garcia Andugar» (el pie de `index.html` y el primer apartado de `privacidad.html`).
- [ ] Cambia la dirección `https://github.com/gguillex/Secretaria` del pie de `index.html` por **la de tu repositorio**.
- [ ] Si tu montaje trata datos distintos (por ejemplo, no usas Drive), ajusta el texto de `privacidad.html` y su fecha.
- [ ] **Commit changes**.

Las páginas **no llevan correo, teléfono ni forma de contacto a propósito**: solo el nombre del responsable, para no publicar
nada más de ti. El correo que Google pide (parte 5.2) se queda dentro de Google Cloud y no sale en la web. El nombre que aparece es
**Secretaria**: si llamas a tu app de otra forma, cámbialo también en el título y el encabezado de las dos páginas y usa ese mismo nombre
en Google y en Meta.

### 3.3 Publicarlas en Netlify

- [ ] Crea una cuenta en <https://www.netlify.com> con **Sign up → GitHub** (así no hace falta otra contraseña). El plan gratuito sobra.
- [ ] **Add new project → Import an existing project → GitHub**. Autoriza a Netlify; si solo das acceso a algunos repositorios, elige
      tu copia de este.
- [ ] Elige el repositorio. En la configuración del despliegue:
  - *Branch to deploy*: `main`.
  - *Base directory*: vacío.
  - *Build command*: **vacío** (no hay nada que compilar).
  - *Publish directory*: `paginas` (si sale ya relleno es por el `netlify.toml`: déjalo).
- [ ] **Deploy**. En un minuto el proyecto queda publicado en una dirección aleatoria (`https://palabras-raras-123.netlify.app`).
- [ ] Ponle un nombre reconocible: **Project configuration → General → Project details → Change project name** (en algunas cuentas se
      llama *Site configuration → Change site name*), por ejemplo `secretaria-tunombre`. La dirección pasa a ser
      `https://secretaria-tunombre.netlify.app`. Apúntala en la hoja de datos: es tu **dominio de las páginas**.
- [ ] Comprueba en una ventana de incógnito que abren las dos:
  - `https://<tu-sitio>.netlify.app/` → la página de inicio.
  - `https://<tu-sitio>.netlify.app/privacidad` → la política (Netlify sirve `privacidad.html` también sin la extensión).

  Si la primera da *Page not found*, el directorio publicado no es `paginas`: revísalo en **Project configuration → Build & deploy →
  Build settings** y vuelve a desplegar (**Deploys → Trigger deploy → Deploy project**). Si `/privacidad` da 404 pero
  `/privacidad.html` abre, usa la dirección **con** `.html` en todos los pasos siguientes. **No sigas hasta que las dos abran**:
  Google y Meta comprueban que existen.

> Netlify vuelve a publicar con cada cambio que subas a `main`, aunque no toque `paginas/`. Es inofensivo: el contenido publicado
> solo cambia si cambian las páginas.

---

## 4. Google: Calendar y Drive

Usa la **misma cuenta de Google** en todo el manual.

### 4.1 Calendario «Secretaria»

Los eventos van a un calendario propio, para no mezclarlos con los tuyos ni que la limpieza automática toque nada más.

- [ ] En <https://calendar.google.com>, a la izquierda, **Otros calendarios → + → Crear calendario**. Nombre: `Secretaria`. Zona horaria:
      la tuya (este proyecto usa `Europe/Madrid`). **Crear calendario**.
- [ ] En la lista de la izquierda, sobre «Secretaria»: **⋮ → Configuración y uso compartido → Integrar el calendario → ID del calendario**.
      Termina en `@group.calendar.google.com`. Apúntalo en la hoja de datos.
- [ ] (Opcional) Para verlo en el iPhone: Ajustes → Calendario → Cuentas → añade la cuenta de Google. iOS actualiza los calendarios de
      Google como mínimo cada 15 minutos: los avisos con poca antelación te llegarán por WhatsApp, no por el calendario.

### 4.2 Carpetas de Drive

- [ ] En <https://drive.google.com> crea una carpeta llamada `Secretaria` y, **dentro**, otra llamada `Entrada` (ahí llega todo lo que
      mandas). Las demás (`Notas` y las que pidas) las crea la secretaria sola.
- [ ] Abre `Secretaria`: la dirección es `https://drive.google.com/drive/folders/XXXXXXXX`. El trozo final (`XXXXXXXX`) es su **ID**.
      Apúntalo. Haz lo mismo con `Entrada`.

---

## 5. Google Cloud: acceso a Calendar y Drive (OAuth)

n8n necesita permiso para usar tu Calendar y tu Drive. Ese permiso se da con una «app» de Google en Google Cloud. Como es para ti
solo, la app se queda **sin verificar** (Google enseña un aviso al conectar; se acepta y ya).

### 5.1 Proyecto y APIs

- [ ] Entra en <https://console.cloud.google.com> con tu cuenta. Arriba, el selector de proyectos → **Proyecto nuevo**. Nombre:
      `Secretaria`. **Crear** y asegúrate de que queda seleccionado arriba.
- [ ] Menú ☰ → **APIs y servicios → Biblioteca**. Busca y **habilita** (botón *Habilitar*) estas dos: **Google Calendar API** y
      **Google Drive API**.

### 5.2 Imagen de marca (Branding)

Menú ☰ → **Google Auth Platform** (si es la primera vez, pulsa **Comenzar**: te pedirá lo mismo que aquí, en pasos).

- [ ] **Branding / Imagen de marca:**
  - *Nombre de la aplicación*: el mismo que en las páginas (`Secretaria`, si no lo cambiaste).
  - *Correo de asistencia*: tu correo.
  - *Logotipo*: **déjalo vacío** (subir un logo obliga a la verificación de la marca).
  - *Dominio de la aplicación*: página principal `https://<tu-sitio>.netlify.app/`; política de privacidad
    `https://<tu-sitio>.netlify.app/privacidad`. Condiciones del servicio: vacío.
  - *Dominios autorizados*: **+ Añadir dominio** → `<tu-sitio>.netlify.app` (sin `https://` ni barra final). `netlify.app` es un sufijo
    público (como `github.io`), así que tu sitio cuenta como dominio propio; para este uso personal no hace falta verificarlo.
  - *Información de contacto del desarrollador*: tu correo.
  - **Guardar**.

### 5.3 Público (Audience): en producción

- [ ] **Público / Audience**: tipo de usuario **Externo**.
- [ ] Estado de publicación: pulsa **Publicar aplicación** y confirma, para que quede **En producción**.

> **Por qué en producción y no en «Prueba»:** en modo prueba, los permisos que das caducan a los **7 días** y la secretaria dejaría de
> poder usar Calendar y Drive cada semana. En producción sin verificar, el límite es de 100 usuarios (te sobra: eres uno) y un aviso al
> conectar.

### 5.4 Cliente OAuth

- [ ] **Clientes → + Crear cliente**. Tipo de aplicación: **Aplicación web**. Nombre: `n8n`.
- [ ] En **URIs de redireccionamiento autorizados → + Añadir URI**, exactamente:

      http://localhost:5678/rest/oauth2-credential/callback

  (Es correcto que sea `localhost`: el editor de n8n se abrirá en tu ordenador a través de un túnel al servidor; ver 11.1.)
- [ ] **Crear**. Copia el **ID de cliente** y el **secreto del cliente** a la hoja de datos. El secreto solo se enseña entero ahora.

---

## 6. Gemini: la clave del modelo

- [ ] Entra en <https://aistudio.google.com> con la misma cuenta. **Get API key / Obtener clave de API → Crear clave** y elige el
      proyecto **Secretaria** de la parte 5 (así la facturación queda en un solo sitio).
- [ ] Copia la clave al gestor (empieza por `AIza…`).
- [ ] **Activa la facturación del proyecto** (en AI Studio, la opción de pasar a pago o *Set up billing*). Usa el **plan de pago**:
  - el gratuito limita a muy pocas peticiones al día y no sirve para uso diario;
  - en el gratuito Google **puede usar** lo que envías para mejorar sus productos; en el de pago, no. Mandarás datos personales.
- [ ] Recarga un saldo pequeño (5 $ dan para meses de uso personal), **desactiva la recarga automática** y pon un **tope de gasto** o
      una alerta de presupuesto en Google Cloud (Facturación → Presupuestos y alertas).

El modelo que usa el proyecto es `gemini-3.8-flash`. Si Google lo retira, se cambia en una línea (ver [Mantenimiento](#17-mantenimiento)).

---

## 7. Supabase: la base de datos

### 7.1 Proyecto

- [ ] Crea una cuenta en <https://supabase.com> y **New project**:
  - *Name*: `secretaria`.
  - *Database password*: pulsa **Generate a password** y guárdala en el gestor.
  - *Region*: una de la **Unión Europea** (por ejemplo, Frankfurt o Irlanda).
  - Si ofrece *Enable automatic RLS* o similar, déjalo **activado**.
  - **Create new project** y espera a que termine (1–2 minutos).

### 7.2 Crear las tablas (un solo archivo)

- [ ] En el proyecto: **SQL Editor → New query**.
- [ ] Abre el archivo [`supabase/instalar.sql`](../supabase/instalar.sql) **en un editor de texto** (descárgalo de GitHub con *Raw* o
      ábrelo desde tu copia del proyecto), selecciónalo **entero** (`Ctrl+A`), cópialo y pégalo en la consulta. **Run**.
      Debe acabar en **«Success. No rows returned»**.
      > Cópialo siempre del archivo, nunca de un chat ni de un documento: al pasar por ellos se pueden partir líneas y el SQL falla
      > de formas difíciles de entender. Todo va en una transacción: si falla, no se crea nada y puedes repetirlo tal cual.
- [ ] **New query** otra vez, pega [`supabase/comprobar-instalacion.sql`](../supabase/comprobar-instalacion.sql) y **Run**. Debe salir
      una tabla de **10 filas, todas con `ok = true`**. Si alguna sale `false`, la columna `detalle` dice qué falta: no sigas.

### 7.3 Dirección y clave

- [ ] **Project Settings → Data API** (o *API*): copia el **Project URL** (`https://xxxxxxxx.supabase.co`, sin nada detrás).
- [ ] **Project Settings → API Keys**: en *Secret keys*, crea una (o usa la que haya) y cópiala: empieza por `sb_secret_`. Al gestor.
      **Nunca** uses la *publishable key*: con la seguridad de la base de datos (RLS sin permisos públicos) no puede leer nada.

> Supabase pausa los proyectos gratuitos tras unos días sin actividad. No te afectará: el flujo «Latido» consulta la base de datos
> cada 5 minutos.

---

## 8. Meta: la app de WhatsApp

Es la parte con más pantallas y nombres parecidos. Ve despacio y apunta cada identificador **en su sitio** de la hoja de datos: el
error más común es pegar uno en el lugar de otro (Meta solo contesta «missing permissions» y no dice cuál).

| Nombre en Meta | Qué es | Forma |
|---|---|---|
| App Secret (clave secreta de la app) | Firma los avisos que Meta manda al servidor | 32 caracteres hexadecimales |
| Token de acceso permanente | Permite al servidor enviar mensajes | Empieza por `EAA`, cientos de caracteres |
| Phone number ID | El número desde el que escribe la secretaria | Solo dígitos (15 o así) |
| WhatsApp Business Account ID (WABA ID) | La cuenta de WhatsApp de la app | Solo dígitos; se usa una sola vez |
| Verify token | Contraseña del webhook, **la inventas tú** | Lo que quieras, largo y aleatorio |

### 8.1 Cuenta de desarrollador

- [ ] Entra en <https://developers.facebook.com> con tu cuenta de Facebook (si no tienes, créala) y pulsa **Empezar / Get started**
      para registrarte como desarrollador (pide verificar un teléfono o un correo).

### 8.2 Crear la app

- [ ] **Mis apps → Crear app**.
- [ ] Caso de uso: **Conectar con clientes a través de WhatsApp** (*Connect with customers through WhatsApp*). Siguiente.
- [ ] Nombre de la app: el mismo que en las páginas y en Google; correo de contacto: el tuyo (no se publica).
- [ ] Portafolio comercial (*business portfolio*): si no tienes, **crea uno** con tu nombre. No hace falta verificar la empresa para uso
      personal.
- [ ] **Crear app** (te pedirá tu contraseña de Facebook).

### 8.3 Número de prueba y tu móvil

- [ ] En el panel de la app: **WhatsApp → Configuración de la API** (*API Setup*). Meta crea automáticamente un **número de prueba**.
- [ ] Apunta en la hoja de datos el **Identificador del número de teléfono** (*Phone number ID*) y el **Identificador de la cuenta de
      WhatsApp Business** (*WhatsApp Business Account ID*).
- [ ] En **Para / To → Administrar la lista de números**, añade **tu móvil** y verifícalo con el código que te llega por WhatsApp.
- [ ] Pulsa **Enviar mensaje** (plantilla `hello_world`): debe llegarte a WhatsApp. Guarda ese chat: **ese contacto es tu secretaria**.

> **Número de prueba o número propio.** Este manual usa el número de prueba de Meta: es gratis, no necesita un número de teléfono extra
> y basta para una sola persona (solo admite como destinatarios los números que añadas a esa lista). Si quieres un número propio
> (por ejemplo, con un nombre visible personalizado), Meta exige un número que **no** esté registrado en WhatsApp, un nombre visible
> que aprueba Meta, un PIN de dos pasos y, según el caso, un método de pago y la verificación del portafolio. El resto del manual es
> igual: solo cambia el *Phone number ID*.

### 8.4 App Secret

- [ ] **Configuración de la app → Básica** (*App settings → Basic*). En **Clave secreta de la app**, **Mostrar**, copia y al gestor.

### 8.5 Dejar la app en modo «Activo» (Live)

**Sin este paso, Meta no entrega al servidor los mensajes reales** (solo los de prueba del panel).

- [ ] En **Configuración de la app → Básica** rellena:
  - **URL de la política de privacidad**: `https://<tu-sitio>.netlify.app/privacidad`.
  - **URL de las instrucciones de eliminación de datos** (si la pide): `https://<tu-sitio>.netlify.app/privacidad#borrar`.
  - **Dominios de la app** (si lo pide): `<tu-sitio>.netlify.app`.
  - **Icono de la app**: una imagen cuadrada de 1024 × 1024 px (cualquier icono propio sencillo).
  - **Categoría**: la que mejor encaje (por ejemplo, *Productividad* o *Utilidades*).
  - **Guardar cambios**.
- [ ] Arriba (o en **Publicar**), cambia el **modo de la app** de *Desarrollo* a **Activo / Live**. Si dice que falta algo, es uno de los
      campos de arriba. No debería pedir revisión de la app ni verificación de empresa para esto.

### 8.6 Token permanente (usuario del sistema)

El token del panel de *Configuración de la API* caduca en unas horas: el servidor necesita uno **permanente**.

- [ ] Abre <https://business.facebook.com/settings> (Configuración del negocio de tu portafolio) → **Usuarios → Usuarios del sistema → Añadir**.
      Nombre: `n8n`; rol: **Administrador**. Crear.
- [ ] Con ese usuario seleccionado: **Asignar activos**:
  - **Apps** → tu app → **Control total** (*Full control*).
  - **Cuentas de WhatsApp** → la cuenta de tu app → **Control total**.
  - Guardar. **Haz esto antes de generar el token**: un token generado antes de asignar los activos no tendrá los permisos.
- [ ] **Generar nuevo token**: app = la tuya; caducidad = **Nunca**; permisos: marca **`whatsapp_business_messaging`** y
      **`whatsapp_business_management`**. Generar.
- [ ] Copia el token (`EAA…`) al gestor **ahora**: Meta no lo vuelve a enseñar.

### 8.7 Verify token

- [ ] Inventa una contraseña larga y aleatoria (tu gestor puede generarla: 40 caracteres, solo letras y números) y guárdala como
      «verify token del webhook». La pondrás en dos sitios: el `.env` del servidor y Meta (parte 12).

El webhook (la dirección a la que Meta manda tus mensajes) se configura en la parte 12, cuando el servidor ya esté funcionando.

---

## 9. Hetzner: el servidor

Un servidor pequeño en la nube, encendido siempre. El que usa este proyecto: **Hetzner Cloud CAX11** (ARM; 2 vCPU, 4 GB de RAM,
40 GB de disco), **Ubuntu 24.04**, en Alemania. Unos 7 €/mes con IPv4 (consulta el precio actual en Hetzner). n8n solo orquesta: no
hace falta más.

### 9.1 Clave SSH en tu ordenador (antes de crear el servidor)

Entrarás al servidor con una clave SSH, no con contraseña (es mucho más seguro y es lo que pide Hetzner).

- [ ] Abre una terminal: en Windows, **PowerShell**; en macOS o Linux, **Terminal**.
- [ ] `ssh-keygen -t ed25519` → pulsa Intro a todo (o pon una frase de paso, mejor). Si dice que ya existe, responde `n`: ya tienes una.
- [ ] Muestra la parte **pública** (la que se puede compartir) y cópiala entera:
  - Windows: `type $env:USERPROFILE\.ssh\id_ed25519.pub`
  - macOS/Linux: `cat ~/.ssh/id_ed25519.pub`

### 9.2 Cuenta y servidor

- [ ] Crea una cuenta en <https://www.hetzner.com/cloud> (pide verificar la identidad y un método de pago; puede tardar un poco).
- [ ] En la consola de Hetzner Cloud: **New project** → `Secretaria` → entra en él.
- [ ] **Security → Firewalls → Create firewall**: nombre `solo-ssh`; en *Inbound* deja **solo** la regla **TCP 22** (y el ICMP si
      quieres hacer `ping`). Nada más: el webhook entra por Tailscale, no por un puerto abierto. **Create firewall**.
- [ ] **Servers → Add server**:
  - *Location*: Falkenstein, Núremberg o Helsinki (las de la UE).
  - *Image*: **Ubuntu 24.04**.
  - *Type*: **Shared vCPU → Arm64 (Ampere) → CAX11**.
  - *Networking*: IPv4 e IPv6.
  - *SSH keys*: **Add SSH key** y pega la clave pública de 9.1.
  - *Firewalls*: `solo-ssh`.
  - *Name*: `secretaria`.
  - **Create & Buy now**.
- [ ] Apunta la **IP** (IPv4) del servidor en la hoja de datos.

### 9.3 Primera entrada y actualizaciones

- [ ] En tu terminal: `ssh root@IP` (cambia `IP` por la del servidor). La primera vez pregunta si confías en el servidor: `yes`.
      Entra **sin pedir contraseña** (usa la clave).
- [ ] `apt update`
- [ ] `apt upgrade -y` (si pregunta por archivos de configuración, Intro deja la opción por defecto).
- [ ] **Actualizaciones de seguridad automáticas:** `apt install -y unattended-upgrades` y después
      `dpkg-reconfigure -plow unattended-upgrades` → **Yes**.
- [ ] **SSH solo con clave** (desactiva las contraseñas):
  - `printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\n' > /etc/ssh/sshd_config.d/00-solo-clave.conf`
  - `sshd -t` → no debe imprimir nada.
  - `systemctl reload ssh`
  - **Sin cerrar esta sesión**, en otra ventana de tu ordenador: `ssh root@IP` → debe entrar. Si te quedas fuera alguna vez: consola de
    Hetzner → el servidor → **Console** (consola web) y borra `/etc/ssh/sshd_config.d/00-solo-clave.conf`.
- [ ] `reboot` y vuelve a entrar al minuto con `ssh root@IP`.

### 9.4 Descargar el proyecto

- [ ] `apt install -y git`
- [ ] `git clone https://github.com/<usuario-del-proyecto>/Secretaria.git /root/Secretaria`
      (la dirección del repositorio de este proyecto; si lo has copiado a tu cuenta, la de tu copia).
- [ ] `cd /root/Secretaria`

> **La carpeta tiene que llamarse exactamente `Secretaria` y no se mueve ni se renombra nunca.** Docker llama al volumen de datos de
> n8n `secretaria_n8n_data` por el nombre de la carpeta: con otro nombre, las copias y la restauración no encontrarían los datos.

### 9.5 Docker

- [ ] `bash herramientas/servidor/instalar-docker.sh` → instala Docker desde el repositorio oficial y acaba con el mensaje de
      `hello-world` y «Docker instalado y funcionando».

### 9.6 Clave de cifrado y `.env`

- [ ] `bash herramientas/servidor/preparar-servidor.sh` → crea:
  - `secretos/n8n_encryption_key`: la **clave de cifrado** de n8n (cifra todas las credenciales). Solo la puede leer n8n.
  - `.env`: copia de `.env.example`, que rellenarás en la parte 11.
- [ ] **Guarda la clave de cifrado en el gestor ahora:** `cat secretos/n8n_encryption_key`, cópiala, y borra la pantalla con `clear`.
      Sin ella, ninguna copia de seguridad recupera las credenciales.

---

## 10. Tailscale: la dirección pública

Meta necesita una dirección **HTTPS fija** para entregar los mensajes. Tailscale Funnel la da gratis, sin comprar un dominio ni abrir
puertos en el servidor.

- [ ] Crea una cuenta en <https://tailscale.com> (puedes entrar con Google o GitHub).
- [ ] En el servidor: `curl -fsSL https://tailscale.com/install.sh | sh` (el instalador oficial).
- [ ] `tailscale up --hostname=secretaria` → imprime un enlace: ábrelo en tu navegador e inicia sesión para añadir el servidor a tu red.
- [ ] En la consola de Tailscale (<https://login.tailscale.com/admin>) → **DNS**: comprueba que **MagicDNS** está activado y, más abajo,
      activa **HTTPS Certificates**. Apunta el nombre de tu red (*Tailnet name*, algo como `tail1234ab.ts.net`).
- [ ] Publica **solo** la ruta de los webhooks:

      tailscale funnel --bg --set-path /webhook http://127.0.0.1:5678/webhook

  Si es la primera vez, el comando imprime un enlace para **permitir Funnel** en tu red: ábrelo, acepta y repite el comando.
  `--bg` lo deja funcionando en segundo plano **y tras cada reinicio**.
- [ ] `tailscale funnel status` debe mostrar exactamente esto (es la salida de un servidor que funciona):

      https://secretaria.<tu-red>.ts.net (Funnel on)
      |-- /webhook proxy http://127.0.0.1:5678/webhook

  Apunta la dirección base `https://secretaria.<tu-red>.ts.net/` en la hoja de datos. Para quitar Funnel: la misma orden de publicar
  con `off` al final.

> Con `--set-path /webhook`, Funnel solo deja pasar `…/webhook/…`: la raíz y el editor de n8n no son accesibles desde internet. Lo
> comprobarás en 11.4.

---

## 11. n8n: arrancar y configurar

### 11.1 Rellenar el `.env` y arrancar

- [ ] En el servidor, `cd /root/Secretaria` y `nano .env`. Rellena cada línea con su valor de la hoja de datos (cada línea lleva encima
      un comentario que dice qué es). Reglas: **sin comillas**, **sin espacios** alrededor del `=`, y `N8N_WEBHOOK_URL` con `https://` y
      **barra final** (`https://secretaria.<tu-red>.ts.net/`). `WHATSAPP_NUMERO_PERMITIDO` es tu móvil con prefijo y solo dígitos
      (`34600111222`). `HEALTHCHECK_URL_N8N` puede quedar vacío hasta la parte 14.
      Guarda con `Ctrl+O`, Intro, y sal con `Ctrl+X`.
- [ ] `docker compose up -d` → descarga n8n (la primera vez tarda) y lo arranca.
- [ ] `docker compose logs --tail 30 n8n` → debe aparecer `Editor is now accessible`. **No** debe aparecer `Mismatching encryption keys`,
      `EACCES` ni `permission denied` (ver [Problemas frecuentes](#16-problemas-frecuentes) si salen).

### 11.2 Abrir el editor (túnel SSH) y crear tu usuario

El editor de n8n solo escucha dentro del servidor. Se abre desde tu ordenador con un túnel SSH:

- [ ] En **otra** terminal de tu ordenador: `ssh -L 5678:127.0.0.1:5678 root@IP` y **déjala abierta** mientras uses el editor.
      (Si tu ordenador ya usa el puerto 5678 para otra cosa, ciérrala antes: la conexión con Google de 11.3 necesita exactamente ese puerto.)
- [ ] En el navegador: `http://localhost:5678`. Crea el usuario propietario (correo y contraseña fuerte; al gestor).

### 11.3 Las cinco credenciales (con estos nombres EXACTOS)

En n8n: **Overview → Credentials → Create credential** (o el botón **+**). Escribe el **nombre** exacto de la tabla (arriba a la izquierda
del diálogo, clic sobre el nombre por defecto): la importación de los flujos enlaza cada nodo con su credencial **por el nombre**, y es
también lo que impide que se crucen las dos de tipo «Header Auth».

| Nombre exacto | Tipo (búscalo así) | Campos |
|---|---|---|
| `Supabase` | **Supabase API** | *Host*: el Project URL. *Service Role Secret*: la clave `sb_secret_…` |
| `Gemini API key` | **Header Auth** | *Name*: `x-goog-api-key`. *Value*: la clave de Gemini (`AIza…`) |
| `WhatsApp token` | **Header Auth** | *Name*: `Authorization`. *Value*: `Bearer ` (con un espacio) seguido del token `EAA…` |
| `Google Calendar` | **Google Calendar OAuth2 API** | *Client ID* y *Client Secret* de 5.4 |
| `Google Drive` | **Google Drive OAuth2 API** | *Client ID* y *Client Secret* de 5.4 |

- [ ] En las dos de Google, comprueba que el campo **OAuth Redirect URL** que enseña n8n es exactamente
      `http://localhost:5678/rest/oauth2-credential/callback` (el que registraste en 5.4). Después, **Sign in with Google**:
  - sale «Google no ha verificado esta aplicación» → **Configuración avanzada → Ir a Secretaria (no seguro)** (o el nombre que le diste);
  - marca **todos** los permisos que pide y **Continuar**;
  - n8n debe decir que la cuenta está conectada. **Save**.
- [ ] Guarda cada una con **Save**. Al guardar, n8n prueba la conexión: Supabase debe decir que funciona.

### 11.4 Importar los 14 flujos (una orden)

- [ ] En el servidor, en `/root/Secretaria`: `bash herramientas/servidor/importar-flujos.sh`. Debe acabar con «Flujos importados».
- [ ] Recarga el editor: en **Overview** aparecen los 14 flujos «Secretaria · …».

Cada flujo llega ya con: cada nodo enlazado a su credencial, el flujo de WhatsApp apuntando al principal, el *Error workflow*
(«Aviso de fallos») elegido, y los identificadores leídos del `.env` (no hay que tocar ningún nodo `Configuración`).

- [ ] Comprobación rápida: abre «Secretaria · Procesar mensaje» y «Secretaria · WhatsApp». Ningún nodo debe tener un aviso rojo de
      credencial. Si alguno lo tiene, el nombre de esa credencial no coincide con la tabla de 11.3: corrígelo y repite la importación.
- [ ] Comprueba que el editor **no** es público: desde el navegador de tu móvil (sin el túnel), `https://secretaria.<tu-red>.ts.net/`
      debe dar error (404), no la pantalla de n8n.

> **Alternativa sin la orden:** también puedes importar cada archivo de `flujos/` desde el editor (**⋯ → Import from file**). n8n
> enlaza las credenciales por nombre al **guardar** el flujo; si algún nodo sigue marcado, elige la credencial a mano en ese nodo.

### 11.5 Publicar los flujos

En n8n 2.x un flujo con disparador (webhook o programación) **solo funciona publicado** (botón **Publish**, arriba a la derecha). Un
flujo que llama a otro no se puede publicar si el otro no lo está. En este orden:

- [ ] 1. **Aviso de fallos** y 2. **Procesar mensaje**.
- [ ] 3. **WhatsApp**.
- [ ] 4. **Sincronizar Calendar**, **Sincronizar Drive**, **Recordatorios**, **Avisos de eventos**, **Resumen diario**,
      **Recordatorio de archivos**.
- [ ] 5. **Limpieza de eventos**: archiva los eventos que acabaron hace más de 7 días y los borra de Calendar. En una instalación nueva
      no hay ninguno; si reutilizas un calendario con eventos antiguos, ejecútalo antes a mano (*Execute workflow*) y revisa su nodo
      *Resumen*.
- [ ] 6. **Vigilar Drive** y **Vigilar Calendar**: antes, ejecuta cada uno una vez a mano (la primera pasada solo guarda una «foto» de
      Drive y Calendar, sin avisar de nada).
- [ ] 7. **Latido**.
- [ ] **«Reiniciar todo» NO se publica nunca**: se ejecuta a mano, y solo si quieres vaciarlo todo (ver [Mantenimiento](#17-mantenimiento)).

> Si vuelves a importar los flujos (por ejemplo, tras actualizar el proyecto), quedan **sin publicar**: repite este apartado.

---

## 12. Conectar WhatsApp con el servidor

### 12.1 Webhook

- [ ] En Meta, panel de la app → **WhatsApp → Configuración** (*Configuration*) → **Webhook → Editar**:
  - **URL de devolución de llamada**: `https://secretaria.<tu-red>.ts.net/webhook/whatsapp`
  - **Token de verificación**: tu verify token (8.7), el mismo que pusiste en el `.env`.
  - **Verificar y guardar**. Meta llama a esa dirección y n8n le responde: si da error, ver [Problemas frecuentes](#16-problemas-frecuentes).
- [ ] En **Campos del webhook** (*Webhook fields*), **Suscribirse** a **`messages`**.

### 12.2 Suscribir la cuenta de WhatsApp a la app (el paso que nadie cuenta)

Sin esto, el webhook se verifica y el botón de prueba del panel funciona, **pero los mensajes reales nunca llegan**. Se hace una sola
vez, desde el servidor (así el token no pasa por tu ordenador ni queda en el historial):

- [ ] `read -rs TOKEN` → pega el token `EAA…` (no se ve al pegarlo) e Intro.
- [ ] `read -r WABA` → escribe el **WhatsApp Business Account ID** (8.3; **no** el Phone number ID) e Intro.
- [ ] `curl -s -X POST "https://graph.facebook.com/v26.0/$WABA/subscribed_apps" -H "Authorization: Bearer $TOKEN"; echo`
      → debe responder `{"success":true}`.
- [ ] `unset TOKEN WABA`

---

## 13. Pruebas por WhatsApp

Escribe al chat de la secretaria (el del número de prueba de 8.3), en este orden. En n8n, **Executions** enseña cada ejecución; si una
sale en rojo, ábrela: el nodo rojo y su mensaje dicen qué pasa.

- [ ] **Primer mensaje** (`hola`): te pregunta cómo quieres llamarla. Contesta con un nombre → «a partir de ahora me llamo …».
- [ ] `/help` → la lista de órdenes (no pasa por el modelo: responde en segundos).
- [ ] `dentista pasado mañana a las 10` → lo apunta, y **en un minuto** aparece en el calendario «Secretaria».
- [ ] `qué tengo pendiente` → la lista, con la cita.
- [ ] `quita la cita del dentista` → desaparece de Calendar en un minuto.
- [ ] `recuérdame en 5 minutos estirar las piernas` → «lo he puesto como alarma»; a los 5 minutos llega «🔔 Ahora: …».
- [ ] `tengo que llamar al banco` y después `ponla como alarma mañana a las 9` → confirma que ahora es una alarma, con sus avisos.
      `qué alarmas tengo` → solo las alarmas, con el título corto (responde en segundos: no pasa por el modelo).
- [ ] `mañana coger la cartera` → pregunta si es alarma, cita o tarea.
- [ ] `borra todo` → pregunta qué sección; contesta `tareas` → quita las tareas y te dice cuáles. Después `deshaz` → las recupera.
      `borra las alarmas y las tareas` quita las dos secciones de una vez, sin preguntar.
- [ ] `para que lo sepas: Emma es mi hermana` → lo guarda; `/memory` lo enseña numerado y `/forget 1` lo olvida.
- [ ] `trabajo los viernes de 16 a 20` → lo guarda en tu horario fijo (`/horario` lo enseña). Después, `médico el viernes a las 17`
      → pregunta si lo apunta igualmente.
- [ ] `qué tengo hoy` sin nada con fecha → te dice qué día ha mirado y que lo que no tiene fecha no sale (`/pending` lo enseña todo).
- [ ] Haz que te pregunte algo (`mañana coger la cartera` → «¿alarma, cita o tarea?») y contesta otra cosa (`qué tengo hoy`) → te dice
      que no hizo nada con la pregunta sin contestar y atiende lo nuevo.
- [ ] Manda seguidos un texto, una foto y otro texto → las tres respuestas llegan en ese orden, cada una citando su mensaje.
- [ ] `crea la carpeta Pruebas` y, cuando exista, `borra la carpeta Pruebas` → enseña lo que se borraría; `sí` → va a la papelera de
      Drive (compruébalo en drive.google.com → Papelera).
- [ ] Una **foto** → «Guardado: …» y aparece en `Secretaria/Entrada` de Drive. **Respóndele** (desliza el mensaje) con
      `guárdala en Fotos` → en 1–2 minutos pasa a `Secretaria/Fotos`.
- [ ] Una **nota de voz** (`qué tengo hoy`) → la respuesta, como si lo hubieras escrito. Un audio que no se entiende da un aviso.
- [ ] `dame las fotos` → te las manda agrupadas por carpeta. `dame todo` y `dame la jerarquía` responden al momento (sin modelo).
- [ ] `crea la carpeta Pruebas` y `crea la carpeta Cosas`; después `mete la carpeta Pruebas dentro de Cosas` → mueve la carpeta en Drive (en unos segundos).
- [ ] Manda dos fotos seguidas → un solo aviso con las dos. Respóndele `guárdalas en Cosas`; después `mueve las fotos de Cosas a Cosas/Fotos`, `déjalo como estaba` y comprueba en Drive que cada cosa acabó donde debía.
- [ ] **Al día siguiente**, sin tocar nada: llega el **resumen de las 7:00** (si escribiste en las 23 h anteriores; ver la nota sobre la
      ventana de 24 h en [Problemas frecuentes](#16-problemas-frecuentes)).

---

## 14. Vigilancia: que te avise si algo cae

Hay cuatro capas. Las dos primeras ya funcionan: **Aviso de fallos** (te escribe por WhatsApp si un flujo falla) y **Latido** (detecta
cosas atascadas). Pero si se cae el servidor entero, nada de dentro puede avisar: por eso hace falta un **monitor externo** que espere
latidos y te mande un correo si dejan de llegar.

### 14.1 Healthchecks.io

- [ ] Crea una cuenta gratuita en <https://healthchecks.io> y configura tu correo como canal de aviso.
- [ ] Crea **tres checks** y apunta sus direcciones (`https://hc-ping.com/…`) en el gestor (son privadas):

| Check | Periodo (*Period*) | Margen (*Grace*) | Quién lo alimenta |
|---|---|---|---|
| `n8n-latido` | 5 minutos | 10 minutos | el flujo «Latido» |
| `servidor` | 5 minutos | 10 minutos | `vigilar-servidor.sh` (cada 5 min, por cron) |
| `copia-semanal` | 7 días | 1 día | `copia-programada.sh` (domingos 03:30) |

### 14.2 En el servidor

- [ ] `nano .env` → `HEALTHCHECK_URL_N8N=` con la dirección del check `n8n-latido`. Guarda y `docker compose up -d`
      (**no** `restart`: no relee el `.env`).
- [ ] `bash herramientas/servidor/instalar-cron.sh` → instala las tareas programadas y crea `/root/.secretaria-monitor`.
- [ ] `nano /root/.secretaria-monitor` → rellena `HEALTHCHECK_URL_SERVIDOR`, `HEALTHCHECK_URL_COPIA` y
      `URL_PUBLICA=https://secretaria.<tu-red>.ts.net` (sin barra final).
- [ ] `bash herramientas/servidor/vigilar-servidor.sh; echo "código: $?"` → `código: 0`, y el check `servidor` pasa a verde.

### 14.3 ¿De verdad avisa? (haz al menos las dos primeras)

- [ ] `docker compose stop n8n` → en ≤ 15 minutos te llega el correo del monitor. Después `docker compose up -d` y vuelve a verde.
- [ ] Despublica «Sincronizar Calendar», manda `revisión del coche pasado mañana a las 12` y espera unos 20 minutos: «Latido» te
      escribe que hay un evento sin sincronizar. Vuelve a publicarlo: llega «Ya está todo en orden».
- [ ] `bash herramientas/servidor/copia-programada.sh` → el check `copia-semanal` pasa a verde.

---

## 15. Copias de seguridad

| Qué | Dónde vive | Copia |
|---|---|---|
| Flujos, credenciales (cifradas) y usuario de n8n | Volumen Docker `secretaria_n8n_data` | Automática los domingos (`copias/` del servidor) y manual con `copia-completa.sh` |
| Clave de cifrado | `secretos/n8n_encryption_key` | **Tu gestor de contraseñas** (parte 9.6) |
| El resto del `.env` | `/root/Secretaria/.env` | Tu gestor de contraseñas |
| Datos (mensajes, tareas, notas…) | Supabase | **Sin copia automática.** Si la quieres: exporta cada tabla a CSV desde el *Table Editor* de Supabase, o `pg_dump` con la cadena de conexión (*Connect* en el panel del proyecto) |
| Eventos y archivos | Google Calendar y Drive | Los guarda Google |

- **Hacer una copia y bajarla a tu ordenador** (hazlo tras la instalación y de vez en cuando: una copia que solo está en el servidor no
  sirve si se pierde el servidor):
  - Servidor: `bash herramientas/servidor/copia-completa.sh` → `copias/secretaria_n8n_completa_FECHA.tar.gz`.
  - Tu ordenador: `scp root@IP:/root/Secretaria/copias/secretaria_n8n_completa_FECHA.tar.gz .`
- **Restaurar** (en un servidor nuevo o tras un desastre): repite las partes 9 y 10, pon la **misma** clave de cifrado en
  `secretos/n8n_encryption_key` (sin ella, n8n arranca pero no descifra ninguna credencial), descomprime la copia y:
  `docker compose stop n8n`, `bash herramientas/servidor/restaurar-n8n.sh ruta/volumen-n8n.tar.gz`, `docker compose up -d`.
  Si la dirección pública cambió, actualiza `N8N_WEBHOOK_URL` y la URL del webhook en Meta (12.1).
- En Windows con Docker Desktop: `herramientas/copias/restaurar-n8n.ps1`. **Nunca** tengas dos n8n con los flujos publicados a la vez
  (duplicarían avisos y resúmenes): prueba la restauración con el ordenador desconectado de internet.

---

## 16. Problemas frecuentes

| Síntoma | Causa | Solución |
|---|---|---|
| Netlify falla con «Deploy directory 'paginas/paginas' does not exist» (o la web no cambia tras un push) | En Netlify está `paginas` como *Base directory* **y** como *Publish directory*: busca una carpeta dentro de otra | **Build settings → Configure**: *Base directory* vacío, *Publish directory* `paginas`. **Save** y **Deploys → Trigger deploy** |
| Meta no verifica el webhook (12.1) | El flujo WhatsApp no está publicado; el verify token no coincide; `N8N_WEBHOOK_URL` mal; Funnel apagado | Publica «WhatsApp». Compara el token con el del `.env` (y `docker compose up -d` si lo cambiaste). `tailscale funnel status`. Prueba: `curl "https://secretaria.<tu-red>.ts.net/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1"` debe dar 403 (token falso) |
| El botón de prueba de Meta llega a n8n, tus mensajes reales no | Falta suscribir la cuenta de WhatsApp a la app, o la app está en modo Desarrollo | 12.2 (`subscribed_apps`) y 8.5 (modo Activo) |
| La ejecución sale en **verde** pero no contesta | Un nodo de envío falló sin parar el flujo (lo hace a propósito para contestarte siempre) | Abre la ejecución y mira la salida de *Procesar mensaje* y *Enviar WhatsApp* |
| `401` con `CREDENTIALS_MISSING` en *Modelo* | La credencial de Gemini no está o es otra | Revisa el nombre `Gemini API key` y su cabecera `x-goog-api-key` |
| Error `190` (`OAuthException`) de Meta | Token caducado, revocado o mal pegado | El valor debe ser `Bearer EAA…` (con espacio). Si caducó, genera otro (8.6) |
| `missing permissions` de Meta | Un identificador en el sitio de otro (token por WABA ID…), o token generado antes de asignar los activos | Revisa la tabla de la parte 8; regenera el token tras asignar los activos |
| `Configuración: pon … en …` | Falta un identificador en el `.env` | El error dice cuál; `nano .env` y `docker compose up -d` |
| `access to env vars denied` | Falta `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` | Usa el `docker-compose.yml` del proyecto sin cambios |
| `Workflow could not be published … sub-workflows` | «Procesar mensaje» no está publicado | Publícalo antes que «WhatsApp» |
| `Mismatching encryption keys` al arrancar | La clave de cifrado no es la que tenían los datos | Pon la clave correcta en `secretos/n8n_encryption_key` (la del gestor) |
| n8n no arranca: `secretos/n8n_encryption_key` no existe | No se ejecutó `preparar-servidor.sh` | 9.6 |
| Google: `redirect_uri_mismatch` | La URI de 5.4 no es exactamente la que muestra n8n | Copia la *OAuth Redirect URL* de la credencial a Google Cloud, letra por letra |
| Google: la página de vuelta no carga tras aceptar | El túnel SSH no usa el puerto 5678 en tu ordenador | Cierra el túnel y ábrelo con `-L 5678:127.0.0.1:5678` |
| Calendar y Drive dejan de funcionar a los 7 días | La app de Google está en modo «Prueba» | 5.3: Publicar aplicación; después reconecta las dos credenciales |
| `429` de Gemini | Límite de peticiones por minuto | Espera; si es constante, revisa el plan de pago |
| `402` de Gemini | **Saldo agotado** | Recarga en AI Studio. No hay aviso previo: revisa el saldo de vez en cuando |
| No llega el resumen de las 7:00, ni avisos | **Ventana de 24 h de Meta**: sin plantillas aprobadas, solo se puede escribir a quien te escribió en las últimas 24 h | Escríbele algo cada día. Es una limitación de WhatsApp, no un fallo |
| «N mensajes tuyos no se procesaron» (Latido) | Un mensaje llegó con el flujo principal despublicado o una ejecución murió | Revisa *Executions*; después ejecuta `supabase/consultas/revisar-sin-procesar.sql` |

Consultas útiles en Supabase (SQL Editor), en [`supabase/consultas/`](../supabase/consultas/):

| Archivo | Qué hace |
|---|---|
| `ver-version.sql` | Solo lee: qué versión de la base de datos tienes instalada (úsala antes de actualizar). |
| `ver-errores.sql` | Solo lee: los últimos mensajes, si se procesaron y el error si lo hubo. |
| `ver-eventos.sql` | Solo lee: los eventos pendientes con su hora de Madrid. |
| `ver-tiempos.sql` | Solo lee: cuánto tarda en contestar cada mensaje (versión 1.2 o posterior). |
| `ver-recordatorios.sql` | Solo lee: las alarmas y qué avisos han salido ya. |
| `ver-avisos.sql` | Solo lee: los últimos eventos y el estado de su aviso por WhatsApp. |
| `ver-archivos.sql` | Solo lee: los últimos archivos recibidos, su estado y su carpeta. |
| `ver-carpetas-pedidas.sql` | Solo lee: las carpetas pedidas y si ya existen en Drive. |
| `revisar-sin-procesar.sql` | **Escribe:** anota como revisados los mensajes que se quedaron sin procesar (los que cuenta el Latido). No borra nada. |
| `vaciar-datos.sql` | **Borra todos los datos**, sin copia. Solo para empezar de cero (parte 17). |

---

## 17. Mantenimiento

- **Nunca `docker compose down -v`**: borra el volumen con todos los flujos y credenciales. Para parar: `docker compose stop`.
- **Tras cambiar el `.env` o el `docker-compose.yml`:** `docker compose up -d` (no `restart`).
- **Actualizaciones del sistema:** automáticas. No reinician solas: si existe `/var/run/reboot-required`, haz `reboot` en un momento
  tranquilo (n8n, Tailscale y Funnel vuelven solos).
- **Actualizar n8n:** la versión está fijada en `docker-compose.yml`. Haz antes una copia, lee los cambios incompatibles de la nueva
  versión, cambia la etiqueta y `docker compose up -d`.
- **Actualizar el proyecto a una versión nueva:** lee su entrada en [`CHANGELOG.md`](../CHANGELOG.md). En general: haz una copia
  (15), ejecuta en Supabase el script `supabase/actualizar-X.Y.sql` de **cada** versión que te saltes, en orden (si lo hay), y después
  `git pull` en `/root/Secretaria`, `bash herramientas/servidor/importar-flujos.sh` y vuelve a publicar los flujos (11.5). La base de
  datos va **antes** que los flujos: un flujo nuevo con la base de datos antigua falla.
- **Modelo de Gemini:** la constante `MODELO` de `herramientas/flujo/configuracion.js` y `MODELO_TRANSCRIPCION` de
  `herramientas/flujo-whatsapp/configuracion.js`; después `npm run generar` y reimportar.
- **Versión de la API de Meta:** `GRAPH_VERSION` en los nodos `Configuración` (hoy `v26.0`). Revísala una vez al año.
- **Cambios de hora:** todo funciona en `Europe/Madrid`; vigila alarmas y resumen el día del cambio.
- **Empezar de cero:** desactiva «Vigilar Drive» y «Vigilar Calendar»; ejecuta `supabase/consultas/vaciar-datos.sql`; ejecuta
  «Reiniciar todo» primero en ensayo y luego con `CONFIRMAR = 'BORRAR TODO'` (manda a la papelera lo de Drive y borra los eventos);
  vuelve a dejar `CONFIRMAR` vacío y reactiva los vigilantes.
