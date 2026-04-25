import path from "node:path";
import {
  listSessions,
  OpenCodeCliSessionListItem,
  resolveCanonicalProjectPath,
} from "./opencode-cli";

export const PROJECT_SESSION_ASSOCIATION = {
  MATCH: "match",
  PROJECT_MISMATCH: "project-mismatch",
  UNSAFE: "unsafe",
} as const;

export type ProjectSessionAssociation =
  (typeof PROJECT_SESSION_ASSOCIATION)[keyof typeof PROJECT_SESSION_ASSOCIATION];

export const PROJECT_SESSION_INSPECTION_RESULT_KIND = {
  SUCCESS: "success",
  ERROR: "error",
} as const;

export type ProjectSessionInspectionResultKind =
  (typeof PROJECT_SESSION_INSPECTION_RESULT_KIND)[keyof typeof PROJECT_SESSION_INSPECTION_RESULT_KIND];

export interface ProjectSessionListItem {
  readonly sessionId: string;
  readonly title?: string;
  readonly model?: string;
  readonly updatedAt?: string;
}

export interface ProjectSessionInspection {
  readonly sessionId: string;
  readonly title?: string;
  readonly model?: string;
  readonly updatedAt?: string;
  readonly path?: string;
  readonly association: ProjectSessionAssociation;
}

export interface ProjectSessionInspectionSuccessResult {
  readonly kind: typeof PROJECT_SESSION_INSPECTION_RESULT_KIND.SUCCESS;
  readonly projectPath: string;
  readonly sessions: readonly ProjectSessionInspection[];
}

export interface ProjectSessionInspectionErrorResult {
  readonly kind: typeof PROJECT_SESSION_INSPECTION_RESULT_KIND.ERROR;
}

export type ProjectSessionInspectionResult =
  | ProjectSessionInspectionSuccessResult
  | ProjectSessionInspectionErrorResult;

interface InspectProjectSessionsInput {
  readonly projectPath: string;
  readonly timeoutMs: number;
  readonly cliOps?: {
    readonly listSessions: typeof listSessions;
    readonly resolveCanonicalProjectPath: typeof resolveCanonicalProjectPath;
  };
}

interface ProjectSessionCandidate {
  readonly session: OpenCodeCliSessionListItem;
  readonly association: ProjectSessionAssociation;
}

const DEFAULT_CLI_OPS = {
  listSessions,
  resolveCanonicalProjectPath,
} as const;

export async function inspectProjectSessions(
  input: InspectProjectSessionsInput
): Promise<ProjectSessionInspectionResult> {
  const cliOps = input.cliOps ?? DEFAULT_CLI_OPS;

  try {
    const canonicalProjectPath = await cliOps.resolveCanonicalProjectPath(input.projectPath);
    const sessions = await cliOps.listSessions(input.timeoutMs);

    const inspected = await Promise.all(
      sessions.map(async (session) => {
        const candidate = await classifySessionCandidate({
          projectPath: canonicalProjectPath,
          session,
          resolveCanonicalProjectPath: cliOps.resolveCanonicalProjectPath,
        });

        return {
          sessionId: session.id,
          title: session.title,
          model: session.model,
          updatedAt: session.updatedAt,
          path: session.path,
          association: candidate.association,
        } satisfies ProjectSessionInspection;
      })
    );

    return {
      kind: PROJECT_SESSION_INSPECTION_RESULT_KIND.SUCCESS,
      projectPath: canonicalProjectPath,
      sessions: inspected.sort(compareProjectSessions),
    };
  } catch {
    return {
      kind: PROJECT_SESSION_INSPECTION_RESULT_KIND.ERROR,
    };
  }
}

export function selectSafeProjectSessions(result: ProjectSessionInspectionSuccessResult): readonly ProjectSessionListItem[] {
  return result.sessions
    .filter((session) => session.association === PROJECT_SESSION_ASSOCIATION.MATCH)
    .map((session) => ({
      sessionId: session.sessionId,
      title: session.title,
      model: session.model,
      updatedAt: session.updatedAt,
    } satisfies ProjectSessionListItem));
}

async function classifySessionCandidate(input: {
  readonly projectPath: string;
  readonly session: OpenCodeCliSessionListItem;
  readonly resolveCanonicalProjectPath: typeof resolveCanonicalProjectPath;
}): Promise<ProjectSessionCandidate> {
  if (!input.session.path?.trim()) {
    return {
      session: input.session,
      association: PROJECT_SESSION_ASSOCIATION.UNSAFE,
    };
  }

  try {
    const canonicalSessionPath = await input.resolveCanonicalProjectPath(input.session.path);
    return {
      session: input.session,
      association: belongsToProject(input.projectPath, canonicalSessionPath)
        ? PROJECT_SESSION_ASSOCIATION.MATCH
        : PROJECT_SESSION_ASSOCIATION.PROJECT_MISMATCH,
    };
  } catch {
    return {
      session: input.session,
      association: PROJECT_SESSION_ASSOCIATION.UNSAFE,
    };
  }
}

function belongsToProject(projectPath: string, sessionPath: string): boolean {
  // A session belongs to the active project when it resolves to the same
  // canonical root or to a descendant path inside that project tree.
  if (projectPath === sessionPath) {
    return true;
  }

  const relativePath = path.relative(projectPath, sessionPath);
  return relativePath.length > 0 && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

function compareProjectSessions(left: ProjectSessionInspection, right: ProjectSessionInspection): number {
  const leftTimestamp = Date.parse(left.updatedAt ?? "");
  const rightTimestamp = Date.parse(right.updatedAt ?? "");

  if (Number.isFinite(leftTimestamp) && Number.isFinite(rightTimestamp) && leftTimestamp !== rightTimestamp) {
    return rightTimestamp - leftTimestamp;
  }

  if (Number.isFinite(leftTimestamp) && !Number.isFinite(rightTimestamp)) {
    return -1;
  }

  if (!Number.isFinite(leftTimestamp) && Number.isFinite(rightTimestamp)) {
    return 1;
  }

  return left.sessionId.localeCompare(right.sessionId);
}
