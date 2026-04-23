# RFC-004 — Manual de testing E2E (Telegram Control Remoto)

> Objetivo: ejecutar una validación manual completa y reproducible de RFC-004 en Telegram real, con foco en UX conversacional, ruteo estricto, compatibilidad por flags y verificación de rollback operativo.

---

## 1) Cuándo usar este manual

Usar este documento cuando necesites:

- validar RFC-004 de punta a punta con interacción real de chat;
- obtener evidencia manual para sign-off (capturas/snippets/logs);
- confirmar comportamiento con flags de compatibilidad;
- ejecutar checks orientados a rollback antes o durante un incidente.

> Referencia complementaria: `docs/rfc4-e2e-regression-checklist.md` (matriz rápida/regresión).  
> Este manual agrega flujo guiado paso a paso y plantilla de evidencia por caso.

---

## 2) Datos de ejecución

- **Fecha:** ____ / ____ / ______
- **Tester:** ______________________
- **Branch/Commit:** ______________________
- **Entorno:** local / otro: ______________________
- **OPEN_CODE_URL:** ______________________
- **COMPAT_LEGACY_TEXT_BRIDGE inicial:** true / false
- **COMPAT_RUN_CMD_COMMANDS inicial:** true / false

---

## 3) Pre-requisitos y preparación de entorno

1. Verificar `.env`:
   
   - `TELEGRAM_BOT_TOKEN` válido.
   - `OPEN_CODE_URL` y `OPEN_CODE_TOKEN` correctos (mock local recomendado).
   - flags iniciales definidos para la corrida.

2. Iniciar runtime local estándar:

```bash
npm run stop:local
npm run start:local
```

3. Confirmar en logs:
   
   - bot iniciado sin crash;
   - mock disponible en `http://localhost:3000` (si aplica);
   - sin errores de arranque recurrentes.

4. Guardrail operativo:
   
   - no tocar workaround IPv4 en `src/index.ts` durante la prueba;
   - usar solo scripts del repo (sin comandos ad-hoc de build).

---

## 4) Flujo E2E recomendado (orden de ejecución)

Ejecutar en este orden para reducir ruido y aislar fallas:

1. **Smoke base** (contexto y routing principal).
2. **Catálogo de comandos + alias**.
3. **Gates de slash vs texto libre**.
4. **Cancelación y estados operativos**.
5. **UX de errores diferenciados**.
6. **Sender seguro (sanitización/fallback/chunking)**.
7. **Compatibilidad por flags** (`COMPAT_*`).
8. **Checks de rollback orientados a incidente**.

> Si un caso crítico falla, pausar la corrida, registrar evidencia y pasar directo a sección 6 (compatibilidad/rollback).

### 4.1) Cómo interpretar respuestas de texto libre (IMPORTANTE)

Antes de ejecutar casos, tené presente esto:

- En **mock local**, el flujo de texto libre (`sendMessage`) responde por diseño con eco:
  - `Respuesta mock sesión: <tu texto>`
  - Esto **NO** significa que el bot esté roto; es comportamiento esperado del mock.
- El bot ejecuta lógica de ruteo/contexto igual, pero el backend mock no “razona” ni ejecuta tareas reales como un orquestador completo.
- Si querés probar **tarea en curso (`running`)** en mock, usá `/run <comando>` con `COMPAT_RUN_CMD_COMMANDS=true`.
- Si querés probar **`needs-attention`** en mock, hay que forzarlo con fixture/llamada explícita al endpoint de sesiones (no se activa automáticamente con texto libre común).

Regla práctica:
- Si el caso evalúa **routing/UX/gates**, el eco del mock es suficiente como evidencia.
- Si el caso evalúa **ejecución real de tareas**, necesitás backend real o fixture forzado.

---

## 5) Casos de prueba detallados

Estado por caso (checkbox clickeables):

- Marcá **una sola** opción por caso.
- Usá `🟡 PARCIAL` cuando el caso esté incompleto pero no bloquee continuar con otros RFC.

### R4-MAN-01 — Estado inicial y ayuda

- **Pasos:**
  1. Abrir chat limpio con el bot.
  2. Enviar `/help` (o `/start`).
  3. Enviar `/status`.
- **Esperado:**
  - ayuda con catálogo operativo;
  - `/status` responde contexto actual sin romper;
  - formato con encabezado semántico y contexto (`📁`/`🔌`) cuando aplique.
- **Evidencia:**

```text
ℹ️ Estado actual
📁 demo-rfc2 • 🔌 sin sesión • 🏷️ session-linked
• Modo: session-linked
• Proyecto: demo-rfc2
• Sesión: sin vincular
• Tarea activa: ninguna
• Recovery: recovered
• Motivo recovery: remote-missing
• Última reconciliación: 2026-04-15T19:49:11.678Z
Siguiente paso: vinculá sesión con /session <id> o creá una con /new.
ℹ️ Ayuda rápida
Comandos disponibles:
• /start | /help
• /status | /st
• /project | /p <alias|projectId>
• /session | /s <sessionId>
• /new | /n
• /cancel | /c
```

- **Estado (marcar una sola opción):**
  - [ ] ✅ PASS
  - [ ] ❌ FAIL
  - [ ] 🟡 PARCIAL / N/A

### R4-MAN-02 — Alias equivalentes

- **Pasos:** comparar pares:
  - `/help` vs `/start`
  - `/status` vs `/st`
  - `/project` vs `/p`
  - `/session` vs `/s`
  - `/new` vs `/n`
  - `/cancel` vs `/c`
- **Esperado:** misma semántica funcional y UX equivalente por par.
- **Evidencia:**

```text
No copio evidencia pero da lo mismo en ambos casos con /help - /start
/status - /st lo mismo
/project - /p lo mismo
/session - /s lo mismo
/new - /n lo mismo
/cancel - /c lo mismo
```

- **Estado (marcar una sola opción):**
  - [ ] ✅ PASS
  - [ ] ❌ FAIL
  - [ ] 🟡 PARCIAL / N/A

### R4-MAN-03 — Selección de proyecto y creación de sesión

- **Pasos:**
  1. `/project <ruta_o_alias>`
  2. `/new`
  3. `/status`
- **Esperado:**
  - proyecto activo confirmado;
  - sesión creada y asociada;
  - `/status` refleja proyecto/sesión y estado operativo coherente.
- **Evidencia:  **
  
  ![c1bc0375-0ba1-4a94-9fa3-da3887f5ee7c](file:///C:/Users/matias/Pictures/Typedown/c1bc0375-0ba1-4a94-9fa3-da3887f5ee7c.png)

```text

```

- **Estado (marcar una sola opción):**
  - [ ] ✅ PASS
  - [ ] ❌ FAIL
  - [ ] 🟡 PARCIAL / N/A

### R4-MAN-04 — Attach de sesión existente

- **Pasos:**
  1. Obtener `sessionId` válido (de corrida previa o salida de `/new`).
  2. Ejecutar `/session <id>`.
  3. Enviar `/status`.
- **Esperado:** sesión existente queda vinculada; estado operativo consistente.
- **Evidencia:**

```text
🟢 Sesión vinculada
📁 test • 🔌 sess-mo1mpb3n • 🏷️ session-linked
Ya podés enviar texto libre o usar /status.
ℹ️ Estado actual
📁 test • 🔌 sess-mo1mpb3n • 🏷️ session-linked
• Modo: session-linked
• Proyecto: test
• Sesión: sess-mo1mpb3n
• Tarea activa: ninguna
```

- **Estado (marcar una sola opción):**
  - [ ] ✅ PASS
  - [ ] ❌ FAIL
  - [ ] 🟡 PARCIAL / N/A

### R4-MAN-05 — Slash vs texto libre sin contexto

- **Pasos:**
  1. Dejar chat sin proyecto/sesión activos.
  2. Enviar `/status`.
  3. Enviar texto libre (ej: `hola`).
- **Esperado:**
  - slash se procesa como comando;
  - texto libre sin contexto: rechazo claro y accionable (o bridge legacy si flag ON).
  - **Nota de validación:** si aparece `Respuesta mock sesión: ...`, ese caso NO prueba "sin contexto" (implica sesión activa).
- **Evidencia:**

```text
Respuesta recibida
Respuesta mock sesión: hola
```

- **Estado (marcar una sola opción):**
  - [ ] ✅ PASS
  - [ ] ❌ FAIL
  - [ ] 🟡 PARCIAL / N/A

### R4-MAN-06 — Texto libre con sesión activa

- **Pasos:**
  1. Crear/vincular sesión (`/project` + `/new` o `/session`).
  2. Enviar texto libre corto.
- **Esperado:** mensaje ruteado por `sendMessage`; no pide reconfigurar contexto.
- **Evidencia:**

```text
Respuesta recibida
Respuesta mock sesión: que onda
```

- **Estado (marcar una sola opción):**
  - [ ] ✅ PASS
  - [ ] ❌ FAIL
  - [ ] 🟡 PARCIAL / N/A

### R4-MAN-07 — Gate de concurrencia (running)

- **Pasos:**
  1. Asegurar `COMPAT_RUN_CMD_COMMANDS=true`.
  2. Disparar tarea con `/run <comando>` (ej: `/run npm test`) para forzar estado `running` en mock.
  2. Enviar otro texto libre/comando operativo enseguida.
- **Esperado:** bloqueo por concurrencia con mensaje explícito (`tarea en curso`).
- **Evidencia:**

```text
🟢 Respuesta recibida
Respuesta mock sesión: haceme un prd para un checklist web
```

- **Estado (marcar una sola opción):**
  - [ ] ✅ PASS
  - [ ] ❌ FAIL
  - [ ] 🟡 PARCIAL / N/A

### R4-MAN-08 — Continuidad en `needs-attention`

- **Pasos:**
  1. Forzar estado en mock con sesión activa (misma `projectId` + `sessionId`) usando terminal:

```bash
curl -s -X POST "http://localhost:3000/opencode/sessions/message" \
  -H "Authorization: Bearer $OPEN_CODE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"projectId":"<projectId>","sessionId":"<sessionId>","message":"confirm?","forceNeedsAttention":true}'
```

  2. Enviar `/status` y validar estado `needs-attention`.
  3. Enviar texto libre de confirmación.
- **Esperado:**
  - UX marca `needs-attention`;
  - texto libre siguiente se acepta para continuar flujo.
- **Evidencia:**

```text
🟢 Respuesta recibida
Respuesta mock sesión: ya terminaste?
```

- **Estado (marcar una sola opción):**
  - [ ] ✅ PASS
  - [ ] ❌ FAIL
  - [ ] 🟡 PARCIAL / N/A

### R4-MAN-09 — `/cancel` soportado / no soportado

- **Pasos:**
  1. En entorno con soporte `cancelOrInterrupt`, ejecutar `/cancel` con tarea activa.
  2. En entorno sin soporte, repetir `/cancel`.
- **Esperado:**
  - soportado: confirmación de cancelación solicitada/ejecutada;
  - no soportado: mensaje explícito con siguiente acción.
- **Evidencia:**

```text
ℹ️ No hay tarea activa para cancelar
📁 test2 • 🔌 sess-mo1n794o • 🏷️ session-linked
Cuando haya una tarea en curso, podés usar /cancel para interrumpirla.
```

- **Estado (marcar una sola opción):**
  - [ ] ✅ PASS
  - [ ] ❌ FAIL
  - [ ] 🟡 PARCIAL / N/A

### R4-MAN-10 — UX de errores diferenciados

- **Pasos:** provocar escenarios (timeout, unavailable, mismatch, sin contexto).
- **Esperado:** mensajes distintos por categoría + acción sugerida (no error genérico).
- **Evidencia:**

```text

```

- **Estado (marcar una sola opción):**
  - [ ] ✅ PASS
  - [ ] ❌ FAIL
  - [ ] 🟡 PARCIAL / N/A

### R4-MAN-11 — Sender seguro (HTML/fallback/chunking)

- **Pasos:**
  1. Respuesta con caracteres conflictivos (`<`, `>`, `&`, comillas) y multilinea.
  2. Forzar contenido que rompa parse mode.
  3. Generar salida > 4096 chars.
- **Esperado:**
  - envío estable con sanitización;
  - fallback automático a texto plano cuando hay error de parseo;
  - chunking correcto `(n/m)` y ordenado para mensajes largos.
- **Evidencia (chat + logs):**

```text

```

- **Estado (marcar una sola opción):**
  - [ ] ✅ PASS
  - [ ] ❌ FAIL
  - [ ] 🟡 PARCIAL / N/A

---

## 6) Compatibilidad por flags y checks de rollback

Referencia operativa: `docs/rfc4-rollback-runbook.md`

### R4-COMP-01 — `COMPAT_LEGACY_TEXT_BRIDGE=true`

- **Pasos:**
  1. Configurar en `.env`: `COMPAT_LEGACY_TEXT_BRIDGE=true`.
  2. Reiniciar runtime (`stop:local` + `start:local`).
  3. Probar texto libre **sin** contexto.
  4. Probar texto libre **con** sesión activa.
- **Esperado:**
  - sin contexto: bridge legacy permitido;
  - con sesión activa: prioridad de router/session-adapter (sin degradar flujo principal).
- **Evidencia:**

```text
Respuesta mock: hola //sin contexto
🟢 Respuesta recibida
Respuesta mock sesión: que onda pa //con session activa
```

- **Estado (marcar una sola opción):**
  - [ ] ✅ PASS
  - [ ] ❌ FAIL
  - [ ] 🟡 PARCIAL / N/A

### R4-COMP-02 — `COMPAT_LEGACY_TEXT_BRIDGE=false`

- **Pasos:**
  1. Configurar `COMPAT_LEGACY_TEXT_BRIDGE=false`.
  2. Reiniciar runtime.
  3. Repetir pruebas con y sin contexto.
- **Esperado:** sin contexto se rechaza de forma estricta; con sesión activa sigue `sendMessage`.
- **Evidencia:**

```text
puse "hola", salio "🔴 Falta contexto operativo
📁 sin proyecto • 🔌 sin sesión • 🏷️ n/d
Primero elegí proyecto y sesión (/project, /session o /new)."
con /p , /n y /s "🟢 Respuesta recibida
Respuesta mock sesión: haceme un prd para una checklist web"
```

- **Estado (marcar una sola opción):**
  - [ ] ✅ PASS
  - [ ] ❌ FAIL
  - [ ] 🟡 PARCIAL / N/A

### R4-COMP-03 — `COMPAT_RUN_CMD_COMMANDS=true/false`

- **Pasos:**
  1. Con flag `true`, validar `/run <cmd>` y `/cmd <cmd>`.
  2. Con flag `false`, repetir.
- **Esperado:**
  - `true`: comandos disponibles como compatibilidad transicional;
  - `false`: comportamiento acorde a desactivación (sin ambigüedad para usuario).
- **Evidencia:**

```text

```

- **Estado (marcar una sola opción):**
  - [ ] ✅ PASS
  - [ ] ❌ FAIL
  - [ ] 🟡 PARCIAL / N/A

### R4-ROLL-01 — Smoke post-rollback por flags

- **Precondición:** incidente de UX/ruteo/sender o simulación de incidente.
- **Pasos:**
  1. Aplicar en `.env`:

```env
COMPAT_LEGACY_TEXT_BRIDGE=true
COMPAT_RUN_CMD_COMMANDS=true
```

2. Reiniciar runtime:

```bash
npm run stop:local
npm run start:local
```

3. Verificar rápido:
   - `/status` responde;
   - texto libre sin contexto tiene comportamiento compatible;
   - `/run` y `/cmd` operativos;
   - texto libre con sesión activa no se rompe.
   - **Esperado:** mitigación efectiva sin tocar código de producción en caliente.
   - **Evidencia:**

```text

```

- **Estado (marcar una sola opción):**
  - [ ] ✅ PASS
  - [ ] ❌ FAIL
  - [ ] 🟡 PARCIAL / N/A

---

## 7) Matriz de cobertura rápida (RFC-004 ↔ casos)

- Catálogo de comandos + alias → R4-MAN-01/02
- Gestión de proyecto/sesión → R4-MAN-03/04
- Routing estricto slash vs texto libre → R4-MAN-05/06
- Concurrencia y continuidad (`running` / `needs-attention`) → R4-MAN-07/08
- Cancel soportado/no soportado → R4-MAN-09
- UX de errores accionables → R4-MAN-10
- Sender robusto (sanitización/fallback/chunking) → R4-MAN-11
- Compatibilidad y rollback → R4-COMP-01/02/03 + R4-ROLL-01

---

## 8) Resumen PASS/FAIL y decisión de cierre

### Estado actual de esta corrida

- [x] 🟡 **Parcialmente cerrado** (seguimos con otros RFC)
- [ ] 🟢 Cerrado para verify final

- **PASS:** ____
- **FAIL:** ____
- **N/A:** ____
- **Bloqueantes encontrados:** Sí / No
- **¿Aprobado para verify?** Sí / No

### Observaciones generales

```text

```

---

## 9) Cierre operativo

1. Guardar evidencia (capturas de chat + fragmentos de logs) por ID de caso.
2. Actualizar/adjuntar `docs/rfc4-e2e-regression-checklist.md` con estado final de regresión.
3. Detener runtime local:

```bash
npm run stop:local
```
