# PRD — Bot de Telegram para respuestas de OpenCode

## Propósito
Dar a los usuarios una forma simple de consultar respuestas generadas por OpenCode directamente desde Telegram, sin tener que abrir otro cliente o dashboard.

## Objetivo SMART (v1)
En 4 semanas tener un bot de Telegram capaz de recibir un mensaje, delegarlo a OpenCode y devolver la respuesta en <5 segundos P95 para prompts cortos, con logs básicos de uso.

## Alcance v1 (MVP)
- Recepción de mensajes de texto en Telegram (sin comandos, solo texto libre).
- Envío de esos mensajes a OpenCode y devolución de la respuesta textual.
- Responder siempre en español para simplificar (se fuerza locale = "es").
- Manejo básico de errores (mensaje amigable si falla OpenCode).
- Configuración mínima (token de bot + endpoint/credenciales de OpenCode) vía variables de entorno.
- Ejecución local con long polling (getUpdates) desde la PC; sin hosting externo.
- Mensaje de bienvenida indicando el inicio de sesión (primera vez o nueva sesión tras reinicio).

## Fuera de alcance (v1)
- Respuestas con contenido rico (audio/imágenes/documentos).
- Persistencia de historial por usuario en base de datos.
- Panel de administración o UI web.
- Controles de acceso granulares por usuario o rol.
- Webhook en producción (se pospone; v1 solo polling local).

## Usuarios y casos de uso
- Usuarios finales que ya usan Telegram y quieren preguntar “al vuelo” a OpenCode.
- Operadores internos que monitorean disponibilidad y respuestas del bot.

## Supuestos y dependencias
- Contrato simple con OpenCode via HTTP POST (ver Decisiones v1) disponible con token válido.
- El proceso local puede mantenerse corriendo (PC encendida) para hacer polling a Telegram.
- Disponemos del token de bot de Telegram y es seguro guardarlo como variable de entorno.
- Latencia de OpenCode es aceptable para uso chat (<3 s promedio).
- No se requieren servicios externos adicionales (solo Telegram y OpenCode).

## Flujo de alto nivel
1) Usuario envía un mensaje al bot en Telegram.
2) Bot realiza long polling (getUpdates) desde la PC y normaliza el texto.
3) Se envía el prompt a OpenCode con locale = "es".
4) Se recibe respuesta y se envía de vuelta al chat.
5) Se registra métrica básica (timestamp, éxito/fallo, duración).

## Requerimientos funcionales
- RF1: El bot debe recibir mensajes de texto y pasarlos a OpenCode.
- RF2: El bot debe enviar la respuesta de OpenCode al mismo chat/origen.
- RF3: El bot debe manejar errores de OpenCode y responder con un mensaje de fallback (“Hubo un problema, probá de nuevo”).
- RF4: Debe existir configuración para tokens/URLs vía variables de entorno (.env.local o equivalente, nunca commitear secretos).
- RF5: Debe permitir modo sandbox vs producción (p. ej. apuntar a distintos endpoints de OpenCode).
- RF6: Responder siempre en español; si llega otro idioma se responde en español igualmente.
- RF7: No requiere comandos; solo mensajes libres. Mensaje de bienvenida opcional en primer contacto.
- RF8: Enviar mensaje de bienvenida que indique la sesión actual o si es una nueva sesión cuando el bot se reinicia.

## Requerimientos no funcionales
- Rendimiento: P95 de respuesta <5 s para prompts cortos; timeouts configurables.
- Observabilidad: logs mínimos (nivel info/error) y trazas de latencia por petición.
- Seguridad: no exponer tokens en logs; validar origen de webhooks (si aplica); rate limiting básico (p. ej. por chat ID) para evitar abuso.
- Fiabilidad: reintento simple en fallos temporales de OpenCode (1 retry con backoff corto opcional).
- Operación: proceso local corriendo en la PC; requiere supervisión mínima para que no se detenga.

## Integraciones
- Telegram Bot API: recepción de updates (webhook o polling) y envío de mensajes.
- OpenCode: endpoint/SDK para consultas (definir URL, auth y formato esperado de request/response).

## Datos y almacenamiento
- Sin base de datos en v1; sólo logs. Si se agrega rate limiting, se puede usar storage en memoria o Redis opcional.

## Métricas de éxito
- % de requests exitosas sobre total.
- Latencia P95 end-to-end.
- Cantidad de usuarios únicos por día.
- Tasa de errores de OpenCode vs errores de Telegram.

## Riesgos
- Cambios en el contrato de OpenCode (schema de request/response) rompen el flujo.
- Bot detenido si la PC se apaga o el proceso muere (al depender de polling local).
- Fugas de token si se loguea sin cuidado.

## Roadmap (tentativo)
1) Implementar polling (getUpdates) + llamada a OpenCode.
2) Manejo de errores, timeouts y logging.
3) Añadir rate limiting básico y modo sandbox/prod.
4) Hardening mínimo (ocultar tokens, supervisar proceso local) y checklist de salida a prod.

## Decisiones v1 (cerradas)
- OpenCode: POST `/opencode/query` con JSON `{ prompt: string, userId?: string, locale: "es", metadata?: object }` y header `Authorization: Bearer <TOKEN>`. Respuesta esperada `{ answer: string, tokensUsed?: number, model?: string, latencyMs?: number }`. Timeout 8s, 1 retry corto.
- Telegram: solo long polling desde la PC (sin webhook en v1). Requiere PC encendida y proceso corriendo.
- UX: sin comandos; se aceptan mensajes libres. Se puede enviar un mensaje de bienvenida automático al primer contacto.
- Idioma: se fuerza español para simplificar; si llega otro idioma se responde en español.
- Infra: sin servicios externos adicionales; todo local salvo Telegram y OpenCode.
- Mensajería: incluir mensaje de bienvenida que señale el inicio de sesión o nueva sesión tras reinicio.

## Diagrama de arquitectura (v1)
```mermaid
flowchart LR
  User[Usuario en Telegram]
  TG[Telegram Bot API]
  Bot[Proceso local del bot\n(long polling en PC)]
  OC[OpenCode API\nPOST /opencode/query]

  User -- mensaje --> TG
  TG -- getUpdates --> Bot
  Bot -- prompt (locale es) --> OC
  OC -- respuesta --> Bot
  Bot -- mensaje de respuesta --> User
```

## Preguntas abiertas
- ¿Definimos contenido del mensaje de bienvenida inicial?
- ¿Agregar rate limiting en v1 o posponer a v1.1?
