import { describe, expect, it } from "vitest";
import {
  appendStreamingTextDelta,
  clearAllStreamingTextBuffers,
  completeStreamingTextWithFinalBody,
  flushStreamingTextBuffer,
  waitForStreamingTextDrained,
  type StreamingTextBuffer,
  type StreamingTextBufferScheduler
} from "./typewriter-stream";

function createStreamingTextBufferScheduler(): StreamingTextBufferScheduler & {
  callbacks: Map<number, () => void>;
  cleared: number[];
} {
  let nextTimer = 1;
  const callbacks = new Map<number, () => void>();
  const cleared: number[] = [];
  return {
    callbacks,
    cleared,
    setInterval(callback) {
      const timer = nextTimer++;
      callbacks.set(timer, callback);
      return timer;
    },
    clearInterval(timer) {
      cleared.push(timer);
      callbacks.delete(timer);
    }
  };
}

describe("typewriter-stream", () => {
  it("queues large text instead of showing it immediately", () => {
    const scheduler = createStreamingTextBufferScheduler();
    const buffers: Record<string, StreamingTextBuffer> = {};
    const updates: string[] = [];

    appendStreamingTextDelta({
      buffers,
      bufferKey: "message-1",
      text: "A".repeat(80),
      scheduler,
      setVisible: (_bufferKey, visible) => updates.push(visible)
    });

    expect(updates).toEqual([]);
    expect(buffers["message-1"]).toMatchObject({ visible: "", queued: "A".repeat(80) });
  });

  it("reveals only one character per tick", () => {
    const scheduler = createStreamingTextBufferScheduler();
    const buffers: Record<string, StreamingTextBuffer> = {};
    const updates: string[] = [];

    appendStreamingTextDelta({
      buffers,
      bufferKey: "message-1",
      text: "ABC",
      scheduler,
      setVisible: (_bufferKey, visible) => updates.push(visible)
    });

    scheduler.callbacks.get(1)?.();
    expect(updates.at(-1)).toBe("A");
    scheduler.callbacks.get(1)?.();
    expect(updates.at(-1)).toBe("AB");
    scheduler.callbacks.get(1)?.();
    expect(updates.at(-1)).toBe("ABC");
  });

  it("queues replacement text instead of dumping it all at once", () => {
    const scheduler = createStreamingTextBufferScheduler();
    const buffers: Record<string, StreamingTextBuffer> = {};
    const updates: string[] = [];

    appendStreamingTextDelta({
      buffers,
      bufferKey: "message-1",
      text: "initial body",
      scheduler,
      setVisible: (_bufferKey, visible) => updates.push(visible)
    });
    scheduler.callbacks.get(1)?.();

    appendStreamingTextDelta({
      buffers,
      bufferKey: "message-1",
      text: "replacement",
      replace: true,
      scheduler,
      setVisible: (_bufferKey, visible) => updates.push(visible)
    });

    expect(updates.at(-1)).toBe("");
    expect(buffers["message-1"]).toMatchObject({ visible: "", queued: "replacement" });
    expect(scheduler.cleared).toContain(1);
    scheduler.callbacks.get(2)?.();
    expect(updates.at(-1)).toBe("r");
  });

  it("queues final body instead of flushing it immediately", () => {
    const scheduler = createStreamingTextBufferScheduler();
    const buffers: Record<string, StreamingTextBuffer> = {};
    const updates: string[] = [];

    appendStreamingTextDelta({
      buffers,
      bufferKey: "message-1",
      text: "Hel",
      scheduler,
      setVisible: (_bufferKey, visible) => updates.push(visible)
    });
    scheduler.callbacks.get(1)?.();

    completeStreamingTextWithFinalBody({
      buffers,
      bufferKey: "message-1",
      finalBody: "Hello",
      scheduler,
      setVisible: (_bufferKey, visible) => updates.push(visible)
    });

    expect(updates.at(-1)).toBe("H");
    expect(buffers["message-1"]).toMatchObject({ visible: "H", queued: "ello" });
  });

  it("waits for the full queued body before resolving drain", async () => {
    const scheduler = createStreamingTextBufferScheduler();
    const buffers: Record<string, StreamingTextBuffer> = {};
    const updates: string[] = [];

    completeStreamingTextWithFinalBody({
      buffers,
      bufferKey: "message-1",
      finalBody: "Done",
      scheduler,
      setVisible: (_bufferKey, visible) => updates.push(visible)
    });

    const drained = waitForStreamingTextDrained({
      buffers,
      bufferKey: "message-1",
      scheduler,
      setVisible: (_bufferKey, visible) => updates.push(visible)
    });
    scheduler.callbacks.get(1)?.();
    scheduler.callbacks.get(1)?.();
    scheduler.callbacks.get(1)?.();
    scheduler.callbacks.get(1)?.();

    await expect(drained).resolves.toBe("Done");
    expect(updates.at(-1)).toBe("Done");
  });

  it("does not split Chinese characters while draining", () => {
    const scheduler = createStreamingTextBufferScheduler();
    const buffers: Record<string, StreamingTextBuffer> = {};
    const updates: string[] = [];

    appendStreamingTextDelta({
      buffers,
      bufferKey: "message-1",
      text: "正在思考",
      scheduler,
      setVisible: (_bufferKey, visible) => updates.push(visible)
    });

    scheduler.callbacks.get(1)?.();
    scheduler.callbacks.get(1)?.();

    expect(updates).toEqual(["正", "正在"]);
    expect(buffers["message-1"]?.queued).toBe("思考");
  });

  it("clears all timers when buffers are discarded", () => {
    const scheduler = createStreamingTextBufferScheduler();
    const buffers: Record<string, StreamingTextBuffer> = {};

    appendStreamingTextDelta({
      buffers,
      bufferKey: "message-1",
      text: "A",
      scheduler,
      setVisible: () => undefined
    });
    appendStreamingTextDelta({
      buffers,
      bufferKey: "message-2",
      text: "B",
      scheduler,
      setVisible: () => undefined
    });

    clearAllStreamingTextBuffers(buffers, scheduler);

    expect(buffers).toEqual({});
    expect(scheduler.cleared).toEqual(expect.arrayContaining([1, 2]));
  });

  it("flushes only when explicitly requested", () => {
    const scheduler = createStreamingTextBufferScheduler();
    const buffers: Record<string, StreamingTextBuffer> = {};

    appendStreamingTextDelta({
      buffers,
      bufferKey: "message-1",
      text: "ABC",
      scheduler,
      setVisible: () => undefined
    });

    expect(flushStreamingTextBuffer({ buffers, bufferKey: "message-1", scheduler })).toBe("ABC");
    expect(buffers["message-1"]?.queued).toBe("");
  });
});
