# RFC-008: Confirmaciones humanas y handoff PC ↔ Telegram

**Estado:** Propuesto  
**Autor:** AI Architect  
**Fecha:** 14 de Abril de 2026  

## 1. Contexto y Problema

Los agentes autónomos de OpenCode (y herramientas similares) a menudo requieren intervención humana durante la ejecución de una tarea. Ejemplos comunes incluyen:
- Aceptar o rechazar un plan de acción propuesto por el agente.
- Autorizar un comando destructivo (ej. `rm -rf`, `DROP TABLE`).
- Resolver un conflicto o responder a una pregunta ambigua ("Judgment Day").

En un entorno puramente local, el CLI de OpenCode pausa la ejecución y muestra un prompt en la terminal (`stdin`). En nuestra arquitectura de control remoto (Nivel 2), el usuario no está frente a la terminal, sino en Telegram. 

Si el bot no maneja estas interrupciones, la sesión de OpenCode quedará bloqueada indefinidamente esperando un input que el usuario nunca verá.

## 2. Objetivos

- Interceptar las solicitudes de confirmación o input requeridas por OpenCode.
- Reenviar estas solicitudes al usuario en Telegram de forma clara y accionable.
- Permitir que la respuesta del usuario en Telegram reanude la ejecución en la PC local.
- Manejar escenarios de "Handoff" (el usuario responde físicamente en la PC en lugar de Telegram).

## 3. Propuesta: Event-Driven Prompts e Inline Keyboards

Dado que en el RFC-007 establecimos una comunicación asíncrona mediante Webhooks locales, utilizaremos este mismo canal para las interrupciones.

### 3.1. Flujo de Solicitud de Input

1. **Interrupción en OpenCode:**
   Cuando el agente de OpenCode detecta que necesita input humano, emite un webhook al bot:
   ```json
   {
     "event": "SESSION_NEEDS_INPUT",
     "session_id": "sess-xyz",
     "data": {
       "prompt_type": "boolean",
       "message": "El agente propone ejecutar 'npm run db:reset'. ¿Autorizar?",
       "options": ["Sí, ejecutar", "No, cancelar"]
     }
   }
   ```
2. **Notificación en Telegram:**
   El bot recibe el evento y envía un mensaje al Chat bloqueado (que actualmente está en estado "Busy").
   Para inputs booleanos o de opciones múltiples, el bot utilizará **Inline Keyboards** (botones bajo el mensaje). Para inputs de texto abierto, simplemente pedirá al usuario que escriba su respuesta.
3. **Respuesta del Usuario:**
   El usuario presiona un botón o envía un texto.
4. **Reanudación (Resume):**
   El bot envía la respuesta de vuelta al proceso de OpenCode. Esto requerirá que OpenCode exponga un endpoint local o que el bot inyecte la respuesta directamente en el `stdin` del proceso (si el bot es quien lo generó vía `spawn`).

### 3.2. Handoff (Transición PC ↔ Telegram)

¿Qué ocurre si el usuario inició la tarea por Telegram, pero cuando el agente pide confirmación, el usuario ya volvió a sentarse frente a su PC?
- Si la sesión de OpenCode está corriendo en background (daemon), el usuario tendría que hacer un `opencode attach sess-xyz` en su terminal para ver el prompt.
- Si el usuario responde físicamente en la terminal, OpenCode continuará la ejecución.
- **Resolución de estado:** El bot de Telegram recibirá un nuevo webhook de OpenCode (ej. `SESSION_RESUMED` o simplemente seguirá recibiendo logs). Al detectar esto, el bot debe **invalidar** los botones de Inline Keyboard en Telegram (editando el mensaje para quitar los botones) para evitar que el usuario los presione horas después de que la tarea ya continuó.

## 4. Escenarios y Edge Cases

### 4.1. El usuario ignora el prompt en Telegram
Si el bot envía la pregunta pero el usuario se fue a dormir.
**Solución:** OpenCode o el bot deben implementar un **Timeout de Inactividad**. Si no hay respuesta en X horas, la sesión se cancela automáticamente (`SESSION_FAILED` por timeout) y se libera el Lock del chat.

### 4.2. El usuario envía texto mientras se esperan botones
El usuario, en lugar de apretar "Sí" o "No", escribe "Dale mandale".
**Solución:** Si el prompt es estricto (`prompt_type: boolean`), el bot interceptará el texto libre, lo ignorará o lo procesará con un LLM liviano para mapearlo a "Sí/No", o simplemente le recordará al usuario: *"Por favor, usa los botones."*

## 5. Consecuencias

- **Positivas:** Permite delegar tareas complejas y destructivas con total tranquilidad, sabiendo que el agente no hará nada peligroso sin un "Ok" explícito en el celular.
- **Negativas:** Añade complejidad técnica bidireccional. El bot no solo lee la salida del proceso, sino que debe tener la capacidad de inyectar datos (`stdin`) en una sesión de OpenCode que está corriendo asíncronamente.

## 6. Alternativas consideradas

- **Rechazar todas las confirmaciones por defecto:** Iniciar las sesiones de OpenCode siempre con un flag `--yes` o `--non-interactive`. *Descartado* porque rompe el propósito principal de los agentes de IA que necesitan validación humana ("Judgment Day") para código crítico.