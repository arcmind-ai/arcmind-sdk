import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Arcmind } from "./client.js";
import { BatchManager } from "./batch.js";
import { withRetry, NonRetryableError } from "./retry.js";

// ── BatchManager ──────────────────────────────────────────────────────────────

describe("BatchManager", () => {
  it("flushes when batch size is reached", async () => {
    const onFlush = vi.fn().mockResolvedValue(undefined);
    const bm = new BatchManager(onFlush, {
      maxSize: 3,
      flushInterval: 60_000,
    });

    bm.push({ type: "track", name: "a", timestamp: 1 });
    bm.push({ type: "track", name: "b", timestamp: 2 });
    expect(onFlush).not.toHaveBeenCalled();

    bm.push({ type: "track", name: "c", timestamp: 3 });
    await new Promise((r) => setTimeout(r, 10));

    expect(onFlush).toHaveBeenCalledWith([
      { type: "track", name: "a", timestamp: 1 },
      { type: "track", name: "b", timestamp: 2 },
      { type: "track", name: "c", timestamp: 3 },
    ]);
    bm.destroy();
  });

  it("flushes manually", async () => {
    const onFlush = vi.fn().mockResolvedValue(undefined);
    const bm = new BatchManager(onFlush, { flushInterval: 60_000 });

    bm.push({ type: "track", name: "x", timestamp: 1 });
    await bm.flush();

    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(bm.pending).toBe(0);
    bm.destroy();
  });

  it("does not call onFlush when queue is empty", async () => {
    const onFlush = vi.fn().mockResolvedValue(undefined);
    const bm = new BatchManager(onFlush, { flushInterval: 60_000 });
    await bm.flush();
    expect(onFlush).not.toHaveBeenCalled();
    bm.destroy();
  });

  it("puts events back on failed flush", async () => {
    const onFlush = vi.fn().mockRejectedValue(new Error("network"));
    const bm = new BatchManager(onFlush, { flushInterval: 60_000 });

    bm.push({ type: "track", name: "a", timestamp: 1 });
    await bm.flush().catch(() => {});

    expect(bm.pending).toBe(1);
    bm.destroy();
  });

  it("drops events on NonRetryableError instead of re-queuing", async () => {
    const onFlush = vi
      .fn()
      .mockRejectedValue(new NonRetryableError("bad request"));
    const bm = new BatchManager(onFlush, { flushInterval: 60_000 });

    bm.push({ type: "track", name: "a", timestamp: 1 });
    await bm.flush().catch(() => {});

    expect(bm.pending).toBe(0);
    bm.destroy();
  });

  it("drops oldest events when queue exceeds maxQueueSize", () => {
    const onFlush = vi.fn().mockResolvedValue(undefined);
    const bm = new BatchManager(onFlush, {
      maxSize: 100,
      flushInterval: 60_000,
      maxQueueSize: 3,
    });

    bm.push({ type: "track", name: "a", timestamp: 1 });
    bm.push({ type: "track", name: "b", timestamp: 2 });
    bm.push({ type: "track", name: "c", timestamp: 3 });
    bm.push({ type: "track", name: "d", timestamp: 4 });

    expect(bm.pending).toBe(3);
    const drained = bm.drain();
    expect(drained[0].name).toBe("b");
    expect(drained[2].name).toBe("d");
    bm.destroy();
  });

  it("caps re-queued events on flush failure when queue is full", async () => {
    let callCount = 0;
    const onFlush = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.reject(new Error("fail"));
      return Promise.resolve();
    });
    const bm = new BatchManager(onFlush, {
      maxSize: 2,
      flushInterval: 60_000,
      maxQueueSize: 3,
    });

    bm.push({ type: "track", name: "a", timestamp: 1 });
    bm.push({ type: "track", name: "b", timestamp: 2 });
    await new Promise((r) => setTimeout(r, 20));

    bm.push({ type: "track", name: "c", timestamp: 3 });
    bm.push({ type: "track", name: "d", timestamp: 4 });
    bm.push({ type: "track", name: "e", timestamp: 5 });

    expect(bm.pending).toBeLessThanOrEqual(3);
    bm.destroy();
  });

  it("clones events to prevent external mutation", () => {
    const onFlush = vi.fn().mockResolvedValue(undefined);
    const bm = new BatchManager(onFlush, { flushInterval: 60_000 });

    const event = { type: "track" as const, name: "original", timestamp: 1 };
    bm.push(event);
    event.name = "mutated";

    const drained = bm.drain();
    expect(drained[0].name).toBe("original");
    bm.destroy();
  });

  it("drain() returns all pending events and clears queue", () => {
    const onFlush = vi.fn().mockResolvedValue(undefined);
    const bm = new BatchManager(onFlush, { flushInterval: 60_000 });

    bm.push({ type: "track", name: "a", timestamp: 1 });
    bm.push({ type: "track", name: "b", timestamp: 2 });

    const drained = bm.drain();
    expect(drained).toHaveLength(2);
    expect(bm.pending).toBe(0);
    bm.destroy();
  });

  it("prevents concurrent flushes from duplicating events", async () => {
    const onFlush = vi
      .fn()
      .mockImplementation(() => new Promise((r) => setTimeout(r, 50)));
    const bm = new BatchManager(onFlush, { flushInterval: 60_000 });

    bm.push({ type: "track", name: "a", timestamp: 1 });

    const p1 = bm.flush();
    const p2 = bm.flush();
    await Promise.all([p1, p2]);

    expect(onFlush).toHaveBeenCalledTimes(1);
    bm.destroy();
  });
});

// ── withRetry ─────────────────────────────────────────────────────────────────

describe("withRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves immediately on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, { maxAttempts: 3, baseDelay: 0 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on failure and succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValue("ok");

    const promise = withRetry(fn, { maxAttempts: 3, baseDelay: 10 });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws after all attempts are exhausted", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("always fails"));
    const promise = withRetry(fn, { maxAttempts: 3, baseDelay: 10 });
    const settled = promise.catch((e: unknown) => e as Error);
    await vi.runAllTimersAsync();
    const result = await settled;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe("always fails");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry NonRetryableError", async () => {
    const fn = vi.fn().mockRejectedValue(new NonRetryableError("bad request"));
    const promise = withRetry(fn, { maxAttempts: 3, baseDelay: 10 });
    const settled = promise.catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const result = await settled;
    expect(result).toBeInstanceOf(NonRetryableError);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// ── Arcmind client ────────────────────────────────────────────────────────────

describe("Arcmind", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("track() queues an event", () => {
    const client = new Arcmind({ token: "test-token" });
    client.track("page_view", { path: "/" });
    expect(client.pendingCount).toBe(1);
    client.destroy();
  });

  it("identify() sets userId and queues event", () => {
    const client = new Arcmind({ token: "test-token" });
    client.identify("user-123", { plan: "pro" });
    expect(client["userId"]).toBe("user-123");
    expect(client.pendingCount).toBe(1);
    client.destroy();
  });

  it("flush() sends events via fetch", async () => {
    const client = new Arcmind({ token: "test-token" });
    client.track("signup");
    await client.flush();
    expect(fetch).toHaveBeenCalledWith(
      "https://collector.arcmind.ai/v1/events",
      expect.objectContaining({ method: "POST" })
    );
    client.destroy();
  });

  it("does not retry 4xx errors and drops events", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response("Bad Request", { status: 400 })
    );
    const client = new Arcmind({ token: "test-token" });
    client.track("test");
    await client.flush().catch(() => {});
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(client.pendingCount).toBe(0);
    client.destroy();
  });

  it("throws when token is empty", () => {
    expect(() => new Arcmind({ token: "" })).toThrow(
      "[arcmind] A non-empty token is required."
    );
  });

  it("throws when token is not a string", () => {
    expect(
      () => new Arcmind({ token: 123 as unknown as string })
    ).toThrow("[arcmind] A non-empty token is required.");
  });

  it("uses default collector URL when none is provided", async () => {
    const client = new Arcmind({ token: "test-token" });
    client.track("test");
    await client.flush();
    expect(fetch).toHaveBeenCalledWith(
      "https://collector.arcmind.ai/v1/events",
      expect.objectContaining({ method: "POST" })
    );
    client.destroy();
  });

  it("track() ignores empty event name", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = new Arcmind({ token: "test-token" });
    client.track("");
    expect(client.pendingCount).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      "[arcmind] track() requires a non-empty event name."
    );
    client.destroy();
  });

  it("identify() ignores empty userId", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = new Arcmind({ token: "test-token" });
    client.identify("");
    expect(client.pendingCount).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      "[arcmind] identify() requires a non-empty userId."
    );
    client.destroy();
  });

  it("drops oversized properties with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = new Arcmind({ token: "test-token" });
    const huge = { data: "x".repeat(40_000) };
    client.track("big_event", huge);
    expect(warn).toHaveBeenCalledWith(
      "[arcmind] properties exceeds 32KB limit, dropping."
    );
    expect(client.pendingCount).toBe(1);
    const drained = client["batch"].drain();
    expect(drained[0].properties).toBeUndefined();
    client.destroy();
  });

  it("drops properties that exceed 32KB in UTF-8 bytes", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = new Arcmind({ token: "test-token" });
    const hugeUnicode = { data: "😀".repeat(10_000) };
    client.track("unicode_event", hugeUnicode);
    expect(warn).toHaveBeenCalledWith(
      "[arcmind] properties exceeds 32KB limit, dropping."
    );
    const drained = client["batch"].drain();
    expect(drained[0].properties).toBeUndefined();
    client.destroy();
  });

  it("clones nested properties to avoid post-track mutation", () => {
    const client = new Arcmind({ token: "test-token" });
    const properties = { cart: { total: 100 } };
    client.track("checkout_started", properties);
    properties.cart.total = 0;
    const drained = client["batch"].drain();
    expect(drained[0].properties).toEqual({ cart: { total: 100 } });
    client.destroy();
  });

  it("destroy() flushes pending events before cleanup", () => {
    const client = new Arcmind({ token: "test-token" });
    client.track("pending_event");
    expect(client.pendingCount).toBe(1);
    client.destroy();
    expect(fetch).toHaveBeenCalledWith(
      "https://collector.arcmind.ai/v1/events",
      expect.objectContaining({ keepalive: true })
    );
  });

  it("falls back to fetch keepalive when sendBeacon returns false", () => {
    const sendBeacon = vi.fn().mockReturnValue(false);
    const originalSendBeacon = navigator.sendBeacon;
    Object.defineProperty(navigator, "sendBeacon", {
      configurable: true,
      value: sendBeacon,
    });

    try {
      const client = new Arcmind({ token: "test-token" });
      client.track("pending_event");
      client.destroy();
      expect(sendBeacon).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith(
        "https://collector.arcmind.ai/v1/events",
        expect.objectContaining({ keepalive: true })
      );
    } finally {
      Object.defineProperty(navigator, "sendBeacon", {
        configurable: true,
        value: originalSendBeacon,
      });
    }
  });

  it("warns when keepalive fallback fetch fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(fetch).mockRejectedValueOnce(new Error("network down"));
    const sendBeacon = vi.fn().mockReturnValue(false);
    const originalSendBeacon = navigator.sendBeacon;
    Object.defineProperty(navigator, "sendBeacon", {
      configurable: true,
      value: sendBeacon,
    });

    try {
      const client = new Arcmind({ token: "test-token" });
      client.track("pending_event");
      client.destroy();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(warn.mock.calls.map((args) => args[0])).toContain(
        "[arcmind] keepalive flush failed: network down"
      );
    } finally {
      Object.defineProperty(navigator, "sendBeacon", {
        configurable: true,
        value: originalSendBeacon,
      });
    }
  });

  it("no-ops all methods after destroy()", async () => {
    const client = new Arcmind({ token: "test-token" });
    client.destroy();
    client.track("after_destroy");
    client.identify("user-456");
    await client.flush();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retries on 429 rate limiting", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(fetch).mockResolvedValue(
        new Response("Too Many Requests", { status: 429 })
      );
      const client = new Arcmind({ token: "test-token" });
      client.track("test");
      const p = client.flush().catch(() => {});
      await vi.runAllTimersAsync();
      await p;
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(client.pendingCount).toBe(1);
      client.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends fetch with AbortController signal", async () => {
    const client = new Arcmind({ token: "test-token" });
    client.track("test");
    await client.flush();
    const callArgs = vi.mocked(fetch).mock.calls[0];
    expect(callArgs[1]).toHaveProperty("signal");
    expect(callArgs[1]!.signal).toBeInstanceOf(AbortSignal);
    client.destroy();
  });
});
