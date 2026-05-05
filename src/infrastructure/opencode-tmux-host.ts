import { execFile } from "node:child_process";
import { SupportedAgent } from "../domain/entities";

export interface EnsureTmuxHostSessionInput {
  readonly opencodeSessionId: string;
  readonly dir: string;
  readonly timeoutMs: number;
  readonly agent?: SupportedAgent;
  readonly model?: string;
}

export interface SendTmuxInputInput {
  readonly opencodeSessionId: string;
  readonly input: string;
  readonly timeoutMs: number;
}

export interface InterruptTmuxInput {
  readonly opencodeSessionId: string;
  readonly timeoutMs: number;
}

export interface StartTemporaryBootstrapSessionInput {
  readonly token: string;
  readonly dir: string;
  readonly initialPrompt: string;
  readonly timeoutMs: number;
}

export interface KillTmuxSessionByNameInput {
  readonly sessionName: string;
  readonly timeoutMs: number;
}

export class OpenCodeTmuxHostError extends Error {
  readonly kind: "not-installed" | "timeout" | "non-zero" | "session-missing";
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    kind: OpenCodeTmuxHostError["kind"],
    message: string,
    details?: Readonly<Record<string, unknown>>
  ) {
    super(message);
    this.name = "OpenCodeTmuxHostError";
    this.kind = kind;
    this.details = details;
  }
}

const hostAgentBySessionName = new Map<string, SupportedAgent>();
const hostModelBySessionName = new Map<string, string>();

export async function ensureHostSession(input: EnsureTmuxHostSessionInput): Promise<void> {
  const sessionName = toTmuxSessionName(input.opencodeSessionId);
  const exists = await hasSession({ sessionName, timeoutMs: input.timeoutMs });

  const knownAgent = hostAgentBySessionName.get(sessionName);
  const knownModel = hostModelBySessionName.get(sessionName);
  const agentNeedsReconfigure = Boolean(input.agent) && knownAgent !== input.agent;
  const modelNeedsReconfigure = Boolean(input.model) && knownModel !== input.model;

  if (exists && !agentNeedsReconfigure && !modelNeedsReconfigure) {
    if (input.agent && knownAgent === undefined) {
      hostAgentBySessionName.set(sessionName, input.agent);
    }
    if (input.model && knownModel === undefined) {
      hostModelBySessionName.set(sessionName, input.model);
    }
    return;
  }

  if (exists) {
    await runTmux({
      args: ["kill-session", "-t", sessionName],
      timeoutMs: input.timeoutMs,
    });
  }

  if (!input.agent) {
    hostAgentBySessionName.delete(sessionName);
  }
  if (!input.model) {
    hostModelBySessionName.delete(sessionName);
  }

  const args = buildHostSessionArgs({
    sessionName,
    dir: input.dir,
    opencodeSessionId: input.opencodeSessionId,
    agent: input.agent,
    model: input.model,
  });
  await runTmux({
    args,
    timeoutMs: input.timeoutMs,
  });

  await waitForSessionReady({
    sessionName,
    timeoutMs: input.timeoutMs,
  });

  if (input.agent) {
    hostAgentBySessionName.set(sessionName, input.agent);
  }
  if (input.model) {
    hostModelBySessionName.set(sessionName, input.model);
  }
}

export async function hasSessionByOpenCodeSessionId(input: {
  readonly opencodeSessionId: string;
  readonly timeoutMs: number;
}): Promise<{ readonly exists: boolean; readonly tmuxSessionName: string }> {
  const tmuxSessionName = toTmuxSessionName(input.opencodeSessionId);
  const exists = await hasSession({ sessionName: tmuxSessionName, timeoutMs: input.timeoutMs });
  return { exists, tmuxSessionName };
}

export async function startTemporaryBootstrapSession(input: StartTemporaryBootstrapSessionInput): Promise<string> {
  const sessionName = toBootstrapTmuxSessionName(input.token);

  await runTmux({
    args: ["new-session", "-d", "-s", sessionName, "-c", input.dir, "opencode", "--prompt", input.initialPrompt],
    timeoutMs: input.timeoutMs,
  });

  return sessionName;
}

export async function killSessionByName(input: KillTmuxSessionByNameInput): Promise<void> {
  if (!(await hasSession({ sessionName: input.sessionName, timeoutMs: input.timeoutMs }))) {
    return;
  }

  await runTmux({
    args: ["kill-session", "-t", input.sessionName],
    timeoutMs: input.timeoutMs,
  });
  hostAgentBySessionName.delete(input.sessionName);
  hostModelBySessionName.delete(input.sessionName);
}

export async function sendInput(input: SendTmuxInputInput): Promise<void> {
  const sessionName = toTmuxSessionName(input.opencodeSessionId);
  const exists = await hasSession({ sessionName, timeoutMs: input.timeoutMs });
  if (!exists) {
    throw new OpenCodeTmuxHostError(
      "session-missing",
      `No encontré sesión tmux activa para ${input.opencodeSessionId}. Vinculá la sesión con /session nuevamente.`,
      {
        opencodeSessionId: input.opencodeSessionId,
        tmuxSessionName: sessionName,
      }
    );
  }

  await runTmux({
    args: ["send-keys", "-t", `${sessionName}:0.0`, "--", input.input, "Enter"],
    timeoutMs: input.timeoutMs,
  });
}

export async function interrupt(input: InterruptTmuxInput): Promise<void> {
  const sessionName = toTmuxSessionName(input.opencodeSessionId);
  const exists = await hasSession({ sessionName, timeoutMs: input.timeoutMs });
  if (!exists) {
    throw new OpenCodeTmuxHostError(
      "session-missing",
      `No encontré sesión tmux activa para ${input.opencodeSessionId}.`,
      {
        opencodeSessionId: input.opencodeSessionId,
        tmuxSessionName: sessionName,
      }
    );
  }

  await runTmux({
    args: ["send-keys", "-t", `${sessionName}:0.0`, "C-c"],
    timeoutMs: input.timeoutMs,
  });
}

export function toTmuxSessionName(opencodeSessionId: string): string {
  const sanitized = opencodeSessionId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "session";

  return `tgoc_${sanitized}`;
}

export function toBootstrapTmuxSessionName(token: string): string {
  const sanitized = token
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 24) || "bootstrap";

  return `tgoc_boot_${sanitized}`;
}

export function buildHostSessionArgs(input: {
  readonly sessionName: string;
  readonly dir: string;
  readonly opencodeSessionId: string;
  readonly agent?: SupportedAgent;
  readonly model?: string;
}): readonly string[] {
  const args = ["new-session", "-d", "-s", input.sessionName, "-c", input.dir, "opencode", "--session", input.opencodeSessionId];
  if (input.agent) {
    args.push("--agent", input.agent);
  }
  if (input.model) {
    args.push("--model", input.model);
  }
  return args;
}

async function hasSession(input: { readonly sessionName: string; readonly timeoutMs: number }): Promise<boolean> {
  try {
    await runTmux({
      args: ["has-session", "-t", input.sessionName],
      timeoutMs: input.timeoutMs,
    });
    return true;
  } catch (error) {
    if (error instanceof OpenCodeTmuxHostError && error.kind === "non-zero") {
      return false;
    }
    throw error;
  }
}

async function waitForSessionReady(input: { readonly sessionName: string; readonly timeoutMs: number }): Promise<void> {
  const deadline = Date.now() + Math.max(50, input.timeoutMs);
  while (Date.now() <= deadline) {
    const remaining = deadline - Date.now();
    const probeTimeout = Math.max(50, Math.min(remaining, 250));
    if (await hasSession({ sessionName: input.sessionName, timeoutMs: probeTimeout })) {
      return;
    }
    await sleep(75);
  }

  throw new OpenCodeTmuxHostError("timeout", "tmux session no quedó lista tras reinicio", {
    sessionName: input.sessionName,
    timeoutMs: input.timeoutMs,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTmux(input: { readonly args: readonly string[]; readonly timeoutMs: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("tmux", input.args, { timeout: input.timeoutMs }, (error, stdout, stderr) => {
      if (!error) {
        resolve(stdout.trim());
        return;
      }

      const errno = (error as NodeJS.ErrnoException).code;

      if (errno === "ENOENT") {
        reject(
          new OpenCodeTmuxHostError(
            "not-installed",
            "No se encontró 'tmux' en PATH. Instalalo para usar OPEN_CODE_ADAPTER=pty.",
            {
              args: input.args,
            }
          )
        );
        return;
      }

      if (errno === "ETIMEDOUT") {
        reject(
          new OpenCodeTmuxHostError("timeout", "tmux no respondió a tiempo", {
            args: input.args,
            timeoutMs: input.timeoutMs,
          })
        );
        return;
      }

      reject(
        new OpenCodeTmuxHostError("non-zero", "tmux devolvió código no cero", {
          args: input.args,
          stderr: stderr.trim(),
          stdout: stdout.trim(),
          code: (error as NodeJS.ErrnoException).code,
        })
      );
    });
  });
}
