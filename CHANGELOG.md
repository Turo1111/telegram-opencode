# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog,
and this project adheres to Semantic Versioning.

## [Unreleased]

### Added
- RFC-026: Feedback visual de acciones (loading). Borrador para indicador "⏳ Procesando..." vía sendChatAction, mensajes editables, o callback feedback.
- RFC-025: Instalación global y CLI setup wizard. Borrador para empaquetar como `npm install -g telegram-opencode`, first-run wizard, subcomandos start/stop/status/logs/doctor/config, service management con systemd.
- RFC-024: Preguntar al iniciar si reanudar última sesión. Borrador para post-reconciliación interactiva con botones inline Reanudar/No.
- RFC-023: Interrupción de sesión desde Telegram. Borrador para completar y verificar `/cancel` end-to-end, botón inline Cancelar, confirmación.
- RFC-022: Project Registry. Catálogo persistente de proyectos con tabla `projects` existente en SQLite. Comandos `/projects` (listar), `/project <alias|ruta>` (seleccionar con alias), `/project --forget <alias>` (eliminar), `/project --alias <nombre>` (alias explícito). Auto-descubrimiento desde sesiones OpenCode.
- RFC-021: Platform-Adaptive Terminal Launcher. Estrategias por plataforma para `/attach-local`: Windows+WSL, Windows+Git Bash/MSYS2/Cygwin, Linux nativo, macOS (experimental). 7 archivos nuevos bajo `src/infrastructure/launcher/`.
- RFC-013: Habilitado `/new <mensaje inicial>` en modo PTY con bootstrap tmux, detección conservadora de `sessionId`, auto-vinculación segura y fallback a `/sesiones` ante ambigüedad.
- RFC-014: Definido `/attach-local` para abrir terminal local y adjuntar `tmux` de sesión activa, con fallback manual.
- RFC-016: Selección de agente OpenCode desde Telegram con comandos `/agentes`, `/agente`, persistencia por chat+proyecto y propagación `agent` en payload de ejecución.
- RFC-017: Selección de modelo OpenCode desde Telegram con comandos `/modelos`, `/modelo`, `/modelo <id>`, catálogo dinámico por adapter, persistencia `activeModel` por chat+proyecto, propagación en ejecución y fallback/degradación explícitos.
- RFC-018: Notificación terminal en Telegram con agente/modelo efectivos, reporte explícito de drift requested→effective (fallback/override) y manejo seguro cuando metadata efectiva no está disponible.
- RFC-019: Hardening de `/sesion` como alias de `/sesiones`, verificación de paginación determinística (máximo 5 por página + callbacks `sesspg:<page>` + límites) y gate de cierre documental por token exacto en changelog.
- RFC-020: Catálogo dinámico de agentes desde OpenCode. Reemplazado SUPPORTED_AGENTS singleton por catálogo consultado a OpenCode con caché TTL 30s, fallback a FALLBACK_AGENTS hardcodeado, notificación doble canal (Telegram ⚠️ + logger.warn), validación dinámica en /agente. Implementado en HTTP, CLI y PTY adapters. Mock extendido con /opencode/agents.

### Changed
- RFC-021: Refactorizado `local-terminal-launcher.ts` (~115→~30 líneas) con Strategy Pattern. Eliminadas 8 ocurrencias de "PC/WSL" en mensajes usuario. README actualizado con requisitos multiplataforma.
- RFC-015: Establecido proceso obligatorio de cierre RFC con actualización de `CHANGELOG.md` versionado (Keep a Changelog + SemVer) y referencia cruzada RFC.

### Fixed
- WSL console crash when sending Telegram message (fix-close-wsl)
  - Added uncaughtException handler to prevent process exit on sync throws
  - Added .catch() to fire-and-forget promise chains
  - Added stderr diagnostics in start-local.js with 500ms shutdown delay
  - Added graceful node:sqlite fallback with once-only logging in mirror service

### Security
- RFC-012: Endurecida automatización local desde Telegram: `private-only`, flags apagadas por defecto, confirmación de 2 pasos, fail-closed y auditoría obligatoria.
