import {
  BOOT_RECOVERY_NOTICE_KIND,
  BootRecoveryNotice,
  OpenCodeSessionAdapter,
  PersistenceUnit,
  PersistenceDriver,
  RECOVERY_REASON,
  RECOVERY_STATUS,
  RecoveryReason,
  RemoteSessionStatus,
} from "./contracts";
import { ACTIVE_TASK_STATUS, OPERATIONAL_MODES, OperationalState, createIdleState } from "../domain/entities";
import { DomainError, ERROR_CODES } from "../domain/errors";
import { logger } from "../logger";

export interface BootRecoverySummary {
  readonly recoveredChats: number;
  readonly chatsInError: number;
  readonly cleanedBindings: number;
  readonly notices: readonly BootRecoveryNotice[];
  readonly evaluatedBindings: number;
}

interface ActiveBindingSnapshot {
  readonly chatId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly state: OperationalState;
}

interface LocalConsistencyResolution {
  readonly consistentBindings: readonly ActiveBindingSnapshot[];
  readonly chatsInError: number;
  readonly cleanedBindings: number;
}

interface BootRecoveryServiceDeps {
  readonly persistence: PersistenceDriver;
  readonly adapter?: OpenCodeSessionAdapter;
  readonly remoteReconcileEnabled: boolean;
}

export class BootRecoveryService {
  constructor(private readonly deps: BootRecoveryServiceDeps) {}

  async reconcileAll(nowIso = new Date().toISOString()): Promise<BootRecoverySummary> {
    const activeBindings = await this.loadActiveBindings(nowIso);
    if (activeBindings.length === 0) {
      return {
        recoveredChats: 0,
        chatsInError: 0,
        cleanedBindings: 0,
        notices: [],
        evaluatedBindings: 0,
      };
    }

    const localConsistency = await this.resolveLocalInconsistencies(activeBindings, nowIso);

    if (!this.deps.remoteReconcileEnabled || !this.deps.adapter) {
      await this.markHealthyWithoutRemote(localConsistency.consistentBindings, nowIso);
      return {
        recoveredChats: localConsistency.consistentBindings.length,
        chatsInError: localConsistency.chatsInError,
        cleanedBindings: localConsistency.cleanedBindings,
        notices: [],
        evaluatedBindings: activeBindings.length,
      };
    }

    const notices: BootRecoveryNotice[] = [];
    let degraded = localConsistency.chatsInError;
    let cleaned = localConsistency.cleanedBindings;

    for (const binding of localConsistency.consistentBindings) {
      const result = await this.deps.adapter.getSessionState({
        projectId: binding.projectId,
        sessionId: binding.sessionId,
      });

      if (result.ok) {
        const closure = await this.applyRemoteStatus(binding, result.value.status, result.value.taskId, nowIso, notices);
        if (closure) {
          cleaned += 1;
        }
        continue;
      }

      const error = result.error;
      if (error.code === ERROR_CODES.NOT_FOUND) {
        await this.closeBinding(binding, RECOVERY_REASON.REMOTE_MISSING, nowIso, notices);
        cleaned += 1;
        continue;
      }

      const reason = this.toDegradedReason(error);
      await this.markBindingDegraded(binding, reason, nowIso, notices);
      degraded += 1;
    }

    const recoveredChats = activeBindings.length - degraded;

    logger.info("Boot remote reconciliation completed", {
      evaluatedBindings: activeBindings.length,
      recoveredChats,
      degradedChats: degraded,
      cleanedBindings: cleaned,
      noticesQueued: notices.length,
    });

    return {
      recoveredChats,
      chatsInError: degraded,
      cleanedBindings: cleaned,
      notices,
      evaluatedBindings: activeBindings.length,
    };
  }

  private async resolveLocalInconsistencies(
    bindings: readonly ActiveBindingSnapshot[],
    nowIso: string
  ): Promise<LocalConsistencyResolution> {
    const consistentBindings: ActiveBindingSnapshot[] = [];
    let chatsInError = 0;
    let cleanedBindings = 0;

    for (const binding of bindings) {
      const isConsistent = await this.isBindingConsistent(binding);
      if (isConsistent) {
        consistentBindings.push(binding);
        continue;
      }

      chatsInError += 1;
      cleanedBindings += 1;
      await this.markBindingInconsistent(binding, nowIso);
    }

    return {
      consistentBindings,
      chatsInError,
      cleanedBindings,
    };
  }

  private async isBindingConsistent(binding: ActiveBindingSnapshot): Promise<boolean> {
    return this.deps.persistence.runInTransaction(async (unit) => {
      const session = await unit.sessions.findById(binding.sessionId);
      if (!session) {
        return false;
      }

      return session.projectId === binding.projectId;
    });
  }

  private async markBindingInconsistent(binding: ActiveBindingSnapshot, nowIso: string): Promise<void> {
    await this.deps.persistence.runInTransaction(async (unit) => {
      const currentBinding = await unit.bindings.findByChatId(binding.chatId);
      const currentState = (await unit.states.findByChatId(binding.chatId)) ?? createIdleState(binding.chatId, nowIso);

      if (currentBinding) {
        await unit.bindings.upsert({
          ...currentBinding,
          activeSessionId: undefined,
          updatedAt: nowIso,
        });
      }

      await this.completePreviousTask(unit, currentState.activeTaskId, nowIso);

      await unit.states.upsert({
        ...currentState,
        mode: OPERATIONAL_MODES.ERROR,
        activeTaskId: undefined,
        recoveryStatus: undefined,
        recoveryReason: undefined,
        lastReconciledAt: nowIso,
        lastErrorCode: ERROR_CODES.INCONSISTENT_BINDING,
        lastErrorMessage: "Binding local inconsistente: la sesión activa no coincide con el proyecto activo.",
        updatedAt: nowIso,
      });
    });
  }

  private async loadActiveBindings(nowIso: string): Promise<readonly ActiveBindingSnapshot[]> {
    return this.deps.persistence.runInTransaction(async (unit) => {
      const [bindings, states] = await Promise.all([unit.bindings.listAll(), unit.states.listAll()]);
      const stateByChatId = new Map(states.map((state) => [state.chatId, state]));

      return bindings
        .filter((binding) => binding.activeProjectId && binding.activeSessionId)
        .map((binding) => ({
          chatId: binding.chatId,
          projectId: binding.activeProjectId!,
          sessionId: binding.activeSessionId!,
          state: stateByChatId.get(binding.chatId) ?? createIdleState(binding.chatId, nowIso),
        }));
    });
  }

  private async markHealthyWithoutRemote(bindings: readonly ActiveBindingSnapshot[], nowIso: string): Promise<void> {
    await this.deps.persistence.runInTransaction(async (unit) => {
      for (const binding of bindings) {
        await unit.states.upsert({
          ...binding.state,
          mode: OPERATIONAL_MODES.SESSION_LINKED,
          recoveryStatus: RECOVERY_STATUS.HEALTHY,
          recoveryReason: undefined,
          lastReconciledAt: nowIso,
          lastErrorCode: undefined,
          lastErrorMessage: undefined,
          updatedAt: nowIso,
        });
      }
    });
  }

  private async applyRemoteStatus(
    binding: ActiveBindingSnapshot,
    remoteStatus: RemoteSessionStatus,
    taskId: string | undefined,
    nowIso: string,
    notices: BootRecoveryNotice[]
  ): Promise<boolean> {
    if (remoteStatus === "running") {
      await this.markBindingRunning(binding, taskId, nowIso);
      return false;
    }

    if (remoteStatus === "needs-attention") {
      await this.markBindingNeedsAttention(binding, nowIso);
      return false;
    }

    if (remoteStatus === "idle" || remoteStatus === "completed") {
      await this.closeBinding(binding, RECOVERY_REASON.REMOTE_MISSING, nowIso, notices);
      return true;
    }

    await this.markBindingDegraded(binding, RECOVERY_REASON.REMOTE_CHECK_FAILED, nowIso, notices);
    return false;
  }

  private async markBindingRunning(
    binding: ActiveBindingSnapshot,
    taskId: string | undefined,
    nowIso: string
  ): Promise<void> {
    await this.deps.persistence.runInTransaction(async (unit) => {
      const normalizedTaskId = taskId?.trim() || undefined;
      const mode = normalizedTaskId ? OPERATIONAL_MODES.TASK_RUNNING : OPERATIONAL_MODES.SESSION_LINKED;

      if (normalizedTaskId) {
        const currentTask = await unit.tasks.findById(normalizedTaskId);
        await unit.tasks.upsert({
          taskId: normalizedTaskId,
          chatId: binding.chatId,
          sessionId: binding.sessionId,
          status: ACTIVE_TASK_STATUS.IN_PROGRESS,
          command: currentTask?.command ?? "(recovered remote task)",
          createdAt: currentTask?.createdAt ?? nowIso,
          updatedAt: nowIso,
        });
      }

      await unit.states.upsert({
        ...binding.state,
        mode,
        activeTaskId: normalizedTaskId,
        recoveryStatus: RECOVERY_STATUS.RECOVERED,
        recoveryReason: undefined,
        lastReconciledAt: nowIso,
        lastErrorCode: undefined,
        lastErrorMessage: undefined,
        updatedAt: nowIso,
      });
    });
  }

  private async markBindingNeedsAttention(binding: ActiveBindingSnapshot, nowIso: string): Promise<void> {
    await this.deps.persistence.runInTransaction(async (unit) => {
      await this.completePreviousTask(unit, binding.state.activeTaskId, nowIso);
      await unit.states.upsert({
        ...binding.state,
        mode: OPERATIONAL_MODES.NEEDS_ATTENTION,
        activeTaskId: undefined,
        recoveryStatus: RECOVERY_STATUS.RECOVERED,
        recoveryReason: undefined,
        lastReconciledAt: nowIso,
        lastErrorCode: undefined,
        lastErrorMessage: undefined,
        updatedAt: nowIso,
      });
    });
  }

  private async closeBinding(
    binding: ActiveBindingSnapshot,
    reason: RecoveryReason,
    nowIso: string,
    notices: BootRecoveryNotice[]
  ): Promise<void> {
    await this.deps.persistence.runInTransaction(async (unit) => {
      const existingBinding = await unit.bindings.findByChatId(binding.chatId);
      if (!existingBinding) {
        return;
      }

      await unit.bindings.upsert({
        ...existingBinding,
        activeSessionId: undefined,
        updatedAt: nowIso,
      });

      await this.completePreviousTask(unit, binding.state.activeTaskId, nowIso);
      await unit.states.upsert({
        ...binding.state,
        mode: existingBinding.activeProjectId ? OPERATIONAL_MODES.SESSION_LINKED : OPERATIONAL_MODES.IDLE,
        activeTaskId: undefined,
        recoveryStatus: RECOVERY_STATUS.RECOVERED,
        recoveryReason: reason,
        lastReconciledAt: nowIso,
        lastErrorCode: undefined,
        lastErrorMessage: undefined,
        updatedAt: nowIso,
      });
    });

    notices.push({
      chatId: binding.chatId,
      projectId: binding.projectId,
      sessionId: binding.sessionId,
      kind: BOOT_RECOVERY_NOTICE_KIND.SESSION_CLOSED,
      reason,
    });
  }

  private async markBindingDegraded(
    binding: ActiveBindingSnapshot,
    reason: RecoveryReason,
    nowIso: string,
    notices: BootRecoveryNotice[]
  ): Promise<void> {
    await this.deps.persistence.runInTransaction(async (unit) => {
      const stableMode =
        binding.state.mode === OPERATIONAL_MODES.IDLE || binding.state.mode === OPERATIONAL_MODES.ERROR
          ? OPERATIONAL_MODES.SESSION_LINKED
          : binding.state.mode;

      await unit.states.upsert({
        ...binding.state,
        mode: stableMode,
        recoveryStatus: RECOVERY_STATUS.DEGRADED,
        recoveryReason: reason,
        lastReconciledAt: nowIso,
        lastErrorCode: undefined,
        lastErrorMessage: undefined,
        updatedAt: nowIso,
      });
    });

    notices.push({
      chatId: binding.chatId,
      projectId: binding.projectId,
      sessionId: binding.sessionId,
      kind: BOOT_RECOVERY_NOTICE_KIND.DEGRADED,
      reason,
    });
  }

  private async completePreviousTask(
    unit: PersistenceUnit,
    taskId: string | undefined,
    nowIso: string
  ): Promise<void> {
    const previousTaskId = taskId?.trim();
    if (!previousTaskId) {
      return;
    }

    const previousTask = await unit.tasks.findById(previousTaskId);
    if (!previousTask) {
      return;
    }

    await unit.tasks.upsert({
      ...previousTask,
      taskId: previousTaskId,
      status: ACTIVE_TASK_STATUS.COMPLETED,
      updatedAt: nowIso,
    });
  }

  private toDegradedReason(error: DomainError): RecoveryReason {
    if (error.code === ERROR_CODES.UPSTREAM_TIMEOUT) {
      return RECOVERY_REASON.REMOTE_TIMEOUT;
    }

    if (error.code === ERROR_CODES.UPSTREAM_5XX) {
      return RECOVERY_REASON.REMOTE_UNAVAILABLE;
    }

    return RECOVERY_REASON.REMOTE_CHECK_FAILED;
  }
}

export async function completeTaskIfExists(
  unit: PersistenceUnit,
  taskId: string | undefined,
  status: typeof ACTIVE_TASK_STATUS.COMPLETED | typeof ACTIVE_TASK_STATUS.FAILED,
  nowIso: string
): Promise<void> {
  const previousTaskId = taskId?.trim();
  if (!previousTaskId) {
    return;
  }

  const previousTask = await unit.tasks.findById(previousTaskId);
  if (!previousTask) {
    return;
  }

  if (previousTask.status !== ACTIVE_TASK_STATUS.IN_PROGRESS) {
    return;
  }

  await unit.tasks.upsert({
    ...previousTask,
    taskId: previousTaskId,
    status,
    updatedAt: nowIso,
  });
}

export function resolveStableSessionMode(mode: OperationalState["mode"]): OperationalState["mode"] {
  if (mode === OPERATIONAL_MODES.IDLE || mode === OPERATIONAL_MODES.ERROR) {
    return OPERATIONAL_MODES.SESSION_LINKED;
  }

  return mode;
}
