import { BatchManager, type ArcmindEvent } from "./batch.js";
import { registerFlushHandlers } from "./flush.js";
import { withRetry, NonRetryableError } from "./retry.js";

const DEFAULT_COLLECTOR_URL = "https://collector.arcmind.ai";
const EVENTS_PATH = "/v1/events";
const BEACON_TOKEN_FIELD = "_token";
const MAX_STRING_LENGTH = 256;
const MAX_PAYLOAD_BYTES = 32_768;
const FETCH_TIMEOUT_MS = 10_000;

export interface ArcmindConfig {
  token: string;
  batchSize?: number;
  flushInterval?: number;
  maxQueueSize?: number;
}

export class Arcmind {
  private static readonly UTM_KEYS = [
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
  ] as const;

  private static readonly UTM_STORAGE_KEY = "arcmind_utm";

  private token: string;
  private sessionId: string;
  private userId?: string;
  private batch: BatchManager;
  private unregisterFlush: (() => void) | null = null;
  private destroyed = false;
  private utmParams: Record<string, string> = {};

  constructor(config: ArcmindConfig) {
    if (!config.token || typeof config.token !== "string") {
      throw new Error("[arcmind] A non-empty token is required.");
    }

    this.token = config.token;
    this.sessionId = this.generateId();
    this.utmParams = this.captureUtm();

    this.batch = new BatchManager((events) => this.sendBatch(events), {
      maxSize: config.batchSize ?? 20,
      flushInterval: config.flushInterval ?? 5000,
      maxQueueSize: config.maxQueueSize ?? 1000,
    });

    this.unregisterFlush = registerFlushHandlers({
      onFlush: () => this.flushBeacon(),
    });
  }

  get pendingCount(): number {
    return this.batch.pending;
  }

  getUtm(): Readonly<Record<string, string>> {
    return { ...this.utmParams };
  }

  track(name: string, properties?: Record<string, unknown>): void {
    if (this.destroyed) return;
    const validated = this.validateString(
      name,
      "track() requires a non-empty event name."
    );
    if (validated === null) return;

    const sanitized = this.sanitizePayload(properties, "properties");
    const merged = this.mergeUtm(sanitized);

    this.batch.push({
      type: "track",
      name: validated,
      properties: merged,
      timestamp: Date.now(),
      sessionId: this.sessionId,
      userId: this.userId,
    });
  }

  identify(userId: string, traits?: Record<string, unknown>): void {
    if (this.destroyed) return;
    const validated = this.validateString(
      userId,
      "identify() requires a non-empty userId."
    );
    if (validated === null) return;

    this.userId = validated;
    this.batch.push({
      type: "identify",
      userId: validated,
      traits: this.sanitizePayload(traits, "traits"),
      timestamp: Date.now(),
      sessionId: this.sessionId,
    });
  }

  async flush(): Promise<void> {
    if (this.destroyed) return;
    await this.batch.flush();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.flushBeacon();
    this.batch.destroy();
    this.unregisterFlush?.();
    this.unregisterFlush = null;
    this.destroyed = true;
  }

  private flushBeacon(): void {
    const events = this.batch.drain();
    if (events.length === 0) return;

    const url = `${DEFAULT_COLLECTOR_URL}${EVENTS_PATH}`;
    const hasBeacon =
      typeof navigator !== "undefined" &&
      typeof navigator.sendBeacon === "function";

    if (hasBeacon) {
      const payload = JSON.stringify({
        events,
        [BEACON_TOKEN_FIELD]: this.token,
      });
      const blob = new Blob([payload], { type: "application/json" });
      const sent = navigator.sendBeacon(url, blob);
      if (!sent) {
        console.warn(
          `[arcmind] sendBeacon failed — falling back to fetch keepalive for ${events.length} event(s).`
        );
        this.sendKeepalive(events);
      }
    } else {
      this.sendKeepalive(events);
    }
  }

  private sendKeepalive(events: ArcmindEvent[]): void {
    fetch(`${DEFAULT_COLLECTOR_URL}${EVENTS_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ events }),
      keepalive: true,
    }).catch((error: unknown) => {
      const reason =
        error instanceof Error ? error.message : "unknown keepalive failure";
      console.warn(`[arcmind] keepalive flush failed: ${reason}`);
    });
  }

  private async sendBatch(events: ArcmindEvent[]): Promise<void> {
    await withRetry(async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      try {
        const res = await fetch(`${DEFAULT_COLLECTOR_URL}${EVENTS_PATH}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.token}`,
          },
          body: JSON.stringify({ events }),
          signal: controller.signal,
        });

        if (!res.ok) {
          if (res.status === 429) {
            throw new Error("[arcmind] HTTP 429: rate limited");
          }
          if (res.status >= 400 && res.status < 500) {
            throw new NonRetryableError(
              `[arcmind] HTTP ${res.status}: ${res.statusText}`
            );
          }
          throw new Error(
            `[arcmind] HTTP ${res.status}: ${res.statusText}`
          );
        }
      } finally {
        clearTimeout(timeout);
      }
    });
  }

  private validateString(value: string, message: string): string | null {
    if (!value || typeof value !== "string") {
      console.warn(`[arcmind] ${message}`);
      return null;
    }
    return value.length > MAX_STRING_LENGTH
      ? value.slice(0, MAX_STRING_LENGTH)
      : value;
  }

  private sanitizePayload(
    data: Record<string, unknown> | undefined,
    label: string
  ): Record<string, unknown> | undefined {
    if (!data) return data;
    try {
      const json = JSON.stringify(data);
      const bytes =
        typeof TextEncoder !== "undefined"
          ? new TextEncoder().encode(json).length
          : json.length;
      if (bytes > MAX_PAYLOAD_BYTES) {
        console.warn(`[arcmind] ${label} exceeds 32KB limit, dropping.`);
        return undefined;
      }
      return JSON.parse(json) as Record<string, unknown>;
    } catch {
      console.warn(`[arcmind] ${label} is not serializable, dropping.`);
      return undefined;
    }
  }

  private captureUtm(): Record<string, string> {
    const isBrowser =
      typeof window !== "undefined" &&
      typeof window.location !== "undefined";
    if (!isBrowser) return {};

    const params = new URLSearchParams(window.location.search);
    const fromUrl: Record<string, string> = {};

    for (const key of Arcmind.UTM_KEYS) {
      const value = params.get(key);
      if (value) fromUrl[key] = value;
    }

    if (Object.keys(fromUrl).length > 0) {
      this.persistUtm(fromUrl);
      return fromUrl;
    }

    return this.loadPersistedUtm();
  }

  private persistUtm(utm: Record<string, string>): void {
    try {
      localStorage.setItem(Arcmind.UTM_STORAGE_KEY, JSON.stringify(utm));
    } catch {
      // localStorage unavailable (private browsing, SSR, etc.)
    }
  }

  private loadPersistedUtm(): Record<string, string> {
    try {
      const stored = localStorage.getItem(Arcmind.UTM_STORAGE_KEY);
      if (stored) return JSON.parse(stored) as Record<string, string>;
    } catch {
      // localStorage unavailable or corrupted
    }
    return {};
  }

  private mergeUtm(
    properties: Record<string, unknown> | undefined
  ): Record<string, unknown> | undefined {
    const hasUtm = Object.keys(this.utmParams).length > 0;
    if (!hasUtm) return properties;
    return { ...this.utmParams, ...properties };
  }

  private generateId(): string {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = Array.from(bytes, (b) =>
        b.toString(16).padStart(2, "0")
      ).join("");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}
