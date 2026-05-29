import type { BlueprintNodeEvent, BlueprintNodeRunStatus, BlueprintNodeType, BlueprintRunStatus } from "@hiveward/shared";

export type Language = "en" | "zh-CN";
export type StatusKey = BlueprintNodeRunStatus | BlueprintRunStatus | "idle";

export interface Messages {
  actions: {
    add: string;
    addNote: string;
    addAgent: string;
    addChannel: string;
    addModel: string;
    addParallelAgent: string;
    addSavedView: string;
    addSkill: string;
    addTag: string;
    addWidget: string;
    approve: string;
    catalog: string;
    createBlueprint: string;
    deleteNode: string;
    disableNode: string;
    enableNode: string;
    exportBlueprint: string;
    importBlueprint: string;
    refreshCatalog: string;
    refreshWorkspace: string;
    remove: string;
    run: string;
    runBlueprint: string;
    stopRun: string;
    save: string;
    saveModel: string;
    saveBlueprint: string;
    saveWorkspace: string;
    switchLanguage: string;
  };
  common: {
    allStatuses: string;
    allBlueprints: string;
    defaultModel: string;
    defaultOption: string;
    dirtyWorkspace: string;
    fresh: string;
    no: string;
    noDefaultModel: string;
    notLinked: string;
    realTime: string;
    stale: string;
    unknown: string;
    yes: string;
  };
  defaults: {
    agentName: string;
    agentLabel: string;
    agentPrompt: string;
    approvalLabel: string;
    conditionLabel: string;
    groupLabel: string;
    loopLabel: string;
    managerLabel: string;
    managerInstructions: string;
    managerSlotLabel: string;
    noteBody: string;
    noteLabel: string;
    parallelAgentsLabel: string;
    savedViewName: string;
    sendBody: string;
    sendLabel: string;
    summaryLabel: string;
    tagColor: string;
    tagLabel: string;
    widgetTitle: string;
  };
  empty: {
    noApprovals: string;
    noCatalog: string;
    noNodeOutput: string;
    noParallelAgents: string;
    noNotes: string;
    noRun: string;
    noRunHistory: string;
    noRuns: string;
    noSavedViews: string;
    noSessions: string;
    noSelectedSkills: string;
    noSkills: string;
    noTags: string;
    noTasks: string;
    noWidgets: string;
    selectNode: string;
    selectRun: string;
    selectSkill: string;
    selectBlueprint: string;
  };
  errors: {
    approve: string;
    catalog: string;
    load: string;
    run: string;
    save: string;
    workspace: string;
  };
  fields: {
    advancedSettings: string;
    advancedSettingsHint: string;
    accessMode: string;
    body: string;
    category: string;
    channels: string;
    crossRoundContext: string;
    crossRoundContextHint: string;
    description: string;
    agentName: string;
    expression: string;
    harness: string;
    harnessPermission: string;
    instructions: string;
    label: string;
    manager: string;
    managerDispatchStepLimit: string;
    managerMode: string;
    managerSlotCount: string;
    autoApproveRequirements: string;
    autoApproveReleaseReports: string;
    maxHandoffs: string;
    maxIterations: string;
    maxRounds: string;
    maxPreparationAttempts: string;
    model: string;
    mode: string;
    nodeId: string;
    openclawAgent: string;
    output: string;
    parallelLanes: string;
    position: string;
    profile: string;
    ports: string;
    primaryModel: string;
    prompt: string;
    provider: string;
    relatedRun: string;
    requirementAgent: string;
    relatedBlueprint: string;
    researchAgent: string;
    runLabel: string;
    safeMode: string;
    section: string;
    selfDispatch: string;
    selfIteration: string;
    sequentialDispatch: string;
    settings: string;
    skills: string;
    slot: string;
    status: string;
    supportsTools: string;
    target: string;
    tagColor: string;
    tagLabel: string;
    title: string;
    fullAccessMode: string;
    updatedAt: string;
    systemPrompt: string;
    userPrompt: string;
    waitFor: string;
    blueprint: string;
    workspace: string;
  };
  metrics: {
    agents: (count: number) => string;
    approvals: (count: number) => string;
    channels: (count: number) => string;
    cost: (cost: string) => string;
    models: (count: number) => string;
    nodes: (count: number) => string;
    notes: (count: number) => string;
    runs: (count: number) => string;
    savedViews: (count: number) => string;
    tags: (count: number) => string;
    tokens: (count: number) => string;
    tools: (count: number) => string;
    widgets: (count: number) => string;
    blueprints: (count: number) => string;
  };
  navigation: Record<string, string>;
  nodeTypes: Record<BlueprintNodeType, string>;
  pages: Record<
    string,
    {
      description: string;
      title: string;
    }
  >;
  panels: {
    catalog: string;
    inspector: string;
    nodes: string;
    run: string;
  };
  catalogConfig: {
    addAgentDescription: string;
    configFallback: string;
    defaultModelDescription: string;
    quickConfig: string;
    workspacePlaceholder: string;
  };
  options: {
    crossRoundNodeHistory: string;
    crossRoundNodeHistoryWithManagerMemory: string;
    crossRoundNodeHistoryWithUpstream: string;
    crossRoundOff: string;
    firstSuccess: string;
    fullAccessMode: string;
    harnessSummary: string;
    managerFallback: string;
    openClawAgent: string;
    safeMode: string;
    selfDispatch: string;
    selfIteration: string;
    sequential: string;
    structuredMerge: string;
    waitForAll: string;
  };
  trace: {
    completed: string;
    currentIssue: (label: string) => string;
    description: string;
    flowFinished: string;
    flowStarted: string;
    inProgress: string;
    issueList: string;
    managerInputBody: string;
    managerInputPreview: string;
    managerInputWaiting: string;
    modelOutput: string;
    noOutput: string;
    pending: string;
    runOption: (runId: string, startedAt: string) => string;
    slotInputSuffix: string;
    slotOutputSuffix: string;
    title: string;
    waitingNestedNodes: string;
  };
  status: Record<StatusKey, string>;
  tables: {
    agents: string;
    channels: string;
    models: string;
    notes: string;
    savedViews: string;
    sessions: string;
    tags: string;
    tasks: string;
    tools: string;
    widgets: string;
  };
  widgetTypes: Record<"approvals" | "catalog" | "notes" | "runs", string>;
  events: Record<BlueprintNodeEvent["type"], string>;
}

export const messages: Record<Language, Messages> = {
  en: {
    actions: {
      add: "Add",
      addNote: "Add note",
      addAgent: "Add agent",
      addChannel: "Add channel",
      addModel: "Add model",
      addParallelAgent: "Add parallel agent",
      addSavedView: "Add saved view",
      addSkill: "Add skill",
      addTag: "Add tag",
      addWidget: "Add widget",
      approve: "Approve",
      catalog: "Catalog",
      createBlueprint: "New blueprint",
      deleteNode: "Delete node",
      disableNode: "Disable node",
      enableNode: "Enable node",
      exportBlueprint: "Export blueprint",
      importBlueprint: "Import blueprint",
      refreshCatalog: "Refresh config data",
      refreshWorkspace: "Refresh workspace",
      remove: "Remove",
      run: "Start run",
      runBlueprint: "Start blueprint",
      stopRun: "Stop run",
      save: "Save",
      saveModel: "Save model",
      saveBlueprint: "Save blueprint",
      saveWorkspace: "Save workspace",
      switchLanguage: "Switch language"
    },
    common: {
      allStatuses: "All statuses",
      allBlueprints: "All blueprints",
      defaultModel: "OpenClaw default",
      defaultOption: "default",
      dirtyWorkspace: "Unsaved workspace state",
      fresh: "fresh",
      no: "No",
      noDefaultModel: "No default model configured",
      notLinked: "Not linked",
      realTime: "Runtime overview",
      stale: "stale",
      unknown: "Unknown",
      yes: "Yes"
    },
    defaults: {
      agentName: "agent",
      agentLabel: "Agent",
      agentPrompt: "Execute this Hiveward blueprint node through the selected runtime.",
      approvalLabel: "Approval",
      conditionLabel: "Condition",
      groupLabel: "Group",
      loopLabel: "Loop",
      managerLabel: "Manager",
      managerInstructions:
        "Route work through numbered slots. Agents may return JSON with status and nextSlot or returnToSlot.",
      managerSlotLabel: "Slot",
      noteBody: "Capture why this run matters, what changed, or what still needs review.",
      noteLabel: "Note",
      parallelAgentsLabel: "Parallel agents",
      savedViewName: "New saved view",
      sendBody: "Blueprint {{blueprint.name}} completed. Summary: {{summary}}",
      sendLabel: "Send",
      summaryLabel: "Summary",
      tagColor: "#0f766e",
      tagLabel: "Review",
      widgetTitle: "New widget"
    },
    empty: {
      noApprovals: "Inbox is empty",
      noCatalog: "Config data has not been loaded yet",
      noNodeOutput: "This node has no output yet.",
      noParallelAgents: "No parallel agents configured",
      noNotes: "No notes yet",
      noRun: "No run yet",
      noRunHistory: "This blueprint has no run activity yet.",
      noRuns: "No blueprint runs yet",
      noSavedViews: "No saved views yet",
      noSessions: "No visible runtime sessions",
      noSelectedSkills: "No skills selected",
      noSkills: "No Skills returned from OpenClaw.",
      noTags: "No tags yet",
      noTasks: "No active runs yet",
      noWidgets: "No overview widgets yet",
      selectNode: "Select a node",
      selectRun: "Select a run",
      selectSkill: "Select a skill",
      selectBlueprint: "No blueprint is selected."
    },
    errors: {
      approve: "Failed to approve run.",
      catalog: "Failed to refresh config data.",
      load: "Failed to load workspace.",
      run: "Failed to start run.",
      save: "Failed to save blueprint.",
      workspace: "Failed to save workspace state."
    },
    fields: {
      advancedSettings: "Advanced settings",
      advancedSettingsHint: "Model, identity, access mode, workspace, timeout, output",
      accessMode: "Access mode",
      body: "Body",
      category: "Category",
      channels: "Channels",
      crossRoundContext: "Cross-round context",
      crossRoundContextHint: "Applies only inside this blueprint run; it is not long-term harness memory.",
      description: "Description",
      agentName: "Agent name",
      expression: "Expression",
      harness: "Harness",
      harnessPermission: "Permission mode",
      instructions: "Instructions",
      label: "Label",
      manager: "Manager",
      managerDispatchStepLimit: "Max dispatch steps",
      managerMode: "Manager mode",
      managerSlotCount: "Slot count",
      autoApproveRequirements: "Auto-approve plans",
      autoApproveReleaseReports: "Auto-approve reports",
      maxHandoffs: "Max handoffs",
      maxIterations: "Max iterations",
      maxRounds: "Max rounds",
      maxPreparationAttempts: "Preparation attempts",
      model: "Model",
      mode: "Mode",
      nodeId: "Node ID",
      openclawAgent: "OpenClaw Agent",
      output: "Output",
      parallelLanes: "Parallel lanes",
      position: "Position",
      profile: "Profile",
      ports: "Ports",
      primaryModel: "Primary model",
      prompt: "Prompt",
      provider: "Provider",
      relatedRun: "Related run",
      requirementAgent: "Round plan agent",
      relatedBlueprint: "Related blueprint",
      researchAgent: "Research agent",
      runLabel: "Run label",
      safeMode: "Safe mode",
      section: "Section",
      selfDispatch: "Self dispatch",
      selfIteration: "Self iteration",
      sequentialDispatch: "Sequential dispatch",
      settings: "Settings",
      skills: "Skills",
      slot: "Slot",
      status: "Status",
      supportsTools: "Supports tools",
      target: "Target",
      tagColor: "Tag color",
      tagLabel: "Tag label",
      title: "Title",
      fullAccessMode: "Full access mode",
      updatedAt: "Updated",
      systemPrompt: "System prompt",
      userPrompt: "User prompt",
      waitFor: "Wait for",
      blueprint: "Blueprint",
      workspace: "Workspace"
    },
    metrics: {
      agents: (count) => `${count} agents`,
      approvals: (count) => `${count} inbox items`,
      channels: (count) => `${count} channels`,
      cost: (cost) => cost,
      models: (count) => `${count} models`,
      nodes: (count) => `${count} nodes`,
      notes: (count) => `${count} notes`,
      runs: (count) => `${count} runs`,
      savedViews: (count) => `${count} saved views`,
      tags: (count) => `${count} tags`,
      tokens: (count) => `${count} tokens`,
      tools: (count) => `${count} tools`,
      widgets: (count) => `${count} overview widgets`,
      blueprints: (count) => `${count} blueprints`
    },
    navigation: {
      company: "Company",
      chat: "Chat",
      blueprint: "Blueprint",
      runs: "Runs",
      approvals: "Inbox",
      models: "Models",
      agents: "Agents",
      openclaw: "Config",
      skills: "Skills",
      schedule: "History",
      channels: "Channels",
      claudeCodeConfig: "Config",
      claudeCodeModels: "Models",
      codexConfig: "Config",
      googleConfig: "Config",
      cursorConfig: "Config",
      opencodeConfig: "Config",
      hermesConfig: "Config",
      hermesModels: "Models",
      hermesAgents: "Agents",
      hermesSkills: "Skills",
      hermesChannels: "Channels"
    },
    nodeTypes: {
      agent: "Agent",
      condition: "Condition",
      group: "Group",
      loop: "Loop",
      manager: "Manager",
      manager_slot: "Slot",
      note: "Note",
      summary: "Summary"
    },
    pages: {
      company: {
        title: "Company Context",
        description: "Switch the active company, inspect company-level usage, and keep blueprint data scoped to a single operator context."
      },
      chat: {
        title: "Chat",
        description: "Talk to configured harness agents with model, mode, thinking, attachments, and runtime evidence controls."
      },
      blueprint: {
        title: "Blueprint Studio",
        description: "Command agent teams through blueprint structure, handoffs, gates, and run evidence."
      },
      runs: {
        title: "Run Monitor",
        description: "Monitor blueprint runs, agent outputs, and execution evidence."
      },
      approvals: {
        title: "Inbox",
        description: "Handle blueprint pauses that are waiting on a human decision."
      },
      models: {
        title: "Models",
        description: "Choose the OpenClaw default model and inspect available model capability."
      },
      agents: {
        title: "Agents",
        description: "Create configured OpenClaw agents and inspect available agents separately from blueprints."
      },
      openclaw: {
        title: "OpenClaw Config",
        description: "Check the local OpenClaw harness, Gateway environment, and connection status."
      },
      skills: {
        title: "Skills",
        description: "Inspect Skills loaded from the OpenClaw catalog."
      },
      schedule: {
        title: "History",
        description: "Review previous run records and inbox items by date range."
      },
      channels: {
        title: "Channels",
        description: "Inspect delivery channels and tool availability for fast channel configuration."
      },
      claudeCodeConfig: {
        title: "Claude code Config",
        description: "Check whether the local Claude Code harness is installed and ready."
      },
      claudeCodeModels: {
        title: "Claude Code Models",
        description: "Inspect and write local Claude Code model mappings."
      },
      codexConfig: {
        title: "Codex Config",
        description: "Check whether the local Codex harness is installed and ready."
      },
      googleConfig: {
        title: "Google CLI Beta Config",
        description: "Check whether the local Gemini CLI harness is installed and ready."
      },
      cursorConfig: {
        title: "Cursor CLI Beta Config",
        description: "Check whether the local Cursor CLI harness is installed and ready."
      },
      opencodeConfig: {
        title: "OpenCode Beta Config",
        description: "Check whether the local OpenCode CLI harness is installed and ready."
      },
      hermesConfig: {
        title: "Hermes Beta Config",
        description: "Check whether the local Hermes CLI harness is installed and ready."
      },
      hermesModels: {
        title: "Hermes Models",
        description: "Model options resolved for Hermes blueprint and chat execution."
      },
      hermesAgents: {
        title: "Hermes Agents",
        description: "Each Agent here maps to one Hermes profile."
      },
      hermesSkills: {
        title: "Hermes Skills",
        description: "HiveWard operating skills installed into Hermes."
      },
      hermesChannels: {
        title: "Hermes Channels",
        description: "Channels scanned from the Hermes channel directory."
      }
    },
    panels: {
      catalog: "Catalog",
      inspector: "Inspector",
      nodes: "Nodes",
      run: "Run"
    },
    catalogConfig: {
      addAgentDescription: "Creates an OpenClaw agent entry using the same config fields as `openclaw agents add`.",
      configFallback: "Read and write OpenClaw config from ~/.openclaw/openclaw.json.",
      defaultModelDescription: "Writes to the active OpenClaw config and refreshes the catalog.",
      quickConfig: "OpenClaw Quick Config",
      workspacePlaceholder: "Leave blank to auto-generate"
    },
    options: {
      crossRoundNodeHistory: "This node history",
      crossRoundNodeHistoryWithManagerMemory: "Node history + upstream + Manager memory",
      crossRoundNodeHistoryWithUpstream: "Node history + upstream artifacts",
      crossRoundOff: "Off",
      firstSuccess: "first success",
      fullAccessMode: "Full access",
      harnessSummary: "harness summary",
      managerFallback: "Manager handles it",
      openClawAgent: "OpenClaw agent",
      safeMode: "Safe mode",
      selfDispatch: "Self dispatch",
      selfIteration: "Self iteration",
      sequential: "Sequential",
      structuredMerge: "structured merge",
      waitForAll: "all"
    },
    trace: {
      completed: "Completed",
      currentIssue: (label) => `Current step: ${label}`,
      description: "Monitor run progress on the left, and read current output on the right.",
      flowFinished: "Blueprint finished",
      flowStarted: "Blueprint started",
      inProgress: "In progress",
      issueList: "Run steps",
      managerInputBody: "Manager handed work into this slot. The nested node outputs are shown between this input and the slot output.",
      managerInputPreview: "Manager input entered this slot.",
      managerInputWaiting: "Waiting for manager input.",
      modelOutput: "Current output",
      noOutput: "No output yet",
      pending: "Pending",
      runOption: (runId, startedAt) => `Run ${runId.slice(-6)} · ${startedAt}`,
      slotInputSuffix: "input",
      slotOutputSuffix: "output",
      title: "Run Monitor",
      waitingNestedNodes: "Waiting for nested nodes to finish."
    },
    status: {
      cancelled: "cancelled",
      failed: "failed",
      idle: "idle",
      queued: "queued",
      running: "running",
      skipped: "skipped",
      succeeded: "succeeded",
      waiting_approval: "waiting for inbox"
    },
    tables: {
      agents: "Agents",
      channels: "Channels",
      models: "Models",
      notes: "Notes",
      savedViews: "Saved views",
      sessions: "Sessions",
      tags: "Tags",
      tasks: "Runs",
      tools: "Tools",
      widgets: "Overview widgets"
    },
    widgetTypes: {
      approvals: "Inbox",
      catalog: "Config health",
      notes: "Notes feed",
      runs: "Recent runs"
    },
    events: {
      "node.run.cancelled": "Node cancelled",
      "node.run.completed": "Node completed",
      "node.run.failed": "Node failed",
      "node.run.queued": "Node queued",
      "node.run.started": "Node started",
      "node.run.waiting_approval": "Waiting for inbox",
      "blueprint.run.completed": "Blueprint completed",
      "blueprint.run.cancelled": "Blueprint stopped",
      "blueprint.run.failed": "Blueprint failed",
      "blueprint.run.started": "Blueprint started"
    }
  },
  "zh-CN": {
    actions: {
      add: "添加",
      addNote: "添加笔记",
      addAgent: "添加 Agent",
      addChannel: "添加频道",
      addModel: "添加模型",
      addParallelAgent: "添加并行 Agent",
      addSavedView: "添加视图",
      addSkill: "添加 Skill",
      addTag: "添加标签",
      addWidget: "添加卡片",
      approve: "批准",
      catalog: "目录",
      createBlueprint: "\u65b0\u5efa\u84dd\u56fe",
      deleteNode: "删除节点",
      disableNode: "禁用节点",
      enableNode: "启用节点",
      exportBlueprint: "\u5bfc\u51fa\u84dd\u56fe",
      importBlueprint: "\u5bfc\u5165\u84dd\u56fe",
      refreshCatalog: "刷新配置数据",
      refreshWorkspace: "刷新工作区",
      remove: "移除",
      run: "启动运行",
      runBlueprint: "\u542f\u52a8\u84dd\u56fe",
      stopRun: "\u505c\u6b62\u8fd0\u884c",
      save: "保存",
      saveModel: "保存模型",
      saveBlueprint: "\u4fdd\u5b58\u84dd\u56fe",
      saveWorkspace: "保存工作区",
      switchLanguage: "切换语言"
    },
    common: {
      allStatuses: "全部状态",
      allBlueprints: "\u5168\u90e8\u84dd\u56fe",
      defaultModel: "OpenClaw 默认",
      defaultOption: "默认",
      dirtyWorkspace: "工作区状态未保存",
      fresh: "新鲜",
      no: "否",
      noDefaultModel: "尚未配置默认模型",
      notLinked: "未关联",
      realTime: "运行时总览",
      stale: "过期",
      unknown: "未知",
      yes: "是"
    },
    defaults: {
      agentName: "agent",
      agentLabel: "Agent",
      agentPrompt: "通过所选执行器运行这个 Hiveward Agent 节点。",
      approvalLabel: "人工审批",
      conditionLabel: "条件",
      groupLabel: "分组",
      loopLabel: "循环",
      managerLabel: "管理器",
      managerInstructions: "通过编号槽位路由运行。Agent 可以返回包含 status、nextSlot 或 returnToSlot 的 JSON。",
      managerSlotLabel: "槽位",
      noteBody: "记录这次运行为什么重要、发生了什么变化，或还需要谁复核。",
      noteLabel: "备注",
      parallelAgentsLabel: "并行 Agent",
      savedViewName: "新建视图",
      sendBody: "\u84dd\u56fe {{blueprint.name}} \u5df2\u5b8c\u6210\u3002\u6458\u8981\uff1a{{summary}}",
      sendLabel: "发送",
      summaryLabel: "汇总",
      tagColor: "#0f766e",
      tagLabel: "待复核",
      widgetTitle: "新建卡片"
    },
    empty: {
      noApprovals: "收件箱为空",
      noCatalog: "配置数据尚未加载",
      noNodeOutput: "这个节点还没有输出。",
      noParallelAgents: "还没有配置并行 Agent",
      noNotes: "还没有笔记",
      noRun: "还没有运行",
      noRunHistory: "\u8fd9\u4e2a\u84dd\u56fe\u8fd8\u6ca1\u6709\u8fd0\u884c\u8bb0\u5f55\u3002",
      noRuns: "\u8fd8\u6ca1\u6709\u84dd\u56fe\u8fd0\u884c",
      noSavedViews: "还没有保存的视图",
      noSessions: "当前没有可见运行会话",
      noSelectedSkills: "\u8fd8\u6ca1\u6709\u9009\u62e9 Skill",
      noSkills: "OpenClaw \u6682\u672a\u8fd4\u56de Skills",
      noTags: "还没有标签",
      noTasks: "当前没有运行",
      noWidgets: "还没有总览卡片",
      selectNode: "请选择一个节点",
      selectRun: "请选择一个运行",
      selectSkill: "选择一个 Skill",
      selectBlueprint: "\u5c1a\u672a\u9009\u62e9\u84dd\u56fe\u3002"
    },
    errors: {
      approve: "批准运行失败。",
      catalog: "刷新配置数据失败。",
      load: "加载工作区失败。",
      run: "启动运行失败。",
      save: "\u4fdd\u5b58\u84dd\u56fe\u5931\u8d25\u3002",
      workspace: "保存工作区状态失败。"
    },
    fields: {
      advancedSettings: "\u9ad8\u7ea7\u8bbe\u7f6e",
      advancedSettingsHint: "\u6a21\u578b\u3001\u8eab\u4efd\u3001\u8bbf\u95ee\u6a21\u5f0f\u3001\u5de5\u4f5c\u533a\u3001\u8d85\u65f6\u3001\u8f93\u51fa",
      accessMode: "\u8bbf\u95ee\u6a21\u5f0f",
      harness: "Harness",
      harnessPermission: "\u6743\u9650\u6a21\u5f0f",
      systemPrompt: "\u7cfb\u7edf\u63d0\u793a\u8bcd",
      userPrompt: "\u7528\u6237\u63d0\u793a\u8bcd",
      body: "内容",
      category: "分类",
      channels: "\u9891\u9053",
      crossRoundContext: "\u8de8\u8f6e\u4e0a\u4e0b\u6587",
      crossRoundContextHint: "\u4ec5\u5728\u540c\u4e00\u6b21\u84dd\u56fe run \u5185\u751f\u6548\uff0c\u4e0d\u662f Harness \u957f\u671f\u8bb0\u5fc6\u3002",
      description: "说明",
      agentName: "Agent 名称",
      expression: "表达式",
      instructions: "说明",
      label: "标签",
      manager: "管理器",
      managerDispatchStepLimit: "\u6700\u5927\u5206\u53d1\u6b65\u6570",
      managerMode: "\u7ba1\u7406\u5668\u6a21\u5f0f",
      managerSlotCount: "\u69fd\u4f4d\u6570",
      autoApproveRequirements: "\u81ea\u52a8\u6279\u51c6\u6267\u884c\u8ba1\u5212",
      autoApproveReleaseReports: "\u81ea\u52a8\u6279\u51c6\u6c47\u62a5",
      maxRounds: "\u6700\u5927\u8f6e\u6570",
      maxHandoffs: "最大交接次数",
      maxIterations: "最大迭代次数",
      maxPreparationAttempts: "准备尝试次数",
      model: "模型",
      mode: "模式",
      nodeId: "节点 ID",
      openclawAgent: "OpenClaw Agent",
      output: "输出",
      parallelLanes: "\u5e76\u884c\u6392\u6570",
      position: "位置",
      profile: "Profile",
      ports: "端口",
      primaryModel: "主模型",
      prompt: "提示词",
      provider: "提供方",
      relatedRun: "关联运行",
      requirementAgent: "提需 / Round plan agent",
      relatedBlueprint: "\u5173\u8054\u84dd\u56fe",
      researchAgent: "调研 agent",
      runLabel: "运行标签",
      safeMode: "\u5b89\u5168\u6a21\u5f0f",
      section: "页面",
      selfDispatch: "\u81ea\u5206\u53d1",
      selfIteration: "\u81ea\u8fed\u4ee3",
      sequentialDispatch: "\u987a\u5e8f\u5206\u53d1",
      settings: "设置",
      skills: "Skills",
      slot: "槽位",
      status: "状态",
      supportsTools: "支持工具",
      target: "目标",
      tagColor: "标签颜色",
      tagLabel: "标签名称",
      title: "标题",
      fullAccessMode: "\u5b8c\u5168\u8bbf\u95ee\u6a21\u5f0f",
      updatedAt: "更新时间",
      waitFor: "等待条件",
      blueprint: "\u84dd\u56fe",
      workspace: "工作区"
    },
    metrics: {
      agents: (count) => `${count} 个 Agent`,
      approvals: (count) => `${count} 个收件箱项`,
      channels: (count) => `${count} \u4e2a\u9891\u9053`,
      cost: (cost) => cost,
      models: (count) => `${count} 个模型`,
      nodes: (count) => `${count} 个节点`,
      notes: (count) => `${count} 条笔记`,
      runs: (count) => `${count} 个运行`,
      savedViews: (count) => `${count} 个视图`,
      tags: (count) => `${count} 个标签`,
      tokens: (count) => `${count} tokens`,
      tools: (count) => `${count} 个工具`,
      widgets: (count) => `${count} 张总览卡片`,
      blueprints: (count) => `${count} \u4e2a\u84dd\u56fe`
    },
    navigation: {
      company: "公司",
      blueprint: "\u84dd\u56fe",
      runs: "运行",
      approvals: "收件箱",
      models: "模型",
      agents: "Agent",
      schedule: "历史",
      openclaw: "\u914d\u7f6e",
      skills: "Skills",
      channels: "\u9891\u9053",
      claudeCodeConfig: "\u914d\u7f6e",
      claudeCodeModels: "\u6a21\u578b",
      codexConfig: "\u914d\u7f6e",
      googleConfig: "\u914d\u7f6e",
      cursorConfig: "\u914d\u7f6e",
      opencodeConfig: "\u914d\u7f6e",
      hermesConfig: "\u914d\u7f6e",
      hermesModels: "\u6a21\u578b",
      hermesAgents: "Agent",
      hermesSkills: "Skills",
      hermesChannels: "\u9891\u9053"
    },
    nodeTypes: {
      agent: "Agent",
      condition: "条件",
      group: "分组",
      loop: "循环",
      manager: "管理器",
      manager_slot: "槽位",
      note: "备注",
      summary: "汇总"
    },
    pages: {
      company: {
        title: "公司上下文",
        description: "切换当前公司、查看公司级用量，并在同一页面维护总览卡片。"
      },
      chat: {
        title: "\u804a\u5929",
        description: "\u9009\u62e9 Harness\u3001Agent\u3001\u6a21\u578b\u548c\u6a21\u5f0f\uff0c\u4e0e\u8fd0\u884c\u65b9\u5b98\u65b9\u63a5\u53e3\u5bf9\u8bdd\u3002"
      },
      blueprint: {
        title: "\u84dd\u56fe\u6307\u6325\u53f0",
        description: "\u7ec4\u7ec7\u591a Agent \u84dd\u56fe\u7ed3\u6784\u3001\u4ea4\u63a5\u548c\u5ba1\u67e5\u5173\uff0c\u5e76\u67e5\u770b\u6700\u8fd1\u4e00\u6b21\u8fd0\u884c\u8bc1\u636e\u3002"
      },
      runs: {
        title: "运行监控",
        description: "监控蓝图运行、节点输出和执行证据。"
      },
      approvals: {
        title: "收件箱",
        description: "\u5904\u7406\u56e0\u4e3a\u4eba\u5de5\u51b3\u7b56\u800c\u6682\u505c\u7684\u84dd\u56fe\u3002"
      },
      models: {
        title: "模型",
        description: "选择 OpenClaw 默认模型，并查看可用模型能力。"
      },
      agents: {
        title: "Agent",
        description: "\u521b\u5efa\u5df2\u914d\u7f6e OpenClaw Agent\uff0c\u5e76\u628a\u53ef\u7528 Agent \u4e0e\u84dd\u56fe\u914d\u7f6e\u5206\u5f00\u67e5\u770b\u3002"
      },
      openclaw: {
        title: "OpenClaw \u914d\u7f6e",
        description: "\u68c0\u67e5\u672c\u673a OpenClaw harness\u3001\u7f51\u5173\u73af\u5883\u548c\u8fde\u63a5\u72b6\u6001\u3002"
      },
      skills: {
        title: "Skills",
        description: "\u67e5\u770b\u4ece OpenClaw \u76ee\u5f55\u62c9\u53d6\u7684 Skills\u3002"
      },
      schedule: {
        title: "历史",
        description: "按日期范围回看运行记录和收件箱记录。"
      },
      channels: {
        title: "\u9891\u9053",
        description: "\u67e5\u770b\u4ea4\u4ed8\u9891\u9053\u548c\u5de5\u5177\u53ef\u7528\u6027\uff0c\u4e3a\u540e\u7eed\u5feb\u901f\u9891\u9053\u914d\u7f6e\u7559\u51fa\u72ec\u7acb\u5165\u53e3\u3002"
      },
      claudeCodeConfig: {
        title: "Claude code \u914d\u7f6e",
        description: "\u68c0\u67e5\u672c\u673a Claude Code harness \u662f\u5426\u5df2\u5b89\u88c5\u5e76\u53ef\u7528\u3002"
      },
      claudeCodeModels: {
        title: "Claude Code \u6a21\u578b",
        description: "\u67e5\u770b\u5e76\u5199\u5165\u672c\u673a Claude Code \u6a21\u578b\u6620\u5c04\u3002"
      },
      codexConfig: {
        title: "Codex \u914d\u7f6e",
        description: "\u68c0\u67e5\u672c\u673a Codex harness \u662f\u5426\u5df2\u5b89\u88c5\u5e76\u53ef\u7528\u3002"
      },
      googleConfig: {
        title: "Google CLI Beta \u914d\u7f6e",
        description: "\u68c0\u67e5\u672c\u673a Gemini CLI harness \u662f\u5426\u5df2\u5b89\u88c5\u5e76\u53ef\u7528\u3002"
      },
      cursorConfig: {
        title: "Cursor CLI Beta \u914d\u7f6e",
        description: "\u68c0\u67e5\u672c\u673a Cursor CLI harness \u662f\u5426\u5df2\u5b89\u88c5\u5e76\u53ef\u7528\u3002"
      },
      opencodeConfig: {
        title: "OpenCode Beta \u914d\u7f6e",
        description: "\u68c0\u67e5\u672c\u673a OpenCode CLI harness \u662f\u5426\u5df2\u5b89\u88c5\u5e76\u53ef\u7528\u3002"
      },
      hermesConfig: {
        title: "Hermes Beta \u914d\u7f6e",
        description: "\u68c0\u67e5\u672c\u673a Hermes CLI harness \u662f\u5426\u5df2\u5b89\u88c5\u5e76\u53ef\u7528\u3002"
      },
      hermesModels: {
        title: "Hermes \u6a21\u578b",
        description: "\u7528\u4e8e Hermes \u84dd\u56fe\u548c\u804a\u5929\u6267\u884c\u7684\u6a21\u578b\u9009\u9879\u3002"
      },
      hermesAgents: {
        title: "Hermes Agent",
        description: "\u8fd9\u91cc\u7684\u6bcf\u4e2a Agent \u5bf9\u5e94 Hermes \u91cc\u7684\u4e00\u4e2a Profile\u3002"
      },
      hermesSkills: {
        title: "Hermes Skills",
        description: "\u5b89\u88c5\u5230 Hermes \u7684 HiveWard \u6267\u884c\u624b\u518c Skills\u3002"
      },
      hermesChannels: {
        title: "Hermes \u9891\u9053",
        description: "\u4ece Hermes channel directory \u626b\u63cf\u5230\u7684\u901a\u4fe1\u9891\u9053\u3002"
      }
    },
    panels: {
      catalog: "目录",
      inspector: "检查器",
      nodes: "节点",
      run: "运行"
    },
    catalogConfig: {
      addAgentDescription: "使用与 `openclaw agents add` 相同的配置字段创建 OpenClaw agent 条目。",
      configFallback: "读取并写入 ~/.openclaw/openclaw.json 中的 OpenClaw 配置。",
      defaultModelDescription: "写入当前 OpenClaw 配置，并刷新目录。",
      quickConfig: "OpenClaw 快速配置",
      workspacePlaceholder: "留空则自动生成"
    },
    options: {
      crossRoundNodeHistory: "\u4ec5\u672c\u8282\u70b9\u5386\u53f2",
      crossRoundNodeHistoryWithManagerMemory: "\u8282\u70b9\u5386\u53f2 + \u4e0a\u6e38 + Manager \u8bb0\u5fc6",
      crossRoundNodeHistoryWithUpstream: "\u8282\u70b9\u5386\u53f2 + \u4e0a\u6e38\u4ea7\u7269",
      crossRoundOff: "\u5173\u95ed",
      firstSuccess: "首个成功",
      fullAccessMode: "\u5168\u6743\u9650",
      harnessSummary: "Harness 总结",
      managerFallback: "\u7531\u7ba1\u7406\u5668\u5904\u7406",
      openClawAgent: "OpenClaw Agent",
      safeMode: "\u5b89\u5168\u6a21\u5f0f",
      selfDispatch: "\u81ea\u4e3b\u5206\u53d1",
      selfIteration: "\u81ea\u8fed\u4ee3",
      sequential: "\u987a\u5e8f\u5206\u53d1",
      structuredMerge: "结构化合并",
      waitForAll: "全部完成"
    },
    trace: {
      completed: "已完成",
      currentIssue: (label) => `当前步骤：${label}`,
      description: "左侧查看运行步骤，右侧查看当前输出。",
      flowFinished: "流程结束",
      flowStarted: "流程开始",
      inProgress: "进行中",
      issueList: "运行步骤",
      managerInputBody: "管理器已将工作交给该槽位。嵌套节点输出会显示在槽位输入和槽位输出之间。",
      managerInputPreview: "管理器输入已进入该槽位。",
      managerInputWaiting: "等待管理器输入。",
      modelOutput: "当前输出",
      noOutput: "暂无输出",
      pending: "待处理",
      runOption: (runId, startedAt) => `运行 ${runId.slice(-6)} · ${startedAt}`,
      slotInputSuffix: "输入",
      slotOutputSuffix: "输出",
      title: "运行监控",
      waitingNestedNodes: "等待嵌套节点完成。"
    },
    status: {
      cancelled: "已取消",
      failed: "失败",
      idle: "空闲",
      queued: "排队中",
      running: "运行中",
      skipped: "已跳过",
      succeeded: "成功",
      waiting_approval: "等待收件箱处理"
    },
    tables: {
      agents: "Agent",
      channels: "\u9891\u9053",
      models: "模型",
      notes: "笔记",
      savedViews: "保存视图",
      sessions: "会话",
      tags: "标签",
      tasks: "运行",
      tools: "工具",
      widgets: "总览卡片"
    },
    widgetTypes: {
      approvals: "收件箱",
      catalog: "配置状态",
      notes: "笔记流",
      runs: "最近运行"
    },
    events: {
      "node.run.cancelled": "节点已取消",
      "node.run.completed": "节点已完成",
      "node.run.failed": "节点失败",
      "node.run.queued": "节点已排队",
      "node.run.started": "节点已启动",
      "node.run.waiting_approval": "等待收件箱处理",
      "blueprint.run.completed": "\u84dd\u56fe\u5df2\u5b8c\u6210",
      "blueprint.run.cancelled": "\u84dd\u56fe\u5df2\u505c\u6b62",
      "blueprint.run.failed": "\u84dd\u56fe\u5931\u8d25",
      "blueprint.run.started": "\u84dd\u56fe\u5df2\u542f\u52a8"
    }
  }
};

export function getInitialLanguage(): Language {
  const stored = localStorage.getItem("hiveward-language");
  if (stored === "en" || stored === "zh-CN") return stored;
  return navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}
