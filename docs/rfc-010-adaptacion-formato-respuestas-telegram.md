# RFC-010 — Adaptación de formato de respuestas para Telegram

**Estado:** Propuesto  
**Autor:** AI Architect  
**Fecha:** 22 de Abril de 2026  

## 1. Contexto

El bot hoy recibe respuestas desde OpenCode y las entrega a Telegram por distintos caminos de egreso. Parte de esas respuestas viene con formato pensado para consola o para modelos LLM, especialmente Markdown simple (`**bold**`, listas, backticks, links estilo `[texto](url)`, bloques de código).

Telegram no interpreta ese Markdown de la misma forma que la consola. En consecuencia, el usuario ve texto degradado o directamente feo, por ejemplo asteriscos visibles, fences de código literales o links con sintaxis cruda.

Además, el sistema actual tiene más de un camino de salida a Telegram:

- `src/adapters/telegram/message-sender.ts` usa `parse_mode: "HTML"`, chunking y fallback.
- `src/handlers.ts` todavía conserva un bridge legacy que envía texto directo con `bot.sendMessage(...)`.

Esto genera una UX inconsistente: mismo contenido, distinta presentación según el camino usado.

## 2. Problema

La salida del modelo está optimizada para consola, no para Telegram.

Hoy el sistema escapa HTML para evitar errores de parseo, pero **no adapta semánticamente** Markdown común del modelo antes de enviarlo al chat. Por eso Telegram puede mostrar:

- `**negrita**` como texto literal,
- `` `codigo` `` sin tratamiento visual útil,
- bloques triple backtick como ruido,
- links markdown sin render correcto,
- encabezados y listas con marcadores poco legibles en mobile.

El problema real NO es el modelo. El problema es la falta de una **capa de presentación específica para Telegram**.

## 3. Objetivo

Introducir una adaptación de formato **solo para Telegram**, preservando el contenido semántico de la respuesta y mejorando su legibilidad en mobile.

La solución debe:

- limpiar Markdown común emitido por el modelo,
- convertir un subconjunto seguro a HTML compatible con Telegram,
- mantener el comportamiento actual de consola/CLI sin cambios,
- centralizar el egreso a Telegram para evitar inconsistencias.

## 4. Alcance y fuera de alcance

### Entra en alcance

- Adaptar respuestas outbound antes de enviarlas a Telegram.
- Cubrir todos los caminos de salida a Telegram, incluyendo el bridge legacy.
- Convertir un subconjunto acotado de Markdown a HTML de Telegram.
- Mantener chunking, sanitización y fallback actuales.

### Fuera de alcance

- Cambiar cómo OpenCode o la consola generan/renderizan respuestas.
- Implementar un parser Markdown completo.
- Soportar el 100% de la especificación CommonMark/GFM.
- Reescribir plantillas internas ya diseñadas nativamente para Telegram.

## 5. Propuesta

Se incorporará una función de adaptación outbound específica para Telegram, por ejemplo:

```ts
adaptModelOutputToTelegram(input: string): string
```

Su responsabilidad será tomar texto crudo proveniente del modelo o del adaptador y devolver una versión apta para ser enviada usando `parse_mode: "HTML"`.

### 5.1. Estrategia

La adaptación tendrá dos etapas:

1. **Normalización semántica mínima**  
   Detectar patrones Markdown frecuentes y mapearlos a una representación compatible con Telegram.

2. **Sanitización final**  
   Escapar caracteres peligrosos y asegurar compatibilidad con el pipeline actual de envío.

### 5.2. Subconjunto soportado

La primera versión deberá soportar, como mínimo:

- `**bold**` → `<b>bold</b>`
- `__bold__` → `<b>bold</b>`
- `*italic*` o `_italic_` → `<i>italic</i>` cuando no colisione con otros patrones
- `` `inline code` `` → `<code>inline code</code>`
- triple backticks → `<pre>...</pre>`
- `[texto](https://url)` → `<a href="https://url">texto</a>` si la URL es válida
- encabezados markdown (`#`, `##`, `###`) → texto plano enfatizado o normalizado
- listas con `-`, `*`, `1.` → texto limpio y consistente para mobile

### 5.3. Principios de diseño

- **Preferir robustez antes que fidelidad perfecta.** Si un patrón es ambiguo, degradar a texto limpio.
- **Nunca romper el mensaje por formateo.** Ante duda, priorizar plain text seguro.
- **No parsear de más.** Soportar solo el subconjunto que realmente aparece en respuestas del modelo.
- **No tocar la consola.** La adaptación vive en el borde de Telegram, no en el dominio ni en OpenCode.

## 6. Arquitectura propuesta

Se propone introducir un módulo nuevo, por ejemplo:

- `src/adapters/telegram/format-outbound.ts`

Con funciones del estilo:

- `adaptModelOutputToTelegram(text: string): string`
- `stripUnsupportedMarkdown(text: string): string`
- `normalizeTelegramWhitespace(text: string): string`

### 6.1. Pipeline recomendado

```text
respuesta OpenCode/modelo
  -> adaptador outbound Telegram
  -> sanitización HTML Telegram
  -> chunking
  -> sendMessage(parse_mode: HTML)
  -> fallback plain text si Telegram rechaza entidades
```

### 6.2. Punto de integración

La función debe ejecutarse en todos los puntos de egreso a Telegram:

1. `sendTelegramText(...)` en `src/adapters/telegram/message-sender.ts`
2. Bridge legacy en `src/handlers.ts`
3. Cualquier otro sender que termine publicando texto del modelo en el chat

La decisión arquitectónica es **centralizar** la salida en `sendTelegramText(...)` o un wrapper equivalente para que no existan bypasses.

## 7. Comportamiento esperado

### Ejemplo A — Markdown simple

Entrada del modelo:

```text
Dejame verificar: **este proyecto** es un bot local en `TypeScript`.
```

Salida visible en Telegram:

**Dejame verificar:** este proyecto es un bot local en `TypeScript`.

### Ejemplo B — Bloque de código

Entrada del modelo:

````text
Probá esto:

```ts
npm run start:local
```
````

Salida esperada en Telegram:

- texto introductorio limpio,
- bloque renderizado en `<pre>...</pre>` si entra en el subset seguro,
- fallback a texto plano limpio si Telegram rechaza el bloque.

### Ejemplo C — Link markdown

Entrada del modelo:

```text
Mirá la doc: [RFC-004](https://example.com/rfc-004)
```

Salida esperada en Telegram:

link clickeable o degradación controlada a `RFC-004: https://example.com/rfc-004`.

## 8. Riesgos

- **Ambigüedad de Markdown:** patrones como `_texto_` pueden chocar con nombres, paths o identificadores.
- **Errores de entidades HTML:** una conversión agresiva puede producir mensajes rechazados por Telegram.
- **Doble transformación:** si una plantilla ya viene lista para Telegram, no debe sufrir una segunda adaptación destructiva.
- **Inconsistencia por bypass:** si queda un `bot.sendMessage(...)` directo fuera del pipeline, la UX seguirá rota.

## 9. Mitigaciones

- Limitar el parser a un subconjunto pequeño y probado.
- Ejecutar sanitización al final del pipeline.
- Mantener el fallback actual a plain text si `parse_mode: HTML` falla.
- Consolidar todos los envíos de texto del modelo detrás de `sendTelegramText(...)`.
- Agregar verificación manual con ejemplos reales de respuestas del modelo.

## 10. Alternativas consideradas

### A. Strip total a texto plano

Eliminar todo el Markdown y enviar solo texto limpio.

**Pros:** simple, robusto, bajo riesgo.  
**Contras:** pierde jerarquía visual, código inline, links y énfasis útiles.

### B. Subconjunto acotado Markdown → HTML Telegram (**elegida**)

Convertir solo patrones frecuentes y seguros.

**Pros:** buena UX con complejidad controlada.  
**Contras:** no cubre todos los casos, requiere criterio explícito.

### C. Parser Markdown completo

Incorporar librería full-featured para convertir Markdown a Telegram.

**Pros:** mayor cobertura teórica.  
**Contras:** sobreingeniería, mayor superficie de bugs, más edge cases y menor control del output.

## 11. Decisiones tomadas

- La adaptación será una responsabilidad del adaptador de Telegram, no del dominio.
- Se mantendrá `parse_mode: "HTML"` como formato de salida principal.
- Se implementará un subconjunto acotado de Markdown, no un parser completo.
- El bridge legacy deberá pasar por el mismo pipeline para evitar inconsistencias.

## 12. Criterios de aceptación

- Respuestas con `**bold**`, backticks y listas se ven limpias en Telegram.
- Links markdown comunes no aparecen con sintaxis cruda al usuario final.
- Si Telegram rechaza entidades HTML, el mensaje igual se entrega en plain text legible.
- La salida de consola/CLI permanece sin cambios funcionales.
- No quedan caminos de egreso a Telegram que envíen respuestas del modelo sin pasar por la capa de adaptación.
- La solución se valida manualmente con mensajes reales o representativos del modelo.

## 13. Plan de implementación sugerido

1. Crear módulo `format-outbound.ts` dentro del adaptador de Telegram.
2. Implementar subset inicial: bold, italic básico, inline code, code fences, links y listas.
3. Integrar la adaptación dentro de `sendTelegramText(...)`.
4. Eliminar bypasses y hacer que el bridge legacy reutilice el sender común.
5. Agregar verificaciones manuales/regresión para ejemplos típicos.

## 14. Preguntas abiertas

- ¿Las plantillas internas del bot deben marcarse explícitamente como “ya formateadas para Telegram” para evitar doble adaptación?
- ¿Conviene degradar encabezados markdown a `<b>` o simplemente a texto limpio sin estilo?
- ¿Los bloques de código largos deben priorizar `<pre>` o plain text para reducir fallos de parseo?

## 15. Verificación manual sugerida

Ejecutar `npm run start:local` y validar en Telegram estos casos representativos:

- `**bold**`, `_italic_`, `` `inline code` `` y listas simples para confirmar que no se ven marcadores crudos.
- bloque triple backtick corto y bloque largo para comprobar que `<pre>` se usa solo cuando sigue siendo seguro y que no hay mensajes rechazados.
- links Markdown válidos e inválidos para confirmar click-through seguro o degradación a texto legible.
- respuestas largas para verificar chunking numerado, sin entidades HTML partidas y con fallback plain text si Telegram rechaza parseo.
- flujo bridge legacy y respuestas espejadas CLI para confirmar que ambos pasan por el mismo sender.
- revisar consola/CLI local para confirmar que el cambio no altera comportamiento fuera de Telegram.
- probar texto ambiguo como `_name_with_underscores_` para confirmar degradación segura a literal, sin itálica accidental.
- probar payloads `telegram-native` y `plain` para confirmar bypass de adaptación Markdown y ausencia de doble transformación sobre plantillas HTML nativas.
