import { PersistenceDriver } from "./contracts";
import { OpenCodeCliMessage } from "../infrastructure/opencode-cli";

export interface RuntimeMetadataSnapshot {
  readonly effectiveAgent?: string;
  readonly effectiveModel?: string;
}

export interface RuntimeMetadataSyncInput {
  readonly persistence: PersistenceDriver;
  readonly chatId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly nowIso: string;
  readonly readRuntimeMessages?: (sessionId: string) => Promise<readonly OpenCodeCliMessage[]>;
  readonly fallback?: {
    readonly requestedAgent?: string;
    readonly requestedModel?: string;
    readonly effectiveAgent?: string;
    readonly effectiveModel?: string;
  };
}

export interface RuntimeMetadataSyncResult {
  readonly changed: boolean;
  readonly requestedAgent?: string;
  readonly requestedModel?: string;
  readonly effectiveAgent?: string;
  readonly effectiveModel?: string;
}

export async function syncRuntimeMetadata(input: RuntimeMetadataSyncInput): Promise<RuntimeMetadataSyncResult> {
  const runtime = input.readRuntimeMessages ? await resolveRuntimeFromMessages(input.readRuntimeMessages, input.sessionId) : undefined;

  let changed = false;
  let output: RuntimeMetadataSyncResult = {
    changed: false,
    requestedAgent: input.fallback?.requestedAgent,
    requestedModel: input.fallback?.requestedModel,
    effectiveAgent: input.fallback?.effectiveAgent,
    effectiveModel: input.fallback?.effectiveModel,
  };

  await input.persistence.runInTransaction(async (unit) => {
    const session = await unit.sessions.findById(input.sessionId);
    if (!session) {
      return;
    }

    const next = {
      requestedAgent: session.requestedAgent,
      requestedModel: session.requestedModel,
      effectiveAgent: runtime?.effectiveAgent ?? session.effectiveAgent,
      effectiveModel: runtime?.effectiveModel ?? session.effectiveModel,
    };

    changed =
      session.requestedAgent !== next.requestedAgent ||
      session.requestedModel !== next.requestedModel ||
      session.effectiveAgent !== next.effectiveAgent ||
      session.effectiveModel !== next.effectiveModel;

    if (changed) {
      await unit.sessions.upsert({
        ...session,
        requestedAgent: next.requestedAgent,
        requestedModel: next.requestedModel,
        effectiveAgent: next.effectiveAgent,
        effectiveModel: next.effectiveModel,
        lastObservedAt: input.nowIso,
        updatedAt: input.nowIso,
      });
    }

    output = {
      changed,
      requestedAgent: next.requestedAgent,
      requestedModel: next.requestedModel,
      effectiveAgent: next.effectiveAgent,
      effectiveModel: next.effectiveModel,
    };
  });

  return output;
}

async function resolveRuntimeFromMessages(
  reader: (sessionId: string) => Promise<readonly OpenCodeCliMessage[]>,
  sessionId: string
): Promise<RuntimeMetadataSnapshot | undefined> {
  const messages = await reader(sessionId);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant") {
      continue;
    }

    const effectiveAgent = normalizeMetaString(message.info?.agent);
    const providerId = normalizeMetaString(message.info?.model?.providerID);
    const modelId = normalizeMetaString(message.info?.model?.modelID);
    const effectiveModel = providerId && modelId ? `${providerId}/${modelId}` : undefined;

    if (!effectiveAgent && !effectiveModel) {
      continue;
    }

    return { effectiveAgent, effectiveModel };
  }

  return undefined;
}

function normalizeMetaString(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}
