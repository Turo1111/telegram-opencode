# RFC-009 — Checklist de verificación (seguridad/autorización)

> Objetivo: dejar evidencia reproducible para RFC-009 (allowlist fail-fast, gate de autorización Telegram, contrato webhook 401/403/404/409 y anti-replay por terminal/restart).

---

## 1) Corrida ejecutada en esta fase

- **Fecha:** 2026-04-17
- **Scope:** Apply fase 6 (6.1, 6.2, 6.3)
- **Comandos ejecutados:**

```bash
npx tsc --noEmit
npm run verify:rfc9
```

### Resultado `npx tsc --noEmit`

- [x] PASS (exit code 0)
- Evidencia: sin errores de tipado en salida.

### Resultado `npm run verify:rfc9`

- [x] PASS (10/10 escenarios)
- Evidencia (resumen):

```text
RFC-009 Security/Auth Verification

| ID | Scenario | Result |
|---|---|---|
| CFG-01 | Config fail-fast without ALLOWED_USER_ID | PASS |
| CFG-02 | Config fail-fast on placeholder allowlist | PASS |
| ING-01 | Unauthorized message+callback are silently dropped | PASS |
| ING-02 | Authorized message+callback preserve ingress behavior | PASS |
| WEB-01 | Webhook missing/malformed auth | PASS |
| WEB-02 | Webhook invalid token | PASS |
| WEB-03 | Webhook unknown session | PASS |
| WEB-04 | Webhook stale binding race | PASS |
| REPLAY-01 | Replay with old token after terminal event | PASS |
| REPLAY-02 | Replay with old token after restart | PASS |

Resumen: 10/10 escenarios PASS.
```

---

## 2) Checklist manual-first (repo style)

Estado por ítem:

- [x] PASS
- [ ] FAIL
- [ ] N/A

### R9-MAN-01 — Boot fail-fast de allowlist

- Verifica que sin `ALLOWED_USER_ID` el arranque falle antes del polling.
- Evidencia: escenario `CFG-01` del harness `verify:rfc9` en PASS.

**Estado:** [x] PASS  [ ] FAIL  [ ] N/A

### R9-MAN-02 — Rechazo de placeholder/valor inválido

- Verifica que `replace_me` u otros inválidos no se aceptan.
- Evidencia: escenario `CFG-02` en PASS.

**Estado:** [x] PASS  [ ] FAIL  [ ] N/A

### R9-MAN-03 — Telegram unauthorized silent-drop (message + callback)

- Esperado: sin handler, sin lock, sin `sendMessage`, sin `answerCallbackQuery`.
- Evidencia: escenario `ING-01` en PASS.

**Estado:** [x] PASS  [ ] FAIL  [ ] N/A

### R9-MAN-04 — Telegram authorized mantiene flujo

- Esperado: handlers ejecutan y lock se adquiere para ambos update types.
- Evidencia: escenario `ING-02` en PASS.

**Estado:** [x] PASS  [ ] FAIL  [ ] N/A

### R9-MAN-05 — Contrato webhook auth/status

- Esperado:
  - header faltante/malformado => 401
  - token inválido => 403
  - sesión desconocida => 404
  - stale binding => 409
- Evidencia: `WEB-01..WEB-04` en PASS.

**Estado:** [x] PASS  [ ] FAIL  [ ] N/A

### R9-MAN-06 — Anti-replay tras terminal/restart

- Esperado:
  - terminal: primer evento 202, replay con token viejo 403
  - restart: invalidación de token y replay 403
- Evidencia: `REPLAY-01` y `REPLAY-02` en PASS.

**Estado:** [x] PASS  [ ] FAIL  [ ] N/A

### R9-MAN-07 — Ejecución con Telegram real (operacional)

- Flujo sugerido para operador:

```bash
npm run stop:local
npm run start:local
```

- Con dos cuentas (autorizada/no autorizada):
  1. cuenta no autorizada envía mensaje y callback => bot no responde;
  2. cuenta autorizada ejecuta `/status`/flujo normal => responde correctamente.

> Nota: esta corrida depende de credenciales reales (`TELEGRAM_BOT_TOKEN`) y dos actores Telegram. En esta fase se dejó validada la cobertura automatizada determinística (`verify:rfc9`) y el procedimiento operativo para ejecutar la prueba humana en entorno local.

**Estado:** [ ] PASS  [ ] FAIL  [x] N/A

---

## 3) Criterio de aprobación RFC9 (fase 6)

Se considera cumplida la fase 6 cuando:

- [x] existe harness dedicado `src/verification/rfc9-security-auth.ts`;
- [x] existe script `npm run verify:rfc9`;
- [x] `npx tsc --noEmit` pasa;
- [x] `npm run verify:rfc9` pasa (10/10);
- [x] documentación/checklist en `docs/` actualizada.

---

## 4) Cierre operativo

Si corriste runtime local durante validación manual:

```bash
npm run stop:local
```
