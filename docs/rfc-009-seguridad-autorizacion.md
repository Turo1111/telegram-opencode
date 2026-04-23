# RFC-009: Seguridad mínima y autorización por actor Telegram (`from.id`)

**Estado:** Implementado (Fases 1-5)  
**Autor:** AI Architect  
**Fecha:** 14 de Abril de 2026  

## Estado de implementación (actual)

Este RFC quedó implementado con el siguiente contrato vigente en código:

1. **Allowlist obligatoria en arranque**
   - `ALLOWED_USER_ID` es requerida.
   - `ALLOWED_USER_IDS` es opcional (CSV) y se mergea con la anterior.
   - Se normaliza, valida numérico positivo y deduplica; placeholders como `replace_me` son inválidos.
   - Si la allowlist efectiva queda inválida/vacía, el proceso falla antes de iniciar polling/webhook.

2. **Autorización por identidad canónica (`from.id`)**
   - Se autoriza por actor Telegram (`message.from.id` / `callback_query.from.id`).
   - No se usa `chat.id` como identidad primaria de autorización.
   - Si falta `from.id`, el update se considera no autorizado.

3. **Silent-drop para no autorizados**
   - No hay respuesta visible al atacante (ni `sendMessage` ni `answerCallbackQuery`).
   - No hay side effects de dominio/comandos.
   - Solo telemetría interna de bajo ruido (`event=telegram-auth-rejected`).

4. **Hardening de webhook local**
   - Receiver restringido a loopback (`127.0.0.1`, `::1`, `localhost`).
   - `Authorization: Bearer <token>` obligatorio.
   - Header faltante/malformado => **401**.
   - Bearer bien formado con token inválido => **403**.
   - `unknown-session` => **404**; `stale-binding` => **409**.

5. **Token efímero por sesión**
   - Token fuerte generado por registro.
   - Validación exacta por evento.
   - Invalidación en terminal/restart para bloquear replay.

## 1. Contexto y Problema

Al conectar la máquina de desarrollo local del usuario (donde están sus proyectos, credenciales, bases de datos y acceso shell total) a un bot de Telegram, abrimos un vector de ataque **masivo**.

Cualquier persona que encuentre el nombre de usuario (`@UsernameBot`) del bot de Telegram en la red pública podría potencialmente enviarle comandos, interactuar con el entorno de desarrollo local, borrar archivos o exfiltrar código fuente si el bot no está estrictamente blindado.

Por lo tanto, la seguridad en Nivel 2 no es opcional, es un requerimiento "Day 0".

## 2. Objetivos

- Asegurar que el bot solo responda y obedezca al propietario del entorno local.
- Prevenir ataques de enumeración (probing) de bots expuestos.
- Establecer un mecanismo de autorización local para los webhooks generados por OpenCode (IPC).
- Mantener la facilidad de configuración inicial sin sacrificar seguridad.

## 3. Propuesta de Seguridad

El modelo de amenazas asume dos vectores de ataque principales:
1. **Externo (Telegram):** Un atacante enviando mensajes al bot.
2. **Interno (PC Local):** Un malware en la máquina del usuario intentando usar el webhook local del bot (puerto `4040`) para inyectar comandos o robar sesiones.

### 3.1. Seguridad Externa: Telegram Whitelisting

La implementación final aplica **whitelisting por User ID de actor (`from.id`)**.

1. **Configuración en `.env`:**
   El bot requiere obligatoriamente `ALLOWED_USER_ID=123456789`. Opcionalmente puede incluir `ALLOWED_USER_IDS` (CSV) para multiusuario. Si no hay IDs válidos, el bot se niega a arrancar.
2. **Silencio absoluto (Drop and Ignore):**
   Si el bot recibe un update (mensaje) de cualquier ID distinto al configurado en la whitelist, lo ignorará **sin responder**. No enviará un mensaje diciendo "No autorizado", ya que esto confirmaría a un atacante automatizado que el bot está vivo y es válido.
3. **Pairing automático (no implementado):**
   Esta alternativa fue considerada pero **no forma parte del contrato actual**. El mecanismo vigente es solo por variables de entorno.

### 3.2. Seguridad Interna: Local Webhook Token (Bearer)

Como se mencionó en el RFC-007, levantar un servidor en `localhost:4040` expone el bot a otras aplicaciones locales.

1. **Host Binding Estricto:**
   El servidor HTTP interno debe hacer bind explícito a `127.0.0.1` o `::1` (localhost), nunca a `0.0.0.0` (todas las interfaces), para evitar accesos desde la misma red LAN o Wi-Fi.
2. **IPC Token:**
   Al iniciar una nueva sesión de OpenCode, el bot generará un UUID v4 o HMAC robusto y efímero para esa sesión. Este token se pasa a OpenCode como argumento o variable de entorno (`--webhook-token=xyz`).
3. **Validación:**
   Cualquier petición `POST /webhook` recibida por el bot que no contenga el header `Authorization: Bearer <token>` será descartada (HTTP 401/403). Esto impide que malware local falsifique el éxito o fracaso de las tareas.

## 4. Escenarios y Edge Cases

### 4.1. El usuario quiere compartir el bot con un compañero
¿Qué ocurre si un equipo de dos personas quiere usar el mismo bot de Telegram conectado a un servidor de staging?
**Solución implementada:** `ALLOWED_USER_ID` (obligatoria) + `ALLOWED_USER_IDS` (opcional CSV). Por defecto sigue siendo "Single User" si solo se define la variable obligatoria.

### 4.2. Filtración del Token del Bot de Telegram
Si el usuario comitea accidentalmente su `.env` con el `TELEGRAM_BOT_TOKEN`, cualquiera puede apoderarse del control del bot y leer/escribir mensajes.
**Mitigación:** Es un problema de Telegram. Sin embargo, la ventaja de nuestra arquitectura es que el atacante **no puede** leer los webhooks locales. El bot de Telegram *pull-ea* (o recibe por webhook) los comandos, pero si el atacante corre otro bot en otro lado con el mismo token, las peticiones se dividirán aleatoriamente entre ambas instancias de Node.js ("Conflict"), rompiendo la funcionalidad pero alertando al dueño original de que algo raro pasa. Aún así, un atacante con el token podría enviar comandos que lleguen a la instancia local legítima. La seguridad última recae en que el usuario proteja el token.

## 5. Consecuencias

- **Positivas:** Blindaje robusto contra bots de escaneo en Telegram y scripts maliciosos locales, sin afectar la experiencia del usuario (cero fricción después del emparejamiento inicial).
- **Negativas:** El usuario debe saber su Chat ID/User ID para configurar la `.env` inicialmente (o implementar un comando de Pairing único, lo cual requiere un poco más de código).

## 6. Alternativas consideradas

- **Contraseñas o PINs por sesión:** Pedirle al usuario un PIN de 4 dígitos para cada comando destructivo. *Descartado* por causar demasiada fricción en la UX de Nivel 2.
- **Autenticación WebApp:** Levantar una Telegram WebApp integrada con OAuth/GitHub. *Descartado* por overkill para un bot que corre atado a un entorno local de desarrollo.
