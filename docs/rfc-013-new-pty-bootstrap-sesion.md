# RFC-013 — `/new` en modo PTY con bootstrap y descubrimiento seguro de sesión

**Estado:** Implementado  
**Autor:** AI Architect  
**Fecha:** 28 de Abril de 2026

## 1. Contexto

El proyecto opera principalmente en modo **PTY-only**, donde Telegram no habla con un backend HTTP capaz de crear sesiones por API, sino con sesiones reales de OpenCode disponibles en la máquina local/WSL.

Hoy el flujo recomendado es:

1. elegir proyecto con `/project`;
2. listar sesiones reales con `/sesiones`;
3. seleccionar y confirmar una sesión;
4. vincularla al chat;
5. enviar texto desde Telegram hacia la sesión activa.

El comando `/new` existe como intención legacy, pero está deshabilitado en la UX PTY actual. La razón no es Telegram: el router, el caso de uso y el flujo de persistencia ya tienen un camino conceptual para crear sesión. El bloqueo real está en infraestructura: en modo PTY todavía no existe una primitiva confiable para pedirle a OpenCode “creá una sesión y devolveme su `sessionId`”.

## 2. Estado actual verificado

### 2.1 Telegram

El router reconoce `/new` y `/n`, pero responde con un mensaje de comando deshabilitado.

Ubicación relevante:

- `src/adapters/telegram/router.ts`
- `src/adapters/telegram/templates.ts`

### 2.2 Aplicación

El caso de uso `createSession()` sigue existiendo y ya contempla:

- proyecto activo requerido;
- bloqueo si hay tarea activa;
- llamada al adapter;
- persistencia de sesión;
- actualización del binding activo del chat;
- actualización del estado operacional.

Ubicación relevante:

- `src/application/use-cases.ts`

### 2.3 Adapter PTY

`PtyOpenCodeSessionAdapter.createSession()` devuelve `unsupported` deliberadamente.

Ubicación relevante:

- `src/infrastructure/opencode-session-adapter.ts`

### 2.4 Host tmux

El host PTY actual puede asegurar una sesión tmux para un `sessionId` ya conocido mediante:

```bash
tmux new-session -d -s tgoc_<sessionId> -c <dir> opencode --session <sessionId>
```

Ubicación relevante:

- `src/infrastructure/opencode-tmux-host.ts`

Esto confirma el problema central: el sistema actual sabe operar una sesión si ya conoce el `sessionId`, pero no sabe crear una sesión nueva y descubrir su ID de manera garantizada.

## 3. Problema

`/new` en PTY necesita resolver una inversión del flujo actual.

Hoy:

```text
sessionId existente → crear/asegurar tmux → vincular chat
```

Para `/new`:

```text
crear sesión real OpenCode con prompt inicial → descubrir sessionId → crear/asegurar tmux → vincular chat
```

El punto frágil es descubrir el `sessionId` nuevo.

Hasta que OpenCode CLI exponga una primitiva oficial tipo:

```bash
opencode session create --dir <path> --format json
```

la implementación solo puede ser **best effort**, comparando el listado de sesiones antes y después del bootstrap.

## 4. Objetivo

Implementar `/new <mensaje inicial>` en modo PTY para crear una sesión OpenCode local desde Telegram y vincularla automáticamente al chat sin que el usuario tenga que tipear manualmente `/session <id>`.

La UX vigente aprobada es:

1. usuario ejecuta `/new <mensaje inicial>`;
2. el bot exige un mensaje inicial: `/new <mensaje inicial>`;
3. el bot descubre el `sessionId` creado;
4. el bot asegura host estable `tgoc_<sessionId>`;
5. el bot vincula automáticamente la sesión al chat;
6. el bot responde “sesión creada y vinculada”.

## 5. Alcance

### Entra en alcance

- Rehabilitar `/new` en modo PTY.
- Crear un bootstrap local de sesión OpenCode desde el proyecto activo.
- Descubrir el `sessionId` creado con estrategia conservadora.
- Reutilizar la semántica de vinculación existente de `/session <id>` después de descubrir una candidata única.
- Persistir sesión y binding solo después de tener un `sessionId` confiable.
- Manejar ambigüedad sin vincular automáticamente.
- Mantener `/new` fuera de backends donde no aplique.

### Fuera de alcance

- Crear sesiones por API HTTP remota.
- Agregar soporte a un eventual `opencode session create` oficial todavía no disponible.
- Resolver creación de sesiones en servidores headless sin entorno local/PTY.
- Cerrar, borrar o renombrar sesiones.
- Abrir una terminal visible en Windows; eso pertenece a RFC-014.
- Ejecutar shell arbitrario desde Telegram.

## 6. Propuesta funcional

### 6.1 Precondiciones

`/new` debe exigir:

- actor autorizado;
- proyecto activo seleccionado;
- proyecto resoluble a path local/canónico;
- modo adapter PTY;
- ausencia de tarea activa incompatible;
- disponibilidad de OpenCode CLI;
- disponibilidad de tmux;
- timeout de control configurado.

Si falta proyecto activo:

```text
🔴 Primero elegí un proyecto con /project <alias|ruta> antes de crear una sesión.
```

Si el backend no es PTY o no soporta creación:

```text
ℹ️ /new no está disponible en este backend. Usá /sesiones o /session <id>.
```

## 7. Estrategia de creación PTY

### 7.1 Algoritmo recomendado

1. Canonizar el path del proyecto activo.
2. Consultar sesiones existentes:

   ```bash
   opencode session list --format json
   ```

3. Crear una sesión tmux temporal con nombre interno, por ejemplo:

   ```text
   tgoc_boot_<token>
   ```

4. Ejecutar OpenCode en el directorio del proyecto con `opencode --prompt <mensaje inicial>`.
5. Pollear `opencode session list --format json` hasta timeout.
6. Calcular diferencia entre sesiones previas y posteriores.
7. Filtrar candidatas por asociación al proyecto activo.
8. Resolver resultado:
   - exactamente 1 candidata → éxito;
   - 0 candidatas → error recuperable;
   - más de 1 candidata → pedir selección manual;
9. Renombrar o recrear el host tmux con nombre estable `tgoc_<sessionId>`.
10. Vincular automáticamente el chat si el diff detectó exactamente una sesión nueva.

### 7.2 Detección conservadora

La detección del `sessionId` debe usar una regla conservadora:

- preferir sesiones nuevas no presentes en snapshot inicial;
- requerir path asociado al proyecto activo cuando esté disponible;
- ordenar por `createdAt`/`updatedAt` cuando OpenCode lo provea;
- no asumir por título o modelo;
- no inventar IDs;
- no vincular automáticamente si hay ambigüedad.

## 8. UX propuesta

### 8.1 Creación exitosa

```text
🟢 Sesión creada y vinculada
📁 telegram-opencode • 🔌 sess_abc123 • 🏷️ session-linked

Ya podés enviar mensajes a la sesión activa.
```

### 8.2 `/new` sin mensaje inicial

```text
Usá /new <mensaje inicial>
```

### 8.3 No se detecta sesión nueva

```text
🔴 No pude confirmar la creación de una sesión nueva

OpenCode no expuso un sessionId nuevo dentro del timeout.
Abrí OpenCode localmente o usá /sesiones si la sesión ya aparece.
```

### 8.4 Ambigüedad

```text
🟠 Encontré más de una sesión nueva para este proyecto

No voy a vincular automáticamente para evitar enganchar la sesión equivocada.
Elegí una con /sesiones.
```

## 9. Diseño técnico sugerido

### 9.1 Extender infraestructura PTY

Agregar una operación interna de bootstrap, por ejemplo:

```ts
bootstrapNewSession(input: {
  readonly projectId: string;
  readonly rootPath: string;
  readonly timeoutMs: number;
}): Promise<Result<SessionState>>
```

Esta operación puede vivir detrás de `PtyOpenCodeSessionAdapter.createSession()` para respetar el contrato existente de la aplicación.

### 9.2 Separar responsabilidades

- `OpenCode CLI`: listar sesiones y resolver paths.
- `tmux host`: crear sesión temporal, renombrar o recrear sesión estable.
- `PtyOpenCodeSessionAdapter`: coordinar bootstrap + detección + retorno de `SessionState`.
- `ApplicationUseCases`: persistir sesión y binding si el adapter devuelve éxito.
- `Telegram router`: exigir mensaje inicial y renderizar éxito/error sin callbacks de confirmación para `/new`.

No mezclar lógica de detección de OpenCode dentro del router. Eso sería mala arquitectura: el router no tiene que saber cómo nace una sesión PTY.

### 9.3 Nombre tmux temporal

La sesión temporal debe usar un nombre no derivado de input libre:

```text
tgoc_boot_<randomToken>
```

Cuando se descubre el `sessionId`, el sistema debe converger al nombre estable existente:

```text
tgoc_<sessionIdSanitized>
```

Opciones:

- renombrar tmux si es seguro;
- o cerrar/recrear host estable con `opencode --session <sessionId>`.

La opción de recrear es más simple y consistente, pero puede perder estado visual de la ventana temporal. La de renombrar conserva proceso, pero exige más cuidado con tmux.

## 10. Seguridad

`/new` no debe convertirse en un shell remoto.

Reglas:

- no aceptar comandos arbitrarios;
- no interpolar texto del usuario en shell;
- usar `spawn`/`execFile` con argumentos separados;
- canonizar paths;
- respetar allowlist existente;
- mantener timeouts;
- no persistir sesión si el descubrimiento no es confiable.

Aunque `/new` no abre una ventana local visible, sí dispara procesos locales. Por eso debe ser tratado como operación controlada, no como texto libre.

## 11. Riesgos y mitigaciones

### 11.1 OpenCode no crea sesión hasta recibir primer input

**Riesgo:** el bootstrap abre OpenCode, pero `session list` no muestra una sesión nueva.  
**Mitigación:** timeout claro y mensaje recuperable. No inventar ID.

### 11.2 Varias sesiones nuevas simultáneas

**Riesgo:** otro proceso crea sesiones en paralelo y la diferencia contiene más de una candidata.  
**Mitigación:** no vincular automático; derivar a `/sesiones`.

### 11.3 Sesión sin path

**Riesgo:** OpenCode lista sesión nueva sin path asociable al proyecto.  
**Mitigación:** tratarla como no confiable salvo que sea la única candidata inequívoca y documentar la decisión.

### 11.4 tmux temporal huérfano

**Riesgo:** falla el bootstrap y queda una sesión tmux temporal.  
**Mitigación:** cleanup best effort en error/timeout.

### 11.5 Dependencia de comportamiento no oficial de OpenCode

**Riesgo:** cambios de salida en `session list` rompen detección.  
**Mitigación:** encapsular parsing y detección en infraestructura; testear con fixtures; fallar cerrado.

## 12. Alternativas consideradas

### A. `/new <mensaje inicial>` crea sesión y vincula automáticamente

**Recomendada vigente.** OpenCode requiere prompt no vacío para materializar sesión; al detectar una única candidata segura se aplica la misma semántica que `/session <id>`.

### B. `/new` devuelve `/session sess_xxx`

Más simple, pero peor UX y más propenso a error humano. Descartada como flujo principal.

### C. Mantener `/new` deshabilitado

Más seguro y simple, pero limita una operación natural del bot. Aceptable si OpenCode no permite descubrimiento confiable.

### D. Esperar soporte oficial de OpenCode

Arquitectónicamente ideal. Tradeoff: bloquea UX hasta que exista `session create` oficial.

## 13. Criterios de aceptación

- `/new` solo opera con proyecto activo y modo PTY.
- Si no hay proyecto activo, responde error claro.
- Si hay tarea activa incompatible, se rechaza sin crear procesos.
- Si OpenCode/tmux no están disponibles, responde error claro.
- Si detecta exactamente una nueva sesión del proyecto, la persiste y vincula automáticamente.
- `/new` sin mensaje inicial se rechaza con uso claro y no crea procesos.
- Si el usuario cancela, la sesión no queda vinculada.
- Si hay 0 o múltiples candidatas, no vincula automáticamente.
- No se expone shell arbitrario.
- No se rompe `/sesiones` ni `/session` existentes.

## 14. Plan de implementación sugerido

1. Agregar operación de bootstrap PTY en infraestructura.
2. Crear tests/verification con fixtures para detección de sesiones nuevas.
3. Implementar `PtyOpenCodeSessionAdapter.createSession()` usando bootstrap.
4. Cambiar router para que `/new` invoque `useCases.createSession()` en modo PTY.
5. Renderizar éxito “Sesión creada y vinculada”.
6. Documentar limitación best effort en README.
7. Ejecutar verificación manual con OpenCode real y tmux.

## 15. Decisión

Se propone implementar `/new` PTY como capacidad **best effort y fail-closed**.

La UX objetivo es buena y coherente con RFC-011 v2, pero la confiabilidad depende de poder descubrir un `sessionId` nuevo desde OpenCode CLI. Mientras no exista primitiva oficial de creación, el sistema debe priorizar no vincular antes que vincular mal.

## 16. Nota de implementación

Implementado con flujo separado de `createSession()` para preservar la semántica legacy HTTP de crear y auto-vincular. En PTY, `/new <mensaje inicial>` usa bootstrap temporal tmux `tgoc_boot_<token>` con `opencode --prompt <mensaje inicial>`, diff conservador de `opencode session list --format json`, cleanup best-effort, host estable `opencode --session <sessionId>` y vinculación automática del chat si hay exactamente una candidata.

Limitación vigente: si OpenCode no expone exactamente una sesión nueva para el proyecto activo, el bot falla cerrado y deriva a `/sesiones` o `/session <id>`. No hay shell arbitrario: sólo `opencode`/`tmux` con `spawn`/`execFile` y argumentos separados.

## 17. Corrección runtime aprobada

Verificación manual corrigió la premisa original: `tmux new-session ... opencode` abre TUI pero no crea sesión nueva. `opencode --prompt "<mensaje>"` sí crea sesión listable; `opencode --prompt ""` no crea sesión. Por eso el contrato soportado es `/new <mensaje inicial>`; `/new` sin mensaje se rechaza con uso claro y no crea procesos.
