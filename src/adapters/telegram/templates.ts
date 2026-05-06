import { CancelSessionOutput, RunSessionCommandOutput, StatusOutput } from "../../application/use-cases";
import { DomainError, ERROR_CODES } from "../../domain/errors";
import {
  ADAPTER_ERROR_CODES,
  ASYNC_SESSION_NOTICE_KIND,
  AdapterErrorCode,
  AsyncSessionNotice,
  BOOT_RECOVERY_NOTICE_KIND,
  BootRecoveryNotice,
  RECOVERY_REASON,
} from "../../application/contracts";
import { PendingPrompt, PENDING_PROMPT_STATUS, PROMPT_TYPE } from "../../domain/entities";
import {
  PROJECT_SESSION_ASSOCIATION,
  ProjectSessionInspectionSuccessResult,
  ProjectSessionListItem,
} from "../../infrastructure/opencode-project-sessions";

const FALLBACK_ERROR_MESSAGE = "Hubo un problema, probá de nuevo en unos segundos.";

const UX_SEMANTIC = {
  SUCCESS: "success",
  RUNNING: "running",
  NEEDS_ATTENTION: "needs-attention",
  ERROR: "error",
  INFO: "info",
} as const;

type UxSemantic = (typeof UX_SEMANTIC)[keyof typeof UX_SEMANTIC];

interface UxContext {
  readonly project?: string;
  readonly session?: string;
  readonly state?: string;
}

interface UxBlock {
  readonly semantic: UxSemantic;
  readonly title: string;
  readonly lines: readonly string[];
  readonly context?: UxContext;
}

function semanticEmoji(semantic: UxSemantic): string {
  if (semantic === UX_SEMANTIC.SUCCESS) return "🟢";
  if (semantic === UX_SEMANTIC.RUNNING) return "🟡";
  if (semantic === UX_SEMANTIC.NEEDS_ATTENTION) return "🟠";
  if (semantic === UX_SEMANTIC.ERROR) return "🔴";
  return "ℹ️";
}

function formatUxContext(context?: UxContext): string | undefined {
  if (!context) return undefined;

  const contextParts = [
    `📁 ${context.project ?? "sin proyecto"}`,
    `🔌 ${context.session ?? "sin sesión"}`,
    `🏷️ ${context.state ?? "n/d"}`,
  ];

  return contextParts.join(" • ");
}

function renderUxBlock(block: UxBlock): string {
  const lines: string[] = [`${semanticEmoji(block.semantic)} ${block.title}`];
  const contextLine = formatUxContext(block.context);
  if (contextLine) {
    lines.push(contextLine);
  }

  lines.push(...block.lines);
  return lines.join("\n");
}

export function formatProjectSelected(projectId: string, alias: string): string {
  return renderUxBlock({
    semantic: UX_SEMANTIC.SUCCESS,
    title: "Proyecto seleccionado",
    context: {
      project: alias,
      session: "sin sesión",
      state: "idle",
    },
    lines: [
      `Alias: ${alias}`,
      `ID: ${projectId}`,
      "Siguiente paso: usá /sesiones para elegir una sesión PTY/OpenCode del proyecto o vinculá una manualmente con /session <id>.",
    ],
  });
}

export function formatSessionLinked(sessionId: string, projectId: string): string {
  return renderUxBlock({
    semantic: UX_SEMANTIC.SUCCESS,
    title: "Sesión vinculada",
    context: {
      project: projectId,
      session: sessionId,
      state: "session-linked",
    },
    lines: [
      "Ya podés enviar mensajes a la sesión activa.",
      "La terminal local se solicita automáticamente para este vínculo.",
      "Para cambiar de sesión, usá /sesiones o repetí /session <otro-id>.",
    ],
  });
}

export function formatLegacyNewDisabled(): string {
  return renderUxBlock({
    semantic: UX_SEMANTIC.INFO,
    title: "Comando deshabilitado",
    lines: ["/new ya no forma parte del flujo PTY-only. Creá o continuá la sesión desde OpenCode y luego usá /sesiones o /session <id>."],
  });
}

export function formatNewSessionUnsupportedBackend(): string {
  return renderUxBlock({
    semantic: UX_SEMANTIC.INFO,
    title: "/new no disponible",
    lines: ["/new no está disponible en este backend. Usá /sesiones o /session <id>."]
  });
}

export function formatNewSessionCreatedConfirmation(sessionId: string, projectId: string): string {
  return renderUxBlock({
    semantic: UX_SEMANTIC.SUCCESS,
    title: "Sesión creada y vinculada",
    context: {
      project: projectId,
      session: sessionId,
      state: "session-linked",
    },
    lines: ["Ya podés enviar mensajes a la sesión activa.", "La terminal local se solicita automáticamente para este vínculo."],
  });
}

export function formatNewSessionCreatedNotLinked(sessionId: string): string {
  return renderUxBlock({
    semantic: UX_SEMANTIC.INFO,
    title: "Sesión creada, no vinculada",
    context: {
      session: sessionId,
    },
    lines: [`Podés vincularla después con /sesiones o /session ${sessionId}.`],
  });
}

export function formatNewSessionNoCandidate(): string {
  return renderUxBlock({
    semantic: UX_SEMANTIC.ERROR,
    title: "No pude confirmar la creación de una sesión nueva",
    lines: [
      "OpenCode no expuso un sessionId nuevo dentro del timeout.",
      "Abrí OpenCode localmente o usá /sesiones si la sesión ya aparece.",
    ],
  });
}

export function formatNewSessionAmbiguous(): string {
  return renderUxBlock({
    semantic: UX_SEMANTIC.NEEDS_ATTENTION,
    title: "Encontré más de una sesión nueva para este proyecto",
    lines: [
      "No voy a vincular automáticamente para evitar enganchar la sesión equivocada.",
      "Elegí una con /sesiones.",
    ],
  });
}

export function formatNewSessionToolingUnavailable(): string {
  return renderUxBlock({
    semantic: UX_SEMANTIC.ERROR,
    title: "Herramientas locales no disponibles",
    lines: ["OpenCode CLI o tmux no están disponibles. Verificá PATH e instalá las herramientas requeridas."],
  });
}

export function formatSessionCreated(sessionId: string, projectId: string): string {
  return renderUxBlock({
    semantic: UX_SEMANTIC.SUCCESS,
    title: "Nueva sesión creada",
    context: {
      project: projectId,
      session: sessionId,
      state: "session-linked",
    },
    lines: ["La sesión quedó lista para operar. Si usás backend CLI, la creación se hace primero desde tu terminal."],
  });
}

export interface ExecutionMetadataInput {
  readonly requestedAgent?: string;
  readonly requestedModel?: string;
  readonly effectiveAgent?: string;
  readonly effectiveModel?: string;
  readonly modelValidationDegraded?: string;
}

function formatExecutionMetadataLines(input?: ExecutionMetadataInput): readonly string[] {
  const lines: string[] = [];
  lines.push(`🤖 Agente: ${input?.effectiveAgent ?? "no disponible"}`);
  lines.push(`🧠 Modelo: ${input?.effectiveModel ?? "no disponible"}`);

  if (input?.requestedModel && input.effectiveModel && input.requestedModel !== input.effectiveModel) {
    lines.push(`ℹ️ Fallback modelo: ${input.requestedModel} → ${input.effectiveModel}`);
  }

  if (input?.requestedAgent && input.effectiveAgent && input.requestedAgent !== input.effectiveAgent) {
    lines.push(`ℹ️ Override agente: ${input.requestedAgent} → ${input.effectiveAgent}`);
  }

  if (input?.modelValidationDegraded) {
    lines.push(`⚠️ Validación de modelo degradada: ${input.modelValidationDegraded}`);
  }

  return lines;
}

export function formatExecutionMetadataBlock(input?: ExecutionMetadataInput): string {
  return formatExecutionMetadataLines(input).join("\n");
}

export function formatSendSuccess(message: string, needsAttention: boolean, metadata?: ExecutionMetadataInput): string {
  const metadataLines = formatExecutionMetadataLines(metadata);
  if (message.trim()) {
    return renderUxBlock({
      semantic: needsAttention ? UX_SEMANTIC.NEEDS_ATTENTION : UX_SEMANTIC.SUCCESS,
      title: needsAttention ? "Respuesta recibida (requiere atención)" : "Respuesta recibida",
      lines: metadataLines.length > 0 ? [message, ...metadataLines] : [message],
    });
  }

  if (needsAttention) {
    return "OpenCode quedó esperando tu respuesta. Revisá /status y seguí por acá.";
  }

  if (metadataLines.length > 0) {
    return ["Listo. Tu mensaje fue enviado a la sesión activa.", ...metadataLines].join("\n");
  }

  return "Listo. Tu mensaje fue enviado a la sesión activa.";
}

export function formatCancelSuccess(result: CancelSessionOutput, status: StatusOutput): string {
  return renderUxBlock({
    semantic: UX_SEMANTIC.SUCCESS,
    title: result.status === "accepted" ? "Cancelación solicitada" : "Sesión cancelada",
    context: {
      project: status.projectAlias ?? status.projectId,
      session: status.sessionId,
      state: status.mode,
    },
    lines: [
      result.message,
      "Si querés continuar, revisá /status y enviá una nueva instrucción cuando quede libre.",
    ],
  });
}

export function formatCancelUnsupported(status: StatusOutput, guidance?: string): string {
  return renderUxBlock({
    semantic: UX_SEMANTIC.INFO,
    title: "Cancelación no soportada en este backend",
    context: {
      project: status.projectAlias ?? status.projectId,
      session: status.sessionId,
      state: status.mode,
    },
    lines: [
      guidance?.trim() || "Este backend no permite interrumpir tareas remotas todavía.",
      "Siguientes pasos: usá /status para monitorear y esperá a que la tarea termine antes de enviar más texto.",
    ],
  });
}

export function formatCancelNoActiveTask(status?: StatusOutput): string {
  return renderUxBlock({
    semantic: UX_SEMANTIC.INFO,
    title: "No hay tarea activa para cancelar",
    context: {
      project: status?.projectAlias ?? status?.projectId,
      session: status?.sessionId,
      state: status?.mode,
    },
    lines: ["Cuando haya una tarea en curso, podés usar /cancel para interrumpirla."],
  });
}

export function formatProjectQuery(status: StatusOutput): string {
  return renderUxBlock({
    semantic: UX_SEMANTIC.INFO,
    title: "Proyecto actual",
    context: {
      project: status.projectAlias ?? status.projectId,
      session: status.sessionId,
      state: status.mode,
    },
    lines: [
      `Proyecto: ${status.projectAlias ?? status.projectId ?? "sin seleccionar"}`,
      status.projectId
        ? "Para cambiar de proyecto usá /project <alias|projectId>."
        : "Todavía no elegiste proyecto. Usá /project <alias|projectId>.",
    ],
  });
}

export function formatBusyCommandRejected(status: StatusOutput, command: string): string {
  return renderUxBlock({
    semantic: UX_SEMANTIC.RUNNING,
    title: "Comando bloqueado por tarea en curso",
    context: {
      project: status.projectAlias ?? status.projectId,
      session: status.sessionId,
      state: status.mode,
    },
    lines: [
      `El comando /${command} no se puede ejecutar mientras hay una tarea activa.`,
      "Permitidos en busy: /status, /sesiones, /cancel, /project (sin argumentos).",
    ],
  });
}

export function formatAgentList(agents: readonly string[], activeAgent?: string): string {
  if (agents.length === 0) {
    return "No hay agentes disponibles.";
  }

  const lines = agents.map((agent) => (agent === activeAgent ? `• ✅ ${agent}` : `• ${agent}`));
  return [
    activeAgent ? `Agentes disponibles (activo: ${activeAgent}):` : "Agentes disponibles:",
    "Elegí un botón abajo.",
    ...lines,
  ].join("\n");
}

export function formatModelActive(model: string): string {
  return `✅ Modelo activo: ${model}`;
}

export function formatModelActiveWithSessionReconfigured(model: string, attachLocalReopened = false): string {
  return [
    formatModelActive(model),
    attachLocalReopened
      ? "ℹ️ Reinicié la sesión PTY/tmux y reabrí la terminal local adjunta con el nuevo modelo."
      : "ℹ️ Reinicié la sesión PTY/tmux para aplicar el modelo. Si tu terminal adjunta se cerró, usá /attach-local para reabrirla.",
  ].join("\n");
}

export function formatModelList(models: readonly string[], activeModel?: string): string {
  if (models.length === 0) {
    return "No hay modelos disponibles.";
  }

  const lines = models.map((model) => (model === activeModel ? `• ✅ ${model}` : `• ${model}`));
  return [
    activeModel ? `Modelos disponibles (activo: ${activeModel}):` : "Modelos disponibles:",
    "Elegí un botón abajo.",
    ...lines,
  ].join("\n");
}

export function formatModelUnavailable(reason?: string): string {
  return `🔴 Catálogo de modelos no disponible${reason ? ` (${reason})` : ""}. Reintentá con /modelos.`;
}

export function formatModelFallbackNotice(previous: string, next: string): string {
  return `⚠️ Modelo ${previous} no disponible. Fallback aplicado: ${next}`;
}

export function formatInvalidModel(): string {
  return "🔴 Modelo no disponible para este entorno. Usá /modelos.";
}

export function formatAgentActive(agent: string): string {
  return [
    `✅ Agente CONFIGURADO (Telegram): ${agent}`,
    "⚠️ Cambio manual en OpenCode Console puede generar drift.",
    "↺ Recomendado: /agente nombre para reaplicar.",
  ].join("\n");
}

export function formatAgentActiveWithSessionReconfigured(agent: string, attachLocalReopened = false): string {
  return [
    formatAgentActive(agent),
    attachLocalReopened
      ? "ℹ️ Reinicié la sesión PTY/tmux y reabrí la terminal local adjunta con el nuevo agente."
      : "ℹ️ Reinicié la sesión PTY/tmux para aplicar el agente. Si tu terminal adjunta se cerró, usá /attach-local para reabrirla.",
  ].join("\n");
}

export function formatAgentSyncNotice(input: {
  readonly requestedAgent?: string;
  readonly requestedModel?: string;
  readonly effectiveAgent?: string;
  readonly effectiveModel?: string;
  readonly changed: boolean;
}): string {
  const lines = [
    input.changed ? "↺ Metadata runtime sincronizada" : "ℹ️ Metadata runtime sin cambios",
    `🤖 Agente: ${input.effectiveAgent ?? "no disponible"}`,
    `🧠 Modelo: ${input.effectiveModel ?? "no disponible"}`,
  ];

  if (input.requestedAgent && input.effectiveAgent && input.requestedAgent !== input.effectiveAgent) {
    lines.push(`ℹ️ Override agente: ${input.requestedAgent} → ${input.effectiveAgent}`);
  }

  if (input.requestedModel && input.effectiveModel && input.requestedModel !== input.effectiveModel) {
    lines.push(`ℹ️ Fallback modelo: ${input.requestedModel} → ${input.effectiveModel}`);
  }

  return lines.join("\n");
}

export function formatInvalidAgent(agents: readonly string[]): string {
  return `🔴 Agente no válido. Opciones: ${agents.join(", ")}`;
}

export function formatRunCommandSuccess(result: RunSessionCommandOutput): string {
  const lines: string[] = [];

  if (result.message.trim()) {
    lines.push(result.message);
  } else if (result.ack?.trim()) {
    lines.push(result.ack);
  } else if (result.taskId) {
    lines.push(`Comando enviado ✅\nTask: ${result.taskId}`);
  } else {
    lines.push("Comando ejecutado ✅");
  }

  if (result.status === "completed") {
    lines.push("La sesión quedó en estado completed. Podés seguir usando /run o enviar texto libre.");
  } else if (result.status === "unknown") {
    lines.push("OpenCode devolvió estado unknown. Mantengo el modo estable local hasta actualizar /status.");
  }

  if (result.warning?.trim()) {
    lines.push(`Aviso: ${result.warning}`);
  }

  if (!result.taskId && result.needsAttention) {
    lines.push("OpenCode quedó esperando tu respuesta. Revisá /status y seguí por acá.");
  }

  return lines.join("\n");
}

export function formatStatus(status: StatusOutput): string {
  const lines = [
    `• Modo: ${status.mode}`,
    `• Proyecto: ${status.projectAlias ?? status.projectId ?? "sin seleccionar"}`,
    `• Sesión: ${status.sessionId ?? "sin vincular"}`,
    `• Tarea activa: ${status.activeTaskId ?? "ninguna"}`,
  ];

  if (status.lastErrorCode) {
    lines.push(`• Último error: ${status.lastErrorCode}`);
    if (status.lastErrorMessage) {
      lines.push(`• Detalle: ${status.lastErrorMessage}`);
    }
  }

  if (status.recoveryStatus) {
    lines.push(`• Recovery: ${status.recoveryStatus}`);
  }

  if (status.recoveryReason) {
    lines.push(`• Motivo recovery: ${status.recoveryReason}`);
  }

  if (status.lastReconciledAt) {
    lines.push(`• Última reconciliación: ${status.lastReconciledAt}`);
  }

  if (!status.projectId) {
    lines.push("Siguiente paso: elegí proyecto con /project <alias|projectId>.");
  } else if (!status.sessionId) {
    lines.push("Siguiente paso: elegí una sesión con /sesiones o vinculala manualmente con /session <id>.");
  }

  return renderUxBlock({
    semantic: status.mode === "task-running" ? UX_SEMANTIC.RUNNING : status.mode === "needs-attention" ? UX_SEMANTIC.NEEDS_ATTENTION : UX_SEMANTIC.INFO,
    title: "Estado actual",
    context: {
      project: status.projectAlias ?? status.projectId,
      session: status.sessionId,
      state: status.mode,
    },
    lines: [
      ...lines,
      !status.projectId
        ? "Flujo PTY: /project <path-local> → /sesiones → confirmá la vinculación."
        : !status.sessionId
          ? "Sesión pendiente: usá /sesiones para ver sólo las sesiones OpenCode seguras del proyecto activo."
          : "",
    ].filter((line) => line.trim().length > 0),
  });
}

export function formatProjectSessionsRequireProject(): string {
  return "🔴 Primero seleccioná un proyecto con /project <ruta> antes de listar sesiones.";
}

export function formatProjectSessions(projectPath: string, sessions: readonly ProjectSessionListItem[]): string {
  return renderUxBlock({
    semantic: UX_SEMANTIC.INFO,
    title: "Sesiones del proyecto actual",
    context: {
      project: projectPath,
      state: "session-selection",
    },
    lines: [
      "Seleccioná una sesión para vincularla a este chat:",
      ...sessions.map((session) => formatProjectSessionLine(session)),
    ],
  });
}

export function formatProjectSessionsEmpty(): string {
  return "ℹ️ No encontré sesiones disponibles para el proyecto actual.";
}

export function formatProjectSessionsEmptyDebug(input: {
  readonly activeRootPath: string;
  readonly inspection: ProjectSessionInspectionSuccessResult;
}): string {
  const { activeRootPath, inspection } = input;
  const counts = inspection.sessions.reduce(
    (accumulator, session) => {
      accumulator[session.association] += 1;
      return accumulator;
    },
    {
      [PROJECT_SESSION_ASSOCIATION.MATCH]: 0,
      [PROJECT_SESSION_ASSOCIATION.PROJECT_MISMATCH]: 0,
      [PROJECT_SESSION_ASSOCIATION.UNSAFE]: 0,
    }
  );

  const lines = [
    `rootPath comparado: ${activeRootPath} => ${inspection.projectPath}${activeRootPath === inspection.projectPath ? "" : " (mismatch)"}`,
    `Total OpenCode: ${inspection.sessions.length}`,
    `MATCH=${counts[PROJECT_SESSION_ASSOCIATION.MATCH]} PROJECT_MISMATCH=${counts[PROJECT_SESSION_ASSOCIATION.PROJECT_MISMATCH]} UNSAFE=${counts[PROJECT_SESSION_ASSOCIATION.UNSAFE]}`,
  ];

  const inspectedSessions = inspection.sessions.slice(0, 5);
  if (inspectedSessions.length > 0) {
    lines.push(
      ...inspectedSessions.map(
        (session) =>
          `• ${session.sessionId} | ${session.association} | ${session.path ?? "sin path"}`
      )
    );
  }

  return renderUxBlock({
    semantic: UX_SEMANTIC.INFO,
    title: "Debug vacío /sesiones",
    context: {
      project: inspection.projectPath,
      state: "empty-filtered",
    },
    lines,
  });
}

export function formatProjectSessionsReadError(): string {
  return "🔴 No pude consultar las sesiones de OpenCode. Verificá que el bridge PTY y OpenCode estén disponibles.";
}

export function formatSesionTypoGuidance(): string {
  return "ℹ️ Comando no disponible: /sesion. Usá /sesiones para listar y elegir una sesión en un solo paso.";
}

export function formatProjectSessionConfirmation(projectPath: string, sessionId: string): string {
  return renderUxBlock({
    semantic: UX_SEMANTIC.NEEDS_ATTENTION,
    title: "Confirmar vinculación",
    context: {
      project: projectPath,
      session: sessionId,
      state: "pending-confirmation",
    },
    lines: ["¿Querés vincular esta sesión a este chat?"],
  });
}

export function formatProjectSessionCancelled(): string {
  return "ℹ️ Vinculación cancelada. La sesión actual del chat no cambió.";
}

export function formatProjectSessionUnavailable(): string {
  return "🔴 La sesión seleccionada ya no está disponible. Volvé a ejecutar /sesiones.";
}

export function formatProjectSessionMismatch(): string {
  return "🔴 La sesión seleccionada no coincide con el proyecto activo de este chat.";
}

export function formatNoSessionGuide(status?: StatusOutput): string {
  return renderUxBlock({
    semantic: UX_SEMANTIC.ERROR,
    title: "Falta contexto operativo",
    context: {
      project: status?.projectAlias ?? status?.projectId,
      session: status?.sessionId,
      state: status?.mode,
    },
    lines: [
      "Primero elegí proyecto y sesión (/project + /sesiones o /session).",
      "Flujo PTY: /project <path-local> → /sesiones → confirmá la vinculación.",
    ],
  });
}

export function formatFreeTextRejectedBusy(status: StatusOutput): string {
  return renderUxBlock({
    semantic: UX_SEMANTIC.RUNNING,
    title: "Hay una tarea en curso",
    context: {
      project: status.projectAlias ?? status.projectId,
      session: status.sessionId,
      state: status.mode,
    },
    lines: ["Esperá a que termine antes de enviar texto libre. Podés consultar /status."],
  });
}

export function formatLegacyRunCmdDisabled(): string {
  return renderUxBlock({
    semantic: UX_SEMANTIC.INFO,
    title: "Comando deshabilitado",
    lines: ["/run y /cmd ya no forman parte del flujo PTY-only. Vinculá una sesión y usá texto libre en el chat."],
  });
}

export function formatLegacyRunCmdDeprecationNotice(): string {
  return "ℹ️ /run y /cmd quedan en transición. Migrá gradualmente al catálogo RFC-004 (/help).";
}

export function formatCommandCatalog(catalog: readonly string[], unknownCommand?: string): string {
  const lines: string[] = [];
  if (unknownCommand) {
    lines.push(`Comando no reconocido: /${unknownCommand}`);
  }

  lines.push("Comandos disponibles:");
  lines.push(...catalog.map((entry) => `• ${entry}`));

  return renderUxBlock({
    semantic: unknownCommand ? UX_SEMANTIC.ERROR : UX_SEMANTIC.INFO,
    title: unknownCommand ? "Comando inválido" : "Ayuda rápida",
    lines,
  });
}

export function formatUsage(command: "project" | "session" | "new" | "attach-local"): string {
  if (command === "project") {
    return "Uso: /project <alias|projectId>";
  }

  if (command === "new") {
    return "Usá /new <mensaje inicial>";
  }

  if (command === "attach-local") {
    return "Uso: /attach-local";
  }

  return "Uso: /session <sessionId>";
}

export function formatRecoveryNotice(notice: BootRecoveryNotice): string {
  if (notice.kind === BOOT_RECOVERY_NOTICE_KIND.SESSION_CLOSED) {
    return renderUxBlock({
      semantic: UX_SEMANTIC.INFO,
      title: "Recuperación de arranque: sesión cerrada",
      context: {
        project: notice.projectId,
        session: notice.sessionId,
        state: "session-linked",
      },
      lines: [
        "La sesión remota ya no estaba disponible y se desvinculó localmente.",
        `Motivo: ${formatRecoveryReason(notice.reason)}.`,
        "Siguiente paso: elegí otra sesión con /sesiones o vinculala manualmente con /session.",
      ],
    });
  }

  if (notice.kind === BOOT_RECOVERY_NOTICE_KIND.DEGRADED) {
    return renderUxBlock({
      semantic: UX_SEMANTIC.NEEDS_ATTENTION,
      title: "Recuperación de arranque: estado degradado",
      context: {
        project: notice.projectId,
        session: notice.sessionId,
        state: "degraded",
      },
      lines: [
        "No pude validar la sesión remota durante el arranque.",
        `Motivo: ${formatRecoveryReason(notice.reason)}.`,
        "El vínculo local se conservó. Revisá /status y reintentá en unos segundos.",
      ],
    });
  }

  return renderUxBlock({
    semantic: UX_SEMANTIC.SUCCESS,
    title: "Recuperación de arranque",
    context: {
      project: notice.projectId,
      session: notice.sessionId,
      state: "recovered",
    },
    lines: [notice.message ?? "Se recuperó la sesión remota correctamente."],
  });
}

export function formatAsyncSessionNotice(notice: AsyncSessionNotice): string {
  if (notice.kind === ASYNC_SESSION_NOTICE_KIND.NEEDS_INPUT) {
    return renderUxBlock({
      semantic: UX_SEMANTIC.NEEDS_ATTENTION,
      title: "OpenCode necesita tu respuesta",
      context: {
        project: notice.projectId,
        session: notice.sessionId,
        state: "needs-attention",
      },
      lines: [
        notice.summary ?? "La sesión quedó esperando confirmación humana para continuar.",
        `Sesión: ${notice.sessionId}`,
        notice.taskId ? `Task: ${notice.taskId}` : "Task: n/d",
        "Respondé en este chat para continuar la misma sesión.",
      ],
    });
  }

  if (notice.kind === ASYNC_SESSION_NOTICE_KIND.CONTINUITY_LOST) {
    return renderUxBlock({
      semantic: UX_SEMANTIC.INFO,
      title: "Watcher restablecido tras reinicio",
      context: {
        project: notice.projectId,
        session: notice.sessionId,
        state: "watchdog-recovery",
      },
      lines: [
        "Se perdió la continuidad del webhook efímero después del reinicio.",
        "A partir de ahora la reconciliación queda a cargo del watchdog hasta el próximo evento de estado estable.",
        notice.summary ?? "Si la tarea ya terminó, vas a recibir la notificación cuando el watchdog la reconcilie.",
      ],
    });
  }

  return renderUxBlock({
    semantic: notice.terminalCause?.includes("failed") ? UX_SEMANTIC.ERROR : UX_SEMANTIC.SUCCESS,
    title: notice.terminalCause?.includes("failed") ? "Sesión finalizada con error" : "Sesión finalizada",
    context: {
      project: notice.projectId,
      session: notice.sessionId,
      state: notice.terminalSource ?? "terminal",
    },
    lines: [
      notice.summary ?? "OpenCode reportó un estado terminal.",
      `🤖 Agente: ${notice.effectiveAgent ?? "no disponible"}`,
      `🧠 Modelo: ${notice.effectiveModel ?? "no disponible"}`,
      ...formatFallbackTransitionLines(notice),
      notice.taskId ? `Task: ${notice.taskId}` : "Task: n/d",
      `Origen: ${notice.terminalSource ?? "desconocido"}`,
      `Causa: ${notice.terminalCause ?? "desconocida"}`,
    ],
  });
}

function formatFallbackTransitionLines(notice: AsyncSessionNotice): readonly string[] {
  return formatExecutionMetadataLines(notice).filter((line) => line.startsWith("ℹ️"));
}

export function formatActiveHumanPrompt(prompt: {
  readonly message: string;
  readonly promptType: PendingPrompt["promptType"];
  readonly options?: readonly string[];
  readonly expiresAt?: string;
}): string {
  const lines: string[] = [prompt.message];

  if (prompt.promptType === PROMPT_TYPE.TEXT) {
    lines.push("Respondé escribiendo texto en este chat.");
  }

  if (prompt.promptType === PROMPT_TYPE.OPTIONS && prompt.options?.length) {
    lines.push(`Opciones: ${prompt.options.join(" | ")}`);
  }

  if (prompt.expiresAt) {
    lines.push(`Vence: ${prompt.expiresAt}`);
  }

  return renderUxBlock({
    semantic: UX_SEMANTIC.NEEDS_ATTENTION,
    title: "Confirmación requerida",
    lines,
  });
}

export function formatStalePromptNotice(): string {
  return renderUxBlock({
    semantic: UX_SEMANTIC.INFO,
    title: "Prompt anterior inválido",
    lines: ["Esta confirmación ya no está vigente porque llegó un prompt más nuevo."],
  });
}

export function formatPromptExpiredNotice(): string {
  return renderUxBlock({
    semantic: UX_SEMANTIC.INFO,
    title: "Prompt expirado",
    lines: ["El tiempo para responder este prompt venció. Esperá el próximo paso de la sesión."],
  });
}

export function formatPromptCancelledNotice(): string {
  return renderUxBlock({
    semantic: UX_SEMANTIC.INFO,
    title: "Prompt cancelado",
    lines: ["Este prompt fue cancelado porque la sesión continuó por otra vía."],
  });
}

export function formatPromptIdempotentNotice(status: PendingPrompt["status"]): string {
  const statusLine =
    status === PENDING_PROMPT_STATUS.INVALIDATED
      ? "Prompt no vigente (invalidado)."
      : status === PENDING_PROMPT_STATUS.EXPIRED
        ? "Prompt no vigente (expirado)."
        : status === PENDING_PROMPT_STATUS.CANCELLED
          ? "Prompt no vigente (cancelado)."
          : status === PENDING_PROMPT_STATUS.RESOLVED
            ? "Prompt ya resuelto."
            : status === PENDING_PROMPT_STATUS.SUBMITTED
              ? "Ya recibí tu respuesta para este prompt."
              : "Prompt ya no vigente.";

  return renderUxBlock({
    semantic: UX_SEMANTIC.INFO,
    title: "Respuesta ignorada (idempotente)",
    lines: [statusLine, "No hace falta reenviar nada."],
  });
}

export function formatPromptTextOnlyNotice(): string {
  return renderUxBlock({
    semantic: UX_SEMANTIC.INFO,
    title: "Respuesta no permitida",
    lines: ["Este prompt requiere seleccionar una opción en los botones. No acepta texto libre."],
  });
}

export function formatPromptRequiresTextNotice(): string {
  return renderUxBlock({
    semantic: UX_SEMANTIC.INFO,
    title: "Respuesta no permitida",
    lines: ["Este prompt requiere escribir texto en el chat. No acepta botones."],
  });
}

export function formatDomainError(error: DomainError): string {
  const adapterCode = extractAdapterErrorCode(error);

  if (adapterCode === ADAPTER_ERROR_CODES.SESSION_PROJECT_MISMATCH) {
    return renderUxBlock({
      semantic: UX_SEMANTIC.ERROR,
      title: "Sesión inválida para el proyecto",
      lines: ["Esa sesión no pertenece al proyecto activo. Cambiá de proyecto con /project o vinculá otra sesión con /session."],
    });
  }

  if (adapterCode === ADAPTER_ERROR_CODES.UNSUPPORTED) {
    const guidance =
      typeof error.details?.guidance === "string" && error.details.guidance.trim()
        ? error.details.guidance
        : "OpenCode todavía no soporta esta operación en este backend. Usá /status para seguir el estado actual.";

    return renderUxBlock({
      semantic: UX_SEMANTIC.INFO,
      title: "Operación no soportada",
      lines: [guidance],
    });
  }

  if (adapterCode === ADAPTER_ERROR_CODES.TIMEOUT) {
    return renderUxBlock({
      semantic: UX_SEMANTIC.ERROR,
      title: "Timeout de OpenCode",
      lines: ["OpenCode tardó demasiado en responder. Reintentá en unos segundos."],
    });
  }

  if (adapterCode === ADAPTER_ERROR_CODES.UNAVAILABLE) {
    return renderUxBlock({
      semantic: UX_SEMANTIC.ERROR,
      title: "OpenCode no disponible",
      lines: ["OpenCode no está disponible en este momento. Probá de nuevo en un rato."],
    });
  }

  let message = FALLBACK_ERROR_MESSAGE;
  switch (error.code) {
    case ERROR_CODES.CONFLICT_ACTIVE_TASK:
      message = "Hay una tarea en curso. Esperá a que termine antes de mandar otra orden.";
      break;
    case ERROR_CODES.VALIDATION_ERROR:
      message = error.message;
      break;
    case ERROR_CODES.NOT_FOUND:
      message = error.message;
      break;
    case ERROR_CODES.UPSTREAM_TIMEOUT:
      message = "OpenCode no respondió a tiempo. Probá de nuevo.";
      break;
    case ERROR_CODES.UPSTREAM_5XX:
      message = "OpenCode está con problemas del lado servidor. Intentá nuevamente en un rato.";
      break;
    case ERROR_CODES.INCONSISTENT_BINDING:
      message = "Detecté una inconsistencia de estado. Revisá /status y reasociá la sesión si hace falta.";
      break;
    case ERROR_CODES.PERSISTENCE_ERROR:
      message = "No pude persistir el estado local. Reintentá y verificá /status.";
      break;
  }

  return renderUxBlock({
    semantic: UX_SEMANTIC.ERROR,
    title: "No se pudo completar la operación",
    lines: [
      message,
      "Si seguís bloqueado: verificá /status y recuperá contexto con /project + /sesiones o /session.",
    ],
  });
}

export function formatDangerousActionDisabled(): string {
  return renderUxBlock({
    semantic: UX_SEMANTIC.INFO,
    title: "Capacidad sensible deshabilitada",
    lines: [
      "Esta capacidad abre una terminal en la máquina local y está deshabilitada por configuración.",
      "Activá ENABLE_LOCAL_HOST_ACTIONS y ENABLE_ATTACH_LOCAL para habilitarla.",
    ],
  });
}

export function formatDangerousActionPrivateOnly(): string {
  return renderUxBlock({
    semantic: UX_SEMANTIC.ERROR,
    title: "Acción sensible sólo en chat privado",
    lines: [
      "Las capacidades de host local sólo se aceptan en chats privados.",
      "Reintentá desde tu chat directo con el bot.",
    ],
  });
}

export function formatDangerousActionConfirmation(input: {
  readonly projectId?: string;
  readonly sessionId?: string;
  readonly targetEnvironment: string;
  readonly expiresAt: string;
  readonly tmuxSessionName?: string;
}): string {
  return renderUxBlock({
    semantic: UX_SEMANTIC.NEEDS_ATTENTION,
    title: "Confirmación sensible requerida",
    context: {
      project: input.projectId,
      session: input.sessionId,
      state: "local-host-dangerous",
    },
    lines: [
      "Voy a abrir una terminal local y ejecutar:",
      `tmux attach -t ${input.tmuxSessionName ?? "tgoc_<session>"}`,
      `Entorno: ${input.targetEnvironment}.`,
      `Vence: ${input.expiresAt}`,
      "¿Confirmás?",
    ],
  });
}

export function formatDangerousActionCancelled(): string {
  return renderUxBlock({
    semantic: UX_SEMANTIC.INFO,
    title: "Acción sensible cancelada",
    lines: ["Se descartó la confirmación pendiente. No se ejecutó ningún side effect local."],
  });
}

export function formatDangerousActionContextChanged(reason?: string): string {
  const detail =
    reason === "expired"
      ? "El TTL ya venció."
      : reason === "context-mismatch"
        ? "Cambió proyecto, sesión, actor o chat respecto del pedido original."
        : "El contexto dejó de ser válido para esta acción.";

  return renderUxBlock({
    semantic: UX_SEMANTIC.ERROR,
    title: "Confirmación sensible inválida",
    lines: [detail, "No se ejecutó ninguna acción sobre el host local."],
  });
}

export function formatDangerousActionEnvironmentUnavailable(input?: {
  readonly detail?: string;
  readonly manualCommand?: string;
}): string {
  return renderUxBlock({
    semantic: UX_SEMANTIC.ERROR,
    title: "Entorno local no disponible",
    lines: [
      "No pude validar el entorno local para ejecutar esta acción sensible.",
      input?.detail ? `Detalle: ${input.detail}` : "",
      input?.manualCommand ? "Fallback manual:" : "",
      input?.manualCommand ?? "",
      "No se ejecutó ninguna acción sobre el host local.",
    ].filter((entry) => entry.length > 0),
  });
}

export function formatDangerousActionIdempotent(status: string): string {
  return renderUxBlock({
    semantic: UX_SEMANTIC.INFO,
    title: "Confirmación ya procesada",
    lines: [`Estado final: ${status}.`, "Este token es de un solo uso; no habrá una segunda ejecución."],
  });
}

export function formatDangerousActionReady(message: string): string {
  return renderUxBlock({
    semantic: UX_SEMANTIC.SUCCESS,
    title: "Hardening confirmado",
    lines: [message],
  });
}

export function formatAttachLocalManualFallback(input: {
  readonly manualCommand: string;
  readonly reason?: string;
}): string {
  return renderUxBlock({
    semantic: UX_SEMANTIC.INFO,
    title: "No pude abrir una terminal local automáticamente",
    lines: [
      "Ejecutá manualmente:",
      input.manualCommand,
      input.reason ? `Detalle: ${input.reason}` : "",
    ].filter((entry) => entry.length > 0),
  });
}

export function formatAttachLocalTmuxMissing(input: {
  readonly tmuxSessionName: string;
  readonly manualCommand: string;
}): string {
  return renderUxBlock({
    semantic: UX_SEMANTIC.ERROR,
    title: "No encontré sesión tmux activa",
    lines: [
      `Target esperado: ${input.tmuxSessionName}`,
      "Reasociá sesión con /sesiones o /session <id>.",
      "Fallback manual:",
      input.manualCommand,
    ],
  });
}

function formatProjectSessionLine(session: ProjectSessionListItem): string {
  const title = session.title?.trim();
  return `• ${title && title.length > 0 ? title : "Sin título"}`;
}

export function formatUnknownError(): string {
  return renderUxBlock({
    semantic: UX_SEMANTIC.ERROR,
    title: "Error inesperado",
    lines: [FALLBACK_ERROR_MESSAGE],
  });
}

function extractAdapterErrorCode(error: DomainError): AdapterErrorCode | undefined {
  const adapterCode = error.details?.adapterCode;
  if (typeof adapterCode !== "string") {
    return undefined;
  }

  return Object.values(ADAPTER_ERROR_CODES).find((code) => code === adapterCode);
}

function formatRecoveryReason(reason?: string): string {
  if (reason === RECOVERY_REASON.REMOTE_MISSING) {
    return "la sesión no existe en OpenCode";
  }

  if (reason === RECOVERY_REASON.REMOTE_CLOSED) {
    return "OpenCode informó la sesión cerrada/finalizada";
  }

  if (reason === RECOVERY_REASON.REMOTE_TIMEOUT) {
    return "timeout al consultar OpenCode";
  }

  if (reason === RECOVERY_REASON.REMOTE_UNAVAILABLE) {
    return "OpenCode respondió con error 5xx";
  }

  if (reason === RECOVERY_REASON.REMOTE_CHECK_FAILED) {
    return "falló la verificación remota";
  }

  if (reason === RECOVERY_REASON.NO_ACTIVE_BINDING) {
    return "no había vínculo activo";
  }

  return "motivo no especificado";
}
