import { spawn } from "node:child_process";

interface CoverageRunResult {
  readonly exitCode: number;
  readonly signal: NodeJS.Signals | null;
}

const COVERAGE_BASELINE_ARGS = [
  "--reporter=text-summary",
  "--reporter=lcov",
  "--include=src/verification/**/*.ts",
  "--exclude=src/**/*.d.ts",
  "ts-node",
  "src/verification/rfc2-harness.ts",
] as const;

async function runC8(args: ReadonlyArray<string>): Promise<CoverageRunResult> {
  return new Promise<CoverageRunResult>((resolve, reject) => {
    const child = spawn("c8", [...args], {
      stdio: "inherit",
      env: process.env,
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code, signal) => {
      resolve({
        exitCode: code ?? 1,
        signal,
      });
    });
  });
}

async function main(): Promise<void> {
  try {
    const result = await runC8(COVERAGE_BASELINE_ARGS);
    if (result.exitCode !== 0) {
      console.error("❌ Coverage baseline could not be generated.");
      console.error("   Revisá configuración de c8/ts-node y reintentá: npm run verify:rfc2:coverage");
      process.exit(result.exitCode);
    }

    console.log("✅ Coverage baseline generated (text-summary + lcov).");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("❌ Coverage baseline could not be generated.");
    console.error(`   Error al ejecutar c8: ${message}`);
    console.error("   Revisá configuración de c8/ts-node y reintentá: npm run verify:rfc2:coverage");
    process.exit(1);
  }
}

void main();
