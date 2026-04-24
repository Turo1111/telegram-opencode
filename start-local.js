const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const runtimeFile = path.join(__dirname, ".local-runtime.json");
const tsNodeBin = path.join(
  __dirname,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "ts-node.cmd" : "ts-node"
);

const children = [];
let shuttingDown = false;

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readRuntime() {
  if (!fs.existsSync(runtimeFile)) return null;

  try {
    return JSON.parse(fs.readFileSync(runtimeFile, "utf8"));
  } catch {
    return null;
  }
}

function writeRuntime() {
  const payload = {
    parentPid: process.pid,
    children: children
      .filter((child) => typeof child.pid === "number")
      .map((child) => ({ name: child.name, pid: child.pid })),
  };

  fs.writeFileSync(runtimeFile, JSON.stringify(payload, null, 2));
}

function cleanupRuntimeFile() {
  try {
    if (fs.existsSync(runtimeFile)) {
      fs.unlinkSync(runtimeFile);
    }
  } catch (error) {
    if (!error || error.code !== "ENOENT") {
      throw error;
    }
  }
}

function cleanupStaleRuntime() {
  const runtime = readRuntime();
  if (!runtime) return;

  if (runtime.parentPid && isAlive(runtime.parentPid)) {
    console.error(
      "Ya hay una instancia local corriendo. Usá 'npm run stop:local' o cerrá la terminal anterior antes de volver a iniciar."
    );
    process.exit(1);
  }

  for (const child of runtime.children || []) {
    if (child.pid && isAlive(child.pid)) {
      try {
        process.kill(child.pid, "SIGTERM");
      } catch {
        // no-op
      }
    }
  }

  cleanupRuntimeFile();
}

function run(name, scriptPath) {
  const child = spawn(tsNodeBin, [scriptPath], {
    stdio: "inherit",
  });

  const managedChild = { name, pid: child.pid, process: child };
  children.push(managedChild);
  writeRuntime();

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;

    if (code === 0 || signal === "SIGTERM") {
      return;
    }

    shutdown(typeof code === "number" ? code : 1);
  });

  return child;
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const child of children) {
    if (child.pid && isAlive(child.pid)) {
      try {
        process.kill(child.pid, "SIGTERM");
      } catch {
        // no-op
      }
    }
  }

  cleanupRuntimeFile();
  process.exit(exitCode);
}

cleanupStaleRuntime();

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("exit", () => cleanupRuntimeFile());

run("mock", path.join(__dirname, "mock", "opencode-mock.ts"));
run("bot", path.join(__dirname, "src", "index.ts"));
