import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { OpenClawConfigStore } from "./openClawConfigStore";

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

describe("OpenClawConfigStore", () => {
  it("resolves staged OpenClaw CLI installs under the global npm root", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hiveward-openclaw-config-"));
    const binDir = join(dir, "bin");
    const globalRoot = join(dir, "global", "node_modules");
    const stagedDir = join(globalRoot, ".openclaw-stage");
    const previousPath = process.env.PATH;
    const previousAppData = process.env.APPDATA;
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const previousCliEntry = process.env.OPENCLAW_CLI_ENTRY;
    mkdirSync(binDir, { recursive: true });
    mkdirSync(stagedDir, { recursive: true });
    writeFakeNpmExecutable(join(binDir, "npm"), globalRoot);
    writeFileSync(join(stagedDir, "openclaw.mjs"), [
      "process.stdout.write('OpenClaw 2026.5.20\\n');"
    ].join("\n"));
    chmodSync(join(stagedDir, "openclaw.mjs"), 0o755);
    process.env.PATH = `${binDir}${delimiter}${previousPath ?? ""}`;
    process.env.APPDATA = join(dir, "appdata");
    process.env.OPENCLAW_STATE_DIR = join(dir, "state");
    delete process.env.OPENCLAW_CLI_ENTRY;

    try {
      const version = await new OpenClawConfigStore(join(dir, "openclaw.json")).getVersion();
      expect(version.error).toBeUndefined();
      expect(version.version).toBe("2026.5.20");
    } finally {
      restoreEnv("PATH", previousPath);
      restoreEnv("APPDATA", previousAppData);
      restoreEnv("OPENCLAW_STATE_DIR", previousStateDir);
      restoreEnv("OPENCLAW_CLI_ENTRY", previousCliEntry);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function writeFakeNpmExecutable(path: string, globalRoot: string): void {
  if (process.platform === "win32") {
    writeFileSync(`${path}.cmd`, [
      "@echo off",
      "if \"%1\"==\"root\" if \"%2\"==\"-g\" (",
      `  echo ${globalRoot}`,
      "  exit /b 0",
      ")",
      "exit /b 1"
    ].join("\r\n"), "utf8");
    return;
  }
  writeFileSync(path, [
    "#!/bin/sh",
    "if [ \"$1\" = \"root\" ] && [ \"$2\" = \"-g\" ]; then",
    `  printf '%s\\n' '${globalRoot}'`,
    "  exit 0",
    "fi",
    "exit 1"
  ].join("\n"));
  chmodSync(path, 0o755);
}
