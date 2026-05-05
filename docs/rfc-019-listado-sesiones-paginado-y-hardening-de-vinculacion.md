# RFC-019 — Listado de sesiones paginado y hardening de vinculación manual

**Estado:** Implementado  
**Autor:** AI Architect  
**Fecha:** 4 de Mayo de 2026

## 1. Contexto

El flujo PTY usa `/project` + `/sesiones` + confirmación para vincular sesiones OpenCode a Telegram. En uso real aparecieron dos fricciones:

1. el usuario crea sesión nueva en OpenCode pero no siempre la ve en `/sesiones`;
2. intento manual con `/sesion <id>` falla porque el alias válido es `/session` o `/s`.

Además, cuando hay muchas sesiones, el listado completo en un solo mensaje degrada UX.

## 2. Problema

### 2.1 Descubribilidad y error de comando

- `/sesion` no está definido en alias de comandos.
- El usuario interpreta “no me dejó vincular manualmente”, aunque el comando correcto existe con otra sintaxis.

### 2.2 Escalabilidad de listado

- `/sesiones` mostraba lista larga sin paginación.
- El texto exponía metadatos extra (id/modelo/fecha) que no siempre aportan para selección rápida.

### 2.3 Causas operativas de “sesión no visible”

El sistema filtra por seguridad solo sesiones `MATCH` del proyecto activo. Por eso pueden quedar afuera:

1. sesiones sin `path` (`UNSAFE`);
2. sesiones con `path` no canonicalizable (`UNSAFE`);
3. sesiones de otro árbol de proyecto (`PROJECT_MISMATCH`);
4. propagación tardía en `opencode session list` justo después de crear.

## 3. Objetivo

Mejorar UX de selección de sesiones sin relajar seguridad de asociación por proyecto:

- listado de `/sesiones` con **máximo 5 ítems por página**;
- render de ítems con **solo título** (fallback: “Sin título”);
- navegación con botones inline de Telegram;
- documentar hardening de vinculación manual y causas de error observadas.

## 4. Alcance

### Entra en alcance

- paginación en `/sesiones`;
- cambio de presentación a “solo título”;
- navegación por callbacks de Telegram;
- preservación del flujo selección → confirmación → attach;
- actualización de verificación RFC-011 impactada por el cambio visual.

### Fuera de alcance

- relajar filtro de seguridad para incluir sesiones `UNSAFE` por defecto;
- crear nuevas sesiones desde backend CLI puro;
- cierre automático del RFC (queda pendiente changelog para cierre formal).

## 5. UX propuesta

### 5.1 Listado paginado

- `/sesiones` muestra 5 sesiones por página, orden ya entregado por inspección actual.
- Botones de sesión: texto = `title` (o `Sin título`).
- Fila de paginación:
  - `⬅️ Anterior` (si aplica)
  - `n/m`
  - `Siguiente ➡️` (si aplica)

### 5.2 Selección y confirmación

No cambia semántica de negocio:

1. usuario toca sesión;
2. bot pide confirmación;
3. confirmar ejecuta misma ruta de attach que `/session <id>`.

## 6. Diseño técnico

## 6.1 Router Telegram

Se incorpora callback específico para paginación (`sesspg:<page>`), además del callback existente de selección (`sess:<action>:<token>`).

Componentes principales:

- `paginateSessions(...)` con tamaño fijo 5;
- `buildProjectSessionsKeyboard(...)` para construir botones de sesión + pager;
- `handleSessionPaginationCallback(...)` para resolver proyecto activo, reconsultar sesiones seguras y renderizar página solicitada.

## 6.2 Templates

`formatProjectSessionLine(...)` pasa a renderizar exclusivamente título:

- con título: `• <title>`
- sin título: `• Sin título`

## 6.3 Compatibilidad y seguridad

- se mantiene validación por proyecto activo en confirmación;
- se mantiene exclusión de sesiones `UNSAFE` / `PROJECT_MISMATCH`;
- no se alteran contratos de `attachSession`.

## 7. Alternativas evaluadas

### A) Mantener listado completo sin paginar

**Pros:** implementación mínima.  
**Contras:** mala UX con muchos ítems; ruido y scroll excesivo.

### B) Paginación + título-only (decisión)

**Pros:** selección rápida, menor ruido, mejor legibilidad móvil.  
**Contras:** `sessionId` no visible en lista textual (sigue disponible implícitamente por token de callback).

### C) Mostrar también `sessionId` en botón

**Pros:** trazabilidad visual inmediata.  
**Contras:** botones más largos y menos legibles.

## 8. Riesgos y mitigaciones

- **Riesgo:** confusión por comando manual mal escrito (`/sesion`).  
  **Mitigación:** reforzar ayuda/uso con `/session` y `/s`.

- **Riesgo:** sesión recién creada no aparece por latencia de listado.  
  **Mitigación recomendada (futuro):** retry corto en lectura de sesiones antes de responder vacío.

- **Riesgo:** sesión válida queda oculta por path no canonicalizable.  
  **Mitigación recomendada (futuro):** normalización adicional WSL/Windows previa a canonicalización.

## 9. Criterios de aceptación

1. `/sesiones` nunca muestra más de 5 sesiones por página.
2. Cada ítem de lista y botón expone solo título (o “Sin título”).
3. Existe navegación entre páginas con callbacks inline.
4. Selección-confirmación sigue vinculando sesión por ruta estándar.
5. Verificación RFC-011 ajustada al nuevo render pasa en el escenario actualizado.

## 10. Implementación aplicada

Archivos modificados:

- `src/adapters/telegram/router.ts`
  - callbacks de paginación;
  - helpers de paginado;
  - keyboard paginado con 5 ítems.
- `src/adapters/telegram/templates.ts`
  - render de línea de sesión por título únicamente.
- `src/verification/rfc11-local-runtime-sessions.ts`
  - expectativas de texto ajustadas a título-only.

## 11. Plan de seguimiento

1. Añadir alias opcional `/sesion` (español) o mensaje de autocorrección al detectar typo frecuente.
2. Evaluar retry corto en `/sesiones` para reducir falsos vacíos post-creación.
3. Evaluar estrategia segura para exponer sesiones `UNSAFE` en bloque separado solo informativo.

## 12. Evidencia de cierre

- Decisión aplicada: alias explícito `/sesion` -> flujo `/sesiones` en router determinístico.
- Verificación ejecutable:
  - `npm run verify:rfc11`
  - `npm run verify:rfc19:closure`
  - `npm run verify:rfc19`
- Gate documental: `CHANGELOG.md` incluye token exacto `RFC-019` (requisito de cierre).
