import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import { createRuntimeAdapter } from "@hiveward/adapter";
import { createApiRouter } from "./routes/apiRouter";
import { createHivewardStore } from "./store/createHivewardStore";
import { OpenClawConfigStore } from "./store/openClawConfigStore";
import { BlueprintWorker } from "./worker/blueprintWorker";

export async function createHivewardApiApp(): Promise<ReturnType<typeof express>> {
  const store = await createHivewardStore();
  await store.init();

  const openClawConfigStore = new OpenClawConfigStore();
  const adapter = createRuntimeAdapter({ sdkWorkspaceRoot: projectRoot() });
  const worker = new BlueprintWorker(store, adapter);

  const app = express();
  app.use(cors({ origin: true }));
  app.use(express.json({ limit: "2mb" }));
  app.use(createApiRouter({ store, openClawConfigStore, adapter, worker }));
  // Serve built web frontend (production only — dist is populated by Docker build)
  const webDistDir = resolve(projectRoot(), "apps/web/dist");
  app.use(express.static(webDistDir));

  // SPA fallback: serve index.html for client-side routing (non-API GET only)
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.url.startsWith("/api/")) {
      next();
      return;
    }
    res.sendFile(resolve(webDistDir, "index.html"), (err) => {
      if (err) next(err);
    });
  });
  app.use(apiNotFoundHandler);
  app.use(errorHandler);
  await worker.resumeActiveRuns();
  return app;
}

const apiNotFoundHandler: express.RequestHandler = (req, res, next) => {
  const url = req.url ?? "";
  if (!url.startsWith("/api/") && url !== "/healthz" && url !== "/readyz") {
    next();
    return;
  }
  res.status(404).json({
    error: {
      code: "not_found",
      message: "API route not found."
    }
  });
};

const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  const message = error instanceof Error ? error.message : "Unexpected API failure.";
  const statusCode = readErrorStatusCode(error);
  const code = readErrorCode(error) ?? (statusCode === 409 ? "conflict" : "internal_error");
  res.status(statusCode).json({
    error: {
      code,
      message
    }
  });
};

function readErrorStatusCode(error: unknown): number {
  if (typeof error === "object" && error !== null && "statusCode" in error) {
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === "number" && Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 600) {
      return statusCode;
    }
  }
  return 500;
}

function readErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.trim()) return code;
  }
  return undefined;
}

function projectRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
}
