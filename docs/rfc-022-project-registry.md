# RFC-022 — Project Registry: catálogo persistente de proyectos

**Estado:** Propuesto
**Autor:** AI Architect
**Fecha:** 6 de Mayo de 2026

## 1. Contexto

El bot maneja el concepto de "proyecto activo" desde el inicio. El usuario selecciona un proyecto con `/project <ruta>` y el bot lo asocia al chat via `ChatBinding.activeProjectId`. Sin embargo, el manejo actual tiene estas características:

**Infraestructura presente pero huérfana:**

- `domain/entities.ts` define `Project` con `projectId`, `alias`, `rootPath`, `createdAt`, `lastUsedAt`.
- `sqlite-store.ts` tiene tabla `projects` con schema completo (`project_id`, `alias`, `root_path`, `created_at`, `last_used_at`), migraciones e índices.
- `ProjectRepository` tiene 5 métodos implementados en ambos drivers: `findById`, `findByAlias`, `listAll`, `upsert`, `markLastUsed`.
- JSON driver replica exactamente el mismo contrato.

**Nada de esto se usa desde Telegram:**

| Componente | Estado |
|------------|--------|
| Tabla `projects` en SQLite | ✅ Creada en schema |
| `ProjectRepository` | ✅ CRUD completo |
| `Project` entity | ✅ Definida |
| Registro automático al hacer `/project` | ❌ Nunca se llama a `projects.upsert()` |
| Comando `/projects` para listar | ❌ No existe |
| Selección por alias | ❌ Solo acepta ruta |
| Dar de baja proyectos | ❌ No existe |
| Auto-descubrimiento desde OpenCode | ❌ No existe |

El flujo actual de `/project <ruta>` solo persiste el `activeProjectId` en `bindings`. El proyecto en sí no queda registrado. Si el usuario quiere cambiar entre proyectos, necesita recordar la ruta exacta cada vez.

## 2. Problema

### 2.1 Proyectos no persistentes como entidades

Cada vez que el usuario usa `/project <ruta>`, el binding se actualiza pero no hay un registro de "proyectos conocidos". Si mañana quiere volver a ese proyecto, tiene que escribir la ruta completa de nuevo. No hay memoria de proyectos anteriores.

### 2.2 Sin listado ni descubrimiento

No existe `/projects` para ver qué proyectos se han usado. El bot no puede responder "estos son tus proyectos" como sí lo hace con `/agentes` o `/modelos`.

### 2.3 Sin alias

Actualmente `/project` solo acepta una ruta absoluta (`/mnt/d/Proyectos/mi-proyecto`). No hay manera de decir `/project mi-proyecto` o `/project backend`. El alias existe en el schema pero no se expone al usuario.

### 2.4 Sin limpieza

No hay forma de olvidar un proyecto. Un proyecto que ya no existe en disco sigue apareciendo como opción (si se implementa listado), y no hay comando para removerlo.

### 2.5 Sin auto-descubrimiento

OpenCode CLI conoce los proyectos en los que opera (`opencode session list --format json` devuelve sessions con path). El bot podría inferir proyectos desde las sesiones existentes, pero no lo hace.

## 3. Escenarios objetivo

| # | Escenario | Input del usuario | Comportamiento esperado |
|---|-----------|-------------------|-------------------------|
| 1 | Registrar proyecto nuevo | `/project /home/user/proj` | upsert en `projects`, alias = "proj" (basename), binding actualizado |
| 2 | Seleccionar proyecto existente por alias | `/project proj` | `findByAlias("proj")` → binding actualizado |
| 3 | Seleccionar proyecto existente por ruta | `/project /home/user/proj` | `findById("/home/user/proj")` → binding actualizado, `markLastUsed` |
| 4 | Listar proyectos registrados | `/projects` | `listAll()` → tabla formateada con alias, ruta, última vez |
| 5 | Listar vacío | `/projects` (sin proyectos) | "ℹ️ No hay proyectos registrados. Usá /project <ruta> para agregar el primero." |
| 6 | Olvidar proyecto | `/project --forget proj` | Eliminar de `projects`, si estaba activo → binding idle |
| 7 | Alias duplicado | `/project /otro/path --alias proj` con alias existente | ❌ "🔴 El alias 'proj' ya está en uso por otro proyecto." |
| 8 | Ruta inexistente | `/project /nope` | ❌ "🔴 La ruta /nope no existe en disco." |
| 9 | Registrar con alias explícito | `/project /home/user/proj --alias mi-app` | upsert con alias "mi-app" en vez de basename |
| 10 | Sin proyecto activo | `/projects` sin haber usado `/project` nunca | "ℹ️ No hay proyectos registrados." |

## 4. Propuesta

### 4.1 Diagrama de flujo de datos

```text
Telegram (/project, /projects)
        │
        ▼
  handlers.ts ───→ use-cases.ts ───→ ProjectRepository
                                             │
                                    ┌────────┼────────┐
                                    ▼        ▼        ▼
                                SQLite     JSON    (extensible)
                              (projects  (projects
                                 table)    map)
```

### 4.2 Comandos nuevos y modificados

#### `/project <ruta|alias>` (modificado)

Comportamiento actual: solo acepta ruta, setea binding.

Comportamiento nuevo:

1. Detectar si el argumento es ruta absoluta existente (`/` inicial o letra+`:\` en Windows y path existe en disco) o alias (cualquier otro string).
2. Si es **ruta**: validar que el directorio exista (`fs.access`). `upsert` en `projects` con alias = basename de la ruta (o `--alias` explícito, ver 4.2.3). Actualizar binding. `markLastUsed`.
3. Si es **alias**: `findByAlias`. Si existe → actualizar binding + `markLastUsed`. Si no existe → "🔴 No encontré un proyecto con alias '{alias}'."
4. Si es **ruta pero ya registrada con otro alias**: `findById` existe → actualizar `lastUsedAt` y binding. No duplicar.
5. Si no hay argumento y hay proyectos registrados: mostrar `/projects`. Si no hay: "ℹ️ Usá /project <ruta> para seleccionar un proyecto."

#### `/projects` (nuevo)

Lista todos los proyectos registrados en `projects` ordenados por `lastUsedAt` descendente.

Formato Telegram:

```text
📁 Proyectos registrados:

1. mi-app → /home/user/mi-app (usado hace 2 min)
2. backend → /home/user/backend-api (usado hace 1 día)
3. legacy → /home/user/viejo-proyecto (usado hace 3 semanas)
```

Si no hay proyectos:

```text
ℹ️ No hay proyectos registrados. Usá /project <ruta> para agregar el primero.
```

La respuesta incluye un botón inline por proyecto: "Seleccionar {alias}" que ejecuta `/project {alias}`.

#### `/project --forget <alias|ruta>` (nuevo flag)

Elimina el proyecto del registro:

1. Buscar por alias, luego por ruta.
2. Si está activo en el binding actual → limpiar `activeProjectId` y `activeSessionId`.
3. Eliminar de `projects`.
4. "🟢 Proyecto '{alias}' eliminado del registro."

#### `/project <ruta> --alias <alias>` (nuevo flag)

Registra con alias explícito en vez del basename automático.

### 4.3 Auto-descubrimiento al listar sesiones

Cuando el usuario ejecuta `/sesiones`, el bot ya consulta `opencode session list --format json` y filtra por el proyecto activo. Propuesta adicional: si alguna sesión tiene un `projectId` no registrado en `projects`, el bot hace upsert automático de ese proyecto.

Esto asegura que proyectos con sesiones activas aparezcan en `/projects` sin que el usuario tenga que registrarlos manualmente.

**Condición:** solo auto-registrar si el path realmente existe en disco (`fs.access`). No confiar ciegamente en el path reportado por OpenCode.

### 4.4 Contrato de `ProjectRepository` (sin cambios)

No se necesitan métodos nuevos. El repositorio actual ya cubre todo:

| Método | Se usa en |
|--------|-----------|
| `findById(projectId)` | Resolución por ruta |
| `findByAlias(alias)` | Resolución por alias |
| `listAll()` | `/projects` |
| `upsert(project)` | Registro automático y explícito |
| `markLastUsed(projectId, lastUsedAt)` | Actualización de última vez |

### 4.5 Formato de respuesta en Telegram

#### `/project <ruta>` exitoso (nuevo proyecto):

```text
🟢 Proyecto activo: mi-app (/home/user/mi-app)
📝 Registrado con alias "mi-app". Usá /projects para ver todos.
```

#### `/project <ruta>` exitoso (ya registrado):

```text
🟢 Proyecto activo: mi-app (/home/user/mi-app)
```

#### `/project <alias>` exitoso:

```text
🟢 Proyecto activo: mi-app (/home/user/mi-app)
```

#### `/project <alias>` fallido:

```text
🔴 No encontré un proyecto con alias '{alias}'. Usá /projects para ver los proyectos registrados.
```

#### `/project --forget <alias>` exitoso:

```text
🟢 Proyecto 'mi-app' eliminado del registro.
```

## 5. Cambios en el código

### 5.1 Archivos nuevos

Ninguno. Todo el cambio es sobre código existente.

### 5.2 Archivos a modificar

| Archivo | Cambio |
|---------|--------|
| `src/adapters/telegram/router.ts` | Agregar ruta `/projects`; modificar handler de `/project` |
| `src/adapters/telegram/handlers.ts` (o donde vivan los handlers) | Implementar `handleListProjects`, modificar `handleSetProject` |
| `src/application/use-cases.ts` | Agregar `listProjects()`, `forgetProject()`, `registerProject()` use-cases |
| `src/application/contracts.ts` | Sin cambios (ProjectRepository ya cubre todo) |
| `src/infrastructure/persistence/factory.ts` | Sin cambios |
| `src/infrastructure/persistence/sqlite-store.ts` | Sin cambios |
| `src/infrastructure/persistence/json-store.ts` | Sin cambios |
| `src/domain/entities.ts` | Sin cambios |

### 5.3 Detalle: use-cases nuevos

#### `listProjects(chatId: string)`

```typescript
async function listProjects(chatId: string): Promise<Project[]> {
  return persistence.runInTransaction(async (unit) => {
    return unit.projects.listAll();
  });
}
```

#### `registerOrSelectProject(input)`

```typescript
interface RegisterOrSelectProjectInput {
  chatId: string;
  identifier: string;       // ruta o alias
  explicitAlias?: string;   // opcional, --alias flag
}

// Lógica:
// 1. Si identifier es ruta absoluta existente:
//    a. alias = explicitAlias ?? basename(identifier)
//    b. upsert en projects
//    c. markLastUsed
//    d. update binding.activeProjectId
// 2. Si identifier no es ruta:
//    a. findByAlias(identifier)
//    b. Si no existe → error "no encontrado"
//    c. markLastUsed, update binding
```

#### `forgetProject(input)`

```typescript
interface ForgetProjectInput {
  chatId: string;
  identifier: string;  // alias o ruta
}

// 1. Buscar en projects por alias, luego por ruta
// 2. Si está activo en binding → limpiar
// 3. Eliminar
// 4. Si era el proyecto activo → idle mode
```

### 5.4 Detalle: auto-descubrimiento en flujo de sesiones

En `opencode-project-sessions.ts` o el adaptador que consulta sesiones, después de obtener la lista de OpenCode:

```typescript
for (const session of remoteSessions) {
  const projectId = session.projectId;
  if (!projectId) continue;

  const exists = await unit.projects.findById(projectId);
  if (!exists && await directoryExists(projectId)) {
    await unit.projects.upsert({
      projectId,
      alias: path.basename(projectId),
      rootPath: projectId,
      createdAt: new Date().toISOString(),
    });
  }
}
```

**Nota:** Esto debe ser best-effort. Si falla el upsert, no debe cortar el flujo principal de listar sesiones.

### 5.5 Orden de implementación

1. Use-case `listProjects` + handler `/projects`
2. Use-case `registerOrSelectProject` — modificar handler `/project`
3. Use-case `forgetProject` + flag `--forget`
4. Flag `--alias` para registro explícito
5. Auto-descubrimiento en listado de sesiones

## 6. Edge cases

### 6.1 Ruta con trailing slash

`/project /home/user/proyecto/` debe normalizarse a `/home/user/proyecto` antes de upsert.

### 6.2 Ruta Windows (Git Bash)

`/c/Users/user/project` debe funcionar como ruta. `fs.access` lo resuelve correctamente en Windows.

### 6.3 Ruta Windows nativa

`C:\Users\user\project` debe funcionar. Normalizar separadores a `/` para consistencia en `projectId`.

### 6.4 Alias con caracteres especiales

El alias debe ser sanitizado: solo alfanumérico, guiones y guiones bajos. Si el basename contiene espacios (ej. "mi proyecto"), se rechaza y se pide `--alias` explícito.

### 6.5 Forget de proyecto con sesión activa

Si el usuario hace `--forget` de un proyecto que tiene `activeSessionId` en el binding:
- Preguntar confirmación: "El proyecto tiene una sesión activa. ¿Eliminar de todas formas?"
- Si confirma: limpiar binding completo (proyecto + sesión) y eliminar de projects.

### 6.6 Auto-descubrimiento: path cambiado

OpenCode puede reportar un proyecto con path antiguo. El auto-descubrimiento solo registra si el path existe en disco. Si el path cambió, el proyecto no se registra automáticamente — el usuario debe usar `/project <nueva-ruta>` para actualizarlo.

### 6.7 `/projects` con muchos proyectos

Si hay más de ~10 proyectos, considerar paginación (estilo `sesspg:`). En v1, mostrar todos con scroll natural de Telegram (no hay límite duro).

### 6.8 `/project` sin argumentos

Comportamiento nuevo: si hay proyectos registrados → mostrar `/projects`. Si no → "ℹ️ Usá /project <ruta> para seleccionar un proyecto."

## 7. Persistencia y migración

### 7.1 Sin migración necesaria

El schema de `projects` ya existe en SQLite (creado via `CREATE TABLE IF NOT EXISTS`). Los datos previos no existen, pero el schema está listo desde el inicio. No hay migración de datos porque no había datos que migrar.

### 7.2 JSON driver

El JSON driver también tiene `projects: {}` en `EMPTY_STORE`. Misma situación: schema listo, datos vacíos.

## 8. Riesgos y mitigaciones

### 8.1 Alias basename no único

**Riesgo:** Dos proyectos con mismo basename (ej. `/proyectos/api` y `/otros/api`). El segundo registro sobrescribe al primero por `project_id` diferente pero alias duplicado viola UNIQUE en SQLite.

**Mitigación:** El schema tiene `alias TEXT NOT NULL UNIQUE`. El upsert fallará con error de constraint. Capturar el error y pedir `--alias` explícito al usuario para el segundo proyecto.

### 8.2 Regresión en `/project` existente

**Riesgo:** El cambio a `/project` rompe el flujo actual de selección por ruta.

**Mitigación:** La ruta absoluta siempre se detecta primero (empieza con `/` o letra+`:` seguido de separador). El comportamiento para rutas existentes es idéntico al actual con el adicional de upsert.

### 8.3 Performance en `/projects` con muchos proyectos

**Riesgo:** `listAll()` en SQLite/JSON es O(n) y devuelve todos los registros.

**Mitigación:** Para v1 no es problema (un usuario típico tiene 3-10 proyectos). Si crece, se puede paginar.

### 8.4 Confusión entre alias y ruta

**Riesgo:** Si un usuario tiene un proyecto en `/home/user/backend` y otro alias "backend", `/project backend` es ambiguo.

**Mitigación:** Siempre resolver por alias primero (es el caso más común). Si el alias no existe, intentar como ruta. Nunca hay ambigüedad porque `findByAlias` tiene prioridad y si falla, se cae a ruta.

## 9. Alternativas consideradas

### A. Solo-ruta, sin alias (como hoy)

Descartado. El alias es la feature principal de UX. Recordar rutas absolutas es tedioso.

### B. Registrar solo con flag `--save`

En vez de registrar automáticamente, pedir `/project --save /ruta`. Decidido en contra: el registro automático no tiene costo y la tabla projects está infrautilizada. El usuario siempre se beneficia del registro.

### C. Alias obligatorio

Pedir `--alias` siempre. Descartado: la mayoría de los casos usan el basename. El flag explícito es opcional para casos edge.

### D. Tabla separada de "proyectos recientes"

En vez de usar `projects` como registro permanente, tener una tabla `recent_projects` que se limpia sola. Descartado: la tabla projects ya existe y soporta `lastUsedAt` para ordenamiento. Los proyectos con `lastUsedAt` muy viejo pueden ignorarse en UI.

### E. Proyectos como tags de sesiones

No persistir proyectos independientemente, solo derivarlos de las sesiones activas. Descartado: una sesión puede terminar y el proyecto desaparecería del registro. El catálogo debe sobrevivir a las sesiones.

## 10. Criterios de aceptación

- [ ] `/project /ruta/valida` hace upsert automático en `projects` con alias = basename.
- [ ] `/project /ruta/valida --alias nombre` registra con alias explícito.
- [ ] `/project alias` resuelve por `findByAlias` y actualiza binding.
- [ ] `/project alias` falla con mensaje claro si el alias no existe.
- [ ] `/project` sin argumentos redirige a `/projects` (si hay proyectos) o muestra mensaje de ayuda.
- [ ] `/projects` lista proyectos ordenados por `lastUsedAt` descendente.
- [ ] `/projects` sin proyectos muestra "ℹ️ No hay proyectos registrados."
- [ ] `/projects` muestra botón inline "Seleccionar {alias}" por proyecto.
- [ ] `/project --forget alias` elimina proyecto y limpia binding si estaba activo.
- [ ] `/project --forget alias` con sesión activa pide confirmación.
- [ ] Ruta con trailing slash se normaliza.
- [ ] Alias basename duplicado muestra error sugiriendo `--alias` explícito.
- [ ] Ruta inexistente en disco rechazada con error.
- [ ] Proyectos vistos en `/sesiones` se auto-registran si el path existe en disco.
- [ ] Auto-registro en sesiones es best-effort (no corta el flujo si falla).
- [ ] `/project /ruta/ya/registrada` actualiza `lastUsedAt` sin duplicar.
- [ ] Sin regresión en flujo existente de `/project <ruta>`.
