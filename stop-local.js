const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const runtimeFile = path.join(__dirname, ".local-runtime.json");

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stopPids(pids) {
  for (const pid of pids) {
    if (pid && isAlive(pid)) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // no-op
      }
    }
  }
}

function findOrphanPids() {
  if (process.platform === "win32") {
    return [];
  }

  const patterns = ["mock/opencode-mock.ts", "src/index.ts", "start-local.js"];
  const pids = new Set();

  for (const pattern of patterns) {
    try {
      const output = execFileSync("pgrep", ["-f", pattern], { encoding: "utf8" });
      for (const line of output.split("\n")) {
        const pid = Number(line.trim());
        if (!Number.isNaN(pid) && pid !== process.pid) {
          pids.add(pid);
        }
      }
    } catch {
      // no-op
    }
  }

  return [...pids];
}

if (!fs.existsSync(runtimeFile)) {
  const orphanPids = findOrphanPids();
  if (orphanPids.length === 0) {
    console.log("No hay una instancia local registrada.");
    process.exit(0);
  }

  stopPids(orphanPids);
  console.log("Se detuvieron procesos locales huérfanos.");
  process.exit(0);
}

const runtime = JSON.parse(fs.readFileSync(runtimeFile, "utf8"));

stopPids((runtime.children || []).map((child) => child.pid));

if (runtime.parentPid && isAlive(runtime.parentPid)) {
  try {
    process.kill(runtime.parentPid, "SIGTERM");
  } catch {
    // no-op
  }
}

fs.unlinkSync(runtimeFile);
console.log("Instancia local detenida.");
