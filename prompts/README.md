# Prompt del clasificador

[`clasificador-v13.md`](clasificador-v13.md) es el prompt que recibe Gemini en el nodo `Construir petición` del flujo «Procesar mensaje»; la
[`v12`](clasificador-v12.md) es la anterior y se elige con `VERSION_PROMPT` en la `Configuración` del flujo principal. La v13 sabe mover carpetas y
archivos, contesta más corto y usa la conversación reciente. Se insertan en el flujo al generarlo (`npm run generar`): no se editan en el JSON de `flujos/`.

- Pide **solo un JSON**: la intención (`guardar`, `consultar`, `corregir`, `completar`, `cancelar`, `aclarar`, `recordar`, `archivar`,
  `ver_archivos`, `crear_carpeta`…) y los elementos, con valores de listas cerradas. El código (`herramientas/flujo/planificar.js`)
  valida cada campo y rechaza lo que no encaje.
- Las variables entre llaves (`{{memoria}}`, `{{ultimos_items}}`, `{{proyectos}}`, `{{fecha_actual}}`…) las rellena el código en cada mensaje.
- Las fechas van en ISO 8601 con el desfase de `Europe/Madrid`; el código lo comprueba.
- Para cambiar el tipo de algo guardado, el modelo solo devuelve `correccion.convertir_a` (`alarma`, `cita` o `tarea`) y, si el usuario
  la dio, `correccion.cuando`: el código mueve las fechas. El código depende de esos campos, así que un prompt que no los produzca
  deja de convertir.
- Charla, datos duraderos y el nombre del usuario: la intención `charla` contesta sin guardar nada (el código filtra cualquier
  respuesta que diga haber hecho algo), y `memoria_nueva` puede acompañar a `guardar`, `charla` o `aclarar` cuando el mensaje cuenta
  un dato estable del usuario.
- El horario fijo: la intención `horario` devuelve `horario_nuevo` con bloques `{titulo, dias, desde, hasta}`; el código los valida,
  los guarda y avisa si una cita cae dentro. La plantilla recibe el horario en `{{horario}}`.
- Para borrar en Drive, el modelo devuelve `borrar_drive` con `{carpeta, archivos, solo_archivos}`: la confirmación y el borrado los
  hace el código.
- Los títulos se piden como titulares (2–6 palabras, máximo 40 caracteres): son lo único que sale en los listados.
- Lo que no necesita interpretación (comandos, frases fijas, aplazamientos simples al responder a un aviso) no llega al modelo.

Si lo cambias, prueba con mensajes reales variados antes de dejarlo: un ajuste pensado para un caso concreto suele empeorar otros.
