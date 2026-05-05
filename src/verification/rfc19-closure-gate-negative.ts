import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const REQUIRED_TOKEN = "RFC-019";

function main(): void {
  const originalPath = path.resolve(process.cwd(), "CHANGELOG.md");
  const original = fs.readFileSync(originalPath, "utf8");

  if (!original.includes(REQUIRED_TOKEN)) {
    console.error("Precondición inválida: CHANGELOG.md no contiene RFC-019 para probar rama negativa.");
    process.exit(1);
  }

  const stripped = original.split(REQUIRED_TOKEN).join("RFC-XXX");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rfc19-gate-"));
  const tempChangelog = path.join(tempDir, "CHANGELOG.no-rfc19.md");
  fs.writeFileSync(tempChangelog, stripped, "utf8");

  const result = spawnSync(
    "npx",
    ["ts-node", "src/verification/rfc19-closure-gate.ts"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        CHANGELOG_PATH: tempChangelog,
      },
    }
  );

  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // best effort
  }

  if (result.status === 1) {
    console.log("[RFC-019 closure gate negative] PASS: gate falla cuando falta RFC-019.");
    if (result.stderr.trim().length > 0) {
      console.log(result.stderr.trim());
    }
    return;
  }

  console.error("[RFC-019 closure gate negative] FAIL: se esperaba exit code 1.");
  console.error(`Exit code actual: ${String(result.status)}`);
  if (result.stdout.trim().length > 0) {
    console.error(result.stdout.trim());
  }
  if (result.stderr.trim().length > 0) {
    console.error(result.stderr.trim());
  }
  process.exit(1);
}

main();
