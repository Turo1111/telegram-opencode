# RFC-026 — Feedback visual de acciones (loading)

**Estado:** Borrador
**Autor:** —
**Fecha:** 6 de Mayo de 2026

## 1. Problema

Cuando el usuario envía un mensaje o ejecuta un comando, el bot puede tardar segundos en responder (especialmente si OpenCode está procesando). Durante ese tiempo el usuario no sabe si el bot está procesando, colgó, o ignoró el mensaje. No hay feedback visual.

## 2. Idea

Después de cada acción del usuario, mostrar algún indicador de que el bot está procesando:

- Un mensaje "⏳ Procesando..." que se reemplaza cuando llega la respuesta.
- Un callback query con "⏳" que se actualiza.
- Un "typing indicator" de Telegram.

## 3. Lo que falta / definir

### 3.1 Mecanismos disponibles

- [ ] **`sendChatAction`** de Telegram: muestra "escribiendo..." o "enviando..." en la interfaz del chat. No requiere mensaje, solo background.
- [ ] **Mensaje temporal**: enviar "⏳ Pensando..." y después editarlo con la respuesta real.
- [ ] **Reacción**: usar reacciones a mensajes (emoji ⏳→✅) como indicador.
- [ ] **Callback query feedback**: cuando la acción viene de un botón inline, responder con texto temporal.

### 3.2 Dónde aplicaría

| Acción | Feedback actual | Feedback propuesto |
|--------|----------------|--------------------|
| Texto libre | Silencio hasta respuesta | `sendChatAction("typing")` |
| `/agente <x>` | Silencio hasta confirmación | "⏳ Configurando agente..." |
| `/modelo <x>` | Silencio hasta confirmación | "⏳ Configurando modelo..." |
| `/cancel` | Silencio hasta confirmación | "⏳ Cancelando tarea..." |
| Callback prompt | `answerCallbackQuery` instant | ⏳ en el botón hasta resolver |
| `/sesiones` | Silencio hasta listado | "⏳ Consultando OpenCode..." |

### 3.3 Tipos de indicador

- **Light**: solo `sendChatAction("typing")`. Mínimo esfuerzo, feedback sutil.
- **Medium**: mensaje "⏳ {acción}..." que se edita con la respuesta.
- **Full**: mensaje temporal + barra de progreso (poco práctico en Telegram).

## 4. Preguntas abiertas

- ¿Light (sendChatAction) como default por simplicidad?
- ¿El mensaje temporal se borra después de N segundos si no hay respuesta?
- ¿Timeout: si OpenCode no responde en X segundos, mostrar "⏳ Aún procesando..."?
- ¿Aplicar a todos los comandos o solo a los lentos (>2s)?
- ¿El typing indicator de Telegram es suficiente o querés algo más visible?
- ¿Manejar el caso donde el mensaje temporal no se puede editar (ej: bot reiniciado entre medio)?
