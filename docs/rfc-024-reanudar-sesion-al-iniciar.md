# RFC-024 — Preguntar al iniciar si reanudar última sesión

**Estado:** Borrador
**Autor:** —
**Fecha:** 6 de Mayo de 2026

## 1. Problema

Cuando el bot se reinicia (crash, deploy, apagado manual), el `BootRecoveryService` reconcilia automáticamente las sesiones activas sin preguntar al usuario. El usuario puede querer decidir si retomar o no la última sesión.

## 2. Contexto actual

- `BootRecoveryService.reconcileAll()` ejecuta en cada arranque.
- Revisa bindings activos, consulta estado remoto, marca como `recovered` / `degraded` / `closed`.
- Envía notificaciones `SESSION_RESUMED`, `SESSION_CLOSED`, `DEGRADED` a Telegram.
- **No pregunta nada.** Todo es automático.

## 3. Lo que falta / definir

- [ ] Después de la reconciliación automática, si hay una sesión recuperable → preguntar.
- [ ] "🟢 Se encontró la sesión anterior en {proyecto}. ¿Querés reanudarla?"
- [ ] Botones inline: "Reanudar" / "No, empezar limpio" / "Ver estado"
- [ ] Si el usuario dice que no → limpiar binding, dejar en idle.
- [ ] Si el usuario no responde en N minutos → reanudar automáticamente (timeout).

## 4. Casos

| # | Escenario | Comportamiento |
|---|-----------|----------------|
| 1 | Sesión sigue activa en OpenCode | Preguntar si reanudar. Sí → session-linked. No → idle. |
| 2 | Sesión terminó mientras estaba offline | Informar: "La sesión X finalizó mientras no estaba." No preguntar. |
| 3 | Múltiples chats con bindings | Preguntar por cada chat que tenga sesión recuperable. |
| 4 | Usuario no responde en 5 min | Auto-reanudar (comportamiento actual = safe default). |
| 5 | Sin sesión previa | No preguntar. |

## 5. Preguntas abiertas

- ¿Persistir preferencia "no preguntar de nuevo"?
- ¿Solo preguntar si la sesión estaba `task-running` al momento del crash?
- ¿Emitir pregunta en el mismo chat donde estaba la sesión o en todos los chats autorizados?
- ¿Qué mensaje mostrar si hay tarea en progreso? ¿Preguntar si reanudar la tarea o solo la sesión?
