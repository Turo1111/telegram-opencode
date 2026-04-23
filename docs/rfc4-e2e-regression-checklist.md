# RFC-004 — Checklist manual E2E de regresión (Telegram Control Remoto)

> Objetivo: validar que la UX RFC-004 no rompe el flujo base y cumple los criterios de aceptación operativos.

---

## 1) Datos de corrida

- **Fecha:** 2026-04-15
- **Tester:** AI apply (evidence-only local)
- **Branch/Commit:** N/A (workspace sin git en este entorno)
- **Entorno:** local (sin interacción Telegram disponible)
- **COMPAT_LEGACY_TEXT_BRIDGE:** no modificado en esta corrida
- **COMPAT_RUN_CMD_COMMANDS:** no modificado en esta corrida

### Evidencia local ejecutada (sí disponible)

- ✅ `npx tsc --noEmit` ejecutado (exit code 0).
- ✅ `npm run stop:local` ejecutado (salida: `Se detuvieron procesos locales huérfanos.`).
- ✅ `npm run start:local` + `npm run stop:local` ejecutado en ventana corta (salida: `Instancia local detenida.`).
- ✅ Corrección operativa mínima aplicada en `start-local.js` para tolerar doble limpieza de `.local-runtime.json` (evita crash `ENOENT` observado durante evidencia).

### Limitación de entorno

- ⚠️ **BLOCKED**: no hay interacción real con Telegram desde este entorno, por lo que los casos E2E de chat quedan pendientes de ejecución por operador humano.

---

## 2) Preparación

1. Verificar `.env` (token de Telegram, URL/token de OpenCode).
2. Arrancar runtime local:

```bash
npm run stop:local
npm run start:local
```

3. Confirmar bot y mock arriba (logs sin crash inicial).
4. Asegurar que el workaround IPv4 en `src/index.ts` NO se tocó.

---

## 3) Smoke de regresión (flujo base)

### R4-BASE-01 — Texto libre con sesión activa (no degradación)

- **Precondición:** proyecto + sesión activos (`/project`, `/new` o `/session`).
- **Pasos:** enviar texto libre corto (ej: `hola, estado actual`).
- **Esperado:** respuesta exitosa por ruta de sesión (`sendMessage`) con tono conciso.
- **Estado:** [ ] PASS  [ ] FAIL  [x] N/A (BLOCKED: requiere chat real de Telegram)
- **Evidencia:**

```text

```

### R4-BASE-02 — Texto libre sin contexto

- **Precondición:** chat sin proyecto/sesión.
- **Pasos:** enviar texto libre.
- **Esperado (strict):** bloqueo con guía de contexto (`/project`, `/session`, `/new`).
- **Esperado (bridge):** puede usar bridge legacy si `COMPAT_LEGACY_TEXT_BRIDGE=true`.
- **Estado:** [ ] PASS  [ ] FAIL  [x] N/A (BLOCKED: requiere chat real de Telegram)

---

## 4) Criterios RFC-004 (aceptación)

### R4-AC-01 — Equivalencia de alias

Validar pares canónico/alias:

- `/help` == `/start`
- `/status` == `/st`
- `/project` == `/p`
- `/session` == `/s`
- `/new` == `/n`
- `/cancel` == `/c`

Para cada par:
- **Esperado:** mismo caso de uso y misma semántica de respuesta.
- **Estado:** [ ] PASS  [ ] FAIL  [x] N/A (BLOCKED: requiere chat real de Telegram)
- **Evidencia:**

```text

```

### R4-AC-02 — Slash vs texto libre

- **Pasos:**
  1. Enviar `/help` sin contexto.
  2. Enviar texto libre sin contexto.
  3. Con estado `task-running`, enviar texto libre.
  4. Con estado `needs-attention`, enviar texto libre.
- **Esperado:**
  - comando slash siempre se procesa como comando;
  - texto libre sin contexto se rechaza (o bridge si flag ON);
  - `task-running` rechaza por concurrencia;
  - `needs-attention` acepta continuación.
- **Estado:** [ ] PASS  [ ] FAIL  [x] N/A (BLOCKED: requiere chat real de Telegram)

### R4-AC-03 — `/cancel` soportado vs no soportado

- **Pasos:**
  1. Backend con `cancelOrInterrupt` soportado: enviar `/cancel`.
  2. Backend sin soporte: enviar `/cancel`.
- **Esperado:**
  - soportado: confirmación de cancelación solicitada/ejecutada;
  - no soportado: mensaje explícito + siguientes pasos.
- **Estado:** [ ] PASS  [ ] FAIL  [x] N/A (BLOCKED: requiere chat real de Telegram)

### R4-AC-04 — UX semántica + línea de contexto

- **Pasos:** ejecutar `/status`, `/project`, `/session`, `/new`.
- **Esperado:** encabezado semántico (emoji severidad) + línea `📁 ... • 🔌 ...`.
- **Estado:** [ ] PASS  [ ] FAIL  [x] N/A (BLOCKED: requiere chat real de Telegram)

### R4-AC-05 — Errores diferenciados y accionables

- **Pasos:** forzar escenarios (timeout/unavailable/mismatch/concurrencia/sin contexto).
- **Esperado:** mensajes distintos por categoría, con acción sugerida.
- **Estado:** [ ] PASS  [ ] FAIL  [x] N/A (BLOCKED: requiere chat real de Telegram)

---

## 5) Sender seguro y límite de 4096

### R4-SND-01 — Sanitización HTML

- **Pasos:** enviar/forzar respuesta con caracteres `< > & " '` y bloques multilinea.
- **Esperado:** render estable sin romper envío.
- **Estado:** [ ] PASS  [ ] FAIL  [x] N/A (BLOCKED: requiere chat real de Telegram)

### R4-SND-02 — Fallback de parse mode

- **Pasos:** provocar error de parseo (contenido conflictivo).
- **Esperado:** el sender reintenta en texto plano automáticamente.
- **Evidencia en logs:** evento `Telegram sender parse-mode fallback`.
- **Estado:** [ ] PASS  [ ] FAIL  [x] N/A (BLOCKED: requiere chat real de Telegram)

### R4-SND-03 — Política >4096 chars

- **Pasos:** generar respuesta larga (>4096).
- **Esperado:** chunking con cabecera `(n/m)` y orden correcto.
- **Estado:** [ ] PASS  [ ] FAIL  [x] N/A (BLOCKED: requiere chat real de Telegram)

---

## 6) Matriz rápida (spec → evidencia)

- Alias equivalence → R4-AC-01
- Unknown slash command → R4-AC-01 (comando inválido + catálogo)
- Strict routing gates → R4-AC-02
- Needs-attention confirmation path → R4-AC-02
- Cancel supported/unsupported → R4-AC-03
- Semantic UX response standard → R4-AC-04
- Error UX consistency → R4-AC-05
- HTML fallback + chunking → R4-SND-01/02/03

---

## 7) Cierre

- **PASS:** 0
- **FAIL:** 0
- **N/A:** 10 (BLOCKED por falta de interacción Telegram en este entorno)
- **¿Aprobado para verify?** No (pendiente ejecución manual por operador)

Observaciones:

```text
Pendientes externos obligatorios:
- Ejecutar todos los casos R4-BASE-01/02, R4-AC-01..05 y R4-SND-01..03 en chat real.
- Adjuntar snippets de conversación y/o logs por caso.
```

```bash
npm run stop:local
```
