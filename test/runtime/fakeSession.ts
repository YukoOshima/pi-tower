import { fauxAssistantMessage, type AssistantMessage, type Usage } from '@earendil-works/pi-ai';
import type { AgentSessionEvent, AgentSessionEventListener } from '@earendil-works/pi-coding-agent';

import type {
  TowerAgentEvent,
  TowerAgentSession,
  TowerAgentSessionFactory,
  TowerAgentSessionRequest,
  TowerThinkingLevel,
} from '../../src/runtime/types.ts';
import type { TowerAgentRuntime } from '../../src/runtime/agentRuntime.ts';

interface PendingPrompt {
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

export class FakeSession implements TowerAgentSession {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  readonly model = { provider: 'fake', id: 'fake-model' };
  readonly thinkingLevel: TowerThinkingLevel = 'low';
  isStreaming = false;
  ignoreAbort = false;
  abortCalls = 0;
  disposed = false;
  readonly prompts: string[] = [];
  readonly steers: string[] = [];
  private readonly listeners = new Set<AgentSessionEventListener>();
  private pending: PendingPrompt | undefined;

  constructor(sessionId: string, sessionFile?: string) {
    this.sessionId = sessionId;
    this.sessionFile = sessionFile;
  }

  prompt(text: string): Promise<void> {
    this.prompts.push(text);
    this.isStreaming = true;
    return new Promise<void>((resolve, reject) => {
      this.pending = { resolve, reject };
    });
  }

  async steer(text: string): Promise<void> {
    this.steers.push(text);
  }

  async abort(): Promise<void> {
    this.abortCalls += 1;
    if (this.ignoreAbort) return;
    this.emit({
      type: 'message_end',
      message: fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'This operation was aborted' }),
    });
    this.settle(true);
  }

  subscribe(listener: AgentSessionEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.disposed = true;
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  emit(event: AgentSessionEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  reply(text: string, usage?: UsagePatch): void {
    this.emit({ type: 'message_end', message: assistantMessage(text, usage) });
  }

  stream(text: string): void {
    const message = assistantMessage(text);
    this.emit({
      type: 'message_update',
      message,
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: text, partial: message },
    });
  }

  fail(errorMessage: string): void {
    this.emit({
      type: 'message_end',
      message: fauxAssistantMessage('', { stopReason: 'error', errorMessage }),
    });
  }

  tool(toolCallId: string, toolName: string, args: unknown, isError?: boolean): void {
    this.emit({ type: 'tool_execution_start', toolCallId, toolName, args });
    if (isError !== undefined) {
      this.emit({ type: 'tool_execution_end', toolCallId, toolName, result: {}, isError });
    }
  }

  settle(aborted = false): void {
    this.isStreaming = false;
    this.emit({ type: 'agent_settled', aborted });
    const pending = this.pending;
    this.pending = undefined;
    pending?.resolve();
  }

  crash(error: unknown): void {
    this.isStreaming = false;
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(error);
  }
}

export type UsagePatch = Partial<Omit<Usage, 'cost'>> & { readonly cost?: Partial<Usage['cost']> };

export function assistantMessage(text: string, usage?: UsagePatch): AssistantMessage {
  const message = fauxAssistantMessage(text);
  if (usage === undefined) return message;
  return {
    ...message,
    usage: {
      ...message.usage,
      ...usage,
      cost: { ...message.usage.cost, ...usage.cost },
    },
  };
}

export class FakeSessionFactory {
  readonly sessions = new Map<string, FakeSession>();
  readonly requests: TowerAgentSessionRequest[] = [];
  failWith: unknown;
  gate: Promise<void> | undefined;

  readonly create: TowerAgentSessionFactory = async (request) => {
    this.requests.push(request);
    if (this.gate !== undefined) await this.gate;
    if (this.failWith !== undefined) throw this.failWith;
    const session = new FakeSession(request.agentId);
    this.sessions.set(request.agentId, session);
    return session;
  };

  session(agentId: string): FakeSession {
    const session = this.sessions.get(agentId);
    if (session === undefined) throw new Error(`no fake session for ${agentId}`);
    return session;
  }
}

export function nextEvent<TType extends TowerAgentEvent['type']>(
  runtime: TowerAgentRuntime,
  type: TType,
): Promise<Extract<TowerAgentEvent, { type: TType }>> {
  return new Promise((resolve) => {
    const unsubscribe = runtime.onEvent((event) => {
      if (event.type !== type) return;
      unsubscribe();
      resolve(event as Extract<TowerAgentEvent, { type: TType }>);
    });
  });
}

export function sequentialIds(): (prefix: 'agent' | 'task') => string {
  const counters = { agent: 0, task: 0 };
  return (prefix) => {
    counters[prefix] += 1;
    return `${prefix}-${String(counters[prefix])}`;
  };
}
