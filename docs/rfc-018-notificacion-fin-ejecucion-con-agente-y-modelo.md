# RFC-018 — Notificación de fin de ejecución con agente y modelo en Telegram

**Estado:** Propuesto  
**Autor:** AI Architect  
**Fecha:** 29 de Abril de 2026

## 1. Contexto

Aunque se ejecute correctamente un prompt, el usuario no siempre ve metadatos de ejecución (agente y modelo efectivos). Eso reduce observabilidad y complica soporte.

## 2. Problema

Sin metadatos finales en Telegram:

1. baja auditabilidad operativa;
2. debugging más lento;
3. confusión cuando hay cambios de agente/modelo por fallback.

## 3. Objetivo

Al finalizar cada ejecución, informar en Telegram:

- agente efectivo;
- modelo efectivo.

Si hubo fallback o override, también informarlo explícitamente.

## 4. Alcance

### Entra en alcance

- enriquecer mensaje final de ejecución con `agente` + `modelo`;
- reflejar valores realmente usados, no solo los configurados;
- contemplar éxito y error con formato consistente.

### Fuera de alcance

- dashboard histórico completo;
- telemetría externa avanzada;
- costos/token usage detallado por proveedor.

## 5. UX propuesta

Formato sugerido al cierre:

```text
✅ Ejecución finalizada
🤖 Agente: plan
🧠 Modelo: openai/gpt-5.3-codex
```

Si hubo fallback:

```text
ℹ️ Se aplicó fallback de modelo: <solicitado> → <efectivo>
```

## 6. Diseño técnico

### 6.1 Contrato de respuesta

El adaptador OpenCode debe exponer en resultado final:

- `effectiveAgent`
- `effectiveModel`
- `fallbackInfo?` (opcional)

### 6.2 Render Telegram

Capa de presentación Telegram agrega bloque de metadatos al final del mensaje de resultado, con truncado/escape seguro para Markdown/HTML según modo actual.

### 6.3 Consistencia

Los valores reportados deben salir del resultado de ejecución real, no del estado previo guardado.

## 7. Alternativas evaluadas

### A) Mostrar solo en logs

**Pros:** mínimo cambio de UX.  
**Contras:** usuario final no lo ve; soporte depende de acceso a host.

### B) Comando aparte `/ultima-ejecucion`

**Pros:** menos ruido en cada respuesta.  
**Contras:** agrega pasos y pierde inmediatez contextual.

### C) Incluir en cierre de cada ejecución (decisión)

**Pros:** observabilidad inmediata, menor ambigüedad.  
**Contras:** mensajes algo más largos.

## 8. Riesgos y mitigaciones

- **Riesgo:** ruido visual en respuestas cortas.  
  **Mitigación:** bloque compacto de 2 líneas + emojis consistentes.

- **Riesgo:** inconsistencias entre configurado vs efectivo.  
  **Mitigación:** usar campos `effective*` devueltos por ejecución.

## 9. Criterios de aceptación

1. toda ejecución muestra agente y modelo efectivos al finalizar;
2. en fallback/override se informa transición explícita;
3. en error también se muestran metadatos si están disponibles;
4. formato es consistente y legible en Telegram.

## 10. Plan de implementación

1. Extender contrato de salida del adaptador OpenCode con metadatos efectivos.
2. Ajustar handler de Telegram para renderizar bloque final.
3. Incluir mensaje de fallback cuando aplique.
4. Verificar manualmente casos: éxito, error, fallback.
