# RFC-014 — `/attach-local` para abrir terminal local y adjuntar tmux de sesión PTY

**Estado:** Implementado  
**Autor:** AI Architect  
**Fecha:** 28 de Abril de 2026

## 1. Contexto

El proyecto ya opera sesiones OpenCode en modo PTY/tmux. Cuando un chat vincula una sesión, el host local usa un nombre tmux estable derivado del `sessionId`:

```text
tgoc_<sessionIdSanitized>
```

La documentación ya puede orientar al usuario a ejecutar manualmente algo equivalente a:

```bash
tmux attach -t tgoc_<id>
```

En una máquina Windows con WSL, existe una mejora de UX posible: pedir desde Telegram que el bot abra una terminal local en la PC del usuario y adjunte automáticamente la sesión tmux correspondiente.

Esta capacidad es distinta de crear o vincular sesiones. No pertenece al dominio de sesiones OpenCode, sino a automatización local del host.

## 2. Problema

El usuario puede tener una sesión activa vinculada en Telegram, pero para verla/intervenir localmente debe:

1. recordar el nombre tmux;
2. abrir PowerShell/Windows Terminal;
3. entrar a WSL;
4. navegar al proyecto si hace falta;
5. ejecutar `tmux attach -t tgoc_<session>`.

Esto es repetitivo y propenso a errores.

Pero automatizarlo desde Telegram cambia la superficie de riesgo: el bot pasa a abrir procesos locales visibles en la PC del usuario. Eso no debe modelarse como `/run` genérico ni como shell libre. Tiene que ser una intención fija, acotada y protegida.

## 3. Relación con RFC-012

RFC-012 define el hardening previo obligatorio para automatización local:

- private-only;
- feature flags apagadas por defecto;
- intent fijo, no shell libre;
- confirmación de dos pasos;
- auditoría;
- fail-closed.

Este RFC aplica esas reglas a una acción concreta:

```text
/attach-local
```

## 4. Objetivo

Diseñar `/attach-local` para abrir una terminal local en Windows/WSL y ejecutar un attach a la sesión tmux asociada a la sesión OpenCode activa del chat.

La intención es:

```text
Telegram → confirmar acción local → abrir terminal local → wsl/tmux attach
```

## 5. Alcance

### Entra en alcance

- Comando fijo `/attach-local`.
- Validar sesión activa del chat.
- Calcular nombre tmux estable con la misma regla que el host PTY.
- Abrir terminal local cuando el entorno lo permita.
- Priorizar Windows Terminal (`wt.exe`) si está disponible.
- Usar PowerShell como fallback.
- Devolver comando manual como fallback seguro.
- Aplicar hardening de RFC-012.
- Registrar auditoría de intento, confirmación, éxito o falla.

### Fuera de alcance

- Ejecutar comandos arbitrarios desde Telegram.
- Soportar servidores headless como si fueran escritorio local.
- Abrir sesiones gráficas en máquinas remotas por SSH.
- Resolver MFA o aprobación nativa de Windows.
- Crear nuevas sesiones OpenCode; eso pertenece a RFC-013.
- Cambiar cómo se nombra la sesión tmux existente.

## 6. Precondiciones obligatorias

`/attach-local` debe ejecutar solo si se cumplen todas:

- actor autorizado;
- `chat.type = private`;
- `ENABLE_LOCAL_HOST_ACTIONS=true`;
- `ENABLE_ATTACH_LOCAL=true`;
- proyecto activo;
- sesión activa;
- sesión y proyecto consistentes;
- tmux disponible en WSL/local;
- entorno local apto para abrir terminal;
- confirmación vigente, atada a actor/chat/proyecto/sesión/intención.

Si cualquier precondición falla, no se abre nada.

## 7. UX propuesta

### 7.1 Feature apagada

```text
ℹ️ Attach local deshabilitado

Esta capacidad abre una terminal en la máquina local y está apagada por configuración.
```

### 7.2 No hay sesión activa

```text
🔴 No hay sesión activa

Primero vinculá una sesión con /sesiones o /session <id>.
```

### 7.3 Confirmación previa

```text
🟠 Confirmar attach local
📁 telegram-opencode • 🔌 sess_abc123 • 🏷️ local-host-action

Voy a abrir una terminal local y ejecutar:
tmux attach -t tgoc_sess_abc123

¿Confirmás?
```

Botones:

- Confirmar
- Cancelar

### 7.4 Éxito

```text
🟢 Terminal local solicitada

Abrí una terminal para adjuntar tmux a tgoc_sess_abc123.
```

### 7.5 Fallback manual

```text
ℹ️ No pude abrir una terminal local automáticamente

Ejecutá manualmente:
wsl.exe bash -lc 'tmux attach -t tgoc_sess_abc123'
```

## 8. Estrategia de launcher

### 8.1 Orden recomendado

1. `wt.exe` si está disponible.
2. PowerShell si está disponible.
3. Comando manual como fallback.

### 8.2 Windows Terminal

Preferir Windows Terminal por UX:

- abre pestaña/ventana moderna;
- maneja mejor perfiles;
- menos dependencia de quoting visual de PowerShell.

Ejemplo conceptual:

```powershell
wt.exe wsl.exe bash -lc 'cd <projectPath> && tmux attach -t tgoc_<session>'
```

### 8.3 PowerShell fallback

PowerShell es más universal en Windows, pero el quoting es más frágil.

Ejemplo conceptual:

```powershell
powershell.exe -NoProfile -Command "Start-Process wsl.exe -ArgumentList ..."
```

### 8.4 Fallback manual

Si no hay entorno gráfico local confiable o falla el launcher, el bot no debe insistir ni probar comandos peligrosos. Debe devolver el comando exacto para copiar.

## 9. Diseño técnico sugerido

### 9.1 Servicio de aplicación

Agregar una acción tipada, no genérica:

```ts
attachLocal(input: {
  readonly actorId: string;
  readonly chatId: string;
  readonly chatType: string;
}): Promise<Result<AttachLocalOutput>>
```

O integrarla como dangerous action existente si el modelo actual ya cubre confirmaciones de host local.

### 9.2 Infraestructura

Crear un launcher dedicado, por ejemplo:

```text
src/infrastructure/local-terminal-launcher.ts
```

Responsabilidades:

- detectar `wt.exe`, `powershell.exe`, `wsl.exe`;
- construir argumentos seguros;
- ejecutar con `spawn`/`execFile`, no shell libre;
- devolver resultado tipado;
- no conocer Telegram.

### 9.3 Reutilizar naming de tmux

Debe usarse la misma función/regla que hoy genera:

```text
tgoc_<sessionIdSanitized>
```

No duplicar sanitización en otro lado. Duplicar reglas de naming es deuda barata hoy y bug caro mañana.

### 9.4 Router Telegram

El router debe:

1. reconocer `/attach-local`;
2. clasificarlo como acción local peligrosa;
3. validar private-only y flags;
4. mostrar confirmación;
5. ejecutar solo desde callback confirmado;
6. responder con éxito o fallback manual.

## 10. Seguridad

Reglas no negociables:

- `/attach-local` no acepta argumentos libres;
- no existe `/run powershell`;
- no se ejecuta shell arbitrario;
- no se interpola texto del usuario;
- el único parámetro variable permitido es sesión/proyecto ya persistido y validado;
- paths y session IDs se sanitizan/canonizan;
- confirmación es de un solo uso;
- TTL corto;
- contexto revalidado al confirmar;
- solo chat privado;
- flags apagadas por defecto.

Esto evita convertir Telegram en una puerta trasera a la PC local.

## 11. Auditoría

Cada intento debe registrar:

- `actorId`;
- `chatId`;
- `chat.type`;
- `projectId`;
- `sessionId`;
- `tmuxSessionName`;
- launcher elegido (`wt`, `powershell`, `manual-fallback`);
- resultado (`requested`, `rejected`, `failed`, `cancelled`);
- razón de rechazo/falla;
- timestamp.

## 12. Riesgos y mitigaciones

### 12.1 Bot corriendo headless

**Riesgo:** no hay escritorio local donde abrir terminal.  
**Mitigación:** detectar entorno no apto y devolver comando manual.

### 12.2 Quoting Windows/WSL frágil

**Riesgo:** path o session name mal escapado rompe el attach.  
**Mitigación:** usar `spawn`/`execFile` con argumentos separados y sanitización centralizada.

### 12.3 RCE local accidental

**Riesgo:** que el feature derive en ejecución remota generalista.  
**Mitigación:** comando fijo, sin args libres, flags, confirmación y auditoría.

### 12.4 Sesión tmux inexistente

**Riesgo:** la sesión OpenCode está vinculada, pero tmux no existe o murió.  
**Mitigación:** verificar tmux antes de abrir terminal o mostrar mensaje de recuperación: revincular con `/session` o `/sesiones`.

### 12.5 Uso en grupo

**Riesgo:** acción sensible disparada desde contexto compartido.  
**Mitigación:** private-only obligatorio.

## 13. Alternativas consideradas

### A. Abrir PowerShell directamente

Compatible y cercano a la idea original, pero más acoplado a Windows y con quoting más frágil.

### B. Abrir Windows Terminal

Recomendada como primera opción. Mejor UX y pestañas modernas. Tradeoff: depende de que `wt.exe` esté instalado.

### C. Solo devolver comando manual

Máxima seguridad y menor complejidad. Peor UX. Debe existir como fallback.

### D. Crear `/run` genérico

Descartada. Es una locura cósmica de seguridad: convierte Telegram en shell remoto.

## 14. Criterios de aceptación

- `/attach-local` no aparece en `/help` si las flags están apagadas.
- Si se invoca apagado, responde deshabilitado y no ejecuta nada.
- Solo funciona en chat privado.
- Requiere sesión activa.
- Muestra confirmación con proyecto, sesión y tmux target.
- Confirmación expira y es de un solo uso.
- Si confirma, intenta abrir terminal local con orden `wt.exe` → PowerShell → fallback manual.
- Si no puede abrir terminal, devuelve comando manual exacto.
- No acepta argumentos libres.
- No ejecuta shell arbitrario.
- Registra auditoría de resultado.

## 15. Plan de implementación sugerido

1. Reutilizar hardening de RFC-012 para clasificar `/attach-local` como acción local peligrosa.
2. Crear `local-terminal-launcher` con detección de `wt.exe`, `powershell.exe`, `wsl.exe`.
3. Reutilizar función de nombre tmux estable desde `opencode-tmux-host`.
4. Implementar confirmación y ejecución desde callback.
5. Agregar mensajes UX y fallback manual.
6. Documentar flags en `.env.example` y README.
7. Verificar manualmente en Windows/WSL local.

## 16. Decisión

Se propone implementar `/attach-local` como automatización local tipada, apagada por defecto y protegida por confirmación.

La prioridad técnica es mantener separación clara:

- RFC-013 resuelve ciclo de vida de sesión PTY;
- RFC-014 resuelve automatización local del host.

Mezclarlas sería mala separación de responsabilidades: una cosa es crear/vincular sesiones; otra muy distinta es abrir procesos en la PC del usuario.
