import { execFile } from "node:child_process";
import { ATTACH_LOCAL_EXECUTION_RESULT, LOCAL_TERMINAL_LAUNCHER } from "../domain/entities";
import { AttachLocalLaunchResult, LocalTerminalLauncher } from "../application/contracts";

export interface LocalTerminalLauncherOptions {
  readonly timeoutMs: number;
  readonly platform?: NodeJS.Platform;
}

export function createLocalTerminalLauncher(options: LocalTerminalLauncherOptions): LocalTerminalLauncher {
  const timeoutMs = options.timeoutMs;
  const platform = options.platform ?? process.platform;

  return {
    async isEnvironmentReady() {
      if (platform === "win32") {
        return { ok: true };
      }

      const wslAvailable = await canExec("wsl.exe", ["--help"], timeoutMs);
      const powershellAvailable = await canExec("powershell.exe", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion"], timeoutMs);

      if (!wslAvailable && !powershellAvailable) {
        return { ok: false, reason: "unsupported-platform" };
      }

      return { ok: true };
    },

    async launchAttach(input) {
      const manualCommand = `wsl.exe bash -lc 'tmux attach -t ${input.tmuxSessionName}'`;

      const wtExists = await canExec("where.exe", ["wt.exe"], timeoutMs);
      if (wtExists) {
        const wtLaunched = await canExec(
          "wt.exe",
          ["new-tab", "wsl.exe", "bash", "-lc", `tmux attach -t ${input.tmuxSessionName}`],
          timeoutMs
        );
        if (wtLaunched) {
          return {
            launcher: LOCAL_TERMINAL_LAUNCHER.WT,
            result: ATTACH_LOCAL_EXECUTION_RESULT.REQUESTED,
            tmuxSessionName: input.tmuxSessionName,
            manualCommand,
          } satisfies AttachLocalLaunchResult;
        }
      }

      const psExists = await canExec("where.exe", ["powershell.exe"], timeoutMs);
      if (psExists) {
        const powershellCommand = `Start-Process -FilePath wsl.exe -ArgumentList \"bash -lc 'tmux attach -t ${input.tmuxSessionName}'\"`;
        const psLaunched = await canExec(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command", powershellCommand],
          timeoutMs
        );
        if (psLaunched) {
          return {
            launcher: LOCAL_TERMINAL_LAUNCHER.POWERSHELL,
            result: ATTACH_LOCAL_EXECUTION_RESULT.REQUESTED,
            tmuxSessionName: input.tmuxSessionName,
            manualCommand,
          } satisfies AttachLocalLaunchResult;
        }
      }

      const wslExists = await canExec("wsl.exe", ["--help"], timeoutMs);
      if (!wslExists && platform !== "win32") {
        return {
          launcher: LOCAL_TERMINAL_LAUNCHER.MANUAL_FALLBACK,
          result: ATTACH_LOCAL_EXECUTION_RESULT.FAILED,
          tmuxSessionName: input.tmuxSessionName,
          manualCommand,
          reason: "unsupported-platform",
        } satisfies AttachLocalLaunchResult;
      }

      return {
        launcher: LOCAL_TERMINAL_LAUNCHER.MANUAL_FALLBACK,
        result: ATTACH_LOCAL_EXECUTION_RESULT.FAILED,
        tmuxSessionName: input.tmuxSessionName,
        manualCommand,
        reason: "launcher-unavailable",
      } satisfies AttachLocalLaunchResult;
    },
  };
}

async function canExec(command: string, args: readonly string[], timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: false }, (error) => {
      if (!error) {
        resolve(true);
        return;
      }

      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ETIMEDOUT") {
        resolve(false);
        return;
      }

      resolve(false);
    });
  });
}
