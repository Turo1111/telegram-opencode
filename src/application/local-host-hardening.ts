export const TELEGRAM_CHAT_TYPES = {
  PRIVATE: "private",
  GROUP: "group",
  SUPERGROUP: "supergroup",
  CHANNEL: "channel",
} as const;

export type TelegramChatType = (typeof TELEGRAM_CHAT_TYPES)[keyof typeof TELEGRAM_CHAT_TYPES];

export const LOCAL_HOST_ACTION_KIND = {
  ATTACH_LOCAL: "attach-local",
} as const;

export type LocalHostActionKind = (typeof LOCAL_HOST_ACTION_KIND)[keyof typeof LOCAL_HOST_ACTION_KIND];

export const LOCAL_HOST_TARGET_ENVIRONMENT = {
  LOCAL_TERMINAL: "local-terminal",
} as const;

export type LocalHostTargetEnvironment =
  (typeof LOCAL_HOST_TARGET_ENVIRONMENT)[keyof typeof LOCAL_HOST_TARGET_ENVIRONMENT];

export const LOCAL_HOST_FEATURE_FLAG = {
  ATTACH_LOCAL: "ENABLE_ATTACH_LOCAL",
} as const;

export type LocalHostFeatureFlag = (typeof LOCAL_HOST_FEATURE_FLAG)[keyof typeof LOCAL_HOST_FEATURE_FLAG];

export const LOCAL_HOST_ACTION_GUARD_REASON = {
  ACTOR_MISSING: "actor-missing",
  ACTOR_NOT_ALLOWED: "actor-not-allowed",
  CHAT_NOT_PRIVATE: "chat-not-private",
  FEATURE_DISABLED: "feature-disabled",
  PROJECT_MISSING: "project-missing",
  SESSION_MISSING: "session-missing",
  SESSION_PROJECT_MISMATCH: "session-project-mismatch",
  ENVIRONMENT_UNAVAILABLE: "environment-unavailable",
} as const;

export type LocalHostActionGuardReason =
  (typeof LOCAL_HOST_ACTION_GUARD_REASON)[keyof typeof LOCAL_HOST_ACTION_GUARD_REASON];

export interface LocalHostActionGuardInput {
  readonly actorId?: string;
  readonly allowedActorIds?: ReadonlySet<string>;
  readonly chatType: string;
  readonly featureEnabled: boolean;
  readonly projectId?: string;
  readonly sessionId?: string;
  readonly sessionProjectId?: string;
  readonly environmentReady?: boolean;
  readonly environmentReason?: string;
}

export interface LocalHostActionGuardAllowed {
  readonly ok: true;
}

export interface LocalHostActionGuardRejected {
  readonly ok: false;
  readonly reason: LocalHostActionGuardReason;
  readonly detail?: string;
}

export type LocalHostActionGuardResult =
  | LocalHostActionGuardAllowed
  | LocalHostActionGuardRejected;

export interface LocalHostFeatureResolution {
  readonly featureEnabled: boolean;
  readonly featureFlag: LocalHostFeatureFlag;
  readonly targetEnvironment: LocalHostTargetEnvironment;
}

export function resolveLocalHostFeature(input: {
  readonly action: LocalHostActionKind;
  readonly localHostActionsEnabled: boolean;
  readonly attachLocalEnabled: boolean;
}): LocalHostFeatureResolution {
  if (input.action === LOCAL_HOST_ACTION_KIND.ATTACH_LOCAL) {
    return {
      featureEnabled: input.localHostActionsEnabled && input.attachLocalEnabled,
      featureFlag: LOCAL_HOST_FEATURE_FLAG.ATTACH_LOCAL,
      targetEnvironment: LOCAL_HOST_TARGET_ENVIRONMENT.LOCAL_TERMINAL,
    };
  }

  return {
    featureEnabled: false,
    featureFlag: LOCAL_HOST_FEATURE_FLAG.ATTACH_LOCAL,
    targetEnvironment: LOCAL_HOST_TARGET_ENVIRONMENT.LOCAL_TERMINAL,
  };
}

export function assertLocalHostActionAllowed(
  input: LocalHostActionGuardInput
): LocalHostActionGuardResult {
  if (input.allowedActorIds) {
    if (!input.actorId) {
      return {
        ok: false,
        reason: LOCAL_HOST_ACTION_GUARD_REASON.ACTOR_MISSING,
      };
    }

    if (!input.allowedActorIds.has(input.actorId)) {
      return {
        ok: false,
        reason: LOCAL_HOST_ACTION_GUARD_REASON.ACTOR_NOT_ALLOWED,
      };
    }
  }

  if (input.chatType !== TELEGRAM_CHAT_TYPES.PRIVATE) {
    return {
      ok: false,
      reason: LOCAL_HOST_ACTION_GUARD_REASON.CHAT_NOT_PRIVATE,
    };
  }

  if (!input.featureEnabled) {
    return {
      ok: false,
      reason: LOCAL_HOST_ACTION_GUARD_REASON.FEATURE_DISABLED,
    };
  }

  if (!input.projectId) {
    return {
      ok: false,
      reason: LOCAL_HOST_ACTION_GUARD_REASON.PROJECT_MISSING,
    };
  }

  if (!input.sessionId) {
    return {
      ok: false,
      reason: LOCAL_HOST_ACTION_GUARD_REASON.SESSION_MISSING,
    };
  }

  if (input.sessionProjectId && input.sessionProjectId !== input.projectId) {
    return {
      ok: false,
      reason: LOCAL_HOST_ACTION_GUARD_REASON.SESSION_PROJECT_MISMATCH,
    };
  }

  if (input.environmentReady === false) {
    return {
      ok: false,
      reason: LOCAL_HOST_ACTION_GUARD_REASON.ENVIRONMENT_UNAVAILABLE,
      detail: input.environmentReason,
    };
  }

  return { ok: true };
}
