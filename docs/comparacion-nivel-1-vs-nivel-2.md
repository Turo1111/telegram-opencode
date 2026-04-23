# Comparación — Nivel 1 vs Nivel 2 para Telegram ↔ OpenCode

## Objetivo
Definir qué nivel de integración cumple mejor con este escenario:

> Estoy trabajando en OpenCode desde mi PC sobre un proyecto local. Si me tengo que ir, quiero asociar esa sesión al bot de Telegram, recibir un mensaje cuando termine una task y poder seguir respondiéndole para continuar trabajando. Si hace falta crear una nueva sesión sobre ese proyecto porque la anterior ya cerró un RFC, también quiero poder hacerlo desde Telegram.

---

## Resumen corto
- **Nivel 1** = Telegram como **cliente remoto** de una sesión/proyecto de OpenCode.
- **Nivel 2** = Telegram como **cliente remoto + observador** de una sesión, con **notificaciones automáticas** de trabajos iniciados fuera del bot (por ejemplo, desde la PC).

---

## Cuadro comparativo

| Criterio | Nivel 1 — Cliente remoto de sesión compartida | Nivel 2 — Cliente remoto + observador/notificador |
|---|---|---|
| Qué resuelve | Continuar una sesión desde Telegram y ejecutar nuevos mensajes/comandos | Continuar una sesión desde Telegram **y además** observar una sesión que también se está usando desde la PC |
| Proyecto activo | Sí | Sí |
| Asociar proyecto desde Telegram | Sí | Sí |
| Asociar una sesión existente de OpenCode | Sí | Sí |
| Crear una nueva sesión sobre el mismo proyecto | Sí | Sí |
| Enviar mensajes normales a OpenCode desde Telegram | Sí | Sí |
| Ejecutar comandos SDD desde Telegram (`/sdd-new`, `/sdd-continue`, etc.) | Sí | Sí |
| Continuar una sesión que ya venías usando en la PC | Sí, si se conoce y guarda el `sessionId` | Sí, si se conoce y guarda el `sessionId` |
| Recibir la respuesta final de una tarea iniciada desde Telegram | Sí | Sí |
| Recibir una notificación automática cuando termina una tarea iniciada desde la PC | **No** | **Sí** |
| Detectar que el orquestador quedó esperando una respuesta y avisarlo por Telegram aunque el trabajo haya arrancado en la PC | **No** | **Sí** |
| Ver el avance en tiempo real / eventos de una sesión compartida | Parcial o no garantizado | Sí, diseñado para eso |
| Complejidad técnica | Baja a media | Media a alta |
| Riesgo de concurrencia (PC + Telegram a la vez) | Medio | Alto, pero más controlable si se diseña como watcher + lock |
| Requiere watcher/monitor de sesión | No | Sí |
| Requiere modelo de eventos / polling de estado / seguimiento activo | No | Sí |
| Tiempo estimado de implementación | Menor | Mayor |
| Riesgo de “me llega tarde o no me entero de algo que arrancó en la PC” | Alto | Bajo |

---

## Traducción al escenario real del usuario

### Escenario A
**Estoy en Telegram y desde ahí continúo una sesión o creo una nueva.**

- **Nivel 1:** lo cumple.
- **Nivel 2:** también lo cumple.

### Escenario B
**Estoy trabajando en OpenCode en mi PC, dejo una tarea corriendo, me voy, y quiero que Telegram me avise solo cuando esa tarea termine.**

- **Nivel 1:** **no lo cumple completamente**.
- **Nivel 2:** **sí lo cumple**.

### Escenario C
**La sesión anterior ya cerró un RFC o ya no me sirve, pero quiero crear una nueva sobre el mismo proyecto desde Telegram.**

- **Nivel 1:** lo cumple.
- **Nivel 2:** también lo cumple.

### Escenario D
**Quiero responderle desde Telegram cuando el orquestador termine una fase o quede esperando mi confirmación.**

- Si la ejecución fue iniciada desde Telegram:
  - **Nivel 1:** sí.
  - **Nivel 2:** sí.
- Si la ejecución fue iniciada desde la PC:
  - **Nivel 1:** no de forma confiable.
  - **Nivel 2:** sí, ese es justamente su valor.

---

## Conclusión

### Qué nivel cumple exactamente con lo que se describió
La necesidad redactada por el usuario encaja **mejor con Nivel 2** porque incluye este punto clave:

> “estar trabajando con OpenCode en mi PC ... irme ... y que me llegue un mensaje cuando termine una task”

Ese requisito implica **observar una sesión que puede haber sido iniciada o continuada fuera del bot**, y eso ya no es solo “cliente remoto”; eso requiere **notificación/seguimiento de sesión**.

### Qué nivel sirve como primer paso práctico
Si se quiere avanzar de forma incremental y sin sobrecargar el diseño desde el día uno:

1. **Primero implementar Nivel 1**
   - asociación de proyecto
   - asociación/creación de sesión
   - ejecución de mensajes y comandos SDD desde Telegram
   - continuidad de la sesión desde Telegram

2. **Luego extender a Nivel 2**
   - watcher de sesión compartida
   - notificaciones automáticas de tareas iniciadas en la PC
   - detección de fases del orquestador que requieren respuesta

---

## Recomendación

### Si el objetivo es cumplir EXACTAMENTE el caso de uso descrito
Ir hacia **Nivel 2**.

### Si el objetivo es llegar antes a algo usable y después evolucionarlo
Implementar **Nivel 1 como base** y dejar **Nivel 2** como siguiente fase explícita del producto.

---

## Decisión pendiente
Antes de tocar PRD/RFC/flows, conviene cerrar esta decisión:

- **Opción recomendada conservadora:** documentar el producto en dos fases:
  - **v1 = Nivel 1**
  - **v1.1 = Nivel 2**

- **Opción recomendada ambiciosa:** documentar desde ya el producto objetivo como **Nivel 2**, aclarando que la primera entrega se construye por etapas.
