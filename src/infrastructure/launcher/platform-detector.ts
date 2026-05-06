import { execFile } from "node:child_process";
import { Platform, PlatformDetectorOptions, LauncherStrategy } from "./types";

export function canExec(command: string, args: readonly string[], timeoutMs: number): Promise<boolean> {
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

export class PlatformDetector {
  readonly timeoutMs: number;
  readonly platform: NodeJS.Platform;

  constructor(options: PlatformDetectorOptions) {
    this.timeoutMs = options.timeoutMs;
    this.platform = options.platform ?? process.platform;
  }

  detectPlatform(): Platform {
    if (this.platform === "win32") return "windows";
    if (this.platform === "darwin") return "macos";
    return "linux";
  }

  async hasWsl(): Promise<boolean> {
    return canExec("wsl.exe", ["--help"], this.timeoutMs);
  }

  async hasBash(): Promise<boolean> {
    if (this.platform !== "win32") return false;
    return canExec("where.exe", ["bash.exe"], this.timeoutMs);
  }

  async hasTmux(): Promise<boolean> {
    const cmd = this.platform === "win32" ? "where.exe" : "which";
    const args = this.platform === "win32" ? ["tmux.exe"] : ["tmux"];
    return canExec(cmd, args, this.timeoutMs);
  }

  async hasTmuxViaBash(): Promise<boolean> {
    if (this.platform !== "win32") return false;
    return canExec("bash.exe", ["-lc", "which tmux"], this.timeoutMs);
  }

  async hasWindowsTerminal(): Promise<boolean> {
    if (this.platform !== "win32") return false;
    return canExec("where.exe", ["wt.exe"], this.timeoutMs);
  }

  async hasPowershell(): Promise<boolean> {
    if (this.platform !== "win32") return false;
    return canExec("where.exe", ["powershell.exe"], this.timeoutMs);
  }

  async hasGnomeTerminal(): Promise<boolean> {
    if (this.platform !== "linux") return false;
    return canExec("which", ["gnome-terminal"], this.timeoutMs);
  }

  async hasKonsole(): Promise<boolean> {
    if (this.platform !== "linux") return false;
    return canExec("which", ["konsole"], this.timeoutMs);
  }

  async hasXTerminalEmulator(): Promise<boolean> {
    if (this.platform !== "linux") return false;
    return canExec("which", ["x-terminal-emulator"], this.timeoutMs);
  }

  hasTerminalEnvVar(): boolean {
    return !!process.env.TERMINAL;
  }

  async hasMacTerminal(): Promise<boolean> {
    if (this.platform !== "darwin") return false;
    return canExec("osascript", ["-e", `tell app "Terminal" to get name`], this.timeoutMs);
  }

  async hasITerm(): Promise<boolean> {
    if (this.platform !== "darwin") return false;
    return canExec("osascript", ["-e", `tell app "iTerm" to get name`], this.timeoutMs);
  }

  async resolveStrategy(): Promise<LauncherStrategy> {
    const platform = this.detectPlatform();

    if (platform === "windows") {
      const wslOk = await this.hasWsl();
      if (wslOk) {
        const { WindowsWslStrategy } = await import("./strategies/windows-wsl");
        return new WindowsWslStrategy(this);
      }

      const bashOk = await this.hasBash();
      if (bashOk) {
        const { WindowsBashStrategy } = await import("./strategies/windows-bash");
        return new WindowsBashStrategy(this);
      }

      const { UnsupportedStrategy } = await import("./strategies/unsupported");
      return new UnsupportedStrategy(this);
    }

    if (platform === "linux") {
      const { LinuxNativeStrategy } = await import("./strategies/linux-native");
      return new LinuxNativeStrategy(this);
    }

    if (platform === "macos") {
      const { MacNativeStrategy } = await import("./strategies/mac-native");
      return new MacNativeStrategy(this);
    }

    const { UnsupportedStrategy } = await import("./strategies/unsupported");
    return new UnsupportedStrategy(this);
  }

  async closeAttachProcesses(sessionName: string): Promise<void> {
    if (this.platform !== "win32") {
      return;
    }

    const psAvailable = await canExec(
      "powershell.exe",
      ["-NoProfile", "-Command", "$PSVersionTable.PSVersion"],
      this.timeoutMs
    );
    if (!psAvailable) {
      return;
    }

    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      `$titlePattern = '*--title ${sessionName}*'`,
      `$attachPattern = '*tmux attach -t ${sessionName}*'`,
      "Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'wt.exe' -and $_.CommandLine -like $titlePattern) -or ($_.CommandLine -like $attachPattern) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
    ].join("; ");

    await canExec(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      this.timeoutMs
    );
  }
}
