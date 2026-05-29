import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BlueprintDefinition, BlueprintNode, BlueprintNodeRun } from "@hiveward/shared";
import { createBlankBlueprint } from "@hiveward/shared";
import { FileHivewardStore } from "./fileHivewardStore";

describe("FileHivewardStore blueprint node sanitization", () => {
  it("strips removed standalone nodes from saved blueprints and run archives", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hiveward-store-"));
    const store = new FileHivewardStore(join(dir, "hiveward-store.json"));
    await store.init();

    const dirtyBlueprint = createDirtyBlueprint(new Date().toISOString());
    const saved = await store.saveBlueprint(dirtyBlueprint);

    expect(saved.nodes.map((node) => node.type)).toEqual(["agent"]);
    expect(saved.edges).toEqual([]);
    await expect(store.getBlueprint(dirtyBlueprint.id)).resolves.toMatchObject({
      nodes: [{ id: "draft", type: "agent" }],
      edges: []
    });

    const run = await store.createBlueprintRun(dirtyBlueprint, "tester");
    await store.upsertNodeRun(createNodeRun(run.id, dirtyBlueprint.id, "draft", "agent", "succeeded"));
    await store.upsertNodeRun(createNodeRun(run.id, dirtyBlueprint.id, "approval", "approval", "waiting_approval"));
    await store.appendEvent({
      id: "event-approval",
      blueprintRunId: run.id,
      nodeRunId: "node-run-approval",
      type: "node.run.waiting_approval",
      message: "Old approval node waiting.",
      createdAt: new Date().toISOString()
    });

    await expect(store.listNodeRuns(run.id)).resolves.toMatchObject([
      { nodeId: "draft", nodeType: "agent" }
    ]);
    await expect(store.listPendingApprovals()).resolves.toEqual([]);
    await expect(store.getRunView(run.id)).resolves.toMatchObject({
      nodeRuns: [{ nodeId: "draft", nodeType: "agent" }],
      events: []
    });
    await expect(store.listRunArchives()).resolves.toMatchObject([
      {
        blueprintSnapshot: {
          nodes: [{ id: "draft", type: "agent" }],
          edges: []
        },
        nodeRuns: [{ nodeId: "draft", nodeType: "agent" }]
      }
    ]);
  });

  it("normalizes legacy OpenClaw refs into runtime refs when reading run archives", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hiveward-store-"));
    const storePath = join(dir, "hiveward-store.json");
    const store = new FileHivewardStore(storePath);
    await store.init();

    const now = new Date().toISOString();
    const blueprint = await store.saveBlueprint(createDirtyBlueprint(now));
    const run = await store.createBlueprintRun(blueprint, "tester");
    const legacyRuntimeRef = {
      source: "codex",
      sourceId: "codex-task-1",
      sourceUpdatedAt: now,
      taskId: "codex-task-1",
      runId: "codex-run-1",
      sessionKey: "codex-session-1"
    };
    const archivePath = join(dir, "runs", `${run.id}.json`);
    const archive = JSON.parse(readFileSync(archivePath, "utf8")) as {
      run: Record<string, unknown>;
      nodeRuns: Array<Record<string, unknown>>;
      events: Array<Record<string, unknown>>;
    };
    delete archive.run.runtimeRefs;
    delete archive.run.openclawRefs;
    archive.nodeRuns = [
      {
        ...createNodeRun(run.id, blueprint.id, "draft", "agent", "succeeded"),
        openclawRef: legacyRuntimeRef
      }
    ];
    archive.events = [
      {
        id: "event-draft",
        blueprintRunId: run.id,
        nodeRunId: "node-run-draft",
        type: "node.run.completed",
        message: "Draft completed.",
        createdAt: now,
        openclawRef: legacyRuntimeRef
      }
    ];
    writeFileSync(archivePath, JSON.stringify(archive, null, 2));

    const view = await store.getRunView(run.id);

    expect(view?.run.runtimeRefs).toEqual([expect.objectContaining({ source: "codex", runId: "codex-run-1" })]);
    expect(view?.run).not.toHaveProperty("openclawRefs");
    expect(view?.nodeRuns[0]?.runtimeRef).toMatchObject({ source: "codex", sessionKey: "codex-session-1" });
    expect(view?.nodeRuns[0]).not.toHaveProperty("openclawRef");
    expect(view?.events[0]?.runtimeRef).toMatchObject({ source: "codex", taskId: "codex-task-1" });
    expect(view?.events[0]).not.toHaveProperty("openclawRef");
  });
});

describe("FileHivewardStore blueprint workspaces", () => {
  it("creates a local bundle skeleton for new blueprints", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hiveward-store-"));
    const storePath = join(dir, "hiveward-store.json");
    const store = new FileHivewardStore(storePath);
    await store.init();

    const blueprint = await store.createBlueprint({
      name: "Skill Decomposer Blueprint",
      description: "Use when decomposing a supplied skill into a governed proposal."
    });
    const workspacePath = join(dir, "blueprint-workspaces", blueprint.id);

    expect(store.getBlueprintWorkspacePath(blueprint.id)).toBe(workspacePath);
    expect(existsSync(join(workspacePath, "BLUEPRINT.md"))).toBe(true);
    expect(existsSync(join(workspacePath, "manifest.json"))).toBe(true);
    expect(existsSync(join(workspacePath, "blueprints", `${blueprint.id}.json`))).toBe(true);
    for (const folder of ["skills", "mcp", "scripts", "artifacts", "tmp"]) {
      expect(existsSync(join(workspacePath, folder))).toBe(true);
    }

    const blueprintEntry = readFileSync(join(workspacePath, "BLUEPRINT.md"), "utf8");
    expect(blueprintEntry).toContain("name: skill-decomposer-blueprint");
    expect(blueprintEntry).toContain(`primaryBlueprintId: ${blueprint.id}`);

    const manifest = JSON.parse(readFileSync(join(workspacePath, "manifest.json"), "utf8")) as {
      schema?: string;
      kind?: string;
      primaryBlueprintId?: string;
      description?: string;
      inputs?: unknown[];
      outputs?: unknown[];
      runModes?: string[];
      requiredResources?: { skills?: unknown[]; scripts?: unknown[]; mcp?: unknown[] };
    };
    expect(manifest).toMatchObject({
      schema: "hiveward.blueprint-bundle/v1",
      kind: "blueprint_exposure",
      primaryBlueprintId: blueprint.id,
      description: "Use when decomposing a supplied skill into a governed proposal.",
      runModes: ["draft", "approval_required"],
      requiredResources: {
        skills: [],
        scripts: [],
        mcp: []
      }
    });
    expect(Array.isArray(manifest.inputs)).toBe(true);
    expect(Array.isArray(manifest.outputs)).toBe(true);

    const mirroredBlueprint = JSON.parse(readFileSync(join(workspacePath, "blueprints", `${blueprint.id}.json`), "utf8")) as {
      id?: string;
      name?: string;
    };
    expect(mirroredBlueprint).toMatchObject({
      id: blueprint.id,
      name: "Skill Decomposer Blueprint"
    });
  });

  it("creates bundle skeletons for imported blueprints without changing JSON-only package behavior", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hiveward-store-"));
    const store = new FileHivewardStore(join(dir, "hiveward-store.json"));
    await store.init();

    const imported = await store.importBlueprintPackage({
      schema: "hiveward.blueprint-package/v1",
      exportedAt: "2026-05-27T00:00:00.000Z",
      blueprints: [
        {
          id: "portable-skill-decomposer",
          name: "Portable Skill Decomposer",
          description: "Use when importing a decomposer-generated blueprint package.",
          version: 1,
          nodes: [],
          edges: [],
          variables: {},
          display: {}
        }
      ]
    });
    const blueprint = imported[0]!;
    const workspacePath = join(dir, "blueprint-workspaces", blueprint.id);

    expect(existsSync(join(workspacePath, "manifest.json"))).toBe(true);
    expect(existsSync(join(workspacePath, "blueprints", `${blueprint.id}.json`))).toBe(true);
    await expect(store.getBlueprint(blueprint.id)).resolves.toMatchObject({
      id: blueprint.id,
      name: "Portable Skill Decomposer"
    });
  });

  it("stores blueprint-owned skill source snapshots with hashes and script inventory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hiveward-store-"));
    const store = new FileHivewardStore(join(dir, "hiveward-store.json"));
    await store.init();
    const blueprint = await store.createBlueprint({ name: "Script Backed Blueprint" });

    const snapshot = await store.storeBlueprintSkillSource({
      blueprintId: blueprint.id,
      sourcePath: join(process.cwd(), "fixtures", "skill-packages", "script-backed-skill"),
      sourceLabel: "script-backed-skill",
      skillIr: createValidSkillIr("script-backed-skill")
    });

    expect(snapshot.skillSourceId).toMatch(/^skill-src-/);
    expect(snapshot.workingDirectory).toBe(join(dir, "blueprint-workspaces", blueprint.id, "skills", snapshot.skillSourceId));
    expect(snapshot.sourceCompleteness).toBe("full_package");
    expect(snapshot.scriptInventory).toMatchObject([
      {
        path: "scripts/generate.mjs",
        runtime: "node",
        shouldExecuteByDefault: false
      }
    ]);
    expect(existsSync(join(snapshot.workingDirectory, "SKILL.md"))).toBe(true);
    expect(existsSync(join(snapshot.workingDirectory, "references", "contract.md"))).toBe(true);
    expect(existsSync(join(snapshot.workingDirectory, "scripts", "generate.mjs"))).toBe(true);
    expect(existsSync(join(snapshot.workingDirectory, "assets", "template.txt"))).toBe(true);

    const sourceMetadata = JSON.parse(readFileSync(join(snapshot.workingDirectory, "hiveward-skill-source.json"), "utf8")) as {
      schema?: string;
      capturedFiles?: string[];
      fileHashes?: Record<string, string>;
      scriptInventory?: Array<{ path: string; runtime: string }>;
    };
    expect(sourceMetadata.schema).toBe("hiveward.skill-source/v1");
    expect(sourceMetadata.capturedFiles).toEqual(expect.arrayContaining([
      "SKILL.md",
      "references/contract.md",
      "scripts/generate.mjs",
      "assets/template.txt"
    ]));
    expect(sourceMetadata.fileHashes?.["scripts/generate.mjs"]).toMatch(/^[a-f0-9]{64}$/);
    expect(sourceMetadata.scriptInventory).toMatchObject([{ path: "scripts/generate.mjs", runtime: "node" }]);

    const storedIr = JSON.parse(readFileSync(join(snapshot.workingDirectory, "skill-ir.json"), "utf8")) as { schema?: string };
    expect(storedIr.schema).toBe("hiveward.skill-ir/v1");

    const manifest = JSON.parse(readFileSync(join(dir, "blueprint-workspaces", blueprint.id, "manifest.json"), "utf8")) as {
      requiredResources?: { skills?: string[]; scripts?: string[] };
    };
    expect(manifest.requiredResources?.skills).toContain(snapshot.skillSourceId);
    expect(manifest.requiredResources?.scripts).toContain(`${snapshot.skillSourceId}/scripts/generate.mjs`);
  });

  it("rejects skill IR script references that escape the blueprint skill source snapshot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hiveward-store-"));
    const store = new FileHivewardStore(join(dir, "hiveward-store.json"));
    await store.init();
    const blueprint = await store.createBlueprint({ name: "Boundary Blueprint" });

    await expect(store.storeBlueprintSkillSource({
      blueprintId: blueprint.id,
      sourcePath: join(process.cwd(), "fixtures", "skill-packages", "markdown-only-skill.md"),
      sourceLabel: "unsafe",
      skillIr: {
        ...createValidSkillIr("unsafe"),
        scripts: [
          {
            path: "../escape.sh",
            runtime: "bash",
            purpose: "Escape workspace.",
            expectedInputs: [],
            expectedOutputs: [],
            sideEffects: ["writes outside workspace"],
            requiredPermissions: ["workspace_write"],
            shouldExecuteByDefault: false
          }
        ]
      }
    })).rejects.toThrow("outside the blueprint skill source workspace");
  });

  it("rejects skill package snapshots that contain symbolic links", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hiveward-store-"));
    const store = new FileHivewardStore(join(dir, "hiveward-store.json"));
    await store.init();
    const blueprint = await store.createBlueprint({ name: "Symlink Boundary Blueprint" });
    const outsideDir = join(dir, "outside-source");
    const skillDir = join(dir, "malicious-skill");
    mkdirSync(join(skillDir, "scripts"), { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), [
      "---",
      "name: malicious-skill",
      "description: Use when testing symlink rejection.",
      "---",
      "",
      "# Malicious Skill",
      ""
    ].join("\n"));
    writeFileSync(join(outsideDir, "external.mjs"), "export const leaked = true;\n");
    symlinkSync(join(outsideDir, "external.mjs"), join(skillDir, "scripts", "external.mjs"));

    await expect(store.storeBlueprintSkillSource({
      blueprintId: blueprint.id,
      sourcePath: skillDir,
      sourceLabel: "malicious-skill",
      skillIr: createValidSkillIr("malicious-skill")
    })).rejects.toThrow("symbolic links");
  });

  it("preserves blueprint-owned skill source references when the blueprint is saved later", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hiveward-store-"));
    const store = new FileHivewardStore(join(dir, "hiveward-store.json"));
    await store.init();
    const blueprint = await store.createBlueprint({ name: "Persistent Skill Source Blueprint" });
    const snapshot = await store.storeBlueprintSkillSource({
      blueprintId: blueprint.id,
      sourcePath: join(process.cwd(), "fixtures", "skill-packages", "script-backed-skill"),
      sourceLabel: "script-backed-skill",
      skillIr: createValidSkillIr("script-backed-skill")
    });

    await store.saveBlueprint({
      ...blueprint,
      description: "Updated description after source capture."
    });

    const manifest = JSON.parse(readFileSync(join(dir, "blueprint-workspaces", blueprint.id, "manifest.json"), "utf8")) as {
      description?: string;
      requiredResources?: { skills?: string[]; scripts?: string[] };
      skillSources?: Array<{ skillSourceId?: string }>;
    };
    expect(manifest.description).toBe("Updated description after source capture.");
    expect(manifest.requiredResources?.skills).toContain(snapshot.skillSourceId);
    expect(manifest.requiredResources?.scripts).toContain(`${snapshot.skillSourceId}/scripts/generate.mjs`);
    expect(manifest.skillSources?.map((item) => item.skillSourceId)).toContain(snapshot.skillSourceId);
  });

  it("preserves custom blueprint exposure metadata when the blueprint is saved later", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hiveward-store-"));
    const store = new FileHivewardStore(join(dir, "hiveward-store.json"));
    await store.init();
    const blueprint = await store.createBlueprint({
      name: "Exposure Blueprint",
      description: "Initial generated description."
    });
    const manifestPath = join(dir, "blueprint-workspaces", blueprint.id, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    writeFileSync(manifestPath, JSON.stringify({
      ...manifest,
      aliases: ["skill-split"],
      intentTags: ["decomposition", "blueprint-generation"],
      triggerPhrases: ["turn this skill into a blueprint"],
      notFor: ["runtime execution"],
      inputs: [{ name: "skillPackage", required: true }],
      outputs: [{ name: "blueprintPackage", required: true }],
      runModes: ["approval_required"],
      permissions: ["read_only", "workspace_write"],
      sideEffects: ["writes blueprint proposal"],
      requiredResources: {
        skills: ["existing-skill"],
        scripts: ["existing-skill/scripts/generate.mjs"],
        mcp: ["filesystem"]
      },
      skillSources: [{ skillSourceId: "existing-skill" }]
    }, null, 2));

    await store.saveBlueprint({
      ...blueprint,
      description: "Updated generated description."
    });

    const savedManifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    expect(savedManifest).toMatchObject({
      description: "Updated generated description.",
      aliases: ["skill-split"],
      intentTags: ["decomposition", "blueprint-generation"],
      triggerPhrases: ["turn this skill into a blueprint"],
      notFor: ["runtime execution"],
      inputs: [{ name: "skillPackage", required: true }],
      outputs: [{ name: "blueprintPackage", required: true }],
      runModes: ["approval_required"],
      permissions: ["read_only", "workspace_write"],
      sideEffects: ["writes blueprint proposal"],
      requiredResources: {
        skills: ["existing-skill"],
        scripts: ["existing-skill/scripts/generate.mjs"],
        mcp: ["filesystem"]
      },
      skillSources: [{ skillSourceId: "existing-skill" }]
    });
  });
});

describe("FileHivewardStore chat storage isolation", () => {
  it("migrates legacy chat fields into a dedicated chat store and cleans the main store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hiveward-store-"));
    const storePath = join(dir, "hiveward-store.json");
    const chatStorePath = join(dir, "hiveward-chat-store.json");
    const now = new Date().toISOString();

    writeFileSync(storePath, JSON.stringify({
      schema: "hiveward.store-index/v1",
      companies: [{
        id: "company-hiveward-studio",
        name: "Hiveward Studio",
        logoLabel: "HW",
        businessGoal: "Keep storage boundaries clean.",
        createdAt: now,
        updatedAt: now
      }],
      selectedCompanyId: "company-hiveward-studio",
      blueprintIndex: [],
      runIndex: [],
      companyDashboards: {},
      roleDirectories: {},
      inboxItems: {},
      chatSessions: [{
        id: "chat-session-legacy",
        companyId: "company-hiveward-studio",
        harnessId: "codex",
        title: "Legacy chat",
        mode: "chat",
        status: "active",
        createdAt: now,
        updatedAt: now
      }],
      chatMessages: {
        "chat-session-legacy": [
          {
            id: "chat-message-user",
            sessionId: "chat-session-legacy",
            role: "user",
            content: "Build the plan.",
            harnessId: "codex",
            status: "sent",
            createdAt: now
          },
          {
            id: "chat-message-assistant",
            sessionId: "chat-session-legacy",
            role: "assistant",
            content: "Plan ready.",
            harnessId: "codex",
            status: "sent",
            createdAt: now
          }
        ]
      }
    }, null, 2));

    const store = new FileHivewardStore(storePath);
    await store.init();

    const mainStore = JSON.parse(readFileSync(storePath, "utf8")) as Record<string, unknown>;
    const chatStore = JSON.parse(readFileSync(chatStorePath, "utf8")) as {
      schema?: string;
      chatSessions?: Array<{ id: string; title: string }>;
      chatMessages?: Record<string, Array<{ id: string; content: string }>>;
    };

    expect(mainStore.chatSessions).toBeUndefined();
    expect(mainStore.chatMessages).toBeUndefined();
    expect(chatStore.schema).toBe("hiveward.chat-store/v1");
    expect(chatStore.chatSessions).toEqual([
      expect.objectContaining({ id: "chat-session-legacy", title: "Legacy chat" })
    ]);
    expect(chatStore.chatMessages?.["chat-session-legacy"]?.map((message) => message.content)).toEqual([
      "Build the plan.",
      "Plan ready."
    ]);
    await expect(store.listChatMessages("chat-session-legacy")).resolves.toHaveLength(2);
  });

  it("drops legacy chat sessions for unknown companies instead of assigning them to the default company", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hiveward-store-"));
    const storePath = join(dir, "hiveward-store.json");
    const chatStorePath = join(dir, "hiveward-chat-store.json");
    const now = new Date().toISOString();

    writeFileSync(storePath, JSON.stringify({
      schema: "hiveward.store-index/v1",
      companies: [{
        id: "company-hiveward-studio",
        name: "Hiveward Studio",
        logoLabel: "HW",
        businessGoal: "Keep storage boundaries clean.",
        createdAt: now,
        updatedAt: now
      }],
      selectedCompanyId: "company-hiveward-studio",
      blueprintIndex: [],
      runIndex: [],
      companyDashboards: {},
      roleDirectories: {},
      inboxItems: {},
      chatSessions: [
        {
          id: "chat-session-valid",
          companyId: "company-hiveward-studio",
          harnessId: "codex",
          title: "Valid chat",
          mode: "chat",
          status: "active",
          createdAt: now,
          updatedAt: now
        },
        {
          id: "chat-session-unknown-company",
          companyId: "company-deleted",
          harnessId: "codex",
          title: "Orphaned chat",
          mode: "chat",
          status: "active",
          createdAt: now,
          updatedAt: now
        }
      ],
      chatMessages: {
        "chat-session-valid": [createStoredChatMessage("chat-session-valid", 1, new Date(now))],
        "chat-session-unknown-company": [createStoredChatMessage("chat-session-unknown-company", 2, new Date(now))]
      }
    }, null, 2));

    const store = new FileHivewardStore(storePath);
    await store.init();

    const chatStore = JSON.parse(readFileSync(chatStorePath, "utf8")) as {
      chatSessions?: Array<{ id: string; companyId: string }>;
      chatMessages?: Record<string, Array<{ content: string }>>;
    };

    expect(chatStore.chatSessions).toEqual([
      expect.objectContaining({ id: "chat-session-valid", companyId: "company-hiveward-studio" })
    ]);
    expect(chatStore.chatMessages?.["chat-session-valid"]).toHaveLength(1);
    expect(chatStore.chatMessages?.["chat-session-unknown-company"]).toBeUndefined();
    await expect(store.listChatMessages("chat-session-unknown-company")).resolves.toEqual([]);
  });

  it("keeps chat writes out of the main store file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hiveward-store-"));
    const storePath = join(dir, "hiveward-store.json");
    const chatStorePath = join(dir, "hiveward-chat-store.json");
    const store = new FileHivewardStore(storePath);
    await store.init();

    const session = await store.createChatSession({ harnessId: "codex", title: "Storage boundary" });
    const mainBefore = readFileSync(storePath, "utf8");
    await store.appendChatMessage({
      sessionId: session.id,
      role: "user",
      content: "This should only touch chat storage.",
      harnessId: "codex",
      status: "sent"
    });

    expect(readFileSync(storePath, "utf8")).toBe(mainBefore);
    const chatStore = JSON.parse(readFileSync(chatStorePath, "utf8")) as {
      chatMessages?: Record<string, Array<{ content: string }>>;
    };
    expect(chatStore.chatMessages?.[session.id]?.[0]?.content).toBe("This should only touch chat storage.");
  });

  it("keeps config writes out of the chat store file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hiveward-store-"));
    const storePath = join(dir, "hiveward-store.json");
    const chatStorePath = join(dir, "hiveward-chat-store.json");
    const store = new FileHivewardStore(storePath);
    await store.init();
    await store.createChatSession({ harnessId: "codex", title: "Stable chat file" });
    const chatBefore = readFileSync(chatStorePath, "utf8");

    const now = new Date().toISOString();
    await store.saveBlueprint(createBlankBlueprint({
      id: "config-only-blueprint",
      companyId: "company-hiveward-studio",
      now,
      name: "Config only blueprint"
    }));

    expect(readFileSync(chatStorePath, "utf8")).toBe(chatBefore);
  });

  it("deletes a company's chat records from the dedicated chat store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hiveward-store-"));
    const storePath = join(dir, "hiveward-store.json");
    const chatStorePath = join(dir, "hiveward-chat-store.json");
    const store = new FileHivewardStore(storePath);
    await store.init();

    const created = await store.createCompany({ name: "Disposable Company" });
    const companyId = created.selectedCompanyId!;
    const session = await store.createChatSession({ harnessId: "codex", title: "Disposable chat" });
    await store.appendChatMessage({
      sessionId: session.id,
      role: "user",
      content: "Delete me with the company.",
      harnessId: "codex",
      status: "sent"
    });

    await store.deleteCompany(companyId);

    const chatStore = JSON.parse(readFileSync(chatStorePath, "utf8")) as {
      chatSessions?: Array<{ id: string }>;
      chatMessages?: Record<string, unknown>;
    };
    expect(chatStore.chatSessions?.some((candidate) => candidate.id === session.id)).toBe(false);
    expect(chatStore.chatMessages?.[session.id]).toBeUndefined();
  });

  it("keeps only the newest 60 visible messages per chat session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hiveward-store-"));
    const storePath = join(dir, "hiveward-store.json");
    const store = new FileHivewardStore(storePath);
    await store.init();

    const session = await store.createChatSession({ harnessId: "codex", title: "Retention" });
    for (let index = 1; index <= 65; index += 1) {
      await store.appendChatMessage({
        sessionId: session.id,
        role: "user",
        content: `message ${index}`,
        harnessId: "codex",
        status: "sent"
      });
    }

    const messages = await store.listChatMessages(session.id);
    expect(messages).toHaveLength(60);
    expect(messages[0]?.content).toBe("message 6");
    expect(messages[59]?.content).toBe("message 65");
  });

  it("applies the message retention limit after merging existing and legacy chat stores", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hiveward-store-"));
    const storePath = join(dir, "hiveward-store.json");
    const chatStorePath = join(dir, "hiveward-chat-store.json");
    const now = new Date("2026-05-26T00:00:00.000Z");
    const company = {
      id: "company-hiveward-studio",
      name: "Hiveward Studio",
      logoLabel: "HW",
      businessGoal: "Keep storage boundaries clean.",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    };
    const session = {
      id: "chat-session-merge",
      companyId: company.id,
      harnessId: "codex",
      title: "Merge retention",
      mode: "chat",
      status: "active",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    };

    writeFileSync(chatStorePath, JSON.stringify({
      schema: "hiveward.chat-store/v1",
      chatSessions: [session],
      chatMessages: {
        [session.id]: Array.from({ length: 40 }, (_, index) => createStoredChatMessage(session.id, index + 1, now))
      }
    }, null, 2));
    writeFileSync(storePath, JSON.stringify({
      schema: "hiveward.store-index/v1",
      companies: [company],
      selectedCompanyId: company.id,
      blueprintIndex: [],
      runIndex: [],
      companyDashboards: {},
      roleDirectories: {},
      inboxItems: {},
      chatSessions: [session],
      chatMessages: {
        [session.id]: Array.from({ length: 40 }, (_, index) => createStoredChatMessage(session.id, index + 41, now))
      }
    }, null, 2));

    const store = new FileHivewardStore(storePath);
    await store.init();

    const messages = await store.listChatMessages(session.id);
    const chatStore = JSON.parse(readFileSync(chatStorePath, "utf8")) as {
      chatMessages?: Record<string, Array<{ content: string }>>;
    };
    expect(messages).toHaveLength(60);
    expect(messages[0]?.content).toBe("message 21");
    expect(messages[59]?.content).toBe("message 80");
    expect(chatStore.chatMessages?.[session.id]).toHaveLength(60);
    expect(chatStore.chatMessages?.[session.id]?.[0]?.content).toBe("message 21");
  });
});

function createDirtyBlueprint(now: string): BlueprintDefinition {
  const blueprint = createBlankBlueprint({
    id: "dirty-blueprint",
    companyId: "company-hiveward-studio",
    now,
    name: "Dirty legacy blueprint"
  });
  return {
    ...blueprint,
    nodes: [
      {
        id: "draft",
        type: "agent",
        runtimeId: "openclaw",
        position: { x: 0, y: 0 },
        config: {
          label: "Draft",
          openclawAgentId: "main",
          agentName: "writer",
          prompt: "Write the draft.",
          tools: []
        }
      },
      createRemovedNode("approval", "approval"),
      createRemovedNode("send", "send"),
      createRemovedNode("parallel", "parallel_agents")
    ],
    edges: [
      { id: "edge-draft-approval", source: "draft", target: "approval" },
      { id: "edge-approval-send", source: "approval", target: "send" },
      { id: "edge-send-parallel", source: "send", target: "parallel" }
    ]
  };
}

function createValidSkillIr(name: string) {
  return {
    schema: "hiveward.skill-ir/v1",
    source: {
      kind: "local_path",
      label: name,
      completeness: "full_package",
      sourceFiles: ["SKILL.md"]
    },
    identity: {
      name,
      description: "A fixture skill.",
      triggers: [name]
    },
    classification: {
      primaryType: "process",
      traits: ["script_backed"],
      confidence: "high",
      reasoning: "The fixture has an ordered process and a script asset."
    },
    packageInventory: {
      hasPackageRoot: true,
      hasSkillMd: true,
      references: [],
      scripts: ["scripts/generate.mjs"],
      assets: [],
      metadataFiles: []
    },
    operatingModel: {
      summary: "Inspect, generate, and validate.",
      inputs: ["source file"],
      outputs: ["artifact"],
      requiredTools: ["shell"],
      requiredPermissions: ["read_only"],
      sideEffects: []
    },
    phases: [
      {
        id: "inspect",
        label: "Inspect",
        purpose: "Inspect source material.",
        inputs: ["source file"],
        outputs: ["inventory"],
        tools: [],
        permissions: ["read_only"],
        validation: ["Inventory is complete."],
        dependencies: [],
        difficulty: "simple",
        modelProfile: {
          modelClass: "standard",
          thinkingEffort: "low",
          reason: "Small fixture."
        },
        canRunInParallel: false
      }
    ],
    scripts: [
      {
        path: "scripts/generate.mjs",
        runtime: "node",
        purpose: "Generate an artifact.",
        expectedInputs: ["source file"],
        expectedOutputs: ["artifact"],
        sideEffects: ["writes artifact"],
        requiredPermissions: ["workspace_write"],
        shouldExecuteByDefault: false
      }
    ],
    references: [],
    assets: [],
    risks: [],
    validation: [
      {
        id: "complete",
        description: "Output is valid.",
        appliesToPhaseIds: ["inspect"]
      }
    ],
    unresolved: []
  };
}

function createRemovedNode(id: string, type: string): BlueprintNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    config: {
      label: id
    }
  } as unknown as BlueprintNode;
}

function createNodeRun(
  blueprintRunId: string,
  blueprintId: string,
  nodeId: string,
  nodeType: string,
  status: BlueprintNodeRun["status"]
): BlueprintNodeRun {
  return {
    id: `node-run-${nodeId}`,
    blueprintRunId,
    blueprintId,
    nodeId,
    nodeLabel: nodeId,
    nodeType,
    status,
    queuedAt: new Date().toISOString(),
    ...(status === "succeeded" ? { output: `${nodeId} output` } : {})
  } as unknown as BlueprintNodeRun;
}

function createStoredChatMessage(sessionId: string, index: number, start: Date): {
  id: string;
  sessionId: string;
  role: "user";
  content: string;
  harnessId: "codex";
  status: "sent";
  createdAt: string;
} {
  return {
    id: `chat-message-${index}`,
    sessionId,
    role: "user",
    content: `message ${index}`,
    harnessId: "codex",
    status: "sent",
    createdAt: new Date(start.getTime() + index * 1000).toISOString()
  };
}
