# RFC-020 — Catálogo dinámico de agentes desde OpenCode

**Estado:** Propuesto
**Autor:** AI Architect
**Fecha:** 05 de Mayo de 2026

## 1. Contexto

Hoy `SUPPORTED_AGENTS` en `src/domain/entities.ts` es un objeto singleton hardcodeado con 4 valores fijos:

```ts
export const SUPPORTED_AGENTS = {
  BUILD: "build",
  PLAN: "plan",
  GENTLEMAN: "gentleman",
  SDD_ORCHESTRATOR: "sdd-orchestrator",
} as const;
```

Este catálogo se usa en:
- `listSupportedAgents()` — devuelve la lista para mostrar en `/agentes`.
- `isSupportedAgent()` — valida si un string es agente conocido.
- `setActiveAgent()` — rechaza agentes no reconocidos.
- `resolveEffectiveAgent()` — fallback a `BUILD` si no hay selección.
- Telegram `/agentes` — renderiza la lista con botones inline.

Cuando OpenCode agrega o cambia agentes (p.ej. `sdd-orchestrator-frontend-cheap`, `sdd-apply-frontend-cheap`, etc.), el bot queda desactualizado hasta que se deploye un cambio. Esto fuerza releases frecuentes y rompe la experiencia cuando un agente existe en OpenCode pero el bot lo rechaza como inválido.

## 2. Problema

Catálogo singleton de agentes genera:

1. **Drift**: agentes nuevos en OpenCode no aparecen hasta deploy manual del bot.
2. **Falsos inválidos**: usuario escribe agente legítimo de OpenCode desde Telegram → `🔴 Agente no válido`.
3. **Releases innecesarias**: cada cambio de catálogo requiere CI/CD en vez de ser reactivo.
4. **Inconsistencia con modelos**: `listModels()` ya sigue patrón dinámico (RFC-017) — agentes deberían hacer lo mismo.

## 3. Objetivo

Reemplazar `SUPPORTED_AGENTS` singleton por catálogo dinámico consultado a OpenCode, con caché local, fallback a lista hardcodeada y validación contra fuente real.

## 4. Alcance

### Entra en alcance

- Agregar `listAgents()` al contrato `OpenCodeSessionAdapter`.
- Endpoint HTTP `/opencode/agents` en backend OpenCode.
- Comando `opencode agents` en CLI.
- Implementación en los 3 adaptadores: HTTP, CLI, PTY.
- Caché de catálogo de agentes con TTL (similar a `ModelCatalogCache`).
- Fallback a lista hardcodeada cuando el catálogo no está disponible.
- Validación dinámica contra agentes disponibles.
- Mock endpoint para desarrollo local.
- Tests de verificación dinámica.

### Fuera de alcance

- Creación de agentes desde Telegram.
- Políticas de routing automático por tipo de prompt.
- Eliminación total del fallback hardcodeado (siempre debe existir como safety net).
- Cache persistente cross-session (solo TTL en memoria).

## 5. UX propuesta

Sin cambios en UX. Comandos existentes mantienen comportamiento:

- `/agentes` → lista agentes disponibles **dinámicos** desde OpenCode.
- `/agente <nombre>` → valida contra catálogo dinámico.
- `/agente` → muestra agente activo (sin cambios).

Mensajes evolucionan:

- éxito: `✅ Agente activo: sdd-orchestrator-frontend-cheap`
- inválido: `🔴 Agente no válido. Opciones: build, plan, gentleman, sdd-orchestrator, sdd-orchestrator-frontend-cheap, ...`
- catálogo degradado (en Telegram al ejecutar `/agentes`): `⚠️ Catálogo remoto no disponible. Usando lista por defecto. Opciones: build, plan, gentleman, sdd-orchestrator`
- catálogo degradado (en Telegram al hacer `/agente <nombre>`): `⚠️ Catálogo remoto no disponible. Usando lista por defecto. Si ves un error inesperado, reintentá.`
- consola (logger.warn): `[agent-catalog] Fallback triggered: {reason} - using FALLBACK_AGENTS`

## 6. Diseño técnico

### 6.1 Contrato — `OpenCodeSessionAdapter`

Agregar método opcional al adapter:

```ts
interface OpenCodeSessionAdapter {
  listAgents?(input: {
    projectId?: string;
    sessionId?: string;
    chatId: string;
  }): Promise<Result<AgentCatalogResult>>;
}

interface AgentCatalogItem {
  readonly id: string;
  readonly label?: string;
}

interface AgentCatalogResult {
  readonly ok: boolean;
  readonly agents: readonly AgentCatalogItem[];
  readonly fetchedAt: string;
  readonly degraded?: {
    readonly reason: "timeout" | "unavailable" | "unsupported" | "upstream";
    readonly usingCache: boolean;
  };
}
```

### 6.2 Implementación por adaptador

#### HTTP (`HttpOpenCodeSessionAdapter`)

```
POST /opencode/agents
Authorization: Bearer <token>
Content-Type: application/json

{ "projectId": "proj-a", "chatId": "12345" }

→ 200
{ "agents": [{ "id": "build" }, { "id": "plan" }, { "id": "gentleman" }, { "id": "sdd-orchestrator" }, { "id": "sdd-orchestrator-frontend-cheap" }] }
```

Cache: `Map<string, AgentCatalogCacheEntry>` con TTL 30s (mismo que models).

En fallo: devolver cached si existe y fresco; si no, `ok: false` + degraded.

#### CLI (`CliOpenCodeSessionAdapter`)

```
$ opencode agents
build
plan
gentleman
sdd-orchestrator
```

Parsea stdout línea por línea, cada línea es un `agentId`.

Cache: mismo TTL.

#### PTY (`PtyOpenCodeSessionAdapter`)

Delega a `opencode agents` CLI (mismo que CLI adapter).

Cache: mismo TTL con prefijo de clave `pty:`.

### 6.3 Capa de aplicación — `use-cases.ts`

Reemplazar `listSupportedAgents()` con notificación explícita:

```ts
async listSupportedAgents(chatId: string): Promise<{
  agents: readonly string[];
  degraded?: { reason: string };
}> {
  if (!deps.adapter.listAgents) {
    logger.warn("[agent-catalog] Adapter does not support listAgents — using FALLBACK_AGENTS");
    return { agents: FALLBACK_AGENTS, degraded: { reason: "unsupported" } };
  }

  const catalog = await deps.adapter.listAgents({ chatId });
  if (!catalog.ok) {
    logger.warn("[agent-catalog] Adapter error — using FALLBACK_AGENTS", {
      error: catalog.error.message,
    });
    return { agents: FALLBACK_AGENTS, degraded: { reason: "adapter-error" } };
  }

  if (!catalog.value.ok) {
    logger.warn("[agent-catalog] Catalog degraded — using FALLBACK_AGENTS", {
      reason: catalog.value.degraded?.reason ?? "unknown",
      usingCache: catalog.value.degraded?.usingCache ?? false,
    });
    return {
      agents: FALLBACK_AGENTS,
      degraded: { reason: catalog.value.degraded?.reason ?? "unknown" },
    };
  }

  logger.info("[agent-catalog] Dynamic catalog loaded", {
    count: catalog.value.agents.length,
  });
  return { agents: catalog.value.agents.map((a) => a.id) };
}
```

`FALLBACK_AGENTS` = `["build", "plan", "gentleman", "sdd-orchestrator"]` (hardcodeado como safety net).

El caller en el router de Telegram (`/agentes`) debe mostrar el banner degradado si `degraded` está presente:

```
⚠️ Catálogo remoto de agentes no disponible ({reason}).
Mostrando lista por defecto.
```

### 6.4 Validación dinámica — `isSupportedAgent`

La función `isSupportedAgent()` en `domain/entities.ts` se mantiene como validación contra `FALLBACK_AGENTS` (uso en configuración/defaults). La validación en `setActiveAgent()` en `use-cases.ts` se extiende para consultar catálogo dinámico:

```ts
// En setActiveAgent():
if (!isSupportedAgent(agent)) {
  const catalog = await listSupportedAgents(input.chatId);
  if (!catalog.includes(agent)) {
    return errResult(ERROR_CODES.VALIDATION_ERROR, "Agente no válido");
  }
}
```

### 6.5 Tipo `SupportedAgent`

`SupportedAgent` evoluciona de union literal a `string`:

```ts
// Antes:
export type SupportedAgent = (typeof SUPPORTED_AGENTS)[keyof typeof SUPPORTED_AGENTS];
// → "build" | "plan" | "gentleman" | "sdd-orchestrator"

// Después:
export type SupportedAgent = string;
```

Breaking change controlado. Todos los usos existentes siguen compilando porque `string` es supertipo de la union.

`SUPPORTED_AGENTS` se depreca como catálogo fuente de verdad y se refactoriza a `FALLBACK_AGENTS = ["build", "plan", "gentleman", "sdd-orchestrator"]`.

### 6.6 Cache

Misma estrategia que `ModelCatalogCache`:

- TTL: 30 segundos en memoria.
- Clave: `{chatId}::{projectId}::{sessionId ?? "-"}`
- En falla: devolver cached si existe + fresco; si no, devolver `ok: false` + degraded.
- En falla sin cache: devolver degraded + use-case cae a fallback.

### 6.7 Mock

Agregar handler en `mock/opencode-mock.ts`:

```
POST /opencode/agents → 200
{ "agents": [{ "id": "build" }, { "id": "plan" }, { "id": "gentleman" }, { "id": "sdd-orchestrator" }, { "id": "sdd-orchestrator-frontend-cheap" }] }
```

Soporte para fixture `UNSUPPORTED` (501) y `UNAVAILABLE` (503).

### 6.8 Templates Telegram

`formatAgentList()` y `formatInvalidAgent()` en `templates.ts` no requieren cambios — ya aceptan `readonly string[]` genérico.

## 7. Alternativas evaluadas

### A) Seguir con singleton + actualización manual

**Pros:** nada que implementar.
**Contras:** drift constante, releases reactivas, fricción para el usuario.
**Decisión:** Rechazado.

### B) Catálogo vía variable de entorno

**Pros:** sin llamado externo.
**Contras:** requiere restart del bot, no refleja estado real de OpenCode.
**Decisión:** Rechazado.

### C) Catálogo dinámico con fallback (decisión)

**Pros:** misma estrategia que modelos (RFC-017), sin breaking changes en UX, robusto contra fallas upstream.
**Contras:** latencia adicional en primer request cada 30s, complejidad de cache.
**Decisión:** Seleccionado.

## 8. Riesgos y mitigaciones

| Riesgo | Mitigación |
|--------|------------|
| Endpoint `/opencode/agents` no implementado en backend | Fallback automático a `FALLBACK_AGENTS` + `logger.warn()` + banner `⚠️` en Telegram. |
| Cache servido después de que OpenCode removió un agente | TTL corto (30s). Si usuario selecciona agente removido, OpenCode rechaza exec y bot lo reporta como fallback (igual que RFC-018). |
| CLI `opencode agents` no existe en versión instalada | Fallback a `FALLBACK_AGENTS` + `logger.warn()` + banner `⚠️` en Telegram. |
| Usuario no ve que está en fallback | Siempre se muestra banner `⚠️` en `/agentes` y `logger.warn()` en consola. Doble canal de notificación. |
| Usuario con agente persistido que ya no existe en catálogo | `resolveEffectiveAgent()` ya tiene fallback a `BUILD`. Agregar verificación contra catálogo. |
| Type narrowing de `SupportedAgent` se vuelve string | El tipo `SupportedAgent` pasa a ser `string`. Super-tipo de la union anterior. Sin errores de compilación. |

## 9. Criterios de aceptación

1. `/agentes` muestra agentes dinámicos desde OpenCode cuando el adapter lo soporta.
2. `/agente <id>` acepta agentes del catálogo dinámico aunque no estén en `FALLBACK_AGENTS`.
3. Cuando `/opencode/agents` falla (timeout/4xx/5xx), se usa `FALLBACK_AGENTS` con banner `⚠️` en Telegram + `logger.warn()` en consola.
4. Cache respeta TTL de 30s y no sirve datos stale por más de 30s.
5. El handler `/agentes` muestra banner degradado cuando `listSupportedAgents()` devuelve `degraded`.
6. El handler `/agente <nombre>` muestra aviso degradado cuando el catálogo no está disponible.
7. Cada entrada a fallback queda registrada en consola con `logger.warn()` y razón explícita.
5. Mock devuelve lista extendida de agentes (incluyendo `sdd-orchestrator-frontend-cheap`).
6. Tests existentes de RFC-016 pasan sin modificación (fallback cubre los 4 agentes originales).
7. `SupportedAgent` type cambia de union literal a `string` — sin errores de compilación.

## 10. Plan de implementación

### Fase 1 — Contrato e infraestructura

1. Agregar `AgentCatalogItem` y `AgentCatalogResult` a `src/application/contracts.ts`.
2. Agregar `listAgents?()` a `OpenCodeSessionAdapter` interface.
3. Refactorizar `SUPPORTED_AGENTS` → `FALLBACK_AGENTS` en `src/domain/entities.ts`.
4. Cambiar `SupportedAgent` type a `string`.

### Fase 2 — Implementación HTTP

5. Implementar `listAgents()` en `HttpOpenCodeSessionAdapter` con cache y fallback.
6. Agregar handler `/opencode/agents` en mock.

### Fase 3 — Implementación CLI/PTY

7. Implementar `listAgents()` en `CliOpenCodeSessionAdapter`.
8. Implementar `listAgents()` en `PtyOpenCodeSessionAdapter`.

### Fase 4 — Integración aplicación

9. Modificar `listSupportedAgents()` en `use-cases.ts` para usar catálogo dinámico con retorno `{ agents, degraded? }`.
10. Modificar `setActiveAgent()` para validar contra catálogo dinámico.
11. Agregar console warn via `logger.warn()` en cada camino de fallback con razón explícita.

### Fase 5 — Notificación Telegram en degradación

12. Modificar handler `/agentes` en `router.ts` para mostrar banner `⚠️` cuando `degraded` está presente.
13. Modificar handler `/agente <nombre>` para mostrar aviso degradado cuando catálogo no disponible.

### Fase 6 — Limpieza

14. Remover usos de `SUPPORTED_AGENTS.BUILD/PLAN/GENTLEMAN/SDD_ORCHESTRATOR` en favor de strings literales o `FALLBACK_AGENTS[0]`.
15. Actualizar verification tests de RFC-016.

## 11. Closing Gate

Este RFC se considera cerrado cuando:

1. TODAS las fases del plan están implementadas.
2. `CHANGELOG.md` actualizado con entrada en `## [Unreleased]` → `### Added` → `- RFC-020: Catálogo dinámico de agentes desde OpenCode.`
