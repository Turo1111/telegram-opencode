# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog,
and this project adheres to Semantic Versioning.

## [Unreleased]

### Added
- RFC-013: Habilitado `/new <mensaje inicial>` en modo PTY con bootstrap tmux, detección conservadora de `sessionId`, auto-vinculación segura y fallback a `/sesiones` ante ambigüedad.
- RFC-014: Definido `/attach-local` para abrir terminal local y adjuntar `tmux` de sesión activa, con fallback manual.

### Changed
- RFC-015: Establecido proceso obligatorio de cierre RFC con actualización de `CHANGELOG.md` versionado (Keep a Changelog + SemVer) y referencia cruzada RFC.

### Fixed
- Sin cambios.

### Security
- RFC-012: Endurecida automatización local desde Telegram: `private-only`, flags apagadas por defecto, confirmación de 2 pasos, fail-closed y auditoría obligatoria.
