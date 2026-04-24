import fs from "node:fs/promises";
import path from "node:path";

interface PolicyCheckResult {
  readonly ok: boolean;
  readonly message: string;
}

async function readDoc(relativePath: string): Promise<string> {
  const absolutePath = path.resolve(process.cwd(), relativePath);
  return fs.readFile(absolutePath, "utf8");
}

function normalize(text: string): string {
  return text.toLowerCase();
}

function includesAll(text: string, requiredPhrases: ReadonlyArray<string>): boolean {
  const normalized = normalize(text);
  return requiredPhrases.every((phrase) => normalized.includes(normalize(phrase)));
}

async function checkManualFallbackPolicy(): Promise<PolicyCheckResult> {
  const manualDocPath = "docs/rfc2_test_manual.md";
  const checklistDocPath = "docs/rfc2-batch5-hardening-checklist.md";

  const [manualDoc, checklistDoc] = await Promise.all([readDoc(manualDocPath), readDoc(checklistDocPath)]);

  const manualRequiredPhrases = [
    "camino normal de verificación: `npm run verify:rfc2`",
    "cobertura baseline opcional: `npm run verify:rfc2:coverage`",
    "no reemplaza",
    "si la automatización está disponible",
    "contingencia",
  ] as const;

  const checklistRequiredPhrases = [
    "`npm run verify:rfc2` es el comando principal one-command",
    "`npm run verify:rfc2:coverage` es baseline opt-in",
    "validación manual opcional",
    "contingencia",
  ] as const;

  const manualOk = includesAll(manualDoc, manualRequiredPhrases);
  const checklistOk = includesAll(checklistDoc, checklistRequiredPhrases);

  if (!manualOk || !checklistOk) {
    return {
      ok: false,
      message:
        "Manual fallback policy check failed: docs must keep automation as default and manual as contingency-only.",
    };
  }

  return {
    ok: true,
    message:
      "Manual fallback policy check passed: automation remains default (`verify:rfc2`) and manual guidance is contingency-only.",
  };
}

async function main(): Promise<void> {
  try {
    const result = await checkManualFallbackPolicy();
    if (!result.ok) {
      console.error(`❌ ${result.message}`);
      process.exit(1);
    }

    console.log(`✅ ${result.message}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("❌ Manual fallback policy check failed unexpectedly.");
    console.error(`   ${message}`);
    process.exit(1);
  }
}

void main();
