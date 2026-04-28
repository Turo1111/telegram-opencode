# RFC-015 — Changelog versionado y actualización obligatoria al cerrar RFC

**Estado:** Implementado  
**Autor:** AI Architect  
**Fecha:** 28 de Abril de 2026

## 1. Contexto

El repositorio tiene RFCs técnicos por funcionalidad, pero no tiene una política explícita y estable para registrar cambios por versión en un único historial de releases.

Hoy, parte del historial queda disperso entre:

- RFCs (`docs/rfc-*.md`)
- commits
- notas informales en conversaciones

Eso complica trazabilidad de “qué salió en cada versión” y dificulta auditoría operativa.

## 2. Problema

Sin un changelog formal:

1. no hay fuente única de verdad por versión;
2. el cierre de RFC no garantiza reflejo en release notes;
3. QA y operación pierden contexto de impacto;
4. aumenta riesgo de regresiones por cambios no comunicados.

Además, mezclar changelog dentro de `AGENTS.md` no es correcto: ese archivo define reglas operativas para agentes, no historial de producto.

## 3. Objetivo

Definir e institucionalizar un flujo:

**cierre de RFC → actualización obligatoria de changelog versionado**

con formato consistente, fácil de revisar y auditable.

## 4. Decisión

### 4.1 Ubicación del changelog

Crear `CHANGELOG.md` en raíz del repositorio.

`AGENTS.md` queda reservado para convenciones de trabajo de agentes, sin historial de versiones.

### 4.2 Estándar

Adoptar:

- **Keep a Changelog** (estructura de secciones)
- **SemVer** (versionado)

Secciones por release:

- `Added`
- `Changed`
- `Fixed`
- `Security`

### 4.3 Regla operativa obligatoria

No se considera “RFC cerrado” hasta cumplir:

1. RFC en estado `Implementado` (o equivalente definido por equipo).
2. Entrada en `CHANGELOG.md`:
   - en `Unreleased` si aún no hay corte de versión,
   - o en bloque de versión concreta si hay release.
3. Referencia cruzada al RFC (ej. `RFC-015`).

## 5. Alcance

### Entra en alcance

- Definir archivo `CHANGELOG.md` y su plantilla inicial.
- Definir política de actualización en cierre de RFC.
- Definir checklist mínimo de cierre.

### Fuera de alcance

- Automatización CI/CD de releases (puede venir en RFC futuro).
- Publicación automática en GitHub Releases.
- Backfill completo de historial pasado (opcional).

## 6. Formato propuesto

Ejemplo de estructura en `CHANGELOG.md`:

```md
# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog,
and this project adheres to Semantic Versioning.

## [Unreleased]

### Added
- ...

### Changed
- ...

### Fixed
- ...

### Security
- ...

## [0.15.0] - 2026-04-28

### Added
- RFC-015: Política de changelog versionado obligatoria al cerrar RFC.
```

Reglas de redacción:

- Cada ítem describe impacto observable (no detalle interno irrelevante).
- Cada ítem referencia RFC/issue/PR cuando exista.
- Evitar ruido de refactors sin impacto externo, salvo que cambien comportamiento.

## 7. Proceso de cierre de RFC

Checklist mínimo:

1. Validar implementación y evidencias (manual/test según RFC).
2. Cambiar estado del RFC a `Implementado`.
3. Actualizar `CHANGELOG.md` en `Unreleased` o versión objetivo.
4. Confirmar referencia cruzada RFC ↔ changelog.
5. Recién ahí: considerar RFC cerrado.

## 8. Alternativas evaluadas

### A) Changelog dentro de `AGENTS.md`

**Pros:** un solo archivo para agentes.  
**Contras:** mezcla responsabilidades, degrada mantenibilidad, y rompe separación entre “reglas operativas” vs “historial de producto”.

### B) `docs/releases/<version>.md` por versión

**Pros:** más detalle narrativo por release.  
**Contras:** mayor carga operativa y riesgo de duplicación con changelog central.

### C) Solo GitHub Releases

**Pros:** integrado con plataforma.  
**Contras:** acopla proceso a herramienta y no garantiza fuente local versionada en repo.

Decisión tomada: **archivo `CHANGELOG.md` central + referencia a RFC**.

## 9. Plan de implementación

1. Crear `CHANGELOG.md` base con `Unreleased`.
2. Agregar en `AGENTS.md` una regla breve de proceso:
   - “Al cerrar RFC, actualizar changelog obligatorio”.
3. Aplicar desde el próximo RFC cerrado.
4. (Opcional) backfill de los últimos RFCs implementados.

## 10. Riesgos y mitigaciones

- **Riesgo:** entradas inconsistentes de changelog.  
  **Mitigación:** plantilla fija + checklist de cierre.

- **Riesgo:** olvidos en cierres rápidos.  
  **Mitigación:** definición explícita de “Done = RFC + changelog”.

- **Riesgo:** sobrecarga operativa inicial.  
  **Mitigación:** formato breve, orientado a impacto.

## 11. Criterios de aceptación

Se considera adoptado cuando:

1. existe `CHANGELOG.md` en raíz con sección `Unreleased`;
2. existe regla documentada de cierre RFC→changelog;
3. próximo RFC cerrado incluye entrada correspondiente en changelog.

## 12. Próximos pasos

1. Aprobar RFC-015.
2. Ejecutar implementación mínima (crear `CHANGELOG.md` + regla en `AGENTS.md`).
3. Aplicar en el siguiente cierre de RFC.
