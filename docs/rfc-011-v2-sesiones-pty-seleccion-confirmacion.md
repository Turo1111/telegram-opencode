# RFC-011 v2 — Sesiones PTY del proyecto con selección y confirmación desde Telegram

## 1. Contexto

El proyecto deja de operar con el flujo basado en mock HTTP y runtime local administrado por `start-local.js` como experiencia principal. A partir de esta versión, el foco operativo pasa a ser exclusivamente el bridge **PTY** hacia sesiones reales de OpenCode.

En este contexto, el comando `/sesiones` ya no debe representar procesos locales del bot o del mock, sino las **sesiones reales disponibles en OpenCode** para el proyecto activo seleccionado en Telegram.

La intención es que el usuario pueda, desde Telegram:

- seleccionar un proyecto,
- listar las sesiones PTY/OpenCode disponibles para ese proyecto,
- elegir una,
- confirmar la acción,
- y vincularla al chat sin tener que tipear manualmente `/session <id>`.

## 2. Problema

La implementación actual de `/sesiones` está basada en `.local-runtime.json`, lo que representa procesos locales lanzados por `start-local.js`, no sesiones reales de OpenCode.

Eso genera un desajuste conceptual y de UX:

- si el usuario trabaja con `npm run dev` y bridge PTY, `/sesiones` no muestra nada útil;
- el estado conversacional del chat y el estado del runtime local quedan mezclados;
- el usuario no puede descubrir ni seleccionar sesiones reales de OpenCode desde Telegram;
- el flujo actual obliga a conocer y tipear manualmente `/session <id>`.

Para un proyecto PTY-only, la fuente de verdad correcta son las sesiones reales de OpenCode.

## 3. Objetivo

Redefinir `/sesiones` para que:

- funcione exclusivamente sobre el modo PTY;
- liste sesiones reales de OpenCode del proyecto activo;
- permita seleccionarlas desde Telegram;
- solicite confirmación antes de vincular la sesión;
- y ejecute el equivalente funcional de `/session <id>` una vez confirmada la acción.

## 4. Alcance y fuera de alcance

### Entra en esta v2

- Redefinición funcional de `/sesiones`.
- Uso de OpenCode CLI como fuente de verdad para listar sesiones.
- Filtro de sesiones por proyecto activo.
- UX de selección desde Telegram.
- Confirmación previa al attach.
- Vinculación de sesión elegida al chat.
- Ajuste del catálogo de comandos para modo PTY-only.
- Deshabilitación de comandos que ya no tienen sentido en este flujo.

### Fuera de alcance

- Crear nuevas sesiones PTY desde Telegram.
- Cerrar, borrar o renombrar sesiones desde Telegram.
- Administrar sesiones de múltiples proyectos en un mismo listado sin proyecto activo.
- Introducir menús complejos de paginación.
- Soporte simultáneo de UX principal para HTTP/mock y PTY.

## 5. Propuesta

El nuevo flujo será:

1. El usuario selecciona un proyecto con `/project <ruta>`.
2. Ejecuta `/sesiones`.
3. El bot consulta las sesiones disponibles en OpenCode.
4. Filtra las sesiones que pertenecen al proyecto activo.
5. Muestra una lista seleccionable en Telegram.
6. Cuando el usuario elige una sesión, el bot pide confirmación.
7. Si el usuario confirma, se ejecuta el attach de esa sesión al chat.
8. El bot responde con el mensaje estándar de sesión vinculada.

## 6. UX propuesta

### 6.1 Precondición obligatoria

`/sesiones` requiere que exista un proyecto activo.

Si no hay proyecto activo:

```text
🔴 Primero seleccioná un proyecto con /project <ruta> antes de listar sesiones.
```

Esto evita mostrar sesiones fuera de contexto y mantiene coherencia con el modelo mental del usuario.

### 6.2 Listado de sesiones

Si existen sesiones para el proyecto activo, el bot responde con una lista de sesiones disponibles.

Cada ítem puede incluir, si está disponible:

- `sessionId`
- `title`
- `model`
- `updatedAt`

Ejemplo:

```text
ℹ️ Sesiones del proyecto actual

📁 /mnt/d/Proyectos/telegram-opencode

Seleccioná una sesión para vincularla a este chat:
- sess_abc123
- sess_def456
- sess_xyz789
```

La selección debe hacerse con botones inline o mecanismo equivalente de selección directa en Telegram.

### 6.3 Confirmación previa

Al seleccionar una sesión, el bot no debe vincularla automáticamente. Antes debe pedir confirmación.

Ejemplo:

```text
🟠 Confirmar vinculación

📁 /mnt/d/Proyectos/telegram-opencode
🔌 Sesión elegida: sess_abc123

¿Querés vincular esta sesión a este chat?
```

Opciones:

- Confirmar
- Cancelar

### 6.4 Confirmación exitosa

Si el usuario confirma y el attach sale bien:

```text
🟢 Sesión vinculada
📁 /mnt/d/Proyectos/telegram-opencode
🔌 sess_abc123

Ya podés enviar mensajes a la sesión activa.
```

### 6.5 Cancelación

Si el usuario cancela:

```text
ℹ️ Vinculación cancelada. La sesión actual del chat no cambió.
```

## 7. Fuente de verdad

La fuente de verdad de `/sesiones` deja de ser `.local-runtime.json`.

A partir de esta v2, la fuente será el listado real de OpenCode obtenido por CLI:

```bash
opencode session list --format json
```

El proyecto ya posee esta capacidad en infraestructura. Esta RFC formaliza su uso en la UX de Telegram.

## 8. Regla de filtrado por proyecto

El listado de `/sesiones` no debe mostrar todas las sesiones globales sin criterio.

La regla será:

- si hay proyecto activo, solo mostrar sesiones cuyo path canonizado sea igual al root activo o quede dentro de su árbol descendiente;
- si una sesión no trae `path`, su inclusión deberá decidirse de forma conservadora;
- por defecto, priorizar consistencia antes que mostrar ruido.

Decisión de esta RFC:

- `/sesiones` opera **sobre el proyecto activo**;
- si la sesión no puede asociarse al proyecto activo de manera confiable, no se muestra.

Esto evita que el usuario vincule por error una sesión de otro proyecto.

## 9. Cambios funcionales en comandos

### Comandos que permanecen

- `/help`
- `/status`
- `/project`
- `/sesiones`
- `/session`
- `/cancel`
- texto libre

### Comandos a deshabilitar o retirar del catálogo principal

- `/new`
- `/run`
- `/sesiones` basado en `.local-runtime.json`
- referencias a mock o `start:local` como flujo principal de operación

## 10. Diseño técnico propuesto

### 10.1 Router de Telegram

El router deberá cambiar la semántica de `/sesiones`:

- ya no leer `.local-runtime.json`;
- sino consultar la capa de infraestructura que lista sesiones OpenCode;
- resolver el proyecto activo del chat;
- filtrar sesiones;
- renderizar el selector;
- manejar la confirmación vía callback.

### 10.2 Infraestructura

Se reutilizará la capacidad existente para listar sesiones de OpenCode.

Será necesario exponerla en el flujo adecuado para que `/sesiones` pueda usarla sin duplicar lógica.

### 10.3 Callback de selección

La selección de una sesión debe preservar, como mínimo, esta información de negocio:

- tipo de acción,
- `sessionId`,
- referencia del proyecto activo,
- y fase del flujo: selección o confirmación.

La implementación puede transportar esos datos de forma indirecta mediante un token corto y opaco en `callback_data`, siempre que ese token referencie en memoria el `sessionId` y el proyecto activo esperados. Esto mantiene el payload dentro del límite de Telegram y permite revalidación defensiva al confirmar.

### 10.4 Confirmación

La confirmación debe ser idempotente y defensiva:

- si la sesión ya no existe, informar error;
- si ya no coincide con el proyecto activo, informar error;
- si el usuario cancela, no cambiar el binding actual.

### 10.5 Attach final

La confirmación exitosa debe invocar la misma lógica de negocio que `/session <id>`.

No debe implementarse una segunda ruta paralela de attach. La UX cambia; la operación de negocio debe seguir siendo una sola.

## 11. Manejo de errores

### Sin proyecto activo

```text
🔴 Primero seleccioná un proyecto con /project <ruta>.
```

### No hay sesiones para el proyecto

```text
ℹ️ No encontré sesiones disponibles para el proyecto actual.
```

### Falla listando sesiones

```text
🔴 No pude consultar las sesiones de OpenCode. Verificá que el bridge PTY y OpenCode estén disponibles.
```

### La sesión desapareció antes de confirmar

```text
🔴 La sesión seleccionada ya no está disponible. Volvé a ejecutar /sesiones.
```

### La sesión pertenece a otro proyecto

```text
🔴 La sesión seleccionada no coincide con el proyecto activo de este chat.
```

## 12. Riesgos

### 12.1 Sesiones sin path confiable

Algunas sesiones podrían no traer `path`, lo que dificulta filtrarlas contra el proyecto activo.

**Mitigación:** excluirlas del listado si no pueden asociarse de forma segura.

### 12.2 Cambios entre listado y confirmación

Una sesión puede desaparecer entre que se lista y que el usuario confirma.

**Mitigación:** revalidar la sesión al confirmar.

### 12.3 Complejidad de UX en Telegram

La incorporación de selección y confirmación agrega estado conversacional temporal.

**Mitigación:** mantener el flujo simple: listar → seleccionar → confirmar → attach.

## 13. Impacto

El impacto esperado es medio, pero bien acotado.

- Mejora fuertemente la UX de vinculación de sesiones.
- Elimina la dependencia conceptual de `.local-runtime.json`.
- Alinea el bot con el nuevo enfoque PTY-only.
- Reduce la necesidad de memorizar y escribir manualmente IDs de sesión.
- Simplifica el catálogo operativo hacia el caso de uso real del proyecto.

## 14. Plan de implementación

1. Redefinir `/sesiones` para usar sesiones reales de OpenCode.
2. Resolver el proyecto activo del chat.
3. Filtrar sesiones por proyecto.
4. Renderizar selector de sesiones en Telegram.
5. Implementar callback de confirmación.
6. Reutilizar la operación existente de attach para completar la vinculación.
7. Ajustar `/help` y mensajes de UX al modo PTY-only.
8. Deshabilitar comandos fuera de foco (`/new`, `/run`, etc.).

## 15. Plan de verificación

### Verificación técnica

- `npx tsc --noEmit`

### Verificación funcional manual

1. Configurar el proyecto en modo PTY.
2. Ejecutar `/project <ruta>`.
3. Ejecutar `/sesiones`.
4. Verificar que solo aparezcan sesiones del proyecto activo.
5. Seleccionar una sesión.
6. Verificar que aparezca la confirmación.
7. Confirmar.
8. Verificar que el chat quede vinculado a esa sesión.
9. Enviar texto libre y comprobar que entra a la sesión correcta.
10. Repetir cancelando en lugar de confirmar.
11. Repetir con una sesión inválida o desaparecida.

## 16. Criterios de aceptación

- `/sesiones` requiere proyecto activo.
- `/sesiones` lista sesiones reales de OpenCode.
- el listado está filtrado por el proyecto activo.
- el usuario puede seleccionar una sesión desde Telegram.
- antes del attach existe una confirmación explícita.
- confirmar ejecuta el equivalente a `/session <id>`.
- cancelar no altera la sesión vinculada actual.
- `/new` y `/run` dejan de figurar como flujo principal en PTY-only.
- el bot ya no depende de `.local-runtime.json` para este caso de uso.

## 17. Conclusión

Esta v2 corrige el error conceptual de la versión anterior: `/sesiones` no debe listar procesos locales del wrapper, sino sesiones reales de OpenCode utilizables por el usuario en modo PTY.

La mejora no es cosmética. Es una corrección de fundamento: cambiar la fuente de verdad, alinear la UX con el modo operativo real del proyecto y reducir fricción al momento de vincular sesiones desde Telegram.
