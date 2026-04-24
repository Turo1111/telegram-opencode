# RFC-011 — Listado de Sesiones Locales desde Telegram

## 1. Contexto
El entorno local del proyecto ya registra información de runtime en `.local-runtime.json` mediante `start-local.js` y `stop-local.js`. Ese archivo permite evitar instancias duplicadas y rastrear los PIDs del bot y del mock, pero hoy esa información solo se usa de manera interna y no puede consultarse desde Telegram.

En la práctica, cuando alguien quiere verificar si el bot local o el mock siguen activos, tiene que ir a la terminal, inspeccionar el archivo o revisar procesos del sistema manualmente. Eso agrega fricción a una tarea de observabilidad básica del entorno de desarrollo.

## 2. Problema
Actualmente no existe un comando del bot que permita consultar desde Telegram qué sesiones locales están registradas, si los procesos asociados siguen activos o si quedaron huérfanos.

La información existe, pero no está expuesta en la interfaz conversacional del bot.

## 3. Objetivo
Agregar un comando `/sesiones` que permita listar desde Telegram el estado de las sesiones locales registradas por el entorno de desarrollo.

El comando debe:
- leer `.local-runtime.json`;
- identificar los PIDs registrados del bot y del mock;
- verificar si cada proceso sigue activo;
- responder en español con un resumen claro y legible.

## 4. Alcance y fuera de alcance

### Entra en este RFC
- Nuevo comando `/sesiones` en el bot de Telegram.
- Lectura segura del archivo `.local-runtime.json`.
- Detección de procesos activos y huérfanos.
- Formateo de respuesta legible en español.
- Actualización de documentación para incluir el nuevo comando.

### Fuera de alcance
- Crear, cerrar, reiniciar o limpiar sesiones desde Telegram.
- Persistir historial de sesiones.
- Exponer esta información por HTTP o mediante una base de datos.
- Cambiar el formato actual de `.local-runtime.json`.

## 5. Propuesta
Se propone incorporar el comando:

```text
/sesiones
```

Cuando el usuario lo ejecute, el bot deberá:

1. Leer `.local-runtime.json` desde la raíz del proyecto.
2. Extraer, como mínimo, `botPid` y `mockPid` y sus timestamps asociados si existen.
3. Verificar si esos PIDs siguen activos en el sistema.
4. Responder con un mensaje resumido.

### Ejemplo de respuesta exitosa

```text
Sesiones locales registradas:

🤖 Bot
PID: 12345
Estado: Activo
Inicio: 2026-04-24 10:15:00

🛠️ Mock
PID: 12346
Estado: Huérfano
Inicio: 2026-04-24 10:15:02
```

### Si no existen sesiones registradas

```text
No hay sesiones locales registradas.
```

### Si ocurre un error de lectura o parseo

```text
No se pudo leer el estado de las sesiones locales.
```

## 6. Diseño técnico propuesto

### 6.1 Nuevo handler en el bot
Se agregará un manejador del comando `/sesiones` en `src/index.ts`.

Ese handler será responsable de:
- invocar una utilidad de lectura de sesiones;
- recibir una estructura normalizada;
- responder al usuario sin exponer errores internos del sistema.

### 6.2 Utilidad dedicada para sesiones
Se creará una utilidad nueva en:

```text
src/utils/sessions.ts
```

Esta utilidad encapsulará la lógica de:
- lectura de `.local-runtime.json`;
- parseo seguro del JSON;
- extracción de PIDs relevantes;
- verificación del estado de cada proceso;
- devolución de una estructura reutilizable por el bot.

Separar esta lógica evita mezclar responsabilidades del transporte Telegram con lógica de sistema y manejo de procesos.

### 6.3 Verificación de procesos
La validación del estado de cada PID se hará con `process.kill(pid, 0)`.

Comportamiento esperado:
- si no arroja error, el proceso existe;
- si arroja `ESRCH`, el proceso no existe;
- si arroja `EPERM`, el proceso existe pero no hay permisos suficientes.

Para este RFC, `EPERM` se tratará como proceso existente.

### 6.4 Fuente de verdad
La única fuente de datos será `.local-runtime.json`.

No se propone modificar el contrato actual de ese archivo en esta etapa.

## 7. Archivos involucrados
- `src/index.ts` — agrega el comando `/sesiones`.
- `src/utils/sessions.ts` — nueva utilidad para leer y normalizar el estado de sesiones.
- `.local-runtime.json` — solo lectura.
- `README.md` o documentación equivalente — registrar el nuevo comando.

## 8. Alternativas consideradas

### 8.1 Exponer un endpoint HTTP en el mock
Permitiría consultar sesiones mediante una API auxiliar.

**Ventajas**
- separación entre bot y lectura del estado local;
- potencial reutilización desde otras herramientas.

**Desventajas**
- obliga a que el mock esté operativo para consultar el estado;
- agrega complejidad y acoplamiento innecesario;
- resuelve por red algo que ya existe localmente en disco.

**Decisión**
Descartada.

### 8.2 Persistir sesiones en una base de datos
Habilitaría historial y consultas más ricas.

**Ventajas**
- mayor flexibilidad futura.

**Desventajas**
- sobreingeniería para una necesidad simple;
- introduce dependencias y mantenimiento adicional.

**Decisión**
Descartada.

### 8.3 Leer directamente `.local-runtime.json`

**Ventajas**
- solución simple;
- cero dependencias nuevas;
- reutiliza el flujo ya existente;
- funciona aunque uno de los procesos ya no esté corriendo.

**Desventajas**
- depende del formato vigente del archivo.

**Decisión**
Elegida.

## 9. Riesgos

### 9.1 Cambios futuros en `.local-runtime.json`
Si cambia el formato, la utilidad deberá adaptarse.

**Mitigación:** centralizar toda la lectura en `src/utils/sessions.ts`.

### 9.2 Diferencias de plataforma o permisos
La verificación por PID puede verse afectada por permisos o diferencias del sistema operativo.

**Mitigación:** usar `process.kill(pid, 0)` y contemplar explícitamente `ESRCH` y `EPERM`.

### 9.3 Registros huérfanos
Puede haber PIDs en el archivo que ya no existan.

**Mitigación:** modelar ese caso como un estado esperado y mostrarlo como `Huérfano`.

## 10. Impacto
El impacto esperado es bajo.

- No se modifica el flujo principal del bot.
- No cambia el contrato con OpenCode.
- No se alteran `start-local.js` ni `stop-local.js`.
- No se agregan dependencias nuevas.
- Se mejora la observabilidad del entorno local.

## 11. Plan de implementación
1. Crear `src/utils/sessions.ts`.
2. Implementar lectura segura de `.local-runtime.json`.
3. Implementar detección de estado de procesos por PID.
4. Agregar handler `/sesiones` en `src/index.ts`.
5. Formatear la respuesta en español.
6. Actualizar la documentación.

## 12. Plan de verificación
La validación será manual.

Escenarios mínimos a cubrir:

1. **Sin `.local-runtime.json`**
   - `/sesiones` responde que no hay sesiones registradas.

2. **Con bot y mock activos**
   - `/sesiones` muestra ambos como activos.

3. **Con un PID muerto y otro activo**
   - `/sesiones` muestra uno activo y otro huérfano.

4. **Con JSON inválido**
   - `/sesiones` responde con error amigable sin romper el bot.

5. **Luego de `npm run stop:local`**
   - el estado reflejado debe ser consistente con el contenido final del archivo.

## 13. Compatibilidad
El cambio es compatible hacia atrás.

No afecta:
- comandos existentes;
- la integración actual con Telegram;
- el flujo HTTP hacia OpenCode;
- el mock local;
- los scripts de desarrollo vigentes.

## 14. Criterios de aceptación
- Existe un comando `/sesiones` accesible desde Telegram.
- El comando lee `.local-runtime.json` sin modificarlo.
- El comando detecta si `botPid` y `mockPid` siguen activos.
- El bot informa estados activos y huérfanos de forma clara.
- La respuesta está en español.
- El bot no falla ante archivo inexistente o JSON inválido.
- La documentación del proyecto refleja la existencia del comando.

## 15. Conclusión
Este RFC propone una mejora pequeña y de bajo riesgo, pero con valor inmediato para el trabajo diario en local. Reutiliza una fuente de verdad que ya existe, evita complejidad innecesaria y mejora la capacidad de inspeccionar el estado del entorno directamente desde Telegram.

La propuesta mantiene el alcance controlado: observar primero, operar después.
