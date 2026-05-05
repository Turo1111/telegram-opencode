# RFC-016 — Selección de agente OpenCode desde Telegram

**Estado:** Propuesto  
**Autor:** AI Architect  
**Fecha:** 29 de Abril de 2026

## 1. Contexto

Hoy el flujo Telegram → OpenCode no expone selección explícita de agente por ejecución. El usuario no controla, desde chat, si quiere correr con perfil `build`, `plan`, `gentleman` o `sdd-orchestrator`.

## 2. Problema

Sin selector de agente:

1. baja trazabilidad de intención por ejecución;
2. se mezclan casos de uso (planificación vs implementación) con mismo comportamiento;
3. se fuerza configuración fuera de Telegram;
4. sube riesgo operativo por ejecutar con agente incorrecto.

## 3. Objetivo

Permitir elegir agente de OpenCode desde Telegram, con validación estricta y persistencia por chat/proyecto para no repetir selección en cada mensaje.

Agentes iniciales permitidos:

- `build`
- `plan`
- `gentleman`
- `sdd-orchestrator`

## 4. Alcance

### Entra en alcance

- Nuevo comando para listar/seleccionar agente.
- Persistencia de agente activo por contexto de chat/proyecto.
- Inclusión del agente seleccionado en requests a OpenCode.
- Fallback a agente por defecto si no hay selección explícita.

### Fuera de alcance

- Creación dinámica de agentes desde Telegram.
- Permitir cualquier string no registrado.
- Políticas avanzadas de routing automático por tipo de prompt.

## 5. UX propuesta

Comandos (definitivos para implementación):

- `/agente` → muestra agente activo.
- `/agentes` → lista agentes disponibles.
- `/agente <nombre>` → cambia agente activo.

Valores objetivo iniciales:

- `build`
- `plan`
- `gentleman`
- `sdd-orchestrator`

Ejemplos:

- `/agente plan`
- `/agente sdd-orchestrator`

Mensajes esperados:

- éxito: `✅ Agente activo: plan`
- inválido: `🔴 Agente no válido. Opciones: build, plan, gentleman, sdd-orchestrator`

## 6. Diseño técnico

### 6.1 Modelo

Agregar a contexto persistido de chat/proyecto:

```ts
activeAgent: 'build' | 'plan' | 'gentleman' | 'sdd-orchestrator'
```

### 6.2 Adaptador OpenCode

Incluir `activeAgent` en payload de ejecución (o en campo equivalente del contrato actual), sin romper compatibilidad backward.

### 6.3 Validación

- allowlist cerrada de agentes;
- fallback seguro a default configurable (`build` sugerido) cuando no exista selección;
- rechazo explícito en input inválido.

## 7. Alternativas evaluadas

### A) Agente fijo por `.env`

**Pros:** simple.  
**Contras:** nula flexibilidad por ejecución/chat.

### B) Agente por comando puntual (`/run --agent`)

**Pros:** granularidad máxima.  
**Contras:** más fricción, más errores de tipeo, peor UX móvil.

### C) Agente persistido por chat/proyecto (decisión)

**Pros:** equilibrio entre control y velocidad.  
**Contras:** requiere estado y mensajes claros de “agente activo”.

## 8. Riesgos y mitigaciones

- **Riesgo:** usuario olvida agente activo.  
  **Mitigación:** mostrar estado en `/agente` y en respuesta final (ver RFC-018).

- **Riesgo:** drift entre catálogo local y OpenCode real.  
  **Mitigación:** catálogo centralizado y validado contra configuración/capabilities.

## 9. Criterios de aceptación

1. usuario puede listar agentes disponibles desde Telegram;
2. usuario puede setear agente válido y queda persistido por contexto;
3. request a OpenCode incluye agente activo;
4. inputs inválidos devuelven error claro sin ejecutar.

## 10. Plan de implementación

1. Definir enum/allowlist de agentes soportados.
2. Extender almacenamiento de contexto de chat/proyecto.
3. Implementar comandos `/agente` y `/agentes`.
4. Inyectar agente activo en adaptador OpenCode.
5. Verificar manualmente con mock y entorno local.
