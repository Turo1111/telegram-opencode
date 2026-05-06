import { ATTACH_LOCAL_EXECUTION_RESULT, LOCAL_TERMINAL_LAUNCHER } from "../../../domain/entities";
import { Platform, LauncherStrategy, LaunchResult } from "../types";
import { PlatformDetector, canExec } from "../platform-detector";

export class WindowsWslStrategy implements LauncherStrategy {
  readonly platform: Platform = "windows";
  readonly name = "WindowsWslStrategy";

  constructor(private readonly detector: PlatformDetector) {}

  async isAvailable(): Promise<boolean> {
    const wslOk = await this.detector.hasWsl();
    const tmuxOk = await this.detector.hasTmux();
    return wslOk && tmuxOk;
  }

  async launch(sessionName: string): Promise<LaunchResult> {
    const manualCommand = this.getManualCommand(sessionName);
    const timeoutMs = this.detector.timeoutMs;

    // 1. Try wt.exe
    const wtExists = await canExec("where.exe", ["wt.exe"], timeoutMs);
    if (wtExists) {
      const wtLaunched = await canExec(
        "wt.exe",
        ["new-tab", "--title", sessionName, "wsl.exe", "bash", "-lc", `tmux attach -t ${sessionName}`],
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

    // 2. Try powershell.exe
    const psExists = await canExec("where.exe", ["powershell.exe"], timeoutMs);
    if (psExists) {
      const powershellCommand = `Start-Process -FilePath wsl.exe -ArgumentList \"bash -lc 'tmux attach -t ${sessionName}'\"`;
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

    // 3. Manual fallback (wsl.exe not needed — manual command is the fallback)
    return {
      launcher: LOCAL_TERMINAL_LAUNCHER.MANUAL_FALLBACK,
      result: ATTACH_LOCAL_EXECUTION_RESULT.FAILED,
      tmuxSessionName: sessionName,
      manualCommand,
      reason: "launcher-unavailable",
    };
  }

  getManualCommand(sessionName: string): string {
    return `wsl.exe bash -lc 'tmux attach -t ${sessionName}'`;
  }

  getEnvironmentLabel(): string {
    return "PC (WSL)";
  }
}
