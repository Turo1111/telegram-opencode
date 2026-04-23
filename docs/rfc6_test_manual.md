# RFC-006 — Manual de testing E2E (Concurrencia + Locks)

> Objetivo: validar manualmente en Telegram real el comportamiento de concurrencia definido en RFC-006 antes de cerrar apply/verify, con evidencia reproducible.

---

## 1) Cuándo usar este manual

Usá este documento cuando necesites:

- cerrar la tarea manual E2E de RFC6 (Task 4.2);
- dejar evidencia de sign-off en chat/logs;
- validar que la política **busy/idle** y el lock FIFO por chat funciona en runtime real.

Este manual **complementa** (no reemplaza) la verificación automatizada:

```bash
npx tsc --noEmit
npm run verify:rfc6
```

---

## 2) Datos de ejecución

- **Fecha:** ____ / ____ / ______
- **Tester:** ______________________
- **Branch/Commit:** ______________________
- **Entorno:** local / otro: ______________________
- **CHAT_LOCK_ENABLED:** true / false
- **LOCK_WARN_WAIT_MS:** __________
- **COMPAT_RUN_CMD_COMMANDS:** true / false

---

## 3) Pre-requisitos

1. Verificar `.env` (mínimo):
   
   - `TELEGRAM_BOT_TOKEN`
   - `OPEN_CODE_URL`
   - `OPEN_CODE_TOKEN`
   - `CHAT_LOCK_ENABLED=true`
   - `LOCK_WARN_WAIT_MS=1500` (o valor definido para la corrida)
   - `COMPAT_RUN_CMD_COMMANDS=true` (recomendado para gatillar busy de forma determinística con `/run`)

2. Correr gates automáticos previos:

```bash
npx tsc --noEmit
npm run verify:rfc6
```

3. Levantar runtime local:

```bash
npm run stop:local
npm run start:local
```

---

## 4) Flujo recomendado de ejecución

Orden sugerido para minimizar ruido:

1. Smoke base (idle/contexto).
2. Semántica dual de `/project` en idle.
3. Entrada a busy (`/run ...`) y matriz de bloqueo/permisos.
4. Kill-switch `/cancel` en busy e idempotencia en idle.
5. Ráfaga de mensajes mismo chat (comportamiento estable).
6. Validación de logs de lock.
7. (Opcional) Aislamiento entre dos chats.

---

## 5) Casos manuales detallados

Estado por caso (marcar una opción por caso):

- [ ] PASS
- [ ] FAIL
- [ ] N/A

### R6-MAN-01 — Smoke idle

- **Pasos:**
  1. En chat limpio, enviar `/status`.
  2. Enviar `/project` (sin args).
- **Esperado:**
  - `/status` responde bloque **"Estado actual"**.
  - `/project` responde bloque **"Proyecto actual"**.
- **Evidencia:**

```text
ℹ️ Estado actual
📁 test2 • 🔌 sin sesión • 🏷️ session-linked
• Modo: session-linked
• Proyecto: test2
• Sesión: sin vincular
• Tarea activa: ninguna
• Recovery: recovered
• Motivo recovery: remote-missing
• Última reconciliación: 2026-04-16T19:34:11.928Z
Siguiente paso: vinculá sesión con /session <id> o creá una con /new.
ℹ️ Proyecto actual
📁 test2 • 🔌 sin sesión • 🏷️ session-linked
Proyecto: test2
Para cambiar de proyecto usá /project <alias|projectId>.
```

- **Estado (marcar una opción):**
  - [x] PASS
  - [ ] FAIL
  - [ ] N/A

### R6-MAN-02 — `/project` dual en idle

- **Pasos:**
  1. Enviar `/project demo-rfc6`.
  2. Enviar `/project`.
- **Esperado:**
  - Con args: confirma **"Proyecto seleccionado"**.
  - Sin args: mantiene semántica de consulta (**"Proyecto actual"**).
- **Evidencia:**

```text
🟢 Proyecto seleccionado
📁 demo-rfc6 • 🔌 sin sesión • 🏷️ idle
Alias: demo-rfc6
ID: demo-rfc6
Siguiente paso: /session <id> o /new.
ℹ️ Proyecto actual
📁 demo-rfc6 • 🔌 sin sesión • 🏷️ idle
Proyecto: demo-rfc6
Para cambiar de proyecto usá /project <alias|projectId>.
```

- **Estado (marcar una opción):**
  - [x] PASS
  - [ ] FAIL
  - [ ] N/A

### R6-MAN-03 — Entrar en busy y validar matriz de comandos

- **Precondición:** proyecto/sesión configurados (`/project ...` + `/new` si hace falta).
- **Pasos:**
  1. Ejecutar `/run npm test` (o `/cmd npm test`) para iniciar task running.
  2. Mientras está busy, enviar:
     - `/status`
     - `/project`
     - `/project otro`
     - `/new`
     - `/foobar`
     - texto libre (ej. `hola`)
- **Esperado:**
  - Permitidos en busy:
    - `/status` (responde estado)
    - `/project` sin args (query)
  - Bloqueados en busy:
    - `/project <arg>`, `/new`, `/foobar`
    - texto libre
  - Mensajes de bloqueo esperados:
    - **"Comando bloqueado por tarea en curso"** (slash bloqueado)
    - **"Hay una tarea en curso"** (texto libre)
- **Evidencia:**

```text
ℹ️ /run y /cmd quedan en transición. Migrá gradualmente al catálogo RFC-004 (/help).

Respuesta mock sesión: npm test
🟡 Estado actual
📁 demo-rfc6 • 🔌 sess-mo1w7g02 • 🏷️ task-running
• Modo: task-running
• Proyecto: demo-rfc6
• Sesión: sess-mo1w7g02
• Tarea activa: task-1
 Proyecto actual
📁 demo-rfc6 • 🔌 sess-mo1w7g02 • 🏷️ task-running
Proyecto: demo-rfc6
Para cambiar de proyecto usá /project <alias|projectId>.
🟡 Comando bloqueado por tarea en curso
📁 demo-rfc6 • 🔌 sess-mo1w7g02 • 🏷️ task-running
El comando /project no se puede ejecutar mientras hay una tarea activa.
Permitidos en busy: /status, /cancel, /project (sin argumentos).
🟡 Comando bloqueado por tarea en curso
📁 demo-rfc6 • 🔌 sess-mo1w7g02 • 🏷️ task-running
El comando /new no se puede ejecutar mientras hay una tarea activa.
Permitidos en busy: /status, /cancel, /project (sin argumentos).
🟡 Comando bloqueado por tarea en curso
📁 demo-rfc6 • 🔌 sess-mo1w7g02 • 🏷️ task-running
El comando /foobar no se puede ejecutar mientras hay una tarea activa.
Permitidos en busy: /status, /cancel, /project (sin argumentos).
🟡 Hay una tarea en curso
📁 demo-rfc6 • 🔌 sess-mo1w7g02 • 🏷️ task-running
Esperá a que termine antes de enviar texto libre. Podés consultar /status.
```

- **Estado (marcar una opción):**
  - [x] PASS
  - [ ] FAIL
  - [ ] N/A

### R6-MAN-04 — `/cancel` kill-switch en busy

- **Precondición:** chat en running con tarea activa.
- **Pasos:**
  1. Enviar `/cancel`.
  2. Enviar `/status`.
- **Esperado:**
  - `/cancel` responde **"Cancelación solicitada"** (o equivalente de cancelación exitosa).
  - `/status` deja de mostrar `task-running` y no mantiene `activeTaskId` activo.
- **Evidencia:**

```text
🟢 Cancelación solicitada
📁 demo-rfc6 • 🔌 sess-mo1w7g02 • 🏷️ task-running
Cancelación solicitada
Si querés continuar, revisá /status y enviá una nueva instrucción cuando quede libre.
ℹ️ Estado actual
📁 demo-rfc6 • 🔌 sess-mo1w7g02 • 🏷️ session-linked
• Modo: session-linked
• Proyecto: demo-rfc6
• Sesión: sess-mo1w7g02
• Tarea activa: ninguna
```

- **Estado (marcar una opción):**
  - [x] PASS
  - [ ] FAIL
  - [ ] N/A

### R6-MAN-05 — `/cancel` idempotente en idle

- **Pasos:**
  1. Con chat en idle/session-linked, enviar `/cancel`.
- **Esperado:**
  - Respuesta explícita: **"No hay tarea activa para cancelar"**.
  - No debe romper estado operativo.
- **Evidencia:**

```text
ℹ️ No hay tarea activa para cancelar
📁 demo-rfc6 • 🔌 sess-mo1w7g02 • 🏷️ session-linked
Cuando haya una tarea en curso, podés usar /cancel para interrumpirla.
```

- **Estado (marcar una opción):**
  - [x] PASS
  - [ ] FAIL
  - [ ] N/A

### R6-MAN-06 — Ráfaga mismo chat (estabilidad)

- **Pasos:**
  1. Enviar rápidamente 3-5 mensajes/comandos en el mismo chat (ej. `msg1`, `msg2`, `msg3`, `/status`, `/project otro`).
- **Esperado:**
  - No hay doble ejecución concurrente en el mismo chat.
  - Respuestas coherentes con la matriz busy/idle, sin mezcla caótica.
  - El bot no queda colgado al terminar la ráfaga.
- **Evidencia:**

```text
Funciona correctamente "🟢 Respuesta recibida
Respuesta mock sesión: das"
```

- **Estado (marcar una opción):**
  - [x] PASS
  - [ ] FAIL
  - [ ] N/A

### R6-MAN-07 — Observabilidad de lock

- **Pasos:**
  1. Mientras corrés los casos anteriores, observar logs de consola.
- **Esperado (logs):**
  - eventos `Chat lock acquired` y `Chat lock released`;
  - metadata con `chatId`, `waitMs`, `heldMs`, `queueDepth`, `outcome`;
  - si hay espera alta, warning por threshold (`LOCK_WARN_WAIT_MS`).
  - tras completar los casos, no quedan señales de lock fantasma.
- **Evidencia (snippets):**

```text
[2026-04-16T20:14:27.555Z] [INFO] OpenCode response {"latencyMs":3,"status":200,"attempt":1,"endpoint":"http://localhost:3000/opencode/sessions/state","operationName":"getSessionState","operationKind":"control","timeoutMs":8000}
[2026-04-16T20:14:27.595Z] [INFO] Telegram sender chunk plan {"chatId":6337553133,"chunkCount":1,"maxLength":4096}
[2026-04-16T20:14:27.966Z] [INFO] Chat lock released {"chatId":"6337553133","waitMs":74,"heldMs":423,"queueDepth":0,"outcome":"released-success"}
[2026-04-16T20:14:29.208Z] [INFO] Chat lock acquired {"chatId":"6337553133","waitMs":0,"heldMs":0,"queueDepth":0,"outcome":"acquired-immediate"}
[2026-04-16T20:14:29.301Z] [INFO] OpenCode response {"latencyMs":48,"status":200,"attempt":1,"endpoint":"http://localhost:3000/opencode/sessions/state","operationName":"getSessionState","operationKind":"control","timeoutMs":8000}
[2026-04-16T20:14:29.696Z] [INFO] Telegram route decision {"chatId":"6337553133","routeDecision":"free-text-allowed","statusMode":"session-linked"}
[2026-04-16T20:14:29.709Z] [INFO] OpenCode response {"latencyMs":5,"status":200,"attempt":1,"endpoint":"http://localhost:3000/opencode/sessions/message","operationName":"sendMessage","operationKind":"execution","timeoutMs":8000}
[2026-04-16T20:14:29.860Z] [INFO] Telegram sender chunk plan {"chatId":6337553133,"chunkCount":1,"maxLength":4096}
[2026-04-16T20:14:30.258Z] [INFO] Chat lock released {"chatId":"6337553133","waitMs":0,"heldMs":1050,"queueDepth":1,"outcome":"released-success"}
[2026-04-16T20:14:30.258Z] [INFO] Chat lock acquired {"chatId":"6337553133","waitMs":1036,"heldMs":0,"queueDepth":0,"outcome":"acquired-after-wait"}
[2026-04-16T20:14:30.929Z] [INFO] OpenCode response {"latencyMs":10,"status":200,"attempt":1,"endpoint":"http://localhost:3000/opencode/sessions/state","operationName":"getSessionState","operationKind":"control","timeoutMs":8000}
[2026-04-16T20:14:31.693Z] [INFO] Telegram route decision {"chatId":"6337553133","routeDecision":"free-text-allowed","statusMode":"session-linked"}
[2026-04-16T20:14:31.795Z] [INFO] OpenCode response {"latencyMs":45,"status":200,"attempt":1,"endpoint":"http://localhost:3000/opencode/sessions/message","operationName":"sendMessage","operationKind":"execution","timeoutMs":8000}
[2026-04-16T20:14:32.055Z] [INFO] Telegram sender chunk plan {"chatId":6337553133,"chunkCount":1,"maxLength":4096}
[2026-04-16T20:14:32.464Z] [INFO] Chat lock released {"chatId":"6337553133","waitMs":1036,"heldMs":2206,"queueDepth":0,"outcome":"released-success"}
```

- **Estado (marcar una opción):**
  - [x] PASS
  - [ ] FAIL
  - [ ] N/A

### R6-MAN-08 — Aislamiento entre chats (opcional recomendado)

- **Pasos:**
  1. Usar dos chats (A y B).
  2. Disparar actividad en ambos casi al mismo tiempo.
- **Esperado:**
  - lock es por chat (no global);
  - A no bloquea indebidamente B;
  - cada chat mantiene su secuencia propia.
- **Evidencia:**

```text

```

- **Estado (marcar una opción):**
  - [ ] PASS
  - [ ] FAIL
  - [x] N/A

---

## 6) Criterio de aprobación para cerrar Task 4.2

Se considera apto para cerrar la validación manual RFC6 cuando:

- R6-MAN-01, R6-MAN-03, R6-MAN-04, R6-MAN-05 y R6-MAN-07 están en **PASS**.
- No hay bloqueantes críticos en logs/chat.
- Evidencia textual o capturas queda adjunta en este documento.

R6-MAN-08 suma confianza, pero puede quedar como recomendado si no hay segundo chat disponible.

---

## 7) Resumen final de corrida

- **PASS:** ____
- **FAIL:** ____
- **N/A:** ____
- **Aprobación final (checkboxes):**
  - [ ] Aprobado para cerrar apply RFC6
  - [ ] Listo para sdd-verify

### Observaciones generales

```text

```

---

## 8) Cierre operativo

```bash
npm run stop:local
```
