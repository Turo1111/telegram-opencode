import {
  ATTACH_LOCAL_EXECUTION_RESULT,
  LOCAL_TERMINAL_LAUNCHER,
} from "../domain/entities";
import { AttachLocalLaunchResult, LocalTerminalLauncher } from "../application/contracts";
import { PlatformDetector } from "./launcher/platform-detector";
import { LauncherStrategy } from "./launcher/types";

export interface LocalTerminalLauncherOptions {
  readonly timeoutMs: number;
  readonly platform?: NodeJS.Platform;
}

export async function createLocalTerminalLauncher(
  options: LocalTerminalLauncherOptions
): Promise<LocalTerminalLauncher> {
  const detector = new PlatformDetector(options);
  const strategy: LauncherStrategy = await detector.resolveStrategy();

  return {
    async isEnvironmentReady() {
      const available = await strategy.isAvailable();
      if (!available) {
        return { ok: false, reason: "unsupported-platform" };
      }
      return { ok: true };
    },

    async launchAttach(input) {
      await detector.closeAttachProcesses(input.tmuxSessionName);
      return strategy.launch(input.tmuxSessionName) as Promise<AttachLocalLaunchResult>;
    },

    getManualCommand(sessionName: string) {
      return strategy.getManualCommand(sessionName);
    },

    getEnvironmentLabel() {
      return strategy.getEnvironmentLabel();
    },
  };
}
