import {
  ATTACH_LOCAL_EXECUTION_RESULT,
  LOCAL_TERMINAL_LAUNCHER,
  LocalTerminalLauncherKind,
} from "../../domain/entities";

export type Platform = "windows" | "linux" | "macos";

export interface PlatformDetectorOptions {
  readonly timeoutMs: number;
  readonly platform?: NodeJS.Platform;
}

export interface LaunchResult {
  readonly launcher: LocalTerminalLauncherKind;
  readonly result: (typeof ATTACH_LOCAL_EXECUTION_RESULT)[keyof typeof ATTACH_LOCAL_EXECUTION_RESULT];
  readonly tmuxSessionName: string;
  readonly manualCommand: string;
  readonly reason?: string;
}

export interface LauncherStrategy {
  readonly platform: Platform;
  readonly name: string;
  isAvailable(): Promise<boolean>;
  launch(sessionName: string): Promise<LaunchResult>;
  getManualCommand(sessionName: string): string;
  getEnvironmentLabel(): string;
}
