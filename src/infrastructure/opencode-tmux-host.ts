import { execFile } from "node:child_process";

export interface EnsureTmuxHostSessionInput {
  readonly opencodeSessionId: string;
  readonly dir: string;
  readonly timeoutMs: number;
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

export async function ensureHostSession(input: EnsureTmuxHostSessionInput): Promise<void> {
  const sessionName = toTmuxSessionName(input.opencodeSessionId);

  if (await hasSession({ sessionName, timeoutMs: input.timeoutMs })) {
    return;
  }

  await runTmux({
    args: ["new-session", "-d", "-s", sessionName, "-c", input.dir, "opencode", "--session", input.opencodeSessionId],
    timeoutMs: input.timeoutMs,
  });
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
