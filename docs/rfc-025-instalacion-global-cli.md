# RFC-025 — Instalación global y CLI setup wizard

**Estado:** Borrador
**Autor:** —
**Fecha:** 6 de Mayo de 2026

## 1. Problema

Hoy el bot se corre localmente con `npm run dev` o `npm run start:local`. Para usarlo hay que clonar el repo, instalar dependencias, configurar `.env` manualmente, y tener las herramientas necesarias (tmux, opencode) ya instaladas. No es "instalable" como herramienta global.

## 2. Idea

Poder instalar el bot en la PC como un CLI global:

```bash
npm install -g telegram-opencode
# o eventualmente:
sudo apt install telegram-opencode
```

Y después ejecutar:

```bash
telegram-opencode            # first-run setup wizard
telegram-opencode start      # arrancar el bot
telegram-opencode stop       # detenerlo
telegram-opencode status     # ver estado
telegram-opencode logs       # ver logs
```

## 3. Lo que falta / definir

### 3.1 Build y distribución

- [ ] Cambiar `"private": true` a `false` en package.json
- [ ] Agregar `"bin": { "telegram-opencode": "./dist/cli.js" }`
- [ ] Agregar build step (`tsc` o similar) para compilar TS a JS
- [ ] Decidir: npm public package vs self-hosted registry vs instalador nativo

### 3.2 CLI entry point

- [ ] Crear `src/cli.ts` como punto de entrada
- [ ] Subcomandos: `start`, `stop`, `status`, `logs`, `config`, `doctor`, `help`
- [ ] Primer argumento sin subcomando → setup wizard si no configurado, `start` si ya configurado

### 3.3 First-run setup wizard

- [ ] Detectar si es primera vez (ausencia de config)
- [ ] Setup interactivo paso a paso:

```text
$ telegram-opencode

╔════════════════════════════════════════╗
║  telegram-opencode - Setup            ║
╚════════════════════════════════════════╝

Paso 1/4: Token del bot
Creá un bot con @BotFather en Telegram y pegá el token:
> 

Paso 2/4: Tu ID de Telegram
Escribí tu Telegram from.id (o varios separados por coma):
> 

Paso 3/4: Ruta de config
¿Dónde guardar la configuración?
[/home/user/.config/telegram-opencode] > 

Paso 4/4: Verificar herramientas
🔍 Buscando tmux... ✅
🔍 Buscando opencode CLI... ✅
🔍 Buscando Node.js... ✅

✅ Configuración guardada en /home/user/.config/telegram-opencode/.env
✅ Podés ejecutar: telegram-opencode start
```

### 3.4 Verificación de dependencias (`doctor`)

- [ ] `telegram-opencode doctor` → verifica que todo esté instalado
- [ ] Detectar: Node.js, tmux, opencode CLI, bash, permisos
- [ ] Guías de instalación si falta algo:

| Dependencia | Linux | macOS | Windows (WSL) |
|------------|-------|-------|---------------|
| Node.js | `apt install nodejs` | `brew install node` | `wsl -d Ubuntu apt install nodejs` |
| tmux | `apt install tmux` | `brew install tmux` | `wsl -d Ubuntu apt install tmux` |
| opencode CLI | instrucciones oficiales | mismas | mismas via WSL |

### 3.5 Service management

- [ ] `telegram-opencode start` → arranca el bot como daemon/background
- [ ] `telegram-opencode stop` → lo detiene
- [ ] `telegram-opencode status` → está corriendo? PID? uptime?
- [ ] `telegram-opencode logs [-f]` → tail de logs
- [ ] Opción: PM2, systemd user service, o proceso background propio
- [ ] `telegram-opencode install-service` → instalar systemd user service (Linux) / launchd (macOS)

### 3.6 Config management

- [ ] `telegram-opencode config` → ver config actual
- [ ] `telegram-opencode config set KEY=VALUE` → cambiar config
- [ ] `telegram-opencode config show` → mostrar valores (ocultando token)
- [ ] Ubicación de config: `~/.config/telegram-opencode/` (XDG) o `~/.telegram-opencode/`

### 3.7 Actualizaciones

- [ ] `telegram-opencode update` → auto-actualizarse
- [ ] `telegram-opencode version` → versión actual
- [ ] Check de versión al iniciar

### 3.8 Instalación nativa (apt/rpm)

- [ ] Empaquetado .deb/.rpm para distribución
- [ ] systemd service incluido
- [ ] Scripts post-install para config

## 4. Preguntas abiertas

- ¿npm global package como primera etapa, instalador nativo como segunda?
- ¿Usar `commander` / `yargs` / `oclif` para CLI o algo custom?
- ¿Mantener soporte para `npm run dev` (desarrollo) además de `telegram-opencode start`?
- ¿El setup wizard debe ser React/ink (interactivo) o readline simple?
- ¿Windows sin WSL cómo se maneja? ¿Solo soporte WSL para el package global?
- ¿Migration path para usuarios existentes que ya tienen `.env` manual?
- ¿El doctor debe auto-instalar dependencias faltantes o solo informar?
