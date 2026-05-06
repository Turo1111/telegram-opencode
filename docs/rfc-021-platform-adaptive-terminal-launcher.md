# RFC-021 — Platform-Adaptive Terminal Launcher

**Estado:** Propuesto  
**Autor:** AI Architect  
**Fecha:** 6 de Mayo de 2026

## 1. Contexto

El proyecto opera sesiones OpenCode en modo **PTY/tmux**. El bot permite adjuntarse a la sesión tmux activa desde una terminal local mediante `/attach-local` (RFC-014), que hoy asume **Windows + WSL** como único entorno.

La implementación actual en `local-terminal-launcher.ts` hardcodea:

- Detección de `wsl.exe` y `powershell.exe` para validar entorno
- Comando manual siempre como `wsl.exe bash -lc 'tmux attach -t <session>'`
- Launcher via `wt.exe` → `powershell.exe` → `wsl.exe`

Esto excluye a usuarios en **Linux nativo**, **macOS** y **Windows sin WSL** (Git Bash, MSYS2, Cygwin).

## 2. Problema

### 2.1 Asunciones WSL en toda la base

| Ubicación | Línea | Código hardcodeado |
|-----------|-------|-------------------|
| `use-cases.ts` | 1867 | `wsl.exe bash -lc 'tmux attach -t ...'` |
| `local-terminal-launcher.ts` | 31 | `wsl.exe bash -lc 'tmux attach -t ...'` |
| `local-terminal-launcher.ts` | 20,70 | Solo detecta `wsl.exe` + `powershell.exe` |
| `local-terminal-launcher.ts` | 39,54 | Solo lanza `wt.exe`/`powershell.exe` → `wsl.exe` |

### 2.2 Mensajes de usuario excluyentes

8 ocurrencias en `src/` dicen "PC/WSL", invisible para Linux/macOS nativos.

### 2.3 Fallo en Linux nativo

`isEnvironmentReady()` busca `wsl.exe` y `powershell.exe`. En Linux ninguno existe → devuelve `unsupported-platform` aunque tmux esté instalado nativamente.

### 2.4 Comando manual inválido fuera de WSL

`wsl.exe bash -lc 'tmux attach -t <s>'` no funciona en Linux, macOS, ni Windows sin WSL.

## 3. Escenarios objetivo

| # | Escenario | process.platform | tmux | bash | Terminal launcher |
|---|-----------|-----------------|------|------|-------------------|
| 1 | Windows + WSL (Ubuntu) | win32 | ✅ via WSL | wsl.exe | wt.exe → powershell.exe |
| 2 | Windows + Git Bash | win32 | ✅ via Git bash | bash.exe (Git) | wt.exe → powershell.exe |
| 3 | Windows + MSYS2 | win32 | ✅ via MSYS2 | bash.exe (MSYS2) | wt.exe → powershell.exe |
| 4 | Windows + Cygwin | win32 | ✅ via Cygwin | bash.exe (Cygwin) | wt.exe → powershell.exe |
| 5 | Linux nativo | linux | ✅ nativo | bash nativo | gnome-terminal → konsole → x-terminal-emulator → $TERMINAL |
| 6 | macOS | darwin | ✅ via brew | bash nativo | open -a Terminal → open -a iTerm |
| 7 | Windows sin bash ni WSL | win32 | ❌ | ❌ | **unsupported** |

### Restricción: tmux es obligatorio

**En todos los escenarios, tmux debe estar disponible en PATH.** No hay soporte para sesiones PTY sin tmux. Es el denominador común de la arquitectura de sesiones del proyecto (RFC-013).

## 4. Arquitectura propuesta

### 4.1 PlatformDetector: detecta capabilities, no solo platform

En vez de `if (platform === "win32")`, se detecta qué herramientas existen:

```text
PlatformDetector
├── detectPlatform()       → "windows" | "linux" | "macos"
├── hasWsl()               → wsl.exe disponible?
├── hasBash()              → bash.exe disponible? (Windows)
├── hasTmux()              → tmux en PATH?
├── hasWindowsTerminal()   → wt.exe disponible?
├── hasPowershell()        → powershell.exe disponible?
├── hasLinuxTerminal()     → gnome-terminal | konsole | etc
├── hasMacTerminal()       → Terminal.app | iTerm.app
└── resolveStrategy()      → selecciona LauncherStrategy
```

### 4.2 LauncherStrategy: strategy pattern para lanzar terminal

```typescript
interface LauncherStrategy {
  readonly platform: Platform;
  readonly name: string;
  isAvailable(): Promise<boolean>;
  launch(sessionName: string): Promise<LaunchResult>;
  getManualCommand(sessionName: string): string;
  getEnvironmentLabel(): string;  // "PC (WSL)", "PC (Git Bash)", "Linux", "Mac"
}
```

### 4.3 Implementaciones concretas

| Strategy | Detecta | Manual command | Launcher chain |
|----------|---------|---------------|----------------|
| `WindowsWslStrategy` | `wsl.exe` presente | `wsl.exe bash -lc 'tmux attach -t <s>'` | `wt.exe` → `powershell.exe` (igual actual) |
| `WindowsBashStrategy` | `bash.exe` presente, sin WSL | `bash.exe -lc 'tmux attach -t <s>'` | `wt.exe` → `powershell.exe` |
| `LinuxNativeStrategy` | `platform === "linux"` | `tmux attach -t <s>` | `gnome-terminal` → `konsole` → `x-terminal-emulator` → `$TERMINAL` |
| `MacNativeStrategy` | `platform === "darwin"` | `tmux attach -t <s>` | `open -a Terminal` → `open -a iTerm` |
| `UnsupportedStrategy` | cualquier otro | N/A | N/A |

### 4.4 Dispatch: resolución en orden de prioridad

```text
resolveStrategy():
  1. Si win32 + wsl.exe        → WindowsWslStrategy
  2. Si win32 + bash.exe       → WindowsBashStrategy
  3. Si linux + tmux           → LinuxNativeStrategy
  4. Si darwin + tmux          → MacNativeStrategy
  5. Sino                      → UnsupportedStrategy
```

`isEnvironmentReady()` delega a `strategy.isAvailable()`:

```text
isAvailable() =
  tmux disponible en PATH
  AND (launcher disponible OR true)  // true porque manual command es fallback
```

## 5. Cambios en el código

### 5.1 Archivos nuevos

| Archivo | Propósito |
|---------|-----------|
| `src/infrastructure/launcher/platform-detector.ts` | Detección de capabilities del SO |
| `src/infrastructure/launcher/types.ts` | Interfaces `LauncherStrategy`, `Platform`, tipos |
| `src/infrastructure/launcher/strategies/windows-wsl.ts` | Strategy para Windows + WSL |
| `src/infrastructure/launcher/strategies/windows-bash.ts` | Strategy para Windows + Git Bash/MSYS2/Cygwin |
| `src/infrastructure/launcher/strategies/linux-native.ts` | Strategy para Linux nativo |
| `src/infrastructure/launcher/strategies/mac-native.ts` | Strategy para macOS |
| `src/infrastructure/launcher/strategies/unsupported.ts` | Fallback para entornos no soportados |

### 5.2 Archivos a modificar

| Archivo | Cambio |
|---------|--------|
| `src/infrastructure/local-terminal-launcher.ts` | Reemplazar lógica monolítica por dispatch a `PlatformDetector.resolveStrategy()` |
| `src/application/use-cases.ts:1867` | Usar `strategy.getManualCommand()` en vez de hardcode `wsl.exe` |
| `src/infrastructure/opencode-cli.ts:351,547` | Reemplazar "PC/WSL" por `strategy.getEnvironmentLabel()` o genérico "terminal local" |
| `src/infrastructure/opencode-session-adapter.ts:629,845,866,968` | Idem |
| `src/adapters/telegram/router.ts:117` | Idem |
| `src/adapters/telegram/templates.ts:188` | Idem |
| `README.md` | Ver sección 7 |
| `start-local.js` | Sin cambios (no depende de WSL) |
| `stop-local.js` | Sin cambios (runtime file + pgrep en Linux, win32 skip intencional) |

### 5.3 Detalle: `local-terminal-launcher.ts` refactor

**Estado actual** (~80 líneas, monolítico):

```typescript
export function createLocalTerminalLauncher(options): LocalTerminalLauncher {
  const platform = options.platform ?? process.platform;

  return {
    async isEnvironmentReady() {
      if (platform === "win32") return { ok: true };
      // busca wsl.exe, powershell.exe...
    },
    async launchAttach(input) {
      const manualCommand = `wsl.exe bash -lc 'tmux attach -t ${...}'`;
      // prueba wt.exe, powershell.exe, wsl.exe...
    },
  };
}
```

**Estado futuro** (~30 líneas, dispatch):

```typescript
export function createLocalTerminalLauncher(options): LocalTerminalLauncher {
  const detector = new PlatformDetector(options);
  const strategy = detector.resolveStrategy();

  return {
    async isEnvironmentReady() {
      if (!strategy.isAvailable()) {
        return { ok: false, reason: "unsupported-platform" };
      }
      return { ok: true };
    },
    async launchAttach(input) {
      return strategy.launch(input.tmuxSessionName);
    },
    getManualCommand(sessionName: string) {
      return strategy.getManualCommand(sessionName);
    },
    getEnvironmentLabel() {
      return strategy.getEnvironmentLabel();
    },
  };
}
```

### 5.4 Detalle: mensajes usuario

| Actual | Nuevo (genérico) | Nuevo (platform-aware) |
|--------|------------------|------------------------|
| `"desde PC/WSL"` | `"desde tu terminal local"` | `"desde tu PC (Git Bash)"` / `"desde tu terminal Linux"` / etc. |

Opción recomendada: usar `strategy.getEnvironmentLabel()` que devuelve:

- `"PC (WSL)"` para Windows + WSL
- `"PC (Git Bash/MSYS2/Cygwin)"` para Windows + bash
- `"Linux"` para Linux nativo
- `"Mac"` para macOS

O versión simplificada genérica: `"terminal local"` (menos info, cero falso).

## 6. Detección de bash.exe en Windows

En Windows sin WSL, el bash proviene de:

| Origen | Path típico | Detectable con |
|--------|-------------|----------------|
| Git Bash | `C:\Program Files\Git\bin\bash.exe` | `where bash.exe` |
| MSYS2 | `C:\msys64\usr\bin\bash.exe` | `where bash.exe` |
| Cygwin | `C:\cygwin64\bin\bash.exe` | `where bash.exe` |

`where.exe bash.exe` es el equivalente Windows de `which`. Ya se usa en `local-terminal-launcher.ts` para detectar `wt.exe`.

```typescript
const bashAvailable = await canExec("where.exe", ["bash.exe"], timeoutMs);
```

Si existe, se puede ejecutar:

```typescript
bash.exe -lc 'tmux attach -t <session>'
```

## 7. README y Quick Start

### 7.1 Sección Requisitos (README)

Actual:

```markdown
- `tmux` disponible en `PATH`
```

Propuesto (expandir con contexto multiplataforma):

```markdown
- `tmux` disponible en `PATH`

  **Windows:** via WSL (Ubuntu), Git Bash, MSYS2 o Cygwin.
  **Linux:** `apt install tmux` / `pacman -S tmux` / `dnf install tmux`.
  **macOS:** `brew install tmux`.

  tmux es OBLIGATORIO. No hay soporte de sesiones PTY sin tmux.
```

### 7.2 Sección Adjuntarte desde PC (README)

Actual:

```markdown
## Adjuntarte desde PC a la misma sesión

El nombre de la sesión `tmux` queda así:

```bash
tmux attach -t tgoc_<session_id_sanitized>
```

Ejemplo:

```bash
tmux attach -t tgoc_mi-session-123
```
```

Propuesto (platform-aware):

```markdown
## Adjuntarte desde tu terminal local a la misma sesión

El nombre de la sesión `tmux` sigue el formato:

```bash
tmux attach -t tgoc_<session_id_sanitized>
```

El comando exacto depende de tu plataforma:

| Plataforma | Comando |
|------------|---------|
| **Windows + WSL** | `wsl.exe bash -lc 'tmux attach -t tgoc_<id>'` |
| **Windows + Git Bash/MSYS2** | `bash.exe -lc 'tmux attach -t tgoc_<id>'` |
| **Linux nativo** | `tmux attach -t tgoc_<id>` |
| **macOS** | `tmux attach -t tgoc_<id>` |

También podés usar `/attach-local` desde Telegram (si está habilitado) para que el bot abra la terminal automáticamente.
```

### 7.3 Quick Start — paso 5

Actual:

```markdown
5. Abrí o continuá una sesión real de OpenCode desde tu terminal, o usá `/new <mensaje inicial>` desde Telegram después de elegir proyecto.
```

Propuesto:

```markdown
5. Abrí o continuá una sesión real de OpenCode desde tu terminal (Linux/macOS nativo, WSL, Git Bash, etc.), o usá `/new <mensaje inicial>` desde Telegram después de elegir proyecto.
```

### 7.4 Sección Problemas comunes — "El proyecto no coincide en WSL"

Actual: solo habla de WSL y `/mnt/d/` paths.

Propuesto: expandir la sección para cubrir Windows sin WSL:

```markdown
### El proyecto no coincide (WSL / Windows / Linux)

Usá rutas que existan y sean visibles tanto para Node.js como para OpenCode.

**WSL:** rutas Linux, ej: `/home/user/proyecto` o `/mnt/d/Proyectos/mi-proyecto`.  
**Windows (Git Bash/MSYS2):** rutas Windows con slash, ej: `/c/Users/tu/Documentos/mi-proyecto` o `C:\Users\tu\...`.  
**Linux/macOS nativo:** rutas nativas del sistema.
```

## 8. Riesgos y mitigaciones

### 8.1 Git Bash/MSYS2/Cygwin: PATH inconsistency

**Riesgo:** `bash.exe` detectado pero tmux no está en el PATH de ese bash, o viceversa.  
**Mitigación:** verificar que `bash.exe -lc 'which tmux'` funcione dentro del timeout ANTES de declarar la plataforma como soportada.

### 8.2 Terminal launcher en Linux no disponible

**Riesgo:** Linux sin `gnome-terminal`, `konsole`, ni `x-terminal-emulator` (ej: servidor headless).  
**Mitigación:** `isAvailable()` solo verifica tmux. El launcher gráfico es best-effort. Si no hay, se devuelve el comando manual como fallback. `isAvailable()` devuelve `true` si tmux existe, independientemente del launcher gráfico.

### 8.3 Windows Terminal no instalado

**Riesgo:** En Windows sin `wt.exe`, la estrategia cae a `powershell.exe`.  
**Mitigación:** ya implementado en el código actual. Se mantiene la misma cadena: `wt.exe` → `powershell.exe` → manual command.

### 8.4 macOS no probado

**Riesgo:** No hay CI/CD en macOS. La implementación puede tener bugs no detectados.  
**Mitigación:** documentar como "experimental" en macOS. El comando manual siempre funciona.

### 8.5 Regresión en flujo WSL existente

**Riesgo:** El refactor rompe el escenario principal (Windows + WSL) que actualmente funciona.  
**Mitigación:** el `WindowsWslStrategy` replica exactamente la misma lógica actual (misma cadena de launcher, mismo comando manual). Los tests de verificación RFC-14 deben pasar sin cambios.

## 9. Alternativas consideradas

### A. PlatformDetector con strategy pattern

**Recomendada.** Cada plataforma tiene su propia clase. Fácil de extender, testear y mantener. Bajo acoplamiento.

### B. If/else en `local-terminal-launcher.ts`

Descartada. El archivo ya tiene 80 líneas con lógica mezclada. Agregar 4 caminos más lo haría ilegible y difícil de testear.

### C. Config-driven: definir comando en `.env`

Pasaría la responsabilidad al usuario. Mala UX. El bot debe auto-detectar.

### D. Siempre devolver comando manual, nunca abrir terminal

Simplifica el código pero pierde el valor de `/attach-local`. El launcher automático es la feature principal de RFC-014.

## 10. Criterios de aceptación

- [ ] `local-terminal-launcher.ts` delega en strategies, no tiene lógica de plataforma inline.
- [ ] `PlatformDetector.resolveStrategy()` selecciona la strategy correcta en cada escenario.
- [ ] `isEnvironmentReady()` devuelve `ok:true` si tmux existe, independientemente de WSL.
- [ ] En **Windows + WSL**: todo funciona exactamente como hoy (wt.exe → powershell → comando manual wsl.exe).
- [ ] En **Windows + Git Bash/MSYS2/Cygwin**: detecta `bash.exe`, comando manual con `bash.exe -lc`, launcher via wt.exe/powershell.
- [ ] En **Linux nativo**: comando manual `tmux attach -t <s>`, launcher via terminal nativo si disponible.
- [ ] En **macOS**: comando manual `tmux attach -t <s>`, launcher via Terminal.app/iTerm si disponible.
- [ ] En **Windows sin bash ni WSL**: `isEnvironmentReady()` devuelve `unsupported-platform`.
- [ ] Mensajes de usuario NO mencionan "PC/WSL" cuando no corresponde (o usan versión genérica).
- [ ] Sección "Requisitos" del README actualizada con instrucciones de instalación de tmux por plataforma.
- [ ] Sección "Adjuntarte desde PC" del README actualizada con comandos por plataforma.
- [ ] RFC-14 verification tests (`npm run verify:rfc14`) pasan sin cambios.
- [ ] No hay regresión en `/attach-local` en flujo WSL.
