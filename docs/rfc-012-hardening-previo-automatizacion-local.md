# RFC-012 — Hardening previo a automatización local desde Telegram

**Estado:** Implementado  
**Autor:** AI Architect  
**Fecha:** 25 de Abril de 2026

## 1. Contexto

El proyecto ya implementó una base de seguridad en **RFC-009**:

- allowlist obligatoria por `from.id` de Telegram;
- silent-drop para actores no autorizados;
- webhook local restringido a loopback y protegido con bearer token efímero.

Esa base es correcta para el flujo actual: seleccionar proyecto, vincular sesión y reenviar texto a OpenCode.

Pero el nivel de riesgo cambia si en una fase posterior se habilitan acciones de **automatización local del host**, por ejemplo:

- abrir una consola en la PC del usuario;
- ejecutar `wsl.exe` o `powershell.exe`;
- adjuntar una sesión `tmux` local;
- disparar automatismos que afectan el escritorio o el shell local.

Ese salto NO es incremental. Cambia el sistema desde “control de sesión OpenCode” a “control del host local”.

## 2. Problema

La seguridad actual protege contra el caso obvio de un tercero que encuentra el bot y le escribe por Telegram, pero no define todavía un contrato específico para **acciones peligrosas** del host.

Los riesgos principales son:

1. **Uso en contexto compartido.** La autorización actual se basa en `from.id`, no en `chat.type`, por lo que un usuario autorizado podría usar el bot dentro de un grupo y exponer respuestas o disparar acciones desde un contexto no privado.
2. **Superficie de ejecución excesiva.** Si se introducen comandos genéricos o shell arbitrario desde Telegram, el bot pasa a ser un puente de ejecución remota sobre la máquina local.
3. **Falta de fail-closed explícito.** Aunque hoy las features peligrosas no existen, todavía no hay una política documentada de flags, confirmación fuerte y visibilidad mínima para futuras automatizaciones locales.
4. **Falta de auditoría específica.** Acciones locales sensibles requieren trazabilidad más estricta que el envío normal de texto a una sesión.

## 3. Objetivo

Definir una capa de hardening previa y obligatoria antes de habilitar cualquier acción de automatización local desde Telegram.

La meta es que el sistema opere bajo un principio **fail-closed**:

- si el contexto no es inequívocamente seguro, no ejecuta;
- si la feature peligrosa no fue habilitada explícitamente, no existe para el usuario;
- si la intención no es fija y verificable, no se permite.

## 4. Alcance

### Entra en alcance

- Restringir acciones peligrosas a chats privados.
- Introducir feature flags explícitas para automatización local.
- Prohibir shell arbitrario desde Telegram para este tipo de capacidades.
- Exigir confirmación explícita, efímera e idempotente antes de ejecutar acciones locales sensibles.
- Registrar auditoría de acciones locales peligrosas.
- Ocultar estas capacidades del catálogo general mientras no estén habilitadas.

### Fuera de alcance

- Implementar la automatización local en sí misma.
- Diseñar el comando final concreto (`/attach-local`, `/open-console`, etc.).
- Resolver aprobación local con UI nativa del sistema operativo.
- Introducir MFA, PIN conversacional o criptografía end-to-end adicional.
- Rediseñar RFC-009; este documento lo extiende para un riesgo distinto.

## 5. Principios de diseño

1. **Privado o nada.** Las acciones de host control solo pueden originarse en `chat.type = private`.
2. **Intent fijo, no shell libre.** Telegram expresa intenciones de negocio, no strings arbitrarios de shell.
3. **Apagado por defecto.** Toda acción local peligrosa debe nacer deshabilitada.
4. **Confirmación fuerte.** Toda operación sensible requiere un segundo paso explícito antes de ejecutarse.
5. **Menor superficie posible.** Si una acción puede modelarse como una operación tipada, no debe exponerse como comando genérico.
6. **Trazabilidad completa.** Toda acción sensible debe quedar auditada.

## 6. Propuesta

### 6.1. Restringir a chat privado

El bot debe rechazar cualquier acción catalogada como “local peligrosa” cuando el update provenga de:

- grupos,
- supergrupos,
- canales,
- o cualquier chat distinto de `private`.

La decisión recomendada es incluso más estricta: permitir que el catálogo peligroso exista **solo** en chats privados, aunque el resto del bot siga aceptando otros contextos.

### 6.2. Flags explícitas de habilitación

Toda automatización local sensible debe quedar deshabilitada por default mediante configuración explícita. Ejemplos de flags:

- `ENABLE_LOCAL_HOST_ACTIONS=false`
- `ENABLE_ATTACH_LOCAL=false`

Contrato:

- si la flag está en `false`, el comando no aparece en `/help`;
- si se invoca manualmente, el bot responde que la feature está deshabilitada;
- no debe existir un camino oculto o implícito para ejecutar la acción.

### 6.3. Prohibición de shell arbitrario

Este RFC prohíbe que una futura feature de host control se implemente como:

- `/run powershell ...`
- `/cmd ...`
- texto libre reenviado al shell local del sistema operativo.

Las acciones permitidas deben ser **operaciones tipadas y acotadas**, por ejemplo:

- “adjuntarse a la sesión local activa”
- “abrir consola local para la sesión actual”

El usuario expresa una intención de alto nivel; la traducción a comandos del sistema ocurre internamente, con parámetros controlados por el bot.

### 6.4. Confirmación de dos pasos

Antes de ejecutar una acción local sensible, el bot debe:

1. recibir la intención inicial;
2. mostrar un resumen exacto de la acción a ejecutar;
3. pedir confirmación explícita con botones;
4. ejecutar solo si la confirmación sigue vigente.

Datos mínimos a mostrar:

- proyecto activo;
- sesión activa;
- tipo de acción local;
- entorno objetivo esperado (ej. WSL/tmux/local terminal).

Requisitos del token de confirmación:

- opaco;
- de un solo uso;
- atado a actor + chat + proyecto + sesión + intención;
- con TTL corto (ej. 30–60 segundos);
- inválido si cambia el contexto activo.

### 6.5. Precondiciones obligatorias

Antes de ejecutar la acción, el sistema debe verificar como mínimo:

- actor allowlisteado;
- chat privado;
- feature flag habilitada;
- proyecto activo;
- sesión activa;
- consistencia entre proyecto y sesión;
- disponibilidad del entorno necesario en la máquina local;
- vigencia del token de confirmación.

Si cualquiera falla, la operación no se ejecuta.

### 6.6. Auditoría y logging

Toda acción peligrosa debe registrar al menos:

- `actorId`
- `chatId`
- `chat.type`
- acción solicitada
- proyecto activo
- sesión activa
- resultado (`accepted`, `rejected`, `failed`, `cancelled`)
- motivo del rechazo o falla
- timestamp

Esto no reemplaza seguridad, pero sí aporta trazabilidad operacional.

### 6.7. Visibilidad mínima en UX

Las capacidades de host control:

- no deben mezclarse con el catálogo normal cuando están apagadas;
- deben estar claramente marcadas como capacidades sensibles o experimentales;
- no deben sugerirse como next-step por defecto en mensajes comunes del bot.

## 7. Alternativas consideradas

### A. Reutilizar la seguridad actual sin cambios

**Descartada.** La allowlist actual protege el ingreso básico, pero no define un perímetro suficiente para host control.

### B. Pedir PIN o challenge dentro del mismo chat

**Descartada como defensa principal.** Si la cuenta de Telegram está comprometida, el atacante también ve el PIN o challenge dentro del mismo canal.

### C. Aprobación local en la PC del usuario

**Valiosa, pero fuera de alcance de este mini RFC.** Sería una segunda barrera real, pero implica otro diseño y otra superficie técnica.

## 8. Riesgos y mitigaciones

### 8.1. Uso del bot dentro de grupos

**Riesgo:** exposición de respuestas o disparo de acciones desde un contexto compartido.  
**Mitigación:** private-only para capacidades peligrosas.

### 8.2. Escalada hacia RCE local

**Riesgo:** convertir Telegram en un shell remoto generalista.  
**Mitigación:** prohibir shell arbitrario y permitir solo intenciones tipadas.

### 8.3. Reutilización accidental o maliciosa de confirmaciones

**Riesgo:** replay o confirmación fuera de contexto.  
**Mitigación:** tokens opacos, de un solo uso, con TTL corto y revalidación de contexto.

### 8.4. Activación accidental de features peligrosas

**Riesgo:** exponer acciones locales sin conciencia explícita del operador.  
**Mitigación:** flags en `false` por defecto + ocultamiento en `/help`.

## 9. Diseño técnico sugerido

### 9.1. Clasificación de comandos por riesgo

Se recomienda introducir una categoría nueva para comandos de automatización local sensible, separada de:

- lectura;
- ejecución sobre OpenCode;
- mutación de contexto conversacional.

Ejemplo conceptual:

```ts
COMMAND_POLICY.LOCAL_HOST_DANGEROUS
```

Esto permitiría aplicar gates adicionales sin contaminar el resto del router.

### 9.2. Guard centralizado

El gating de seguridad no debe quedar distribuido ad hoc en cada comando. Debe existir una verificación central reutilizable para toda acción peligrosa.

Ejemplo conceptual:

```ts
assertLocalHostActionAllowed({
  actorId,
  chatType,
  featureFlag,
  projectId,
  sessionId,
})
```

### 9.3. Confirmación desacoplada de la ejecución

La operación final no debe ejecutarse en el mismo paso que la intención inicial. Debe quedar desacoplada vía callback tokenizado y revalidación completa al confirmar.

## 10. Criterios de aceptación

- Las acciones locales peligrosas se rechazan fuera de chats privados.
- Las features peligrosas están deshabilitadas por default.
- No existe ejecución arbitraria de shell local desde Telegram para este tipo de capacidades.
- Toda acción peligrosa requiere confirmación explícita en dos pasos.
- La confirmación tiene TTL, es de un solo uso y revalida contexto.
- `/help` no muestra comandos peligrosos cuando las flags están apagadas.
- Toda acción peligrosa deja auditoría suficiente para trazabilidad.
- Ante contexto incompleto o inseguro, el sistema falla cerrado.

## 11. Plan de implementación sugerido

1. Introducir restricción `private-only` para capacidades peligrosas.
2. Agregar feature flags explícitas para host automation.
3. Definir clasificación de riesgo para estos comandos.
4. Implementar guard centralizado de precondiciones.
5. Reutilizar patrón de callback tokenizado con TTL corto para confirmación.
6. Agregar auditoría estructurada para aceptación, rechazo y fallas.
7. Ajustar `/help` y mensajes UX para ocultar capacidades apagadas.
8. Recién después redactar el RFC funcional de la acción local concreta.

## 12. Plan de verificación

### Verificación técnica

- cobertura automatizada para rechazo por `chat.type !== private`;
- cobertura automatizada para flags deshabilitadas;
- cobertura automatizada para replay/expiración de confirmación;
- cobertura automatizada para ausencia de side effects cuando falla una precondición.

### Verificación manual

1. Con feature flag apagada, confirmar que el comando peligroso no aparece en `/help`.
2. Invocarlo manualmente y verificar rechazo explícito sin side effects.
3. Intentarlo desde grupo/supergrupo y verificar rechazo.
4. Intentarlo desde chat privado y verificar aparición del paso de confirmación.
5. Cambiar proyecto/sesión antes de confirmar y verificar invalidación.
6. Esperar expiración del TTL y verificar rechazo.
7. Confirmar una vez y reintentar con el mismo token para verificar idempotencia/replay block.
8. Revisar logs para confirmar trazabilidad completa.

## 13. Preguntas abiertas

- ¿La restricción `private-only` debe aplicarse solo a comandos peligrosos o a TODO el bot?
- ¿Conviene una flag global única (`ENABLE_LOCAL_HOST_ACTIONS`) más flags específicas, o solo flags granulares?
- ¿La aprobación local en desktop debe ser requisito obligatorio para la primera acción de host control o quedar para una fase posterior?

## 14. Conclusión

Antes de abrir una consola local, lanzar `wsl`, adjuntar `tmux` o tocar el host desde Telegram, el proyecto necesita un endurecimiento específico y explícito.

RFC-009 resolvió la seguridad mínima de ingreso. Este RFC define la siguiente muralla: asegurar que toda futura automatización local sea privada, explícita, acotada, confirmada y auditada.

Primero perímetro. Después automatización. No al revés.
