import { ATTACH_LOCAL_EXECUTION_RESULT, LOCAL_TERMINAL_LAUNCHER } from "../../../domain/entities";
import { Platform, LauncherStrategy, LaunchResult } from "../types";
import { PlatformDetector, canExec } from "../platform-detector";

export class LinuxNativeStrategy implements LauncherStrategy {
  readonly platform: Platform = "linux";
  readonly name = "LinuxNativeStrategy";

  constructor(private readonly detector: PlatformDetector) {}

  async isAvailable(): Promise<boolean> {
    return this.detector.hasTmux();
  }

  async launch(sessionName: string): Promise<LaunchResult> {
    const manualCommand = this.getManualCommand(sessionName);
    const timeoutMs = this.detector.timeoutMs;

    // 1. Try gnome-terminal
    const gnomeOk = await this.detector.hasGnomeTerminal();
    if (gnomeOk) {
      const launched = await canExec(
        "gnome-terminal",
        ["--", "bash", "-c", `tmux attach -t ${sessionName}`],
        timeoutMs
      );
      if (launched) {
        return {
          launcher: LOCAL_TERMINAL_LAUNCHER.GNOME_TERMINAL,
          result: ATTACH_LOCAL_EXECUTION_RESULT.REQUESTED,
          tmuxSessionName: sessionName,
          manualCommand,
        };
      }
    }

    // 2. Try konsole
    const konsoleOk = await this.detector.hasKonsole();
    if (konsoleOk) {
      const launched = await canExec(
        "konsole",
        ["-e", "bash", "-c", `tmux attach -t ${sessionName}`],
        timeoutMs
      );
      if (launched) {
        return {
          launcher: LOCAL_TERMINAL_LAUNCHER.KONSOLE,
          result: ATTACH_LOCAL_EXECUTION_RESULT.REQUESTED,
          tmuxSessionName: sessionName,
          manualCommand,
        };
      }
    }

    // 3. Try x-terminal-emulator
    const xtermOk = await this.detector.hasXTerminalEmulator();
    if (xtermOk) {
      const launched = await canExec(
        "x-terminal-emulator",
        ["-e", "bash", "-c", `tmux attach -t ${sessionName}`],
        timeoutMs
      );
      if (launched) {
        return {
          launcher: LOCAL_TERMINAL_LAUNCHER.X_TERMINAL_EMULATOR,
          result: ATTACH_LOCAL_EXECUTION_RESULT.REQUESTED,
          tmuxSessionName: sessionName,
          manualCommand,
        };
      }
    }

    // 4. Try $TERMINAL env var
    const terminalEnv = this.detector.hasTerminalEnvVar();
    if (terminalEnv) {
      const terminalCmd = process.env.TERMINAL!;
      const launched = await canExec(
        terminalCmd,
        ["-e", "bash", "-c", `tmux attach -t ${sessionName}`],
        timeoutMs
      );
      if (launched) {
        return {
          launcher: LOCAL_TERMINAL_LAUNCHER.MANUAL_FALLBACK,
          result: ATTACH_LOCAL_EXECUTION_RESULT.REQUESTED,
          tmuxSessionName: sessionName,
          manualCommand,
        };
      }
    }

    // 5. Manual fallback
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
    return "Linux";
  }
}
