import { createChatLockManager } from "../application/chat-lock-manager";

interface ScenarioResult {
  readonly id: string;
  readonly scenario: string;
  readonly ok: boolean;
  readonly details: string;
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function runScenario(id: string, scenario: string, work: () => Promise<string>): Promise<ScenarioResult> {
  try {
    const details = await work();
    return {
      id,
      scenario,
      ok: true,
      details,
    };
  } catch (error) {
    return {
      id,
      scenario,
      ok: false,
      details: error instanceof Error ? error.message : String(error),
    };
  }
}

async function scenarioS01FifoSameChatBurst(): Promise<string> {
  const lockManager = createChatLockManager();
  const executionOrder: string[] = [];

  await Promise.all(
    ["A", "B", "C", "D"].map((label, index) =>
      lockManager.runExclusive("chat-1", async () => {
        executionOrder.push(`start-${label}`);
        await wait(20 - index * 3);
        executionOrder.push(`end-${label}`);
      })
    )
  );

  const starts = executionOrder.filter((entry) => entry.startsWith("start-")).join(",");
  assert(starts === "start-A,start-B,start-C,start-D", `orden FIFO inválido: ${starts}`);
  assert(lockManager.getQueueDepth("chat-1") === 0, "queueDepth debe quedar en 0 al finalizar");
  return `starts=${starts}`;
}

async function scenarioS02ParallelDifferentChats(): Promise<string> {
  const lockManager = createChatLockManager();
  const marks: string[] = [];

  await Promise.all([
    lockManager.runExclusive("chat-A", async () => {
      marks.push("A-start");
      await wait(40);
      marks.push("A-end");
    }),
    lockManager.runExclusive("chat-B", async () => {
      marks.push("B-start");
      await wait(5);
      marks.push("B-end");
    }),
  ]);

  const joined = marks.join(",");
  assert(joined.includes("A-start,B-start") || joined.includes("B-start,A-start"), "no hubo paralelo entre chats distintos");
  assert(joined.indexOf("B-end") < joined.indexOf("A-end"), "chat B debería terminar antes por menor duración");
  return joined;
}

async function scenarioS03ReleaseAfterExceptionAndContinue(): Promise<string> {
  const lockManager = createChatLockManager();
  const executionTrace: string[] = [];

  const first = lockManager.runExclusive("chat-x", async () => {
    executionTrace.push("first-start");
    await wait(10);
    executionTrace.push("first-throw");
    throw new Error("boom-first");
  });

  const second = lockManager.runExclusive("chat-x", async () => {
    executionTrace.push("second-start");
    await wait(10);
    executionTrace.push("second-end");
  });

  let firstFailed = false;
  try {
    await first;
  } catch {
    firstFailed = true;
  }

  await second;

  assert(firstFailed, "la primera ejecución debería fallar");
  assert(
    executionTrace.join(",") === "first-start,first-throw,second-start,second-end",
    `secuencia inesperada: ${executionTrace.join(",")}`
  );
  assert(lockManager.getQueueDepth("chat-x") === 0, "queueDepth debe volver a 0 tras excepción");
  return executionTrace.join(",");
}

function formatResults(results: readonly ScenarioResult[]): string {
  const lines = [
    "RFC-006 Concurrency Verification",
    "",
    "| ID | Scenario | Result | Details |",
    "|---|---|---|---|",
  ];

  for (const result of results) {
    lines.push(`| ${result.id} | ${result.scenario} | ${result.ok ? "PASS" : "FAIL"} | ${result.details.replace(/\|/gu, "\\|")} |`);
  }

  const passed = results.filter((result) => result.ok).length;
  lines.push("", `Resumen: ${passed}/${results.length} escenarios PASS.`);
  return lines.join("\n");
}

async function main(): Promise<void> {
  const results = [
    await runScenario("S01", "Burst FIFO mismo chat", scenarioS01FifoSameChatBurst),
    await runScenario("S02", "Paralelo chats distintos", scenarioS02ParallelDifferentChats),
    await runScenario("S03", "Release tras excepción", scenarioS03ReleaseAfterExceptionAndContinue),
  ];

  const output = formatResults(results);
  const failed = results.some((result) => !result.ok);
  if (failed) {
    // eslint-disable-next-line no-console
    console.error(output);
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log(output);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("No pude ejecutar verificación de concurrencia RFC6", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
