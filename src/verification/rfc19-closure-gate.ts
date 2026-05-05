import fs from "node:fs";
import path from "node:path";

const REQUIRED_TOKEN = "RFC-019";

function main(): void {
  const changelogPath = process.env.CHANGELOG_PATH
    ? path.resolve(process.cwd(), process.env.CHANGELOG_PATH)
    : path.resolve(process.cwd(), "CHANGELOG.md");
  const content = fs.readFileSync(changelogPath, "utf8");
  const lines = content.split(/\r?\n/u);

  const evidence = lines
    .map((line, index) => ({ lineNumber: index + 1, line }))
    .filter(({ line }) => line.includes(REQUIRED_TOKEN));

  if (evidence.length === 0) {
    console.error(`[RFC-019 closure gate] FAIL: token exacto '${REQUIRED_TOKEN}' no encontrado en CHANGELOG.md`);
    console.error("Acción requerida: agregar referencia explícita RFC-019 en bloque Unreleased o versionado.");
    process.exit(1);
  }

  console.log(`[RFC-019 closure gate] PASS: token '${REQUIRED_TOKEN}' encontrado en CHANGELOG.md`);
  for (const item of evidence) {
    console.log(`- Línea ${item.lineNumber}: ${item.line}`);
  }
}

main();
