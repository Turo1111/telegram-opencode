# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog,
and this project adheres to Semantic Versioning.

## [Unreleased]

### Added
- RFC-013: Habilitado `/new <mensaje inicial>` en modo PTY con bootstrap tmux, detección conservadora de `sessionId`, auto-vinculación segura y fallback a `/sesiones` ante ambigüedad.
- RFC-014: Definido `/attach-local` para abrir terminal local y adjuntar `tmux` de sesión activa, con fallback manual.
- RFC-016: Selección de agente OpenCode desde Telegram con comandos `/agentes`, `/agente`, persistencia por chat+proyecto y propagación `agent` en payload de ejecución.
- RFC-017: Selección de modelo OpenCode desde Telegram con comandos `/modelos`, `/modelo`, `/modelo <id>`, catálogo dinámico por adapter, persistencia `activeModel` por chat+proyecto, propagación en ejecución y fallback/degradación explícitos.
- RFC-018: Notificación terminal en Telegram con agente/modelo efectivos, reporte explícito de drift requested→effective (fallback/override) y manejo seguro cuando metadata efectiva no está disponible.
- RFC-019: Hardening de `/sesion` como alias de `/sesiones`, verificación de paginación determinística (máximo 5 por página + callbacks `sesspg:<page>` + límites) y gate de cierre documental por token exacto en changelog.

### Changed
- RFC-015: Establecido proceso obligatorio de cierre RFC con actualización de `CHANGELOG.md` versionado (Keep a Changelog + SemVer) y referencia cruzada RFC.

### Fixed
- Sin cambios.

### Security
- RFC-012: Endurecida automatización local desde Telegram: `private-only`, flags apagadas por defecto, confirmación de 2 pasos, fail-closed y auditoría obligatoria.
