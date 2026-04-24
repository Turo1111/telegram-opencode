interface ChatLockQueueEntry {
  readonly run: () => Promise<void>;
}

interface ChatLockState {
  active: boolean;
  queue: ChatLockQueueEntry[];
}

export interface ChatLockManager {
  runExclusive<T>(chatId: string, work: () => Promise<T>): Promise<T>;
  getQueueDepth(chatId: string): number;
}

export function createChatLockManager(): ChatLockManager {
  const states = new Map<string, ChatLockState>();

  return {
    async runExclusive<T>(chatId: string, work: () => Promise<T>): Promise<T> {
      const state = getOrCreateState(states, chatId);

      if (!state.active) {
        state.active = true;
        try {
          return await work();
        } finally {
          release(states, chatId);
        }
      }

      return new Promise<T>((resolve, reject) => {
        state.queue.push({
          run: async () => {
            try {
              resolve(await work());
            } catch (error) {
              reject(error);
            } finally {
              release(states, chatId);
            }
          },
        });
      });
    },

    getQueueDepth(chatId: string): number {
      return states.get(chatId)?.queue.length ?? 0;
    },
  };
}

function getOrCreateState(states: Map<string, ChatLockState>, chatId: string): ChatLockState {
  const existing = states.get(chatId);
  if (existing) {
    return existing;
  }

  const created: ChatLockState = {
    active: false,
    queue: [],
  };

  states.set(chatId, created);
  return created;
}

function release(states: Map<string, ChatLockState>, chatId: string): void {
  const state = states.get(chatId);
  if (!state) {
    return;
  }

  const next = state.queue.shift();
  if (next) {
    state.active = true;
    void next.run();
    return;
  }

  state.active = false;
  states.delete(chatId);
}
