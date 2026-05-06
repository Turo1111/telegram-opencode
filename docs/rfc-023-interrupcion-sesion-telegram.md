# RFC-023 — Interrupción de sesión desde Telegram

**Estado:** Borrador
**Autor:** —
**Fecha:** 6 de Mayo de 2026

## 1. Problema

El usuario necesita interrumpir una tarea en ejecución desde Telegram sin tener que ir a la terminal local.

## 2. Contexto actual

- `/cancel` / `/c` existe en router.ts, resuelve a `useCases.cancelSession()`.
- `cancelSession()` llama al adapter → `cancelOrInterrupt()`.
- `formatCancelSuccess`, `formatCancelUnsupported`, `formatCancelNoActiveTask` existen en templates.
- Ya hay manejo de estados: `task-running`, `session-linked`, `idle`.

## 3. Lo que falta / definir

- [ ] ¿CancelNotification/Interrupcion forzada realmente funciona end-to-end en PTY?
- [ ] ¿En HTTP adapter está implementado `cancelOrInterrupt`?
- [ ] ¿Qué pasa si la tarea ignora la interrupción? Timeout?
- [ ] ¿Confirmación antes de cancelar? (hoy va directo)
- [ ] Feedback post-cancelación: ¿el bot informa que la tarea se canceló realmente o solo que envió la señal?
- [ ] ¿Posibilidad de `/force-cancel` para tareas colgadas?
- [ ] ¿Botón inline "Cancelar" cuando hay una tarea running? (hoy solo responde a texto `/cancel`)

## 4. Preguntas abiertas

- ¿Debe pedir confirmación? ("¿Estás seguro de cancelar la tarea X?")
- ¿Notificar cuando la cancelación se complete realmente (async vs sync)?
- ¿Soporte para cancelación en todos los adapters (HTTP, CLI, PTY)?
