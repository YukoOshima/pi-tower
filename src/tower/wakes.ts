import { WAKE_BATCH_LIMIT, type InboxWakeItem } from '../prompts/index.ts';
import type { TowerInboxSentPayload } from '../tools/support.ts';

export const WAKE_TRACKED_KEY_LIMIT = 100;

export interface InboxWakeEntry extends InboxWakeItem {
  readonly key: string;
}

export interface InboxWakeBatch {
  readonly items: readonly InboxWakeEntry[];
  readonly omitted: number;
}

export class InboxWakeQueue {
  private items: InboxWakeEntry[] = [];
  private omitted = 0;
  private legacySequence = 0;
  private readonly recentKeys = new Set<string>();

  get size(): number {
    return this.items.length;
  }

  entryFor(event: TowerInboxSentPayload): InboxWakeEntry {
    let key: string;
    if (event.messageId !== undefined) {
      key = `id:${event.messageId}`;
    } else if (event.file !== undefined) {
      key = `file:${event.file}`;
    } else {
      this.legacySequence += 1;
      key = `legacy:${String(this.legacySequence)}`;
    }
    return {
      key,
      from: event.from,
      subject: event.subject,
      ...(event.messageId === undefined ? {} : { messageId: event.messageId }),
      ...(event.file === undefined ? {} : { file: event.file }),
      ...(event.sentAt === undefined ? {} : { sentAt: event.sentAt }),
      ...(event.missionId === undefined ? {} : { missionId: event.missionId }),
    };
  }

  enqueue(item: InboxWakeEntry, replay = false): void {
    if (this.items.some((candidate) => candidate.key === item.key)) return;
    if (!replay && this.recentKeys.has(item.key)) return;
    this.recentKeys.add(item.key);
    if (this.recentKeys.size > WAKE_TRACKED_KEY_LIMIT) {
      const oldest = this.recentKeys.values().next().value;
      if (oldest !== undefined) this.recentKeys.delete(oldest);
    }
    this.items.push(item);
    if (this.items.length > WAKE_BATCH_LIMIT) {
      this.items.shift();
      this.omitted += 1;
    }
  }

  requeue(batch: InboxWakeBatch): void {
    for (const item of batch.items) this.enqueue(item, true);
    this.omitted += batch.omitted;
  }

  take(): InboxWakeBatch | undefined {
    if (this.items.length === 0) return undefined;
    const batch: InboxWakeBatch = { items: this.items, omitted: this.omitted };
    this.items = [];
    this.omitted = 0;
    return batch;
  }

  discardPending(): void {
    this.items = [];
    this.omitted = 0;
  }

  reset(): void {
    this.discardPending();
    this.recentKeys.clear();
  }
}
