# Manual de test manual del proyecto (post-RFCs)

> Objetivo: validar de punta a punta el estado funcional del proyecto tras RFC2, RFC5, RFC6, RFC7, RFC8 y RFC9 con una combinación de checks automatizados y validación manual en Telegram.

---

## 1) Prerrequisitos y setup de entorno

- Node.js y npm instalados.
- Dependencias instaladas:

```bash
npm install
```

- Variables de entorno configuradas (`.env`), mínimo:
  - `TELEGRAM_BOT_TOKEN`
  - `OPEN_CODE_URL`
  - `OPEN_CODE_TOKEN`
  - `ALLOWED_USER_ID`
- Para pruebas de seguridad/manual con autorización:
  - Tener **una cuenta Telegram autorizada** (en allowlist) y **otra no autorizada**.

---

## 2) Secuencia exacta de comandos (operación local)

> Ejecutar en este orden para evitar procesos huérfanos y asegurar estado limpio.

```bash
npm run stop:local
npm run start:local
```

Al finalizar pruebas manuales:

```bash
npm run stop:local
```

---

## 3) Checklist de verificación automatizada

### 3.1 Comandos requeridos

```bash
npx tsc --noEmit
npm run verify:rfc2
npm run verify:rfc5
npm run verify:rfc6
npm run verify:rfc7
npm run verify:rfc8
npm run verify:rfc9
```

### 3.2 Criterio de aceptación automatizado

- Todos los comandos deben devolver exit code `0`.
- Cada harness RFC debe finalizar con todos los escenarios en `PASS`.

---

## 4) Checklist manual Telegram (flujo operativo)

Estado por ítem:

- [ ] PASS
- [ ] FAIL
- [ ] N/A

### M01 — Cuenta no autorizada (silent drop)

- Enviar mensaje desde cuenta no autorizada.
- Enviar callback query desde interacción previa (si aplica).
- Esperado:
  - el bot no responde en chat;
  - no ejecuta handlers operativos para ese actor.

**Estado:** [ ] PASS  [ ] FAIL  [ ] N/A

### M02 — Cuenta autorizada (flujo normal)

- Desde cuenta autorizada ejecutar:
  - `/status`
  - `/project <id>`
  - `/new`
  - texto libre
- Esperado: flujo normal habilitado, con respuestas coherentes en español.

**Estado:** [ ] PASS  [ ] FAIL  [ ] N/A

### M03 — Gate de busy/needs-attention

- Con tarea en ejecución, probar comando mutante adicional y texto libre.
- Esperado:
  - se bloquean acciones no permitidas durante busy;
  - se mantiene la política definida para needs-attention.

**Estado:** [ ] PASS  [ ] FAIL  [ ] N/A

---

## 5) Checks de seguridad

### S01 — Silent drop de actor no autorizado

- Validar que updates no autorizados se descartan silenciosamente.
- Referencia automatizada: `verify:rfc9` (ING-01, ING-03).

**Estado:** [ ] PASS  [ ] FAIL  [ ] N/A

### S02 — Contrato de auth del webhook

- Validar respuestas HTTP esperadas:
  - header faltante/malformado => `401`
  - token inválido => `403`
  - sesión desconocida => `404`
  - stale binding => `409`
- Referencia automatizada: `verify:rfc9` (WEB-01..WEB-04).

**Estado:** [ ] PASS  [ ] FAIL  [ ] N/A

---

## 6) Checks de recovery/restart

### R01 — Reinicio controlado

```bash
npm run stop:local
npm run start:local
```

- Esperado: arranque limpio, sin lockfile huérfano, y bot operativo.

**Estado:** [ ] PASS  [ ] FAIL  [ ] N/A

### R02 — Reconciliación post-restart

- Con sesión previa activa, reiniciar y consultar `/status`.
- Esperado: continuidad consistente o degradación segura según política.
- Referencias automatizadas: `verify:rfc5`, `verify:rfc6`, `verify:rfc7`, `verify:rfc9`.

**Estado:** [ ] PASS  [ ] FAIL  [ ] N/A

---

## 7) Estado actual verificado

> Corrida ejecutada en esta sesión: 2026-04-17

| Comando | Resultado | Evidencia breve |
|---|---|---|
| `npx tsc --noEmit` | PASS | Sin errores de tipado (exit 0). |
| `npm run verify:rfc2` | **FAIL** | `18/20 passed`; fallan `R4S2` (rehidratación inconsistente) y `R7S1` (coexistencia legacy/router con sesión activa). |
| `npm run verify:rfc5` | PASS | `12/12 escenarios PASS`. |
| `npm run verify:rfc6` | PASS | Concurrency + policy + recovery en PASS (`3/3`, `6/6`, recovery PASS). |
| `npm run verify:rfc7` | PASS | `9/9 escenarios PASS`. |
| `npm run verify:rfc8` | PASS | `7/7 escenarios PASS`. |
| `npm run verify:rfc9` | PASS | `14/14 escenarios PASS`. |

Conclusión de esta corrida: **no** se puede declarar “totalmente funcional” de forma estricta mientras `verify:rfc2` siga fallando (2 escenarios críticos de regresión funcional).

---

## 8) Plantilla de resultados PASS/FAIL (para próximas corridas)

### Resumen ejecutivo

- Fecha:
- Tester:
- Branch/commit:
- ¿Aprobado global?: Sí / No

### Tabla de resultados

| Área | Caso | Esperado | Resultado real | Estado (PASS/FAIL/N/A) | Evidencia |
|---|---|---|---|---|---|
| Automatizado | `npx tsc --noEmit` | Sin errores TS |  |  |  |
| Automatizado | `verify:rfc2` | Todos PASS |  |  |  |
| Automatizado | `verify:rfc5` | Todos PASS |  |  |  |
| Automatizado | `verify:rfc6` | Todos PASS |  |  |  |
| Automatizado | `verify:rfc7` | Todos PASS |  |  |  |
| Automatizado | `verify:rfc8` | Todos PASS |  |  |  |
| Automatizado | `verify:rfc9` | Todos PASS |  |  |  |
| Manual Telegram | No autorizado silent drop | Sin respuesta operativa |  |  |  |
| Manual Telegram | Autorizado flujo normal | Respuestas correctas |  |  |  |
| Seguridad | Webhook 401/403/404/409 | Contrato correcto |  |  |  |
| Recovery | Restart + reconciliación | Continuidad/degradación segura |  |  |  |
