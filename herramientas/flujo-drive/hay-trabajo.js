// Nodo "Hay trabajo": deja pasar UN item si hay algún archivo o carpeta pendiente y ninguno si no. Así, cuando no hay nada que hacer (casi
// siempre), el flujo termina aquí sin pedir el turno ni tocar Drive: dos lecturas de Supabase cada 10 segundos y nada más.
// Usa la misma función que «Preparar» (se inserta aquí al generar el flujo): no editar aquí.

/*__PREPARAR__*/

// --- Pegamento con n8n ---
return preparar($('Leer pendientes').all(), $('Leer carpetas pendientes').all()).length > 0 ? [{ json: {} }] : [];
