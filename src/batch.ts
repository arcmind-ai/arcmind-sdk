import { NonRetryableError } from "./retry.js";

export type FlushCallback = (events: ArcmindEvent[]) => Promise<void>;

export interface ArcmindEvent {
  type: "track" | "identify";
  name?: string;
  userId?: string;
  traits?: Record<string, unknown>;
  properties?: Record<string, unknown>;
  timestamp: number;
  sessionId?: string;
}

export interface BatchManagerOptions {
  maxSize?: number;
  flushInterval?: number;
  maxQueueSize?: number;
}

export class BatchManager {
  private queue: ArcmindEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;
  private readonly maxSize: number;
  private readonly maxQueueSize: number;
  private readonly flushInterval: number;
  private readonly onFlush: FlushCallback;

  constructor(onFlush: FlushCallback, options: BatchManagerOptions = {}) {
    this.onFlush = onFlush;
    this.maxSize = options.maxSize ?? 20;
    this.flushInterval = options.flushInterval ?? 5000;
    this.maxQueueSize = options.maxQueueSize ?? 1000;
  }

  push(event: ArcmindEvent): void {
    if (this.queue.length >= this.maxQueueSize) {
      this.queue.shift();
    }
    this.queue.push({ ...event });

    if (this.queue.length >= this.maxSize) {
      this.flush().catch(() => {});
      return;
    }

    this.scheduleFlush();
  }

  async flush(): Promise<void> {
    if (this.flushing) await this.flushing.catch(() => {});

    this.clearTimer();

    if (this.queue.length === 0) return;

    const batch = this.queue.splice(0);
    this.flushing = this.onFlush(batch)
      .catch((err) => {
        if (!(err instanceof NonRetryableError)) {
          const available = Math.max(0, this.maxQueueSize - this.queue.length);
          if (available > 0) {
            this.queue.unshift(...batch.slice(0, available));
          }
        }
        throw err;
      })
      .finally(() => {
        this.flushing = null;
      });

    await this.flushing;
  }

  drain(): ArcmindEvent[] {
    this.clearTimer();
    return this.queue.splice(0);
  }

  get pending(): number {
    return this.queue.length;
  }

  destroy(): void {
    this.clearTimer();
    this.queue = [];
  }

  private scheduleFlush(): void {
    if (!this.timer) {
      this.timer = setTimeout(
        () => this.flush().catch(() => {}),
        this.flushInterval
      );
    }
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
