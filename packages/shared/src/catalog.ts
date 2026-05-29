import type { RuntimeAgent, RuntimeChannel, RuntimeModel, RuntimeTool } from "./runtime";

export interface CatalogSnapshot {
  id: string;
  source: "openclaw";
  sourceUpdatedAt: string;
  refreshedAt: string;
  staleAfter: string;
  models: RuntimeModel[];
  agents: RuntimeAgent[];
  tools: RuntimeTool[];
  channels: RuntimeChannel[];
}

export function isCatalogStale(snapshot: CatalogSnapshot, now = new Date()): boolean {
  return new Date(snapshot.staleAfter).getTime() <= now.getTime();
}
