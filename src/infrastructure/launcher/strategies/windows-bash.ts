import { ATTACH_LOCAL_EXECUTION_RESULT, LOCAL_TERMINAL_LAUNCHER } from "../../../domain/entities";
import { Platform, LauncherStrategy, LaunchResult } from "../types";
import { PlatformDetector, canExec } from "../platform-detector";

export class WindowsBashStrategy implements LauncherStrategy {
  readonly platform: Platform = "windows";
  readonly name = "WindowsBashStrategy";

  constructor(private readonly detector: PlatformDetector) {}

  async isAvailable(): Promise<boolean> {
    const bashOk = await this.detector.hasBash();
    const tmuxOk = await this.detector.hasTmuxViaBash();
    return bashOk && tmuxOk;
  }

  async launch(sessionName: string): Promise<LaunchResult> {
    const manualCommand = this.getManualCommand(sessionName);
    const timeoutMs = this.detector.timeoutMs;

    // 1. Try wt.exe with bash.exe
    const wtExists = await canExec("where.exe", ["wt.exe"], timeoutMs);
    if (wtExists) {
      const wtLaunched = await canExec(
        "wt.exe",
        ["new-tab", "--title", sessionName, "bash.exe", "-lc", `tmux attach -t ${sessionName}`],
        timeoutMs
      );
      if (wtLaunched) {
        return {
          launcher: LOCAL_TERMINAL_LAUNCHER.WT,
          result: ATTACH_LOCAL_EXECUTION_RESULT.REQUESTED,
          tmuxSessionName: sessionName,
          manualCommand,
        };
      }
    }

    // 2. Try powershell.exe with bash.exe
    const psExists = await canExec("where.exe", ["powershell.exe"], timeoutMs);
    if (psExists) {
      const powershellCommand = `Start-Process -FilePath bash.exe -ArgumentList \"-lc 'tmux attach -t ${sessionName}'\"`;
      const psLaunched = await canExec(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", powershellCommand],
        timeoutMs
      );
      if (psLaunched) {
        return {
          launcher: LOCAL_TERMINAL_LAUNCHER.POWERSHELL,
          result: ATTACH_LOCAL_EXECUTION_RESULT.REQUESTED,
          tmuxSessionName: sessionName,
          manualCommand,
        };
      }
    }

    // 3. Manual fallback
    return {
      launcher: LOCAL_TERMINAL_LAUNCHER.MANUAL_FALLBACK,
      result: ATTACH_LOCAL_EXECUTION_RESULT.FAILED,
      tmuxSessionName: sessionName,
      manualCommand,
      reason: "launcher-unavailable",
    };
  }

  getManualCommand(sessionName: string): string {
    return `bash.exe -lc 'tmux attach -t ${sessionName}'`;
  }

  getEnvironmentLabel(): string {
    return "PC (Git Bash/MSYS2/Cygwin)";
  }
}
