import { ATTACH_LOCAL_EXECUTION_RESULT, LOCAL_TERMINAL_LAUNCHER } from "../../../domain/entities";
import { Platform, LauncherStrategy, LaunchResult } from "../types";
import { PlatformDetector } from "../platform-detector";

export class UnsupportedStrategy implements LauncherStrategy {
  readonly platform: Platform = "windows";
  readonly name = "UnsupportedStrategy";

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private readonly detector: PlatformDetector) {}

  async isAvailable(): Promise<boolean> {
    return false;
  }

  async launch(sessionName: string): Promise<LaunchResult> {
    return {
      launcher: LOCAL_TERMINAL_LAUNCHER.MANUAL_FALLBACK,
      result: ATTACH_LOCAL_EXECUTION_RESULT.FAILED,
      tmuxSessionName: sessionName,
      manualCommand: "",
      reason: "unsupported-platform",
    };
  }

  getManualCommand(_sessionName: string): string {
    return "";
  }

  getEnvironmentLabel(): string {
    return "terminal local";
  }
}
