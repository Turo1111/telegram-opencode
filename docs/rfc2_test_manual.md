# RFC2 + RFC3 — Checklist manual incremental (Telegram + OpenCode mock)

> Objetivo: usar evidencia manual **solo como contingencia/smoke** para la convivencia RFC2/RFC3 en Telegram.
>
> Camino normal de verificación: `npm run verify:rfc2` (one-command, automatizado).  
> Cobertura baseline opcional: `npm run verify:rfc2:coverage` (opt-in, no bloqueante).

---

## Datos de ejecución

- **Fecha:** ____ / ____ / ______
- **Tester:** ______________________
- **Branch/Commit:** ______________________
- **Entorno:** local / otro: ______________________
- **OPEN_CODE_URL:** ______________________
- **STATE_DRIVER:** sqlite / json
- **COMPAT_LEGACY_TEXT_BRIDGE inicial:** true / false

---

## Preparación

1) Verificar token/URL en `.env` (usar el mock local por defecto).

2) Arrancar stack local:

```bash
npm run stop:local
npm run start:local
```

3) Confirmar que el mock inició y anuncia endpoints de sesión:

```text
OpenCode mock running on http://localhost:3000 (... sessions: create/attach/message/command/state/cancel/observe ...)
```

> Si querés comparar bridge ON vs OFF, reiniciá con `npm run stop:local` + `npm run start:local` después de editar `.env`.

---

## Política de uso de este checklist (fallback)

- Este documento **no reemplaza** el flujo principal automatizado.
- Usar este checklist solo cuando:
  - no se puede ejecutar `npm run verify:rfc2` por restricciones del entorno local, o
  - se necesita smoke UX contra Telegram real para diagnóstico puntual.
- Si la automatización está disponible, la evidencia requerida para verify debe salir del harness (`verify:rfc2`).

---

## Criterios rápidos de aceptación

- `/project` selecciona proyecto y limpia sesión activa previa.
- `/new` crea sesión vinculada al proyecto activo.
- `/run` ejecuta `runCommand` (ruta distinta de texto libre).
- Texto libre con sesión activa usa `sendMessage`.
- `/status` refleja modo/proyecto/sesión/tarea coherentes.
- Con `COMPAT_LEGACY_TEXT_BRIDGE=true`:
  - Si hay sesión activa, **NO** usa legacy bridge (prioriza session-adapter).
  - Si NO hay sesión activa, puede usar fallback legacy para texto libre.
- Con `COMPAT_LEGACY_TEXT_BRIDGE=false`, nunca usa el bridge legacy.

---

## Casos de prueba

> Estado: `PASS` / `FAIL` / `N/A`

### T01 — Estado inicial sin contexto

- **Pasos:** En chat limpio enviar `/status`.
- **Esperado:**
  - `Modo: idle`
  - `Proyecto: sin seleccionar`
  - `Sesión: sin vincular`
  - guía para `/project`
- **Resultado real:**

```text

```

- **Estado:** [ ] PASS  [ ] FAIL  [ ] N/A
- **Notas/Evidencia:**

```text

```

### T02 — Selección de proyecto

- **Pasos:** `/project demo-rfc3`
- **Esperado:** confirma proyecto activo y sugiere `/session` o `/new`.
- **Resultado real:**

```text

```

- **Estado:** [ ] PASS  [ ] FAIL  [ ] N/A
- **Notas/Evidencia:**

```text

```

### T03 — Crear sesión con `/new`

- **Pasos:** `/new`
- **Esperado:** `Nueva sesión creada ✅` con `projectId` + `sessionId`.
- **Resultado real:**

```text

```

- **Estado:** [ ] PASS  [ ] FAIL  [ ] N/A
- **Notas/Evidencia:**

```text

```

### T04 — Status luego de crear sesión

- **Pasos:** `/status`
- **Esperado:**
  - `Modo: session-linked` (o estado operativo equivalente)
  - muestra proyecto y sesión actuales.
- **Resultado real:**

```text

```

- **Estado:** [ ] PASS  [ ] FAIL  [ ] N/A
- **Notas/Evidencia:**

```text

```

### T05 — `/run` sobre sesión activa

- **Pasos:** `/run npm test` (o `/cmd npm test`).
- **Esperado:**
  - responde éxito de comando,
  - si devuelve `taskId`, queda visible en `/status` como tarea activa.
- **Resultado real:**

```text

```

- **Estado:** [ ] PASS  [ ] FAIL  [ ] N/A
- **Notas/Evidencia:**

```text

```

### T06 — Texto libre con sesión activa

- **Pasos:** enviar mensaje no comando (ej. `hola equipo`).
- **Esperado:** usa ruta de sesión (`sendMessage`), devuelve respuesta de sesión; no pide reconfigurar proyecto/sesión.
- **Resultado real:**

```text

```

- **Estado:** [ ] PASS  [ ] FAIL  [ ] N/A
- **Notas/Evidencia:**

```text

```

### T07 — Guard de tarea activa (si aplica)

- **Pasos:** disparar tarea running y enviar otra orden enseguida.
- **Esperado:** bloqueo con mensaje de `tarea en curso` (sin duplicar envío).
- **Resultado real:**

```text

```

- **Estado:** [ ] PASS  [ ] FAIL  [ ] N/A
- **Notas/Evidencia:**

```text

```

### T08 — Coexistencia legacy ON (sesión activa)

- **Precondición:** `COMPAT_LEGACY_TEXT_BRIDGE=true`, sesión activa ya creada.
- **Pasos:** enviar texto libre.
- **Esperado:** prioridad session-adapter; NO usar `/opencode/query` legacy.
- **Cómo verificar:** revisar logs del bot/mock; no debe verse hit legacy para este mensaje.
- **Resultado real:**

```text

```

- **Estado:** [ ] PASS  [ ] FAIL  [ ] N/A
- **Notas/Evidencia:**

```text

```

### T09 — Coexistencia legacy ON (sin sesión activa)

- **Precondición:** `COMPAT_LEGACY_TEXT_BRIDGE=true`, chat sin sesión activa.
- **Pasos:** enviar texto libre.
- **Esperado:** fallback explícito por legacy bridge (`/opencode/query`) permitido en este contexto.
- **Resultado real:**

```text

```

- **Estado:** [ ] PASS  [ ] FAIL  [ ] N/A
- **Notas/Evidencia:**

```text

```

### T10 — Legacy OFF

- **Precondición:** editar `.env` con `COMPAT_LEGACY_TEXT_BRIDGE=false` y reiniciar (`stop:local` + `start:local`).
- **Pasos:** repetir texto libre con y sin sesión activa.
- **Esperado:** nunca invoca endpoint legacy; todo pasa por router/session-adapter o guía de contexto.
- **Resultado real:**

```text

```

- **Estado:** [ ] PASS  [ ] FAIL  [ ] N/A
- **Notas/Evidencia:**

```text

```

### T11 — Rehidratación post restart

- **Pasos:** con sesión activa, ejecutar `npm run stop:local` + `npm run start:local`, luego `/status`.
- **Esperado:** mantiene continuidad coherente o cae a estado seguro (`error`) sin binding corrupto.
- **Resultado real:**

```text

```

- **Estado:** [ ] PASS  [ ] FAIL  [ ] N/A
- **Notas/Evidencia:**

```text

```

### T12 — UX de errores RFC3

- **Pasos:** forzar o reproducir errores representativos (`TIMEOUT`, `UNAVAILABLE`, `SESSION_PROJECT_MISMATCH`, `UNSUPPORTED`).
- **Esperado:** mensajes en español y accionables (retry/cambio de proyecto, etc.).
- **Resultado real:**

```text

```

### T13 — Determinismo de fixtures del mock (SCN-LOM-001, fallback diagnóstico)

- **Nota:** el criterio principal de SCN-LOM-001 se valida automáticamente en `npm run verify:rfc2`. Este caso manual queda para contingencia/debug.

- **Precondición:** mock local corriendo (`npm run mock` o `npm run start:local`).
- **Pasos:** ejecutar cada fixture 2 veces contra el mismo endpoint y comparar `status/code`.

```bash
curl -s -i -H "Authorization: Bearer dev-token" -H "Content-Type: application/json" \
  -d '{"projectId":"proj-det","rootPath":"/tmp/proj-det","fixture":"UNSUPPORTED"}' \
  http://localhost:3000/opencode/sessions/create

curl -s -i -H "Authorization: Bearer dev-token" -H "Content-Type: application/json" \
  -d '{"projectId":"proj-det","rootPath":"/tmp/proj-det","fixture":"UNSUPPORTED"}' \
  http://localhost:3000/opencode/sessions/create

curl -s -i -H "Authorization: Bearer dev-token" -H "Content-Type: application/json" \
  -d '{"projectId":"proj-det","rootPath":"/tmp/proj-det","fixture":"TIMEOUT"}' \
  http://localhost:3000/opencode/sessions/create

curl -s -i -H "Authorization: Bearer dev-token" -H "Content-Type: application/json" \
  -d '{"projectId":"proj-det","rootPath":"/tmp/proj-det","fixture":"TIMEOUT"}' \
  http://localhost:3000/opencode/sessions/create

curl -s -i -H "Authorization: Bearer dev-token" -H "Content-Type: application/json" \
  -d '{"projectId":"proj-det","rootPath":"/tmp/proj-det","fixture":"UNAVAILABLE"}' \
  http://localhost:3000/opencode/sessions/create

curl -s -i -H "Authorization: Bearer dev-token" -H "Content-Type: application/json" \
  -d '{"projectId":"proj-det","rootPath":"/tmp/proj-det","fixture":"UNAVAILABLE"}' \
  http://localhost:3000/opencode/sessions/create
```

- **Esperado:**
  - `UNSUPPORTED` => `501` + `code=UNSUPPORTED` (estable en ambas llamadas)
  - `TIMEOUT` => `504` + `code=TIMEOUT` (estable en ambas llamadas)
  - `UNAVAILABLE` => `503` + `code=UNAVAILABLE` (estable en ambas llamadas)
- **Resultado real:**

```text

```

- **Estado:** [ ] PASS  [ ] FAIL  [ ] N/A
- **Notas/Evidencia:**

```text

```

- **Estado:** [ ] PASS  [ ] FAIL  [ ] N/A
- **Notas/Evidencia:**

```text

```

---

## Matriz corta de cobertura (spec ↔ evidencia)

- **SCN-TSCE-001 (routing split):** T05 + T06
- **SCN-SLM-002 (coexistencia legacy):** T08 + T09 + T10
- **SCN-ORSA-002 (create project missing):** harness `R9S1`
- **SCN-ORSA-009 (state unknown mapping):** harness `R9S2`
- **SCN-ORSA-011 (cancel unsupported):** harness `R9S3`
- **SCN-SLM-001 (gate parity running/needs-attention):** harness `R9S4`
- **SCN-LOM-001 (mock fixtures determinísticos):** `npm run verify:rfc2` (principal) + T13 (fallback)

---

## Resultado final de la corrida

- **Cantidad PASS:** ____
- **Cantidad FAIL:** ____
- **Cantidad N/A:** ____
- **¿Aprobado para siguiente fase verify?** Sí / No

### Observaciones generales

________________________________________________________________________________

________________________________________________________________________________

________________________________________________________________________________

---

## Cierre

```bash
npm run stop:local
```
