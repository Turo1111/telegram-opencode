# Telegram OpenCode Bot

Bot local de Telegram para operar sesiones reales de OpenCode desde Telegram.

**Estado actual:** este README documenta solamente el flujo soportado **PTY-only**. El repositorio puede conservar compatibilidades o scripts legacy, pero NO forman parte del flujo principal documentado acá.

## Qué hace este proyecto

- Recibe mensajes por **long polling** de Telegram.
- Restringe el acceso por **allowlist** de Telegram `from.id`.
- Consulta sesiones reales de OpenCode para el proyecto activo.
- Permite vincular una sesión desde Telegram con `/sesiones` + confirmación.
- Reenvía texto libre a la sesión activa ya vinculada.
- Mantiene estado local en `data/`.
- Responde en **español**.

## Flujo operativo soportado

1. Abrís o continuás una sesión real de OpenCode desde tu máquina/WSL.
2. Corrés este bot localmente.
3. En Telegram seleccionás el proyecto activo con `/project <ruta-local>`.
4. Ejecutás `/sesiones`, elegís una sesión real del proyecto y confirmás la vinculación.
5. Desde ese momento mandás texto libre al chat y el bot lo reenvía a la sesión activa.

La fuente de verdad del listado es OpenCode CLI:

```bash
opencode session list --format json
```

No se listan procesos locales del wrapper. Se listan sesiones reales de OpenCode asociables de forma segura al proyecto activo.

## Arquitectura general

1. **Telegram** entrega updates al bot.
2. **Este proceso Node.js** valida que el usuario esté autorizado.
3. El bot resuelve el **proyecto activo** del chat.
4. Para `/sesiones`, consulta OpenCode CLI y filtra por el árbol del proyecto activo.
5. Para texto libre, reenvía el mensaje a la sesión PTY ya vinculada.

No hay magia: hay un adaptador de entrada (Telegram), una capa de aplicación, persistencia local y un adaptador hacia OpenCode.

## Requisitos

- **Node.js LTS**
- **npm**
- Un **bot de Telegram** propio
- Tu **Telegram `from.id`**
- `opencode` disponible en `PATH`
- `tmux` disponible en `PATH`

### Requisito importante de paths

La ruta del proyecto debe existir y ser visible IGUAL para Node y para OpenCode.

Si usás WSL, pasá rutas Linux/WSL, por ejemplo:

```text
/mnt/d/Proyectos/mi-proyecto
```

No uses rutas Windows tipo `C:\mi-proyecto` dentro del flujo PTY.

## Instalación

```bash
npm install
cp .env.example .env
```

Después editá `.env` con tus valores reales.

## Configuración mínima

```bash
TELEGRAM_BOT_TOKEN=<tu_token_de_botfather>
ALLOWED_USER_ID=<tu_telegram_from_id>

OPEN_CODE_ADAPTER=pty
LOCALE=es
```

### Variables importantes

- `TELEGRAM_BOT_TOKEN`: token de tu bot.
- `ALLOWED_USER_ID`: usuario principal autorizado.
- `ALLOWED_USER_IDS`: usuarios extra autorizados, separados por coma.
- `OPEN_CODE_ADAPTER`: debe ser `pty` en el flujo soportado.
- `OPEN_CODE_TIMEOUT_MS`: timeout general hacia OpenCode.
- `OPEN_CODE_CONTROL_TIMEOUT_MS`: timeout para operaciones de control, como listar sesiones.
- `POLLING_INTERVAL_MS`: intervalo del polling de Telegram.
- `STATE_DRIVER`: `sqlite` o `json`.
- `STATE_DB_PATH`: por defecto `./data/telegram-opencode.sqlite`.
- `STATE_JSON_PATH`: por defecto `./data/telegram-opencode-state.json`.
- `LOCALE`: en v1 queda en `es`.

## Quick start

1. Creá un bot con **@BotFather**.
2. Obtené tu **Telegram `from.id`**.
3. Configurá `.env` con `TELEGRAM_BOT_TOKEN`, `ALLOWED_USER_ID` y `OPEN_CODE_ADAPTER=pty`.
4. Instalá dependencias con `npm install`.
5. Abrí o continuá una sesión real de OpenCode desde tu terminal.
6. Corré el bot:

```bash
npm run dev
```

7. En Telegram:

```text
/project <ruta-local>
/sesiones
```

8. Elegí la sesión, confirmá y empezá a mandar texto libre.

## Comandos de Telegram disponibles

- `/start` o `/help`
- `/status` o `/st`
- `/project` o `/p <ruta-local|alias|projectId>`
- `/sesiones`
- `/session` o `/s <sessionId>`
- `/cancel` o `/c`
- texto libre

### Comandos y flujos fuera de foco

- `/new` está deshabilitado en el flujo PTY-only.
- `/run` está deshabilitado en el flujo PTY-only.
- El README NO documenta `mock`, `start:local` ni flujos HTTP/CLI como operación soportada.

### Flujo recomendado en Telegram

```text
/project <ruta-local>
/sesiones
```

Después elegís una sesión real del proyecto, confirmás la vinculación y ya podés mandar texto libre.

### Fallback manual

Si ya conocés el `sessionId`, podés vincularlo manualmente con:

```text
/session <sessionId>
```

## UX esperada

### Sin proyecto activo

```text
🔴 Primero seleccioná un proyecto con /project <ruta> antes de listar sesiones.
```

### Sin sesiones seguras para el proyecto

```text
ℹ️ No encontré sesiones disponibles para el proyecto actual.
```

### Error consultando OpenCode

```text
🔴 No pude consultar las sesiones de OpenCode. Verificá que el bridge PTY y OpenCode estén disponibles.
```

### Vinculación exitosa

```text
🟢 Sesión vinculada
```

## Adjuntarte desde PC a la misma sesión

El nombre de la sesión `tmux` queda así:

```bash
tmux attach -t tgoc_<session_id_sanitized>
```

Ejemplo:

```bash
tmux attach -t tgoc_mi-session-123
```

## Scripts útiles

Flujo principal:

```bash
npm install
npm run dev
```

Verificaciones disponibles:

```bash
npm run verify:rfc2
npm run verify:rfc2:coverage
npm run verify:rfc2:coverage:negative
npm run verify:rfc2:policy
npm run verify:rfc5
npm run verify:rfc6:concurrency
npm run verify:rfc6:policy
npm run verify:rfc6:recovery
npm run verify:rfc6
npm run verify:rfc7
npm run verify:rfc8
npm run verify:rfc9
npm run verify:rfc10
npm run verify:rfc11
```

### Nota sobre scripts legacy

El repo todavía puede conservar scripts como `npm run mock`, `npm run start:local` o `npm run stop:local`, pero NO forman parte del flujo soportado documentado en este README.

## Problemas comunes

### El bot no responde

Revisá esto en orden:

1. `TELEGRAM_BOT_TOKEN` correcto.
2. `ALLOWED_USER_ID` correcto.
3. Estás escribiéndole desde el usuario permitido.
4. El proceso está corriendo con `npm run dev`.
5. `opencode` está en `PATH`.
6. `tmux` está instalado y visible en `PATH`.
7. Ya existe una sesión real de OpenCode para vincular.

### `/sesiones` no muestra nada

Las causas más comunes son:

- no seleccionaste proyecto con `/project <ruta-local>`;
- no hay sesiones reales de OpenCode para ese proyecto;
- la sesión existe pero pertenece a otro path/proyecto;
- la sesión no trae un path confiable y el bot la excluye por seguridad.

### El proyecto no coincide en WSL

Usá rutas WSL/Linux reales, por ejemplo:

```text
/mnt/d/Proyectos/telegram-opencode
```

### Usuario no autorizado

El bot hace **silent-drop**. No responde nada. Eso NO es un bug; es una decisión de seguridad.

## Persistencia local

Por defecto el proyecto guarda estado local en `data/`.

Valores por defecto importantes:

- SQLite: `./data/telegram-opencode.sqlite`
- JSON: `./data/telegram-opencode-state.json`

Política actual de continuidad:

- Si SQLite queda ilegible, se intenta backup y reinicialización limpia.
- Si el JSON queda corrupto, se renombra a `.bak.<timestamp>` y se crea un estado vacío operable.

La prioridad es continuidad operativa.

## Notas importantes del proyecto

- El cliente de Telegram fuerza **IPv4** para evitar fallos tipo `EFATAL: AggregateError` en entornos donde IPv6 rompe.
- La respuesta está hardcodeada en **español** en v1.
- La documentación funcional y técnica vive en `docs/`.

## Estructura general

- `src/` — código principal del bot
- `mock/` — artefactos legacy de mock local
- `docs/` — PRD, RFCs y runbooks
- `data/` — estado local y artefactos generados

## Resumen

Para operar bien este proyecto necesitás CINCO cosas alineadas:

1. un bot de Telegram real,
2. un token válido,
3. tu `from.id` correcto en allowlist,
4. `OPEN_CODE_ADAPTER=pty`,
5. una sesión real de OpenCode disponible para el proyecto correcto.

Primero fundamentos. Después automatización. Es así de simple.
