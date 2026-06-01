export type StreamingTextBuffer = {
  visible: string;
  queued: string;
  timer?: number;
  drainResolvers?: Array<(visible: string) => void>;
};

export type StreamingTextBufferScheduler = {
  setInterval: (callback: () => void, delayMs: number) => number;
  clearInterval: (timer: number) => void;
};

export const streamingTextTickMs = 12;

export function streamingTextChunkSize(queuedLength: number): number {
  return queuedLength > 0 ? 1 : 0;
}

export function drainStreamingTextBufferTick(buffer: StreamingTextBuffer): string | undefined {
  if (!buffer.queued) return undefined;
  const chunkSize = Math.min(Array.from(buffer.queued).length, streamingTextChunkSize(buffer.queued.length));
  const [nextChunk, rest] = takeStreamingTextChars(buffer.queued, chunkSize);
  buffer.visible = `${buffer.visible}${nextChunk}`;
  buffer.queued = rest;
  return buffer.visible;
}

export function appendStreamingTextDelta(input: {
  buffers: Record<string, StreamingTextBuffer>;
  bufferKey: string;
  text: string;
  replace?: boolean;
  scheduler: StreamingTextBufferScheduler;
  setVisible: (bufferKey: string, visible: string) => void;
}): string {
  const buffer = input.buffers[input.bufferKey] ?? { visible: "", queued: "" };
  input.buffers[input.bufferKey] = buffer;

  if (input.replace) {
    if (buffer.timer !== undefined) {
      input.scheduler.clearInterval(buffer.timer);
      buffer.timer = undefined;
    }
    buffer.visible = "";
    buffer.queued = input.text;
    input.setVisible(input.bufferKey, buffer.visible);
    ensureStreamingTextTimer(input.buffers, input.bufferKey, input.scheduler, input.setVisible);
    return buffer.visible;
  }

  buffer.queued = `${buffer.queued}${input.text}`;
  ensureStreamingTextTimer(input.buffers, input.bufferKey, input.scheduler, input.setVisible);
  return buffer.visible;
}

export function completeStreamingTextWithFinalBody(input: {
  buffers: Record<string, StreamingTextBuffer>;
  bufferKey: string;
  finalBody: string;
  scheduler: StreamingTextBufferScheduler;
  setVisible: (bufferKey: string, visible: string) => void;
}): string {
  const buffer = input.buffers[input.bufferKey] ?? { visible: "", queued: "" };
  input.buffers[input.bufferKey] = buffer;

  const pendingBody = `${buffer.visible}${buffer.queued}`;
  if (input.finalBody.startsWith(pendingBody)) {
    buffer.queued = `${buffer.queued}${input.finalBody.slice(pendingBody.length)}`;
  } else if (input.finalBody.startsWith(buffer.visible)) {
    buffer.queued = input.finalBody.slice(buffer.visible.length);
  } else {
    buffer.visible = "";
    buffer.queued = input.finalBody;
    input.setVisible(input.bufferKey, buffer.visible);
  }

  ensureStreamingTextTimer(input.buffers, input.bufferKey, input.scheduler, input.setVisible);
  if (!buffer.queued) resolveStreamingTextDrained(buffer);
  return buffer.visible;
}

export function flushStreamingTextBuffer(input: {
  buffers: Record<string, StreamingTextBuffer>;
  bufferKey: string;
  scheduler: StreamingTextBufferScheduler;
  setVisible?: (bufferKey: string, visible: string) => void;
  finalBody?: string;
}): string {
  const buffer = input.buffers[input.bufferKey];
  if (!buffer) {
    if (input.finalBody !== undefined) {
      input.setVisible?.(input.bufferKey, input.finalBody);
      return input.finalBody;
    }
    return "";
  }

  if (buffer.timer !== undefined) {
    input.scheduler.clearInterval(buffer.timer);
    buffer.timer = undefined;
  }

  buffer.visible = input.finalBody ?? `${buffer.visible}${buffer.queued}`;
  buffer.queued = "";
  input.setVisible?.(input.bufferKey, buffer.visible);
  resolveStreamingTextDrained(buffer);
  return buffer.visible;
}

export function waitForStreamingTextDrained(input: {
  buffers: Record<string, StreamingTextBuffer>;
  bufferKey: string;
  scheduler: StreamingTextBufferScheduler;
  setVisible: (bufferKey: string, visible: string) => void;
}): Promise<string> {
  const buffer = input.buffers[input.bufferKey];
  if (!buffer) return Promise.resolve("");
  if (!buffer.queued) return Promise.resolve(buffer.visible);
  ensureStreamingTextTimer(input.buffers, input.bufferKey, input.scheduler, input.setVisible);
  return new Promise((resolve) => {
    buffer.drainResolvers = [...(buffer.drainResolvers ?? []), resolve];
  });
}

export function clearStreamingTextBuffer(
  buffers: Record<string, StreamingTextBuffer>,
  bufferKey: string,
  scheduler: StreamingTextBufferScheduler
): void {
  const buffer = buffers[bufferKey];
  if (buffer?.timer !== undefined) {
    scheduler.clearInterval(buffer.timer);
  }
  delete buffers[bufferKey];
}

export function clearAllStreamingTextBuffers(
  buffers: Record<string, StreamingTextBuffer>,
  scheduler: StreamingTextBufferScheduler
): void {
  for (const bufferKey of Object.keys(buffers)) {
    clearStreamingTextBuffer(buffers, bufferKey, scheduler);
  }
}

function ensureStreamingTextTimer(
  buffers: Record<string, StreamingTextBuffer>,
  bufferKey: string,
  scheduler: StreamingTextBufferScheduler,
  setVisible: (bufferKey: string, visible: string) => void
): void {
  const buffer = buffers[bufferKey];
  if (!buffer || buffer.timer !== undefined) return;

  const timer = scheduler.setInterval(() => {
    const current = buffers[bufferKey];
    if (!current) {
      scheduler.clearInterval(timer);
      return;
    }
    const visible = drainStreamingTextBufferTick(current);
    if (visible !== undefined) {
      setVisible(bufferKey, visible);
    }
    if (!current.queued) {
      scheduler.clearInterval(timer);
      if (current.timer === timer) {
        current.timer = undefined;
      }
      resolveStreamingTextDrained(current);
    }
  }, streamingTextTickMs);
  buffer.timer = timer;
}

function takeStreamingTextChars(value: string, count: number): [string, string] {
  if (count <= 0) return ["", value];
  const chars = Array.from(value);
  return [chars.slice(0, count).join(""), chars.slice(count).join("")];
}

function resolveStreamingTextDrained(buffer: StreamingTextBuffer): void {
  if (!buffer.drainResolvers?.length) return;
  const resolvers = buffer.drainResolvers;
  buffer.drainResolvers = undefined;
  for (const resolve of resolvers) {
    resolve(buffer.visible);
  }
}
