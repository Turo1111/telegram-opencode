# RFC-004 — Runbook operativo de rollback

> Alcance: mitigación rápida ante incidentes de UX/ruteo/sender introducidos por RFC-004.

## 1) Señales para activar rollback

Activar mitigación si aparece alguno de estos síntomas en producción/local:

- incremento de errores al enviar mensajes en Telegram (`parse/entities` o fallos recurrentes de entrega);
- usuarios reportan bloqueo inesperado de texto libre;
- `/run` o `/cmd` dejan de responder para usuarios que aún dependen de esos comandos;
- confusión operativa por UX nueva en incidentes.

## 2) Rollback inmediato por flags (sin tocar código)

Editar `.env` y aplicar:

```env
COMPAT_LEGACY_TEXT_BRIDGE=true
COMPAT_RUN_CMD_COMMANDS=true
```

Reiniciar runtime:

```bash
npm run stop:local
npm run start:local
```

### Efecto esperado

- `COMPAT_LEGACY_TEXT_BRIDGE=true`:
  - habilita puente legacy **solo para texto libre sin contexto** (sin sesión/proyecto activos);
  - si hay sesión activa, se mantiene prioridad del router/session-adapter RFC.
- `COMPAT_RUN_CMD_COMMANDS=true`:
  - re-habilita `/run` y `/cmd` como compatibilidad de transición;
  - mantiene aviso de deprecación, pero evita cortar operación.

## 3) Verificación rápida post-rollback

1. `/status` responde sin error.
2. Chat sin contexto + texto libre: comportamiento compatible (bridge permitido).
3. `/run <cmd>` y `/cmd <cmd>` vuelven a funcionar.
4. Texto libre con sesión activa sigue por `sendMessage` (sin regresión funcional).

Registrar evidencia mínima (capturas/logs) antes de cerrar incidente.

### Evidencia local aplicada en esta fase (2026-04-15)

- `npm run stop:local` → `Se detuvieron procesos locales huérfanos.`
- `npm run start:local` + `npm run stop:local` (ventana corta) → `Instancia local detenida.`
- Incidente detectado durante evidencia: cierre concurrente de runtime podía disparar `ENOENT` al borrar `.local-runtime.json` en `start-local.js`.
- Mitigación aplicada: cleanup tolerante a `ENOENT` en `cleanupRuntimeFile()`.

## 4) Fallback adicional de sender (si persisten fallos de formato)

Si aún hay errores de render en Telegram, usar mitigación temporal operativa:

- priorizar respuestas cortas y sin markup complejo desde origen;
- monitorear logs `Telegram sender parse-mode fallback` para confirmar que el fallback plano absorbe errores de parseo.

> Nota: en la versión actual el sender ya implementa fallback automático a plain text cuando Telegram rechaza `parse_mode=HTML`.

## 5) Restauración controlada (roll-forward)

Cuando el incidente esté estabilizado:

1. Mantener `COMPAT_LEGACY_TEXT_BRIDGE=true` unas horas para monitoreo.
2. Desactivar gradualmente en ambiente controlado:
   - primero `COMPAT_RUN_CMD_COMMANDS=false` (si usuarios ya migraron);
   - luego `COMPAT_LEGACY_TEXT_BRIDGE=false` para volver a modo estricto RFC-004.
3. Reiniciar con `npm run stop:local` + `npm run start:local` y repetir smoke corto.

## 6) Guardrails

- No modificar `src/index.ts` workaround IPv4 durante incidente.
- No ejecutar build para rollback operativo; usar solo lifecycle local estándar.
- Evitar refactors en caliente: priorizar flags y evidencia de comportamiento.
