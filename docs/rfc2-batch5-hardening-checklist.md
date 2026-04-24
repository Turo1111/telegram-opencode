# RFC2 Batch 5 — Compatibility + Hardening Checklist

Este checklist documenta la capa final de compatibilidad/hardening pedida para RFC2.

## 1) Compatibilidad legacy por flag

- [x] `COMPAT_LEGACY_TEXT_BRIDGE=true` mantiene puente legacy **solo** para texto libre.
- [x] Comandos (`/project`, `/session`, `/new`, `/status`) siempre pasan por router RFC2.
- [x] Fallback legacy habilitado únicamente cuando estado operativo es:
  - `mode=session-linked`
  - `projectId` presente
  - `sessionId` presente
- [x] Si el bridge legacy falla, se hace fallback seguro al router RFC2 (sin romper flujo).

## 2) Soporte mock RFC2 sesión/proyecto

- [x] Se preserva endpoint legacy `POST /opencode/query`.
- [x] Se agregan endpoints RFC2:
  - `POST /opencode/projects/resolve`
  - `POST /opencode/sessions/create`
  - `POST /opencode/sessions/attach`
  - `POST /opencode/sessions/message`
  - `POST /opencode/sessions/command`
  - `POST /opencode/sessions/state`
- [x] Mock simula mismatches/errores controlados:
  - `SESSION_NOT_FOUND` (404)
  - `SESSION_PROJECT_MISMATCH` (409)
  - `VALIDATION_ERROR` (400)

## 3) Safety checks de integración (evidencia automatizada)

Ejecución determinística sin build (2026-04-14):

1. `npx tsc --noEmit` ✅
2. `npm run verify:rfc2` ✅

Flujo de verificación vigente para hardening RFC3:

- ✅ `npm run verify:rfc2` es el comando principal one-command (incluye SCN-LOM-001 en el summary final).
- ✅ `npm run verify:rfc2:coverage` es baseline opt-in (genera `text-summary` + `lcov`) y **no** aplica thresholds bloqueantes.

Cobertura del harness `src/verification/rfc2-harness.ts`:

- ✅ R1S1 selección válida de proyecto
- ✅ R1S2 no filtrar `rootPath`
- ✅ R2S1 attach sesión existente
- ✅ R2S2 precondición sin proyecto activo
- ✅ R3S1 guard de tarea activa bloquea segunda orden y evita llamada upstream
- ✅ R4S1 rehidratación exitosa
- ✅ R4S2 rehidratación inconsistente (`mode=error` + cleanup seguro)
- ✅ R5S1 timeout + retry corto único + mapeo `UPSTREAM_TIMEOUT`
- ✅ R5S2 mismatch sesión/proyecto sin corrupción de binding
- ✅ R6S1 `/status` completo
- ✅ R6S2 texto libre en idle y gate explícito por modo permitido
- ✅ R7S1 toggle `COMPAT_LEGACY_TEXT_BRIDGE` (legacy vs RFC2)
- ✅ SCN-LOM-001 determinismo fixtures (`UNSUPPORTED`, `TIMEOUT`, `UNAVAILABLE`) integrado en harness

Nota: se mantiene validación manual opcional con Telegram real solo para smoke UX/contingencia; la verificación requerida por SDD queda trazable y repetible con el harness automatizado.

## Riesgos y mitigaciones

- Riesgo: doble semántica temporal (legacy + RFC2) puede confundir pruebas.
  - Mitigación: gate explícito por modo + IDs + flag.
- Riesgo: mock no refleje 100% backend real.
  - Mitigación: mantener códigos de error contractuales (`SESSION_NOT_FOUND`, `SESSION_PROJECT_MISMATCH`, `VALIDATION_ERROR`) alineados a adapter.
