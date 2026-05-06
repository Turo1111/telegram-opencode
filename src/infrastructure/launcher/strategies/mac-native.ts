import { ATTACH_LOCAL_EXECUTION_RESULT, LOCAL_TERMINAL_LAUNCHER } from "../../../domain/entities";
import { Platform, LauncherStrategy, LaunchResult } from "../types";
import { PlatformDetector, canExec } from "../platform-detector";

export class MacNativeStrategy implements LauncherStrategy {
  readonly platform: Platform = "macos";
  readonly name = "MacNativeStrategy";

  constructor(private readonly detector: PlatformDetector) {}

  async isAvailable(): Promise<boolean> {
    return this.detector.hasTmux();
  }

  async launch(sessionName: string): Promise<LaunchResult> {
    const manualCommand = this.getManualCommand(sessionName);
    const timeoutMs = this.detector.timeoutMs;

    // 1. Try Terminal.app via osascript
    const terminalOk = await this.detector.hasMacTerminal();
    if (terminalOk) {
      const script = `tell app "Terminal" to do script "tmux attach -t ${sessionName}"`;
      const launched = await canExec("osascript", ["-e", script], timeoutMs);
      if (launched) {
        return {
          launcher: LOCAL_TERMINAL_LAUNCHER.TERMINAL_APP,
          result: ATTACH_LOCAL_EXECUTION_RESULT.REQUESTED,
          tmuxSessionName: sessionName,
          manualCommand,
        };
      }
    }

    // 2. Try iTerm via osascript
    const itermOk = await this.detector.hasITerm();
    if (itermOk) {
      const script = `tell app "iTerm" to create window with default profile command "tmux attach -t ${sessionName}"`;
      const launched = await canExec("osascript", ["-e", script], timeoutMs);
      if (launched) {
        return {
          launcher: LOCAL_TERMINAL_LAUNCHER.ITERM,
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
    return `tmux attach -t ${sessionName}`;
  }

  getEnvironmentLabel(): string {
    return "Mac";
  }
}
