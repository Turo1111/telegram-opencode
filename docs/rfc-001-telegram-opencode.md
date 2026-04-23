# RFC-001 — Bot de Telegram local para OpenCode (MVP)

## Contexto
Necesitamos un bot de Telegram que, corriendo localmente, reciba mensajes de texto y los reenvíe a OpenCode, devolviendo la respuesta. Se prioriza simplicidad: sin hosting externo, sin webhook; idioma forzado a español.

## Objetivo
Definir el diseño técnico mínimo para implementar el MVP con long polling local, contrato HTTP hacia OpenCode y manejo básico de errores/logs.

## Alcance
- Solo mensajes de texto, sin comandos.
- Idioma único: español (locale = "es").
- Long polling a Telegram desde la PC local (getUpdates). Webhook fuera de v1.
- Llamada HTTP a OpenCode con contrato simple (POST JSON, Bearer token).
- Mensaje de bienvenida genérico al iniciar sesión/nueva sesión.
- Logs mínimos; sin base de datos.
- Sin rate limiting ni persistencia; opcional a futuro.

## Fuera de alcance
- Multimedia, archivos, botones.
- Webhook en producción.
- Panel/DB/roles.
- Internacionalización más allá de forzar español.

## Stack y dependencias sugeridas
- Runtime: Node.js LTS (ejecución local simple) o Python; elegir uno. Sugerencia: Node.js por ecosistema de bots.
- Cliente Telegram: `node-telegram-bot-api` (soporta polling fácil).
- HTTP cliente: `node-fetch` o `axios` para llamar a OpenCode.
- Logging: consola + prefijo de nivel (info/error) y timestamps. Puede usarse `pino` si se quiere JSON, pero consola basta en MVP.

## Configuración (.env ejemplo)
- `TELEGRAM_BOT_TOKEN` (requerido)
- `OPEN_CODE_URL` (ej: https://api.opencode.local/opencode/query)
- `OPEN_CODE_TOKEN` (Bearer)
- `OPEN_CODE_TIMEOUT_MS` (ej: 8000)
- `POLLING_INTERVAL_MS` (ej: 1000-2000)
- `LOCALE` (fijo "es")

## Contrato hacia OpenCode (propuesto)
- Método: POST `${OPEN_CODE_URL}`
- Headers: `Authorization: Bearer <OPEN_CODE_TOKEN>`, `Content-Type: application/json`
- Body: `{ prompt: string, userId?: string, locale: "es", metadata?: object }`
- Respuesta esperada: `{ answer: string, tokensUsed?: number, model?: string, latencyMs?: number }`
- Timeouts: `OPEN_CODE_TIMEOUT_MS`; 1 retry corto si timeout o 5xx.

## Flujo (polling)
1) Bot arranca, imprime mensaje de sesión y envía mensaje de bienvenida al primer chat que escriba.
2) Inicia long polling (`getUpdates`) con cursor `offset` persistido en memoria (variable en proceso).
3) Por cada mensaje de texto:
   - Normaliza (trim); si vacío, ignora.
   - Construye payload y llama a OpenCode.
   - Si éxito, responde con `answer` en español.
   - Si falla, responde fallback: “Hubo un problema, probá de nuevo”.
4) Logs: entrada/salida básica (sin tokens), duración de llamada a OpenCode, errores.

## Manejo de errores
- Timeout o 5xx de OpenCode: 1 retry inmediato con backoff corto (p. ej. 200-500ms).
- Si falla retry: responder fallback y loguear error.
- Errores de Telegram sendMessage: loguear; no retry automático en v1.

## Mensaje de bienvenida (genérico)
- Texto: “Sesión iniciada. Enviame tu pregunta y te respondo con OpenCode.”
- Se envía al primer chat que interactúe tras iniciar el proceso (o cada vez que se reinicie el bot, en el primer mensaje recibido de ese chat durante esa sesión de proceso).

## Estructura de carpetas (sugerida)
```
docs/
  prd.md
  rfc-001-telegram-opencode.md
src/
  config.ts        # lee .env, valida required
  logger.ts        # wrapper consola
  opencode.ts      # cliente HTTP a OpenCode
  bot.ts           # bootstrap del bot de Telegram
  handlers.ts      # lógica de manejo de mensajes
  index.ts         # entrypoint
.env.example
```

## Consideraciones operativas
- El proceso debe mantenerse corriendo en la PC. Si se detiene o se apaga la máquina, el bot queda offline.
- No loguear tokens. Sanitizar errores al log.
- Para producción con webhook, habría que agregar HTTPS público y validación de origen (fuera de v1).

## Extensiones futuras
- Rate limiting por chat ID (memoria o Redis si se despliega).
- Webhook para menor latencia y operación 24/7.
- Persistencia de historial o analítica.
- Internacionalización (detectar idioma y responder en consecuencia).
