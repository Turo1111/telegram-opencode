import { spawn } from "node:child_process";

interface CoverageRunResult {
  readonly exitCode: number;
}

const NEGATIVE_ARGS = [
  "--reporter=text-summary",
  "--reporter=lcov",
  "--include=src/verification/**/*.ts",
  "--exclude=src/**/*.d.ts",
  "--",
  "node",
  "-e",
  "process.exit(7)",
] as const;

async function runNegativeCoverage(): Promise<CoverageRunResult> {
  return new Promise<CoverageRunResult>((resolve, reject) => {
    const child = spawn("c8", [...NEGATIVE_ARGS], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
    });

    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
      });
    });
  });
}

async function main(): Promise<void> {
  try {
    const result = await runNegativeCoverage();

    if (result.exitCode === 0) {
      console.error("❌ Expected non-zero exit for coverage negative-path, but command succeeded.");
      process.exit(1);
    }

    console.log("✅ Coverage command failure is explicit.");
    console.log(`   Non-zero exit observed: ${result.exitCode}`);
    console.log("   Coverage baseline could not be generated for the negative-path run.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("❌ Coverage negative-path execution failed unexpectedly.");
    console.error(`   ${message}`);
    process.exit(1);
  }
}

void main();
