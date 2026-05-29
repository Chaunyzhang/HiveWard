import type { AgentTaskResult, RuntimeExecutionStatus, RuntimeUsageFact, WaitForAgentTaskInput } from "@hiveward/shared";
import type { AgentSdkTaskRecord } from "./types";

export class AgentSdkTaskRegistry {
  private readonly records = new Map<string, AgentSdkTaskRecord>();
  private activeTasks = 0;
  private readonly queuedTasks: Array<() => void> = [];

  constructor(private readonly maxConcurrency: number) {}

  register(record: AgentSdkTaskRecord): void {
    this.records.set(record.taskId, record);
  }

  waitForTask(input: WaitForAgentTaskInput): Promise<AgentTaskResult> {
    const record = this.records.get(input.taskId);
    if (!record) {
      throw new Error(`SDK task not found: ${input.taskId}`);
    }

    return record.final.finally(() => {
      if (record.timeout) clearTimeout(record.timeout);
      this.records.delete(input.taskId);
    });
  }

  async cancelTask(input: WaitForAgentTaskInput): Promise<AgentTaskResult> {
    const record = this.records.get(input.taskId);
    if (!record) {
      throw new Error(`SDK task not found: ${input.taskId}`);
    }

    record.abortController.abort("cancelled");
    return this.waitForTask(input);
  }

  runWithConcurrency<T>(task: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const run = () => {
        this.activeTasks += 1;
        task()
          .then(resolve, reject)
          .finally(() => {
            this.activeTasks -= 1;
            this.queuedTasks.shift()?.();
          });
      };

      if (this.activeTasks < this.maxConcurrency) {
        run();
      } else {
        this.queuedTasks.push(run);
      }
    });
  }
}

export function createTerminalTaskResult({
  taskId,
  runId,
  sessionKey,
  source,
  status,
  error,
  output,
  usage,
  updatedAt = new Date().toISOString()
}: {
  taskId: string;
  runId: string;
  sessionKey: string;
  source: AgentTaskResult["source"];
  status: RuntimeExecutionStatus;
  error?: string;
  output?: string;
  usage?: RuntimeUsageFact;
  updatedAt?: string;
}): AgentTaskResult {
  return {
    taskId,
    runId,
    sessionKey,
    source,
    status,
    error,
    output,
    usage,
    updatedAt
  };
}
