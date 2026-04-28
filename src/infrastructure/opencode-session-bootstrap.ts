import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ADAPTER_ERROR_CODES, AdapterError } from "../application/contracts";
import { OpenCodeCliSessionListItem, listSessions, resolveCanonicalProjectPath } from "./opencode-cli";

export const BOOTSTRAP_RESOLUTION_KIND = {
  FOUND: "found",
  NONE: "none",
  AMBIGUOUS: "ambiguous",
} as const;

export type BootstrapResolutionKind =
  (typeof BOOTSTRAP_RESOLUTION_KIND)[keyof typeof BOOTSTRAP_RESOLUTION_KIND];

export interface BootstrapSessionCandidate {
  readonly sessionId: string;
  readonly path?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface BootstrapSessionFoundResult {
  readonly kind: typeof BOOTSTRAP_RESOLUTION_KIND.FOUND;
  readonly candidate: BootstrapSessionCandidate;
}

export interface BootstrapSessionNoCandidateResult {
  readonly kind: typeof BOOTSTRAP_RESOLUTION_KIND.NONE;
}

export interface BootstrapSessionAmbiguousResult {
  readonly kind: typeof BOOTSTRAP_RESOLUTION_KIND.AMBIGUOUS;
  readonly candidates: readonly BootstrapSessionCandidate[];
}

export type BootstrapSessionResolution =
  | BootstrapSessionFoundResult
  | BootstrapSessionNoCandidateResult
  | BootstrapSessionAmbiguousResult;

export interface PollBootstrapSessionInput {
  readonly before: readonly OpenCodeCliSessionListItem[];
  readonly projectPath: string;
  readonly timeoutMs: number;
  readonly intervalMs?: number;
  readonly listSessionsFn?: typeof listSessions;
  readonly resolveCanonicalProjectPathFn?: typeof resolveCanonicalProjectPath;
}

export async function pollBootstrapSessionCandidate(
  input: PollBootstrapSessionInput
): Promise<BootstrapSessionResolution> {
  const deadline = Date.now() + input.timeoutMs;
  const intervalMs = Math.max(100, Math.min(input.intervalMs ?? 500, input.timeoutMs));
  const listSessionsFn = input.listSessionsFn ?? listSessions;
  const resolveCanonicalProjectPathFn = input.resolveCanonicalProjectPathFn ?? resolveCanonicalProjectPath;

  let latestResolution: BootstrapSessionResolution = { kind: BOOTSTRAP_RESOLUTION_KIND.NONE };

  while (Date.now() <= deadline) {
    const after = await listSessionsFn(Math.max(100, Math.min(input.timeoutMs, deadline - Date.now() || 100)));
    latestResolution = await resolveBootstrapSessionCandidate({
      before: input.before,
      after,
      projectPath: input.projectPath,
      resolveCanonicalProjectPathFn,
    });

    if (latestResolution.kind !== BOOTSTRAP_RESOLUTION_KIND.NONE) {
      return latestResolution;
    }

    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }

  return latestResolution;
}

export async function resolveBootstrapSessionCandidate(input: {
  readonly before: readonly OpenCodeCliSessionListItem[];
  readonly after: readonly OpenCodeCliSessionListItem[];
  readonly projectPath: string;
  readonly resolveCanonicalProjectPathFn?: typeof resolveCanonicalProjectPath;
}): Promise<BootstrapSessionResolution> {
  const beforeIds = new Set(input.before.map((session) => session.id));
  const resolveCanonicalProjectPathFn = input.resolveCanonicalProjectPathFn ?? resolveCanonicalProjectPath;
  const canonicalProjectPath = await resolveCanonicalProjectPathFn(input.projectPath);
  const candidates: BootstrapSessionCandidate[] = [];

  for (const session of input.after) {
    if (beforeIds.has(session.id) || !session.path?.trim()) {
      continue;
    }

    const canonicalSessionPath = await tryResolvePath(session.path, resolveCanonicalProjectPathFn);
    if (!canonicalSessionPath || !belongsToProject(canonicalProjectPath, canonicalSessionPath)) {
      continue;
    }

    candidates.push({
      sessionId: session.id,
      path: canonicalSessionPath,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    });
  }

  if (candidates.length === 1) {
    return {
      kind: BOOTSTRAP_RESOLUTION_KIND.FOUND,
      candidate: candidates[0]!,
    };
  }

  if (candidates.length > 1) {
    return {
      kind: BOOTSTRAP_RESOLUTION_KIND.AMBIGUOUS,
      candidates: [...candidates].sort(compareBootstrapCandidates),
    };
  }

  return { kind: BOOTSTRAP_RESOLUTION_KIND.NONE };
}

export function bootstrapResolutionToAdapterError(input: {
  readonly resolution: Exclude<BootstrapSessionResolution, BootstrapSessionFoundResult>;
  readonly operation: string;
}): AdapterError {
  if (input.resolution.kind === BOOTSTRAP_RESOLUTION_KIND.AMBIGUOUS) {
    return {
      code: ADAPTER_ERROR_CODES.AMBIGUOUS_SESSION_CANDIDATE,
      message: "Encontré más de una sesión nueva para este proyecto. Elegí una con /sesiones.",
      retryable: false,
      details: {
        operation: input.operation,
        candidateCount: input.resolution.candidates.length,
      },
    };
  }

  return {
    code: ADAPTER_ERROR_CODES.TIMEOUT,
    message: "No pude confirmar la creación de una sesión nueva dentro del timeout.",
    retryable: true,
    details: {
      operation: input.operation,
    },
  };
}

async function tryResolvePath(
  targetPath: string,
  resolveCanonicalProjectPathFn: typeof resolveCanonicalProjectPath
): Promise<string | undefined> {
  try {
    return await resolveCanonicalProjectPathFn(targetPath);
  } catch {
    return undefined;
  }
}

function belongsToProject(projectPath: string, sessionPath: string): boolean {
  if (projectPath === sessionPath) {
    return true;
  }

  const relativePath = path.relative(projectPath, sessionPath);
  return relativePath.length > 0 && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

function compareBootstrapCandidates(left: BootstrapSessionCandidate, right: BootstrapSessionCandidate): number {
  const leftTimestamp = Date.parse(left.createdAt ?? left.updatedAt ?? "");
  const rightTimestamp = Date.parse(right.createdAt ?? right.updatedAt ?? "");

  if (Number.isFinite(leftTimestamp) && Number.isFinite(rightTimestamp) && leftTimestamp !== rightTimestamp) {
    return rightTimestamp - leftTimestamp;
  }

  return left.sessionId.localeCompare(right.sessionId);
}
