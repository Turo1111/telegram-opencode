# Telegram OpenCode Bot

Bot local de Telegram que recibe mensajes, los reenvía a OpenCode y devuelve la respuesta al chat. Está pensado para correr en tu máquina y permitirte operar OpenCode desde Telegram, con distintos modos de integración según tu flujo.

## Qué hace este proyecto

- Recibe mensajes por **long polling** de Telegram.
- Restringe el acceso por **allowlist de Telegram `from.id`**.
- Reenvía prompts a OpenCode por uno de estos modos:
  - **HTTP**: contra un backend HTTP o el mock local.
  - **CLI**: vincula Telegram con una sesión real de OpenCode creada desde tu PC/WSL.
  - **PTY**: usa `tmux` para compartir una sesión real viva entre Telegram y tu terminal.
- Responde en **español**.
- Mantiene estado local en `data/`.

## Arquitectura general

1. **Telegram** entrega updates al bot.
2. **Este proceso Node.js** valida si vos estás autorizado.
3. Si el mensaje es válido, lo manda a **OpenCode**.
4. La respuesta vuelve y el bot te la manda por Telegram.

No hay magia: hay un adaptador de entrada (Telegram), una capa de aplicación, persistencia local y un adaptador de salida hacia OpenCode.

## Quick start

Si querés ponerlo a funcionar lo antes posible:

1. Creá un bot con **@BotFather**.
2. Obtené tu **Telegram `from.id`**.
3. Copiá `.env.example` a `.env` y completá `TELEGRAM_BOT_TOKEN` + `ALLOWED_USER_ID`.
4. Instalá dependencias:

```bash
npm install
```

5. Para probar el flujo más simple, usá modo mock:

```bash
npm run start:local
```

6. Abrí Telegram, hablale a tu bot y verificá la respuesta.

## Requisitos

- **Node.js LTS**
- **npm**
- Un **bot de Telegram** propio
- Tu **Telegram `from.id`**

Según el modo que uses:

- **Modo HTTP/mock**: no necesitás `opencode` instalado.
- **Modo CLI**: necesitás `opencode` en `PATH`.
- **Modo PTY**: necesitás `opencode` y `tmux` en `PATH`.

## Instalación

```bash
npm install
```

## Paso 1: crear tu bot de Telegram

Esto se hace con **@BotFather**.

1. Abrí Telegram.
2. Buscá **@BotFather**.
3. Enviá `/newbot`.
4. BotFather te va a pedir:
   - un **nombre visible** para el bot;
   - un **username** que termine en `bot`.
5. Cuando termine, BotFather te devuelve un mensaje con el **token HTTP API**.

Ese token es el valor que va en:

```bash
TELEGRAM_BOT_TOKEN=<tu_token>
```

### Cómo obtener de nuevo el token

Si lo perdés:

1. Volvé a **@BotFather**.
2. Ejecutá `/mybots`.
3. Elegí tu bot.
4. Entrá en **API Token**.

## Paso 2: obtener tu Telegram ID

Este proyecto **NO autoriza por `chat.id`**, autoriza por **`from.id`** del usuario real. Eso es importante.

La forma más práctica:

1. En Telegram, escribile a un bot como **@userinfobot**.
2. Copiá el campo **Id**.

Ese valor va en:

```bash
ALLOWED_USER_ID=<tu_id_numerico>
```

Si querés varios usuarios permitidos:

```bash
ALLOWED_USER_ID=123456789
ALLOWED_USER_IDS=111111111,222222222
```

### Regla importante de seguridad

- `ALLOWED_USER_ID` es **obligatoria**.
- Tiene que ser un número válido.
- Si ponés un placeholder o un valor inválido, el proceso falla al arrancar.
- Usuarios no autorizados reciben **silent-drop**: el bot no responde.

## Paso 3: crear tu archivo `.env`

Usá `.env.example` como base:

```bash
cp .env.example .env
```

Después editá `.env` con tus valores reales.

### Configuración mínima para modo HTTP/mock

```bash
TELEGRAM_BOT_TOKEN=<tu_token_de_botfather>
ALLOWED_USER_ID=<tu_telegram_from_id>

OPEN_CODE_ADAPTER=http
OPEN_CODE_URL=http://localhost:3000/opencode/query
OPEN_CODE_TOKEN=dev-token

LOCALE=es
```

### Configuración mínima para modo CLI

```bash
TELEGRAM_BOT_TOKEN=<tu_token_de_botfather>
ALLOWED_USER_ID=<tu_telegram_from_id>

OPEN_CODE_ADAPTER=cli
LOCALE=es
```

En modo `cli`, `OPEN_CODE_URL` y `OPEN_CODE_TOKEN` pueden omitirse.

### Configuración mínima para modo PTY

```bash
TELEGRAM_BOT_TOKEN=<tu_token_de_botfather>
ALLOWED_USER_ID=<tu_telegram_from_id>

OPEN_CODE_ADAPTER=pty
LOCALE=es
```

## Variables importantes

Estas son las más relevantes para que entiendas qué estás tocando:

- `TELEGRAM_BOT_TOKEN`: token de tu bot.
- `ALLOWED_USER_ID`: usuario principal autorizado.
- `ALLOWED_USER_IDS`: usuarios extra autorizados, separados por coma.
- `OPEN_CODE_ADAPTER`: `http`, `cli` o `pty`.
- `OPEN_CODE_URL`: endpoint HTTP de OpenCode cuando usás modo `http`.
- `OPEN_CODE_TOKEN`: bearer token para el backend HTTP.
- `OPEN_CODE_TIMEOUT_MS`: timeout general hacia OpenCode.
- `POLLING_INTERVAL_MS`: intervalo del polling de Telegram.
- `STATE_DRIVER`: `sqlite` o `json`.
- `STATE_DB_PATH`: por defecto `./data/telegram-opencode.sqlite`.
- `STATE_JSON_PATH`: por defecto `./data/telegram-opencode-state.json`.
- `LOCALE`: en v1 queda en `es`.

El archivo `.env.example` ya trae una plantilla completa con defaults razonables.

## Modos de funcionamiento

## 1) Modo HTTP con mock local

Este es el punto de entrada más fácil para probar que TODO el cableado funciona.

### Qué hace

- Levanta un backend mock local.
- El bot le pega por HTTP.
- El mock responde con una respuesta falsa para validar el flujo.

### Cómo levantarlo

Tenés dos opciones.

#### Opción A: todo junto

```bash
npm run start:local
```

Eso levanta:

- `npm run mock`
- `npm run dev`

Si quedó una instancia previa registrada:

```bash
npm run stop:local
```

#### Opción B: procesos separados

Terminal 1:

```bash
npm run mock
```

Terminal 2:

```bash
npm run dev
```

### Cuándo usar este modo

- Cuando querés validar Telegram + auth + configuración.
- Cuando todavía no querés conectar OpenCode real.
- Cuando querés testear local sin dependencias externas.

## 2) Modo CLI

Este modo conecta Telegram con una sesión real de OpenCode que ya corrés desde PC/WSL.

### Requisitos extra

- `opencode` instalado y visible en `PATH`.
- El path del proyecto debe existir y ser visible IGUAL para Node y OpenCode.
- Si usás WSL, pasá rutas Linux/WSL como `/home/...` o `/mnt/d/...`.

### Flujo correcto

1. En tu PC/WSL abrís OpenCode.
2. Creás o continuás una sesión desde OpenCode.
3. En Telegram ejecutás:

```text
/project <path-local-del-proyecto>
/session <session-id-existente>
```

4. Después de eso ya podés mandar texto libre por Telegram.

### Importante

En modo `cli`:

- `/new` no crea sesiones desde Telegram.
- `/cancel` no tiene paridad completa desde Telegram.
- La gestión principal de sesión sigue viviendo en PC/WSL.

O sea: Telegram se vuelve una extensión operativa de tu sesión real, no un reemplazo total.

## 3) Modo PTY

Este es el modo más potente. Corre OpenCode dentro de una sesión `tmux`, y Telegram + tu terminal comparten la misma sesión viva.

### Requisitos extra

- `opencode` en `PATH`
- `tmux` en `PATH`

### Flujo

En Telegram:

```text
/project <path-local-del-proyecto>
/session <opencode_session_id>
```

Después mandás texto y el bot lo inyecta en la sesión compartida.

### Adjuntarte desde PC a la misma sesión

El nombre de la sesión `tmux` queda así:

```bash
tmux attach -t tgoc_<session_id_sanitized>
```

Ejemplo:

```bash
tmux attach -t tgoc_mi-session-123
```

## Comandos de Telegram disponibles

- `/start` o `/help`
- `/status` o `/st`
- `/project` o `/p <alias|projectId>`
- `/session` o `/s <sessionId>`
- `/new` o `/n`
- `/cancel` o `/c`

## Flujo recomendado de punta a punta

Si querés ir a lo seguro, hacé esto:

1. Creá el bot con BotFather.
2. Obtené tu `from.id`.
3. Creá `.env` con `TELEGRAM_BOT_TOKEN` y `ALLOWED_USER_ID`.
4. Elegí modo:
   - mock local: `OPEN_CODE_ADAPTER=http`
   - OpenCode real por CLI: `OPEN_CODE_ADAPTER=cli`
   - OpenCode real compartido con tmux: `OPEN_CODE_ADAPTER=pty`
5. Instalá dependencias con `npm install`.
6. Levantá el proyecto:
   - mock: `npm run start:local`
   - bot solo: `npm run dev`
7. Abrí Telegram y hablale a tu bot.
8. Si usás CLI o PTY, primero asociá proyecto y sesión con `/project` y `/session`.

Es así de simple, pero SOLO si entendés qué modo estás usando.

## Scripts disponibles

```bash
npm install
npm run dev
npm run mock
npm run start:local
npm run stop:local
```

Scripts de verificación incluidos:

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
```

## Problemas comunes

### El bot no responde

Revisá esto en orden:

1. `TELEGRAM_BOT_TOKEN` correcto.
2. `ALLOWED_USER_ID` correcto.
3. Estás escribiéndole desde el usuario permitido.
4. El proceso está corriendo (`npm run dev` o `npm run start:local`).
5. Si usás `http`, que `OPEN_CODE_URL` y `OPEN_CODE_TOKEN` coincidan con el backend/mock.
6. Si usás `cli` o `pty`, que `opencode` esté en `PATH`.
7. Si usás `pty`, que `tmux` esté instalado.

### `start:local` dice que ya hay una instancia corriendo

Corré:

```bash
npm run stop:local
```

### En WSL no encuentra el path del proyecto

No uses rutas Windows tipo `C:\proyecto`.

Usá rutas WSL/Linux, por ejemplo:

```text
/mnt/d/Proyectos/mi-proyecto
```

### Usuario no autorizado

El bot hace **silent-drop**. O sea: no responde nada. Eso no es un bug; es una decisión de seguridad.

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
- `start:local` crea `.local-runtime.json` para no duplicar instancias.
- La documentación funcional y técnica vive en `docs/`.

## Estructura general

- `src/` — código principal del bot
- `mock/` — mock local de OpenCode
- `docs/` — PRD, RFCs y runbooks
- `data/` — estado local y artefactos generados

## Resumen

Para que esto funcione de verdad necesitás CUATRO cosas bien configuradas:

1. un bot de Telegram real,
2. un token válido,
3. tu `from.id` correcto en allowlist,
4. el modo de OpenCode bien elegido.

Si una de esas cuatro falla, el sistema no va a responder como esperás. Primero configuración correcta, después automatización.
