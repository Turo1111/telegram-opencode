# Casos de uso — Telegram como consola remota de OpenCode

## Alcance de este documento
Este documento describe los flujos principales del producto objetivo y marca si cada uno:

- **Existe hoy**,
- **es prototipo parcial**,
- o **falta implementar**.

## Estado general actual
- **Hoy existe:** bot Telegram local por polling, envío de texto libre, llamada HTTP simple a OpenCode, mock local y scripts de arranque.
- **Hoy es prototipo:** canal de mensajería básico; no hay modelo de proyecto ni sesión.
- **Hoy falta:** asociación de proyecto, asociación/creación de sesión, notificaciones por watcher, recuperación real y control de concurrencia.

---

## 1) Asociación de proyecto
**Objetivo:** vincular un proyecto local a un chat autorizado para poder operar sobre él desde Telegram.

**Estado:** **falta**.

**Resultado esperado:** queda un proyecto registrado y, opcionalmente, marcado como activo.

```mermaid
flowchart TD
  A[Usuario pide asociar proyecto] --> B[Bot solicita alias o selecciona proyecto conocido]
  B --> C[Bot valida datos mínimos del proyecto]
  C --> D[Guarda binding chat-proyecto]
  D --> E[Confirma proyecto activo o disponible]
```

---

## 2) Asociación de sesión existente
**Objetivo:** conectar Telegram con una sesión de OpenCode ya iniciada en la PC.

**Estado:** **falta**.

**Resultado esperado:** el chat queda asociado a un `sessionId` existente dentro del proyecto activo.

```mermaid
flowchart TD
  A[Usuario elige proyecto activo] --> B[Envía sessionId existente]
  B --> C[Bot consulta si la sesión existe y es utilizable]
  C -->|sí| D[Guarda asociación chat-proyecto-sesión]
  C -->|no| E[Informa error y pide reintentar]
  D --> F[Confirma sesión activa]
```

---

## 3) Creación de nueva sesión
**Objetivo:** abrir una sesión nueva sobre el proyecto activo cuando no sirve continuar la anterior.

**Estado:** **falta**.

**Resultado esperado:** se crea una nueva sesión y pasa a ser la activa para el chat.

```mermaid
flowchart TD
  A[Usuario pide nueva sesión] --> B[Bot valida proyecto activo]
  B --> C[Bot solicita a OpenCode crear sesión]
  C --> D[Guarda nueva sesión como activa]
  D --> E[Responde con sessionId y estado inicial]
```

---

## 4) Continuación de sesión con mensaje libre
**Objetivo:** seguir una sesión activa desde Telegram usando lenguaje libre.

**Estado:** **hoy existe parcialmente** como prototipo, pero sin noción real de sesión.

**Resultado esperado:** el mensaje entra a la sesión activa y la respuesta vuelve al chat correcto.

```mermaid
flowchart TD
  A[Usuario envía mensaje libre] --> B[Bot resuelve proyecto y sesión activa]
  B --> C{¿Hay tarea en curso?}
  C -->|No| D[Envía mensaje a OpenCode]
  C -->|Sí| E[Aplica política de concurrencia]
  D --> F[Recibe respuesta o estado]
  F --> G[Responde al usuario]
  E --> G
```

---

## 5) Ejecución de comandos SDD/orquestador desde Telegram
**Objetivo:** disparar acciones estructuradas como continuar flujo, crear cambio o pedir estado.

**Estado:** **falta**.

**Resultado esperado:** el bot interpreta el comando, ejecuta la acción sobre la sesión activa y devuelve resultado o acuse.

```mermaid
flowchart TD
  A[Usuario envía comando] --> B[Bot parsea intención]
  B --> C[Valida proyecto y sesión activa]
  C --> D[Invoca operación de OpenCode/orquestador]
  D --> E[Responde acuse inmediato]
  E --> F[Si la tarea tarda, queda esperando finalización]
```

---

## 6) Notificación cuando termina una tarea iniciada desde Telegram
**Objetivo:** avisar que una tarea lanzada desde Telegram terminó.

**Estado:** **falta como flujo explícito**. Hoy solo existe respuesta sin seguimiento formal de tarea.

**Resultado esperado:** el usuario recibe una notificación final con resultado o siguiente acción.

```mermaid
sequenceDiagram
  participant U as Usuario
  participant B as Bot
  participant O as OpenCode

  U->>B: comando o mensaje
  B->>O: inicia tarea
  B->>U: acuse de recepción
  O-->>B: tarea finalizada
  B-->>U: notificación de fin + resumen
```

---

## 7) Notificación cuando termina una tarea iniciada desde la PC
**Objetivo:** avisar por Telegram que una tarea de una sesión observada terminó aunque se haya iniciado fuera del bot.

**Estado:** **falta**. Este es el salto a **Nivel 2**.

**Resultado esperado:** Telegram recibe el fin de tarea sin que el usuario haya iniciado esa ejecución desde el bot.

```mermaid
sequenceDiagram
  participant PC as OpenCode en PC
  participant W as Watcher
  participant B as Bot
  participant U as Usuario

  PC->>W: cambio de estado / fin de task
  W->>B: evento de sesión asociada
  B->>U: notificación automática
```

---

## 8) Respuesta/interacción cuando el orquestador pide confirmación
**Objetivo:** permitir que el usuario confirme o responda una pregunta del orquestador desde Telegram.

**Estado:** **falta**.

**Resultado esperado:** el flujo queda pausado esperando input y luego se reanuda con la respuesta del usuario.

```mermaid
flowchart TD
  A[OpenCode/orquestador pide confirmación] --> B[Bot notifica al usuario]
  B --> C[Usuario responde o confirma]
  C --> D[Bot reenvía input a la sesión activa]
  D --> E[La tarea continúa]
```

---

## 9) Cambio de proyecto
**Objetivo:** cambiar el proyecto activo del chat sin perder el registro de otros proyectos asociados.

**Estado:** **falta**.

**Resultado esperado:** otro proyecto pasa a ser el activo y la sesión asociada se actualiza o se invalida explícitamente.

```mermaid
flowchart TD
  A[Usuario pide cambio de proyecto] --> B[Bot lista o resuelve proyectos asociados]
  B --> C[Usuario elige nuevo proyecto]
  C --> D[Bot marca proyecto activo]
  D --> E[Resetea o reasocia sesión activa según política]
  E --> F[Confirma nuevo contexto]
```

---

## 10) Consulta de estado
**Objetivo:** saber rápidamente qué proyecto/sesión está activa y si hay algo corriendo o esperando respuesta.

**Estado:** **falta**.

**Resultado esperado:** el bot devuelve un resumen corto y confiable del contexto operativo.

```mermaid
flowchart TD
  A[Usuario pide estado] --> B[Bot lee proyecto activo]
  B --> C[Bot lee sesión activa]
  C --> D[Bot consulta tarea en curso o espera de input]
  D --> E[Responde resumen de estado]
```

---

## 11) Recuperación tras reinicio del bot
**Objetivo:** restaurar bindings mínimos y evitar que un reinicio deje al usuario completamente ciego.

**Estado:** **falta**.

**Resultado esperado:** al arrancar, el bot rehidrata asociaciones persistidas y puede continuar o informar cómo reanudar.

```mermaid
flowchart TD
  A[Bot reinicia] --> B[Carga persistencia local]
  B --> C[Rehidrata proyectos y sesiones asociadas]
  C --> D{¿Estado recuperable?}
  D -->|Sí| E[Queda listo para seguir]
  D -->|No| F[Informa contexto incompleto y pasos para reanudar]
```

---

## 12) Manejo de concurrencia / tarea ya en curso
**Objetivo:** evitar que PC y Telegram rompan la misma sesión con órdenes simultáneas o ambiguas.

**Estado:** **falta**.

**Resultado esperado:** el usuario recibe una respuesta explícita cuando ya hay trabajo en curso y el sistema aplica una política consistente.

```mermaid
flowchart TD
  A[Nueva orden desde Telegram o PC] --> B[Bot/Watcher detecta tarea activa]
  B --> C{Política}
  C -->|Bloquear| D[Rechaza nueva orden con estado actual]
  C -->|Encolar| E[Guarda orden pendiente]
  C -->|Reemplazar| F[Pide confirmación antes de interrumpir]
  D --> G[Usuario decide siguiente paso]
  E --> G
  F --> G
```

---

## Agrupación por fases

### v0.1 — base usable de cliente remoto
- Asociación de proyecto
- Asociación de sesión existente
- Creación de nueva sesión
- Continuación con mensaje libre
- Comandos SDD/orquestador
- Cambio de proyecto
- Consulta de estado
- Recuperación tras reinicio
- Política básica de concurrencia

### v1 / v1.1 — observación y continuidad real fuera de la PC
- Notificación de tareas iniciadas desde Telegram con modelo formal de task
- Notificación de tareas iniciadas desde la PC
- Confirmaciones del orquestador desde Telegram
- Watcher de sesión compartida

## Resumen franco
- **Lo que hoy existe:** forwarding local por polling y mock de OpenCode.
- **Lo que puede reutilizarse:** transporte Telegram, config, cliente HTTP, logs, scripts.
- **Lo que falta de verdad para el producto nuevo:** estado de proyecto/sesión, persistencia, comandos, watcher, recuperación y concurrencia.
