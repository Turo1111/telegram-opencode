# RFC-017 — Selección de modelo OpenCode desde Telegram

**Estado:** Propuesto  
**Autor:** AI Architect  
**Fecha:** 29 de Abril de 2026

## 1. Contexto

El bot hoy no expone control directo del modelo LLM desde Telegram. Esto impide ajustar costo, latencia y calidad por tarea sin tocar configuración externa.

## 2. Problema

Sin selector de modelo:

1. no hay control operativo fino por chat/proyecto;
2. difícil balancear velocidad vs calidad;
3. troubleshooting más lento al no saber con qué modelo corrió cada ejecución.

## 3. Objetivo

Permitir elegir, desde Telegram, un modelo entre los disponibles en OpenCode para el contexto activo, con validación contra catálogo real y persistencia por chat/proyecto.

## 4. Alcance

### Entra en alcance

- comandos para listar y seleccionar modelos;
- consulta de modelos disponibles en OpenCode (capabilities/config);
- persistencia de `activeModel` por chat/proyecto;
- envío del modelo activo en cada ejecución.

### Fuera de alcance

- pricing dinámico en Telegram;
- tuning avanzado por parámetros de proveedor (temperature/top_p/etc.);
- selección multi-modelo por una misma ejecución.

## 5. UX propuesta

Comandos (definitivos para implementación):

- `/modelo` → muestra modelo activo.
- `/modelos` → lista modelos disponibles.
- `/modelo <id>` → cambia modelo activo.

Fuente de ids válidos:

- salida de `opencode models` en host local.

Ejemplos:

- `/modelo openai/gpt-5.3-codex`
- `/modelo cursor-acp/gpt-5.3-codex`

Respuestas:

- éxito: `✅ Modelo activo: openai/gpt-5.3-codex`
- inválido/no disponible: `🔴 Modelo no disponible para este entorno. Usá /modelos.`

## 6. Diseño técnico

### 6.1 Fuente de verdad

Modelos permitidos deben salir de OpenCode (capabilities endpoint o configuración central), no hardcodeados en bot.

### 6.2 Persistencia

Agregar en contexto:

```ts
activeModel: string
```

### 6.3 Validación y fallback

- aceptar solo modelos reportados como disponibles;
- si modelo persistido deja de existir: fallback a default + aviso al usuario;
- nunca ejecutar con modelo inválido silenciosamente.

## 7. Alternativas evaluadas

### A) Hardcode de lista en bot

**Pros:** implementación rápida.  
**Contras:** se desactualiza fácil, alto riesgo de drift.

### B) Modelo fijo global

**Pros:** operación simple.  
**Contras:** pierde flexibilidad y experimentación controlada.

### C) Catálogo dinámico + persistencia por contexto (decisión)

**Pros:** robusto y alineado a disponibilidad real.  
**Contras:** requiere manejo de cache/falla de consulta.

## 8. Riesgos y mitigaciones

- **Riesgo:** endpoint de capacidades caído.  
  **Mitigación:** cache de última lista válida + mensaje degradado.

- **Riesgo:** modelo removido mientras estaba activo.  
  **Mitigación:** fallback automático al default + notificación explícita.

## 9. Criterios de aceptación

1. `/modelos` devuelve lista vigente de modelos disponibles;
2. `/modelo <id>` valida contra lista vigente y persiste selección;
3. ejecución usa `activeModel` en request a OpenCode;
4. ante modelo inválido/removido no se ejecuta en silencio y se informa fallback/error.

## 10. Plan de implementación

1. Definir contrato de lectura de modelos disponibles.
2. Extender estado de chat/proyecto con `activeModel`.
3. Implementar comandos `/modelo` y `/modelos`.
4. Integrar validación previa a ejecución.
5. Verificar manualmente en mock/local.
