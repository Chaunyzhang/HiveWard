import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type ReactNode,
  type SetStateAction
} from "react";
import { createPortal } from "react-dom";
import {
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileUp,
  LayoutTemplate,
  Loader2,
  MessageSquareText,
  Paperclip,
  Pencil,
  Plus,
  Send,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  Wrench,
  X
} from "lucide-react";
import type {
  BlueprintDefinition,
  CatalogSnapshot,
  ChatAttachment,
  ChatMode,
  ChatPermissionMode,
  ChatRoleScope,
  ChatRuntimeRef,
  ChatStreamEvent,
  ChatStreamTimings,
  ChatThinkingEffort,
  CompanyOverview,
  CompanyRoleDirectory,
  HarnessId,
  HarnessStatus,
  HivewardChatMessage,
  HivewardChatSession,
  InboxItem,
  OpenClawConfigState,
  RuntimeOverview
} from "@hiveward/shared";
import type { Language } from "../lib/i18n";
import { api } from "../lib/api";
import { shouldRefreshStreamingChatMessages, shouldShowRuntimeStatus, toChatRuntimeStatus, type ChatRuntimeStatusView } from "../lib/chat-state";
import { harnessDisplayParts, harnessLikeDisplayLabel, harnessLikeDisplayParts } from "../lib/harness-labels";
import { HarnessLabel } from "./HarnessLabel";
import { MarkdownRenderer } from "./MarkdownRenderer";

type ChatMessage = HivewardChatMessage & {
  status?: "sent" | "streaming" | "failed";
  runtimeRef?: ChatRuntimeRef;
  runtimeStatus?: ChatRuntimeStatusView;
  progressText?: string;
  speakerLabel?: string;
  agentId?: string;
};

type SelectOption = {
  value: string;
  label: string;
  badgeLabel?: string;
  meta?: string;
  disabled?: boolean;
  variant?: "create";
  thinkingLevels?: ChatThinkingEffort[];
};

type HivewardSessionView = HivewardChatSession & {
  messages: ChatMessage[];
};

const maxReadableFileChars = 24_000;
const maxUploadFiles = 6;
const composerMinHeightPx = 42;
const composerMaxHeightPx = 132;
const newSessionViewOptionValue = "__new_session_view__";
const nativeSessionOptionPrefix = "__native_harness_session__:";
const legacyNativeSessionOptionPrefix = "__native_openclaw_session__:";
const newBlueprintOptionValue = "__new_blueprint__";

export function ChatPage({
  catalog,
  openClawConfig,
  harnessStatuses,
  runtime,
  company,
  selectedCompanyId,
  blueprints,
  roleDirectory,
  language,
  harnessPermissionModes,
  onInboxItemCreated
}: {
  catalog?: CatalogSnapshot;
  openClawConfig?: OpenClawConfigState;
  harnessStatuses: HarnessStatus[];
  runtime?: RuntimeOverview;
  company?: CompanyOverview;
  selectedCompanyId?: string;
  blueprints: BlueprintDefinition[];
  roleDirectory?: CompanyRoleDirectory;
  language: Language;
  harnessPermissionModes?: Partial<Record<HarnessId, ChatPermissionMode>>;
  onInboxItemCreated?: (item: InboxItem) => void;
}) {
  const copy = chatCopy(language);
  const openClawModelOptions = useMemo(() => buildOpenClawModelOptions(catalog, openClawConfig), [catalog, openClawConfig]);
  const agentOptions = useMemo(() => buildAgentOptions(catalog, openClawConfig), [catalog, openClawConfig]);
  const initialModelId = openClawConfig?.defaultModelId ?? openClawModelOptions[0]?.value ?? "";
  const defaultAgentId =
    openClawConfig?.configuredAgents.find((agent) => agent.isDefault)?.id ?? agentOptions[0]?.value ?? "main";

  const [sessionViews, setSessionViews] = useState<HivewardSessionView[]>([]);
  const [activeSessionViewId, setActiveSessionViewId] = useState<string | undefined>();
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [harnessId, setHarnessId] = useState<HarnessId>("openclaw");
  const [modelId, setModelId] = useState(initialModelId);
  const [agentId, setAgentId] = useState(defaultAgentId);
  const [thinkingEffort, setThinkingEffort] = useState<ChatThinkingEffort>("minimal");
  const [chatMode, setChatMode] = useState<ChatMode>("chat");
  const [selectedRoleId, setSelectedRoleId] = useState("ceo");
  const [selectedBlueprintId, setSelectedBlueprintId] = useState(newBlueprintOptionValue);
  const [settingsCollapsed, setSettingsCollapsed] = useState(false);
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [titleSaving, setTitleSaving] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [historyLoadingSessionKey, setHistoryLoadingSessionKey] = useState<string | undefined>();
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [rebuildFromHivewardHistory, setRebuildFromHivewardHistory] = useState(false);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  const activeSessionView = sessionViews.find((sessionView) => sessionView.id === activeSessionViewId) ?? sessionViews[0];
  const messages = activeSessionView?.messages ?? [];
  const runtimeSessions = runtime?.sessions ?? [];
  const isOpenClawHarness = harnessId === "openclaw";
  const selectedHarnessStatus = harnessStatuses.find((status) => status.id === harnessId);
  const selectedHarnessLabel = formatHarnessLabel(harnessId);
  const modelOptions = useMemo(
    () => buildHarnessModelOptions(harnessId, selectedHarnessStatus, openClawModelOptions, copy),
    [copy, harnessId, openClawModelOptions, selectedHarnessStatus]
  );
  const defaultModelId = modelOptions[0]?.value ?? "";
  const selectedModelOption = modelOptions.find((option) => option.value === modelId);
  const selectedHarnessAvailable =
    (!selectedHarnessStatus ||
      selectedHarnessStatus.connectionState === "connected" ||
      selectedHarnessStatus.connectionState === "available");
  const roleOptions = useMemo<SelectOption[]>(() => buildRoleOptions(roleDirectory, blueprints, copy), [blueprints, copy, roleDirectory]);
  const selectedRole =
    roleDirectory?.ceo.id === selectedRoleId
      ? roleDirectory.ceo
      : roleDirectory?.leaders.find((role) => role.id === selectedRoleId) ?? roleDirectory?.ceo;
  const selectedRoleBlueprint = selectedRole?.blueprintId
    ? blueprints.find((blueprint) => blueprint.id === selectedRole.blueprintId)
    : undefined;
  const blueprintOptions = useMemo<SelectOption[]>(
    () => buildBlueprintOptions(selectedRole, blueprints, copy),
    [blueprints, copy, selectedRole]
  );
  const selectedBlueprintOptionValue = resolveBlueprintSelection(selectedRole, selectedBlueprintId, blueprints);
  const selectedBlueprintScopeId =
    chatMode === "blueprint" ? readSelectedBlueprintScopeId(selectedBlueprintOptionValue) : undefined;
  const selectedChatBlueprint = selectedBlueprintScopeId
    ? blueprints.find((blueprint) => blueprint.id === selectedBlueprintScopeId)
    : undefined;
  const titleBlueprint = chatMode === "blueprint" ? selectedChatBlueprint : selectedRoleBlueprint;
  const selectedRoleLabel = selectedRole?.label ?? copy.ceoRole;
  const activePermissionMode = resolveHarnessPermissionMode(harnessId, harnessPermissionModes, activeSessionView);
  const canConfigurePermission =
    Boolean(activeSessionView) && activeSessionView?.harnessId === harnessId && supportsChatPermissionMode(harnessId);

  const applySessionRoleScope = useCallback(
    (roleScope: ChatRoleScope | undefined) => {
      if (!roleScope) return;
      if (roleScope.role === "ceo") {
        setSelectedRoleId(roleDirectory?.ceo.id ?? "ceo");
      } else if (roleScope.leaderId) {
        setSelectedRoleId(roleScope.leaderId);
      }
      setSelectedBlueprintId(roleScope.blueprintId ?? newBlueprintOptionValue);
    },
    [roleDirectory?.ceo.id]
  );

  const loadChatSessions = useCallback(
    async (preferredSessionId?: string) => {
      setSessionsLoading(true);
      setError(undefined);
      try {
        let sessions = await api.listChatSessions();
        if (sessions.length === 0) {
          const created = await api.createHivewardChatSession({
            harnessId,
            title: copy.newSessionViewTitle,
            modelId: defaultModelId || undefined,
            agentId: harnessId === "openclaw" ? agentId || undefined : undefined,
            thinkingEffort,
            permissionMode: resolveHarnessPermissionMode(harnessId, harnessPermissionModes),
            mode: chatMode,
            roleScope: buildChatRoleScope(selectedCompanyId, selectedRole, selectedBlueprintScopeId)
          });
          sessions = [created];
        }
        const nextActiveId =
          preferredSessionId && sessions.some((session) => session.id === preferredSessionId)
            ? preferredSessionId
            : activeSessionViewId && sessions.some((session) => session.id === activeSessionViewId)
              ? activeSessionViewId
              : sessions[0]?.id;
        const activeMessages = nextActiveId ? await api.getHivewardChatMessages(nextActiveId) : [];
        const nextSessionViews = sessions.map((session) => ({
          ...session,
          messages: session.id === nextActiveId ? activeMessages.map((message) => decorateHivewardMessage(message, copy)) : []
        }));
        setSessionViews(nextSessionViews);
        setActiveSessionViewId(nextActiveId);
        const nextActiveSession = nextSessionViews.find((session) => session.id === nextActiveId);
        if (nextActiveSession) {
          setHarnessId(nextActiveSession.harnessId);
          if (nextActiveSession.modelId) setModelId(nextActiveSession.modelId);
          if (nextActiveSession.agentId) setAgentId(nextActiveSession.agentId);
          if (nextActiveSession.thinkingEffort) setThinkingEffort(nextActiveSession.thinkingEffort);
          setChatMode(nextActiveSession.mode);
          applySessionRoleScope(nextActiveSession.roleScope);
        }
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : copy.historyLoadFailed);
      } finally {
        setSessionsLoading(false);
      }
    },
    [
      activeSessionViewId,
      agentId,
      chatMode,
      copy,
      defaultModelId,
      harnessId,
      harnessPermissionModes,
      applySessionRoleScope,
      selectedCompanyId,
      selectedBlueprintScopeId,
      selectedRole,
      thinkingEffort
    ]
  );

  const updateActiveSessionView = useCallback(
    (update: (sessionView: HivewardSessionView) => HivewardSessionView) => {
      setSessionViews((current) =>
        current.map((sessionView) => (sessionView.id === activeSessionView?.id ? update(sessionView) : sessionView))
      );
    },
    [activeSessionView?.id]
  );

  const updateActiveSessionViewMessages = useCallback<Dispatch<SetStateAction<ChatMessage[]>>>(
    (nextMessagesAction) => {
      updateActiveSessionView((sessionView) => {
        const nextMessages =
          typeof nextMessagesAction === "function"
            ? nextMessagesAction(sessionView.messages)
            : nextMessagesAction;
        return {
          ...sessionView,
          title: deriveSessionViewTitle(sessionView, nextMessages, copy),
          messages: nextMessages,
          updatedAt: new Date().toISOString()
        };
      });
    },
    [copy, updateActiveSessionView]
  );

  useEffect(() => {
    if (!titleEditing) setTitleDraft(activeSessionView?.title ?? "");
  }, [activeSessionView?.title, titleEditing]);

  const startEditingTitle = useCallback(() => {
    setTitleDraft(activeSessionView?.title ?? "");
    setTitleEditing(true);
  }, [activeSessionView?.title]);

  const cancelEditingTitle = useCallback(() => {
    setTitleDraft(activeSessionView?.title ?? "");
    setTitleEditing(false);
  }, [activeSessionView?.title]);

  const saveSessionTitle = useCallback(async () => {
    if (!activeSessionView) return;
    const nextTitle = titleDraft.trim();
    if (!nextTitle) return;
    setTitleSaving(true);
    setError(undefined);
    try {
      const titleResult = await api.updateHivewardChatSession(activeSessionView.id, { title: nextTitle });
      setSessionViews((current) =>
        current.map((sessionView) =>
          sessionView.id === activeSessionView.id
            ? {
                ...titleResult,
                messages: sessionView.messages,
                updatedAt: new Date().toISOString()
              }
            : sessionView
        )
      );
      setTitleEditing(false);
    } catch (titleError) {
      setError(titleError instanceof Error ? titleError.message : copy.titleUpdateFailed);
    } finally {
      setTitleSaving(false);
    }
  }, [activeSessionView, copy.titleUpdateFailed, titleDraft]);

  const endActiveSession = useCallback(async () => {
    if (!activeSessionView || activeSessionView.status === "ended") return;
    setError(undefined);
    try {
      const ended = await api.endHivewardChatSession(activeSessionView.id);
      setSessionViews((current) =>
        current.map((sessionView) =>
          sessionView.id === ended.id
            ? {
                ...ended,
                messages: sessionView.messages
              }
            : sessionView
        )
      );
      setRebuildFromHivewardHistory(false);
    } catch (endError) {
      setError(endError instanceof Error ? endError.message : copy.sessionEndFailed);
    }
  }, [activeSessionView, copy.sessionEndFailed]);

  const updateActiveSessionPermissionMode = useCallback(
    async (value: string) => {
      if (!activeSessionView || activeSessionView.harnessId !== harnessId || !supportsChatPermissionMode(harnessId)) return;
      const permissionMode = value === "full_access" ? "full_access" : "safe";
      const previousPermissionMode = activeSessionView.permissionMode ?? activePermissionMode ?? "safe";
      setError(undefined);
      setSessionViews((current) =>
        current.map((sessionView) =>
          sessionView.id === activeSessionView.id
            ? {
                ...sessionView,
                permissionMode,
                updatedAt: new Date().toISOString()
              }
            : sessionView
        )
      );
      try {
        const updated = await api.updateHivewardChatSession(activeSessionView.id, { permissionMode });
        setSessionViews((current) =>
          current.map((sessionView) =>
            sessionView.id === updated.id
              ? {
                  ...updated,
                  messages: sessionView.messages
                }
              : sessionView
          )
        );
      } catch (permissionError) {
        setSessionViews((current) =>
          current.map((sessionView) =>
            sessionView.id === activeSessionView.id
              ? {
                  ...sessionView,
                  permissionMode: previousPermissionMode,
                  updatedAt: new Date().toISOString()
                }
              : sessionView
          )
        );
        setError(permissionError instanceof Error ? permissionError.message : copy.permissionUpdateFailed);
      }
    },
    [activePermissionMode, activeSessionView, copy.permissionUpdateFailed, harnessId]
  );

  const bindActiveSessionView = useCallback(
    (event: Extract<ChatStreamEvent, { type: "started" | "done" }>, eventHarnessId: HarnessId) => {
      updateActiveSessionView((sessionView) => ({
        ...sessionView,
        harnessId: eventHarnessId,
        nativeSessionId: event.sessionKey || undefined,
        nativeSessionState: event.sessionKey ? "resumable" : sessionView.nativeSessionState,
        updatedAt: event.updatedAt
      }));
    },
    [updateActiveSessionView]
  );

  const createSessionView = useCallback(async () => {
    try {
      const roleScope = buildChatRoleScope(selectedCompanyId, selectedRole, selectedBlueprintScopeId);
      const nextSession = await api.createHivewardChatSession({
        harnessId,
        title: copy.newSessionViewTitle,
        modelId: modelId || undefined,
        agentId: harnessId === "openclaw" ? agentId || undefined : undefined,
        thinkingEffort,
        permissionMode: resolveHarnessPermissionMode(harnessId, harnessPermissionModes),
        mode: chatMode,
        roleScope
      });
      const nextSessionView: HivewardSessionView = { ...nextSession, messages: [] };
      setSessionViews((current) => [nextSessionView, ...current]);
      setActiveSessionViewId(nextSessionView.id);
      setRebuildFromHivewardHistory(false);
      setDraft("");
      setAttachments([]);
      setError(undefined);
    } catch (sessionError) {
      setError(sessionError instanceof Error ? sessionError.message : copy.sessionCreateFailed);
    }
  }, [agentId, chatMode, copy, harnessId, harnessPermissionModes, modelId, selectedBlueprintScopeId, selectedCompanyId, selectedRole, thinkingEffort]);

  const loadSessionMessages = useCallback(
    async (sessionViewId: string) => {
      setHistoryLoadingSessionKey(sessionViewId);
      try {
        const messages = await api.getHivewardChatMessages(sessionViewId);
        setSessionViews((current) =>
          current.map((sessionView) =>
            sessionView.id === sessionViewId
              ? {
                  ...sessionView,
                  messages: messages.map((message) => decorateHivewardMessage(message, copy)),
                  updatedAt: new Date().toISOString()
                }
              : sessionView
          )
        );
      } catch (historyError) {
        setError(historyError instanceof Error ? historyError.message : copy.historyLoadFailed);
      } finally {
        setHistoryLoadingSessionKey((current) => (current === sessionViewId ? undefined : current));
      }
    },
    [copy]
  );

  const activateNativeSession = useCallback(
    async (sessionKey: string) => {
      const nativeSession = runtimeSessions.find((session) => session.id === sessionKey);
      try {
        const session = await api.createHivewardChatSession({
          harnessId: "openclaw",
          nativeSessionId: sessionKey,
          title: nativeSession ? formatNativeSessionLabel(nativeSession) : sessionKey,
          agentId: readAgentIdFromSessionKey(sessionKey) ?? defaultAgentId,
          modelId: modelId || undefined,
          thinkingEffort,
          mode: chatMode,
          roleScope: buildChatRoleScope(selectedCompanyId, selectedRole, selectedBlueprintScopeId)
        });
        setSessionViews((current) => [{ ...session, messages: [] }, ...current]);
        setActiveSessionViewId(session.id);
        setHarnessId("openclaw");
        setAgentId(session.agentId ?? defaultAgentId);
        setRebuildFromHivewardHistory(false);
        setDraft("");
        setAttachments([]);
        setError(undefined);
      } catch (sessionError) {
        setError(sessionError instanceof Error ? sessionError.message : copy.sessionCreateFailed);
      }
    },
    [chatMode, copy.sessionCreateFailed, defaultAgentId, modelId, runtimeSessions, selectedBlueprintScopeId, selectedCompanyId, selectedRole, thinkingEffort]
  );

  useEffect(() => {
    if (modelOptions.some((option) => option.value === modelId)) return;
    setModelId(defaultModelId);
  }, [defaultModelId, modelId, modelOptions]);

  useEffect(() => {
    if (!agentId && defaultAgentId) setAgentId(defaultAgentId);
  }, [agentId, defaultAgentId]);

  useEffect(() => {
    if (roleOptions.some((option) => option.value === selectedRoleId)) return;
    setSelectedRoleId(roleOptions[0]?.value ?? "ceo");
  }, [roleOptions, selectedRoleId]);

  useEffect(() => {
    if (selectedBlueprintId === selectedBlueprintOptionValue) return;
    setSelectedBlueprintId(selectedBlueprintOptionValue);
  }, [selectedBlueprintId, selectedBlueprintOptionValue]);

  useEffect(() => {
    void loadChatSessions();
  }, [selectedCompanyId]);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [messages]);

  useEffect(() => {
    if (!activeSessionView?.messages.some((message) => message.status === "streaming")) return;

    const interval = window.setInterval(() => {
      void api.getHivewardChatMessages(activeSessionView.id).then((serverMessages) => {
        const shouldRefresh = shouldRefreshStreamingChatMessages({
          localMessages: activeSessionView.messages,
          serverMessages
        });
        if (shouldRefresh) {
          void loadSessionMessages(activeSessionView.id);
        }
      }).catch(() => undefined);
    }, 8_000);

    return () => window.clearInterval(interval);
  }, [activeSessionView?.id, activeSessionView?.messages, loadSessionMessages]);

  useEffect(() => {
    const textarea = composerTextareaRef.current;
    if (!textarea) return;
    textarea.style.height = `${composerMinHeightPx}px`;
    const nextHeight = Math.min(textarea.scrollHeight, composerMaxHeightPx);
    textarea.style.height = `${Math.max(composerMinHeightPx, nextHeight)}px`;
    textarea.style.overflowY = textarea.scrollHeight > composerMaxHeightPx ? "auto" : "hidden";
  }, [draft]);

  useEffect(
    () => () => {
      streamAbortRef.current?.abort();
    },
    []
  );

  const sessionViewOptions = useMemo<SelectOption[]>(
    () => {
      const knownNativeSessionIds = new Set(sessionViews.flatMap((sessionView) => sessionView.nativeSessionId ? [sessionView.nativeSessionId] : []));
        return [
          {
            value: newSessionViewOptionValue,
            label: copy.newSessionView,
            variant: "create"
          },
        ...sessionViews
          .filter((sessionView) => sessionView.harnessId === harnessId)
          .filter((sessionView) => isVisibleSessionView(sessionView, agentId))
          .map((sessionView) => ({
            value: sessionView.id,
            label: sessionView.status === "ended" ? `${sessionView.title} / ${copy.ended}` : sessionView.title,
            meta: sessionView.status === "native_missing" ? copy.nativeSessionMissing : undefined
          })),
        ...(harnessId === "openclaw"
          ? runtimeSessions
              .filter((session) => isVisibleNativeChatSessionKey(session.id, agentId))
              .filter((session) => !knownNativeSessionIds.has(session.id))
              .map((session) => ({
                value: `${nativeSessionOptionPrefix}${session.id}`,
                label: formatNativeSessionLabel(session)
              }))
          : [])
      ];
    },
    [agentId, copy, harnessId, runtimeSessions, sessionViews]
  );
  const harnessOptions = useMemo<SelectOption[]>(
    () =>
      ([
        "openclaw",
        "codex",
        "google",
        "cursor",
        "opencode",
        "hermes",
        "claudeCode"
      ] as const).map((value) => {
        const status = harnessStatuses.find((item) => item.id === value);
        return {
          value,
          ...harnessDisplayParts(value),
          meta: formatHarnessStatusMeta(status, copy),
          disabled: status?.connectionState === "needs_config" || status?.connectionState === "unavailable"
        };
      }),
    [copy, harnessStatuses]
  );
  const thinkingOptions = useMemo<SelectOption[]>(
    () => buildThinkingOptions(selectedModelOption?.thinkingLevels, copy),
    [copy, selectedModelOption?.thinkingLevels]
  );
  const permissionOptions = useMemo<SelectOption[]>(
    () => [
      { value: "safe", label: copy.permissionSafe },
      { value: "full_access", label: copy.permissionFull }
    ],
    [copy]
  );
  const modeOptions = useMemo<SelectOption[]>(
    () => [
      { value: "chat", label: copy.modeChat },
      { value: "blueprint", label: copy.modeBlueprint },
      { value: "skill_split", label: copy.modeSkillSplit }
    ],
    [copy]
  );
  const thinkingOptionLevels = useMemo(
    () => thinkingOptions.map((option) => option.value as ChatThinkingEffort),
    [thinkingOptions]
  );
  const effectiveThinkingEffort = useMemo(
    () => resolveSupportedThinkingEffort(thinkingOptionLevels, thinkingEffort),
    [thinkingEffort, thinkingOptionLevels]
  );

  useEffect(() => {
    if (effectiveThinkingEffort !== thinkingEffort) {
      setThinkingEffort(effectiveThinkingEffort);
    }
  }, [effectiveThinkingEffort, thinkingEffort]);

  const selectSessionView = useCallback(
    (sessionViewId: string) => {
      if (sessionViewId === newSessionViewOptionValue) {
        void createSessionView();
        return;
      }
      const nativeSessionKey = readNativeSessionOptionValue(sessionViewId);
      if (nativeSessionKey) {
        void activateNativeSession(nativeSessionKey);
        return;
      }
      const nextSessionView = sessionViews.find((sessionView) => sessionView.id === sessionViewId);
      setActiveSessionViewId(sessionViewId);
      if (nextSessionView) setHarnessId(nextSessionView.harnessId);
      if (nextSessionView?.agentId) setAgentId(nextSessionView.agentId);
      if (nextSessionView?.modelId) setModelId(nextSessionView.modelId);
      if (nextSessionView?.thinkingEffort) setThinkingEffort(nextSessionView.thinkingEffort);
      if (nextSessionView?.mode) setChatMode(nextSessionView.mode);
      applySessionRoleScope(nextSessionView?.roleScope);
      void loadSessionMessages(sessionViewId);
      setRebuildFromHivewardHistory(false);
      setDraft("");
      setAttachments([]);
      setError(undefined);
    },
    [activateNativeSession, applySessionRoleScope, createSessionView, loadSessionMessages, sessionViews]
  );

  const selectHarness = useCallback(
    async (nextHarnessId: HarnessId) => {
      setHarnessId(nextHarnessId);
      const existing = sessionViews.find((sessionView) => sessionView.harnessId === nextHarnessId && sessionView.status !== "ended");
      if (existing) {
        setActiveSessionViewId(existing.id);
        applySessionRoleScope(existing.roleScope);
        void loadSessionMessages(existing.id);
        return;
      }
      try {
        const session = await api.createHivewardChatSession({
          harnessId: nextHarnessId,
          title: copy.newSessionViewTitle,
          modelId: modelId || undefined,
          agentId: nextHarnessId === "openclaw" ? agentId || undefined : undefined,
          thinkingEffort,
          permissionMode: resolveHarnessPermissionMode(nextHarnessId, harnessPermissionModes),
          mode: chatMode,
          roleScope: buildChatRoleScope(selectedCompanyId, selectedRole, selectedBlueprintScopeId)
        });
        setSessionViews((current) => [{ ...session, messages: [] }, ...current]);
        setActiveSessionViewId(session.id);
        setRebuildFromHivewardHistory(false);
      } catch (sessionError) {
        setError(sessionError instanceof Error ? sessionError.message : copy.sessionCreateFailed);
      }
    },
    [agentId, applySessionRoleScope, chatMode, copy, harnessPermissionModes, loadSessionMessages, modelId, selectedBlueprintScopeId, selectedCompanyId, selectedRole, sessionViews, thinkingEffort]
  );

  const selectAgent = useCallback(
    async (nextAgentId: string) => {
      setAgentId(nextAgentId);
      if (harnessId !== "openclaw" || nextAgentId === agentId) return;
      try {
        const session = await api.createHivewardChatSession({
          harnessId: "openclaw",
          title: copy.newSessionViewTitle,
          modelId: modelId || undefined,
          agentId: nextAgentId || undefined,
          thinkingEffort,
          mode: chatMode,
          roleScope: buildChatRoleScope(selectedCompanyId, selectedRole, selectedBlueprintScopeId)
        });
        const nextSessionView: HivewardSessionView = { ...session, messages: [] };
        setSessionViews((current) => [nextSessionView, ...current]);
        setActiveSessionViewId(nextSessionView.id);
        setRebuildFromHivewardHistory(false);
        setDraft("");
        setAttachments([]);
        setError(undefined);
      } catch (sessionError) {
        setError(sessionError instanceof Error ? sessionError.message : copy.sessionCreateFailed);
      }
    },
    [agentId, chatMode, copy, harnessId, modelId, selectedBlueprintScopeId, selectedCompanyId, selectedRole, thinkingEffort]
  );

  const canSend =
    !isSending &&
    selectedHarnessAvailable &&
    (draft.trim().length > 0 || attachments.length > 0) &&
    Boolean(activeSessionView) &&
    activeSessionView?.status !== "ended" &&
    (activeSessionView?.status !== "native_missing" || rebuildFromHivewardHistory);

  const sendMessage = async () => {
    if (!canSend) return;

    const controller = new AbortController();
    const content = draft.trim();
    const outgoingAttachments = attachments;
    const includePlatformContext = messages.length === 0;
    const roleScope = buildChatRoleScope(selectedCompanyId, selectedRole, selectedBlueprintScopeId);
    const sendHarnessId = harnessId;
    const sendHarnessLabel = formatHarnessLabel(sendHarnessId);
    const sendIsOpenClawHarness = sendHarnessId === "openclaw";
    const sendPermissionMode = resolveHarnessPermissionMode(sendHarnessId, harnessPermissionModes, activeSessionView);
    const sendModelId = modelOptions.some((option) => option.value === modelId) ? modelId : defaultModelId;
    const sendModelOption = modelOptions.find((option) => option.value === sendModelId);
    const sendThinkingEffort = resolveSupportedThinkingEffort(
      normalizeThinkingLevels(sendModelOption?.thinkingLevels),
      thinkingEffort
    );
    const now = new Date().toISOString();
    const userMessage: ChatMessage = {
      id: makeLocalId("chat-user"),
      sessionId: activeSessionView!.id,
      role: "user",
      content: content || copy.attachmentOnlyMessage,
      createdAt: now,
      attachments: outgoingAttachments,
      status: "sent",
      speakerLabel: copy.you,
      harnessId: sendHarnessId
    };
    const assistantId = makeLocalId("chat-assistant");
    const assistantMessage: ChatMessage = {
      id: assistantId,
      sessionId: activeSessionView!.id,
      role: "assistant",
      content: "",
      createdAt: now,
      status: "streaming",
      speakerLabel: `${selectedRoleLabel} / ${formatHarnessSpeaker(
        sendHarnessId,
        sendIsOpenClawHarness ? agentId : undefined
      )}`,
      harnessId: sendHarnessId,
      agentId: sendIsOpenClawHarness ? agentId : undefined,
      modelId: sendModelId
    };

    updateActiveSessionViewMessages((current) => [...current, userMessage, assistantMessage]);
    setDraft("");
    setAttachments([]);
    setError(undefined);
    setIsSending(true);
    streamAbortRef.current = controller;

    let progressTimer: number | undefined;
    try {
      const progressStartedAt = Date.now();
      progressTimer = window.setInterval(() => {
        const elapsedSeconds = Math.max(1, Math.floor((Date.now() - progressStartedAt) / 1000));
        updateActiveSessionViewMessages((current) =>
          current.map((item) =>
            item.id === assistantId && item.status === "streaming" && !item.content
              ? {
                  ...item,
                  progressText: formatWaitingProgress(copy, elapsedSeconds, Boolean(item.runtimeRef), sendHarnessLabel)
                }
              : item
          )
        );
      }, 10_000);

      if (controller.signal.aborted) throw new DOMException(copy.stopped, "AbortError");

      await api.streamSessionChat(
        activeSessionView!.id,
        {
          message: content,
          attachments: outgoingAttachments,
          modelId: sendModelId || undefined,
          agentId: sendIsOpenClawHarness ? agentId || undefined : undefined,
          thinkingEffort: sendThinkingEffort,
          permissionMode: sendPermissionMode,
          includePlatformContext,
          mode: chatMode,
          roleScope,
          rebuildFromHivewardHistory
        },
        {
          onEvent: (event) => {
            applyChatEvent(assistantId, event, updateActiveSessionViewMessages, copy, sendHarnessId);
            if (event.type === "started" || event.type === "done") bindActiveSessionView(event, sendHarnessId);
            if (event.type === "inbox_item_created") onInboxItemCreated?.(event.item);
          }
        },
        controller.signal
      );
      setRebuildFromHivewardHistory(false);
      void loadChatSessions(activeSessionView!.id);
    } catch (streamError) {
      if (controller.signal.aborted) {
        updateActiveSessionViewMessages((current) =>
          current.map((item) =>
            item.id === assistantId
              ? { ...item, progressText: undefined, runtimeStatus: undefined, content: item.content || copy.stopped, status: "sent" }
              : item
          )
        );
        return;
      }
      const message = streamError instanceof Error ? streamError.message : copy.sendFailed;
      setError(message);
      updateActiveSessionViewMessages((current) =>
        current.map((item) =>
          item.id === assistantId
            ? { ...item, progressText: undefined, runtimeStatus: undefined, content: item.content || message, status: "failed" }
            : item
        )
      );
    } finally {
      if (progressTimer !== undefined) window.clearInterval(progressTimer);
      if (streamAbortRef.current === controller) streamAbortRef.current = null;
      setIsSending(false);
    }
  };

  const stopMessage = () => {
    streamAbortRef.current?.abort();
  };

  const addFiles = async (fileList: FileList | null) => {
    if (!fileList) return;
    const remainingSlots = Math.max(0, maxUploadFiles - attachments.length);
    const files = Array.from(fileList).slice(0, remainingSlots);
    const nextAttachments = await Promise.all(files.map(readChatAttachment));
    setAttachments((current) => [...current, ...nextAttachments]);
  };

  return (
    <section className={`page-grid chat-page-grid ${settingsCollapsed ? "chat-settings-collapsed" : ""}`}>
      <div className="trace-page-title chat-page-title">
        <div className="chat-page-title-copy">
          <h2>{copy.title}</h2>
          <p>
            {selectedRoleLabel}
            {titleBlueprint ? ` / ${titleBlueprint.name}` : company?.name ? ` / ${company.name}` : ""}
          </p>
        </div>
        <span
          className={`openclaw-panel-state ${
            selectedHarnessStatus?.connectionState === "connected" || selectedHarnessStatus?.connectionState === "available"
              ? "online"
              : "offline"
          }`}
        >
          <HarnessLabel {...harnessLikeDisplayParts(harnessId)} />
        </span>
      </div>

      <div className="chat-workspace">
        <div className={`chat-settings-column ${settingsCollapsed ? "collapsed" : ""}`}>
          <div className="chat-column-header chat-settings-column-header">
            {!settingsCollapsed && <h3>{copy.settings}</h3>}
            <button
              type="button"
              className="chat-settings-collapse-button"
              title={settingsCollapsed ? copy.expandSettings : copy.collapseSettings}
              aria-label={settingsCollapsed ? copy.expandSettings : copy.collapseSettings}
              onClick={() => setSettingsCollapsed((current) => !current)}
            >
              {settingsCollapsed ? <ChevronRight size={15} /> : <ChevronLeft size={15} />}
              <span>{settingsCollapsed ? copy.expandSettings : copy.collapseSettings}</span>
            </button>
          </div>

          <aside className={`content-card stack-card chat-settings-panel ${settingsCollapsed ? "collapsed" : ""}`} aria-label={copy.settings}>
            {settingsCollapsed ? (
              <div className="chat-settings-icon-rail" aria-label={copy.settings}>
                <button type="button" title={copy.harness} aria-label={copy.harness} onClick={() => setSettingsCollapsed(false)}>
                  <Wrench size={16} />
                </button>
                <button type="button" title={copy.role} aria-label={copy.role} onClick={() => setSettingsCollapsed(false)}>
                  <Bot size={16} />
                </button>
                {chatMode === "blueprint" && (
                  <button type="button" title={copy.blueprint} aria-label={copy.blueprint} onClick={() => setSettingsCollapsed(false)}>
                    <LayoutTemplate size={16} />
                  </button>
                )}
                {isOpenClawHarness && (
                  <button type="button" title={copy.agent} aria-label={copy.agent} onClick={() => setSettingsCollapsed(false)}>
                    <Bot size={16} />
                  </button>
                )}
                <button type="button" title={copy.sessionView} aria-label={copy.sessionView} onClick={() => setSettingsCollapsed(false)}>
                  <MessageSquareText size={16} />
                </button>
                <button type="button" title={copy.model} aria-label={copy.model} onClick={() => setSettingsCollapsed(false)}>
                  <Sparkles size={16} />
                </button>
                <button type="button" title={copy.thinking} aria-label={copy.thinking} onClick={() => setSettingsCollapsed(false)}>
                  <Brain size={16} />
                </button>
                <button type="button" title={copy.mode} aria-label={copy.mode} onClick={() => setSettingsCollapsed(false)}>
                  <LayoutTemplate size={16} />
                </button>
                {canConfigurePermission && (
                  <button type="button" title={copy.permission} aria-label={copy.permission} onClick={() => setSettingsCollapsed(false)}>
                    <ShieldCheck size={16} />
                  </button>
                )}
              </div>
            ) : (
              <div className="chat-settings-body">
                <ChatSelect
                  label={copy.harness}
                  icon={<Wrench size={14} />}
                  value={harnessId}
                  options={harnessOptions}
                  onChange={(value) => void selectHarness(value as HarnessId)}
                />

                <ChatSelect
                  label={copy.role}
                  icon={<Bot size={14} />}
                  value={selectedRole?.id ?? selectedRoleId}
                  options={roleOptions}
                  onChange={setSelectedRoleId}
                />

                {chatMode === "blueprint" && (
                  <ChatSelect
                    label={copy.blueprint}
                    icon={<LayoutTemplate size={14} />}
                    value={selectedBlueprintOptionValue}
                    options={blueprintOptions}
                    onChange={setSelectedBlueprintId}
                  />
                )}

                {isOpenClawHarness && (
                  <ChatSelect
                    label={copy.agent}
                    icon={<Bot size={14} />}
                    value={agentId}
                    options={agentOptions}
                    onChange={(value) => void selectAgent(value)}
                  />
                )}

                <ChatSelect
                  label={copy.sessionView}
                  icon={<MessageSquareText size={14} />}
                  value={activeSessionView?.id ?? ""}
                  options={sessionViewOptions}
                  onChange={selectSessionView}
                />

                <ChatSelect
                  label={copy.model}
                  icon={<Sparkles size={14} />}
                  value={modelId}
                  options={modelOptions}
                  onChange={setModelId}
                />

                <ChatSelect
                  label={copy.thinking}
                  icon={<Brain size={14} />}
                  value={effectiveThinkingEffort}
                  options={thinkingOptions}
                  onChange={(value) => setThinkingEffort(value as ChatThinkingEffort)}
                />

                <ChatSelect
                  label={copy.mode}
                  icon={<LayoutTemplate size={14} />}
                  value={chatMode}
                  options={modeOptions}
                  onChange={(value) => setChatMode(value as ChatMode)}
                />

                {canConfigurePermission && (
                  <div className={`chat-permission-field ${activePermissionMode === "full_access" ? "enabled" : ""}`}>
                    <ChatSelect
                      label={copy.permission}
                      icon={<ShieldCheck size={14} />}
                      value={activePermissionMode ?? "safe"}
                      options={permissionOptions}
                      onChange={(value) => void updateActiveSessionPermissionMode(value)}
                    />
                  </div>
                )}
              </div>
            )}
          </aside>
        </div>

        <div className="chat-window-column">
          <div className="chat-column-header chat-window-column-header">
            {titleEditing ? (
              <form
                className="chat-title-edit-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveSessionTitle();
                }}
              >
                <input
                  value={titleDraft}
                  aria-label={copy.editSessionTitle}
                  autoFocus
                  maxLength={120}
                  onChange={(event) => setTitleDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") cancelEditingTitle();
                  }}
                />
                <button type="submit" title={copy.saveSessionTitle} aria-label={copy.saveSessionTitle} disabled={titleSaving || !titleDraft.trim()}>
                  {titleSaving ? <Loader2 className="spin" size={14} /> : <Check size={14} />}
                </button>
                <button type="button" title={copy.cancelEditSessionTitle} aria-label={copy.cancelEditSessionTitle} onClick={cancelEditingTitle}>
                  <X size={14} />
                </button>
              </form>
            ) : (
              <div className="chat-title-display">
                <h3>{activeSessionView?.title || copy.noSessionView}</h3>
                <button type="button" title={copy.newSessionView} aria-label={copy.newSessionView} onClick={() => void createSessionView()}>
                  <Plus size={14} />
                </button>
                <button type="button" title={copy.editSessionTitle} aria-label={copy.editSessionTitle} onClick={startEditingTitle}>
                  <Pencil size={14} />
                </button>
                <button
                  type="button"
                  title={copy.endSession}
                  aria-label={copy.endSession}
                  disabled={!activeSessionView || activeSessionView.status === "ended"}
                  onClick={() => void endActiveSession()}
                >
                  <Square size={14} />
                </button>
              </div>
            )}
          </div>
          <section className="content-card chat-window-card" aria-label={activeSessionView?.title || copy.noSessionView}>
            <div className="chat-thread" ref={threadRef}>
              {messages.length === 0 ? (
                <div className="chat-empty-state">
                  <MessageSquareText size={22} />
                  <strong>{copy.emptyTitle}</strong>
                  <span>{copy.emptyBody}</span>
                </div>
              ) : (
                messages.map((message) => {
                  const visibleContent =
                    message.role === "assistant" ? stripHivewardInboxSubmissionBlocks(message.content) : message.content;
                  return (
                    <article
                      key={message.id}
                      className={`chat-message-row chat-message-row-${message.role} ${message.status ?? ""}`}
                    >
                      <div
                        className={`chat-avatar chat-avatar-${message.role}`}
                        aria-label={message.role === "user" ? copy.you : message.speakerLabel ?? copy.assistant}
                      >
                        {message.role === "user" ? copy.youAvatar : <Bot size={16} />}
                      </div>
                      <div className={`chat-message chat-message-${message.role} ${message.status ?? ""}`}>
                        {visibleContent ? <MarkdownRenderer value={visibleContent} className="chat-message-body" /> : null}
                        {shouldShowRuntimeStatus(message) && message.runtimeStatus ? (
                          <div className="chat-message-runtime-status">
                            <Loader2 className="spin" size={15} />
                            <span className="chat-runtime-status">
                              <span>{formatChatRuntimeStatusTitle(message.runtimeStatus, copy)}</span>
                              <span className="chat-runtime-label">{message.runtimeStatus.label}</span>
                            </span>
                          </div>
                        ) : null}
                        {!visibleContent && !shouldShowRuntimeStatus(message) ? (
                          <div className="chat-message-pending">
                            <Loader2 className="spin" size={15} />
                            {message.progressText ?? copy.waiting(formatHarnessLabel(message.harnessId ?? harnessId))}
                          </div>
                        ) : null}
                        {message.attachments?.length ? (
                          <div className="chat-message-attachments">
                            {message.attachments.map((attachment) => (
                              <span key={attachment.id}>
                                <FileUp size={13} />
                                {attachment.name}
                              </span>
                            ))}
                          </div>
                        ) : null}
                        {message.status === "failed" && <span className="chat-message-status">{copy.failed}</span>}
                        {message.runtimeRef?.timings ? (
                          <span className="chat-message-runtime">
                            {formatRuntimeTimings(message.runtimeRef.timings, message.runtimeRef.source, copy)}
                          </span>
                        ) : null}
                      </div>
                    </article>
                  );
                })
              )}
            </div>

            <div className="chat-composer">
              {sessionsLoading && <div className="chat-inline-error">{copy.sessionsLoading}</div>}
              {activeSessionView?.status === "native_missing" && (
                <div className="chat-inline-error">
                  {copy.nativeSessionMissing}
                  <button type="button" className="secondary-action" onClick={() => setRebuildFromHivewardHistory(true)}>
                    {rebuildFromHivewardHistory ? copy.rebuildFromHistoryEnabled : copy.rebuildFromHistory}
                  </button>
                </div>
              )}
              {activeSessionView?.status === "ended" && <div className="chat-inline-error">{copy.sessionEnded}</div>}
              {error && <div className="chat-inline-error">{error}</div>}
              {attachments.length > 0 && (
                <div className="chat-attachment-list">
                  {attachments.map((attachment) => (
                    <span key={attachment.id} className="chat-attachment-chip">
                      <Paperclip size={13} />
                      {attachment.name}
                      <small>{formatBytes(attachment.size)}</small>
                      <button
                        type="button"
                        title={copy.removeAttachment}
                        aria-label={copy.removeAttachment}
                        onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}
                      >
                        <Trash2 size={12} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="chat-composer-row">
                <label className="chat-file-button" title={copy.upload}>
                  <Paperclip size={16} />
                  <input
                    type="file"
                    multiple
                    hidden
                    onChange={(event) => {
                      void addFiles(event.target.files);
                      event.currentTarget.value = "";
                    }}
                  />
                </label>
                <textarea
                  ref={composerTextareaRef}
                  value={draft}
                  placeholder={copy.placeholder(selectedHarnessLabel)}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      if (!isSending) void sendMessage();
                    }
                  }}
                />
                <button
                  type="button"
                  className={`${isSending ? "danger-action chat-stop-button" : "primary-action"} chat-send-button`}
                  disabled={isSending ? false : !canSend}
                  onClick={() => {
                    if (isSending) {
                      stopMessage();
                      return;
                    }
                    void sendMessage();
                  }}
                >
                  {isSending ? <Square size={15} /> : <Send size={16} />}
                  {isSending ? copy.stop : copy.send}
                </button>
              </div>
            </div>
          </section>
        </div>
      </div>
    </section>
  );
}

function ChatSelect({
  label,
  icon,
  value,
  options,
  onChange
}: {
  label: string;
  icon: ReactNode;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const selectedOption = options.find((option) => option.value === value && option.variant !== "create");
  const selectedLabel = selectedOption?.label ?? options.find((option) => option.value === value)?.label ?? "";

  useEffect(() => {
    if (!open) return;

    const updateMenuPosition = () => {
      const button = buttonRef.current;
      if (!button) return;
      const rect = button.getBoundingClientRect();
      const gutter = 8;
      const viewportPadding = 10;
      const menuWidth = Math.min(320, Math.max(190, rect.width));
      const optionHeight = 38;
      const menuHeight = Math.min(280, options.length * optionHeight + 12);
      const spaceBelow = window.innerHeight - rect.top - viewportPadding;
      const spaceAbove = rect.bottom - viewportPadding;
      const openDown = spaceBelow >= menuHeight || spaceBelow >= spaceAbove;
      const top = openDown
        ? Math.min(rect.top, window.innerHeight - menuHeight - viewportPadding)
        : Math.max(viewportPadding, rect.bottom - menuHeight);
      const preferredLeft = rect.right + gutter;
      const left = Math.min(Math.max(viewportPadding, preferredLeft), window.innerWidth - menuWidth - viewportPadding);
      setMenuStyle({
        left,
        top,
        width: menuWidth,
        maxHeight: Math.min(menuHeight, window.innerHeight - viewportPadding * 2)
      });
    };

    updateMenuPosition();
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);
    return () => {
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (rootRef.current?.contains(target) || menuRef.current?.contains(target))) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);

  return (
    <div
      ref={rootRef}
      className="chat-select-field"
    >
      <span className="chat-control-label">
        {icon}
        {label}
      </span>
      <div className="chat-select-shell">
        <button
          ref={buttonRef}
          type="button"
          className={`chat-select-button ${open ? "open" : ""}`}
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          <span className="chat-select-value">
            <strong>
              <HarnessLabel label={selectedLabel} badgeLabel={selectedOption?.badgeLabel} />
            </strong>
          </span>
          <ChevronDown className="chat-select-arrow" size={15} />
        </button>
        {open && typeof document !== "undefined" && createPortal(
          <div ref={menuRef} className="chat-select-menu" role="listbox" aria-label={label} style={menuStyle}>
            {options.map((option) => {
              const selected = option.value === value && option.variant !== "create";
              return (
                <button
                  key={option.value}
                  type="button"
                  className={`chat-select-option ${selected ? "selected" : ""} ${option.variant === "create" ? "create" : ""}`}
                  role="option"
                  aria-selected={selected}
                  disabled={option.disabled}
                  onClick={() => {
                    if (option.disabled) return;
                    onChange(option.value);
                    setOpen(false);
                  }}
                >
                  <span className="chat-select-option-main">
                    {option.variant === "create" && <Plus size={14} />}
                    <HarnessLabel label={option.label} badgeLabel={option.badgeLabel} />
                    {option.meta && <small>{option.meta}</small>}
                  </span>
                  {selected && <Check size={14} />}
                </button>
              );
            })}
          </div>,
          document.body
        )}
      </div>
    </div>
  );
}

function applyChatEvent(
  assistantId: string,
  event: ChatStreamEvent,
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>,
  copy: ReturnType<typeof chatCopy>,
  fallbackHarnessId: HarnessId
) {
  if (event.type === "delta") {
    setMessages((current) =>
      current.map((message) =>
        message.id === assistantId
          ? {
              ...message,
              content: event.replace ? event.text : `${message.content}${event.text}`,
              progressText: undefined
            }
          : message
      )
    );
    return;
  }

  if (event.type === "runtime_state") {
    setMessages((current) =>
      current.map((message) =>
        message.id === assistantId
          ? { ...message, runtimeStatus: toChatRuntimeStatus(event) }
          : message
      )
    );
    return;
  }

  if (event.type === "started") {
    const harnessLabel = formatHarnessLabel(event.source || fallbackHarnessId);
    setMessages((current) =>
      current.map((message) =>
        message.id === assistantId
          ? {
              ...message,
              progressText: message.content ? undefined : copy.acceptedWaiting(harnessLabel),
              runtimeStatus: undefined,
              runtimeRef: toRuntimeRef(event)
            }
          : message
      )
    );
    return;
  }

  if (event.type === "done") {
    setMessages((current) =>
      current.map((message) =>
        message.id === assistantId
          ? {
              ...message,
              progressText: undefined,
              runtimeStatus: undefined,
              content: message.content || event.output || event.error || "",
              status: event.status === "failed" || event.status === "cancelled" ? "failed" : "sent",
              runtimeRef: toRuntimeRef(event)
            }
          : message
      )
    );
    return;
  }

  if (event.type === "inbox_item_created") {
    return;
  }

  setMessages((current) =>
    current.map((message) =>
      message.id === assistantId
        ? { ...message, progressText: undefined, runtimeStatus: undefined, content: message.content || event.message, status: "failed" }
        : message
    )
  );
}

function formatWaitingProgress(
  copy: ReturnType<typeof chatCopy>,
  elapsedSeconds: number,
  accepted: boolean,
  harnessLabel: string
): string {
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  const elapsed = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
  return `${accepted ? copy.acceptedWaiting(harnessLabel) : copy.waiting(harnessLabel)} ${elapsed}`;
}

function formatChatRuntimeStatusTitle(status: ChatRuntimeStatusView, copy: ReturnType<typeof chatCopy>): string {
  if (status.phase === "command") return copy.runtimeCommand;
  if (status.phase === "tool") return copy.runtimeTool;
  return copy.runtimeThinking;
}

function formatRuntimeTimings(timings: ChatStreamTimings, source: string, copy: ReturnType<typeof chatCopy>): string {
  const hivewardMs = timings.hivewardPreprocessMs + timings.hivewardPostprocessMs;
  const runtimeMs = timings.runtimeMs ?? timings.openclawMs ?? 0;
  const runtimeAcceptedMs = timings.runtimeAcceptedMs ?? timings.openclawAcceptedMs;
  const runtimeFirstDeltaMs = timings.runtimeFirstDeltaMs ?? timings.openclawFirstDeltaMs;
  const harnessDetails = [
    `${formatHarnessLabel(source)} ${formatDurationMs(runtimeMs)}`,
    runtimeAcceptedMs === undefined ? undefined : `${copy.timingAccepted} ${formatDurationMs(runtimeAcceptedMs)}`,
    runtimeFirstDeltaMs === undefined ? undefined : `${copy.timingFirstToken} ${formatDurationMs(runtimeFirstDeltaMs)}`
  ].filter((item): item is string => Boolean(item));
  return `${copy.timingTotal} ${formatDurationMs(timings.totalMs)} · ${harnessDetails.join(" / ")} · ${copy.timingHiveward} ${formatDurationMs(hivewardMs)}`;
}

function formatDurationMs(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}s`;
  return `${Math.max(0, Math.round(value))}ms`;
}

function stripHivewardInboxSubmissionBlocks(content: string): string {
  return content
    .replace(/```hiveward-inbox\s*[\s\S]*?```/gi, "")
    .replace(/(?:^|\n)\s*(?:#{1,6}\s*)?hiveward-inbox\s*\n```(?:json)?\s*[\s\S]*?```/gi, "")
    .replace(/(?:^|\n)\s*(?:#{1,6}\s*)?hiveward-inbox\s*\n\{[\s\S]*\}\s*$/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function toRuntimeRef(event: Extract<ChatStreamEvent, { type: "started" | "done" }>): ChatRuntimeRef {
  return {
    taskId: event.taskId,
    runId: event.runId,
    sessionKey: event.sessionKey,
    source: event.source,
    status: event.status,
    updatedAt: event.updatedAt,
    error: "error" in event ? event.error : undefined,
    usage: "usage" in event ? event.usage : undefined,
    timings: "timings" in event ? event.timings : undefined
  };
}

function decorateHivewardMessage(message: HivewardChatMessage, copy: ReturnType<typeof chatCopy>): ChatMessage {
  return {
    ...message,
    status: message.status,
    speakerLabel: message.role === "user" ? copy.you : formatHarnessLabel(message.harnessId)
  };
}

function readNativeSessionOptionValue(value: string): string | undefined {
  if (value.startsWith(nativeSessionOptionPrefix)) return value.slice(nativeSessionOptionPrefix.length);
  if (value.startsWith(legacyNativeSessionOptionPrefix)) return value.slice(legacyNativeSessionOptionPrefix.length);
  return undefined;
}

function readAgentIdFromSessionKey(sessionKey: string): string | undefined {
  if (sessionKey === "main") return "main";
  const match = /^agent:([^:]+):/.exec(sessionKey);
  return match?.[1];
}

function isVisibleSessionView(sessionView: HivewardSessionView, agentId: string): boolean {
  if (sessionView.harnessId !== "openclaw") return true;
  const selectedAgentId = normalizeSessionAgentId(agentId);
  if (sessionView.agentId) return normalizeSessionAgentId(sessionView.agentId) === selectedAgentId;
  if (!sessionView.nativeSessionId) return true;
  const parsed = parseAgentSessionKey(sessionView.nativeSessionId);
  return parsed ? normalizeSessionAgentId(parsed.agentId) === selectedAgentId : selectedAgentId === "main";
}

function isVisibleNativeChatSessionKey(sessionKey: string, agentId: string): boolean {
  const selectedAgentId = normalizeSessionAgentId(agentId);
  if (sessionKey === "main") return selectedAgentId === "main";
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed) return false;
  if (normalizeSessionAgentId(parsed.agentId) !== selectedAgentId) return false;
  return isPrimaryChatSessionRest(parsed.rest);
}

function parseAgentSessionKey(sessionKey: string): { agentId: string; rest: string } | undefined {
  const match = /^agent:([^:]+):(.+)$/.exec(sessionKey);
  return match ? { agentId: match[1]!, rest: match[2]! } : undefined;
}

function isPrimaryChatSessionRest(rest: string): boolean {
  return rest === "main" || rest.startsWith("dashboard:");
}

function normalizeSessionAgentId(agentId: string | undefined): string {
  return (agentId || "main").trim().toLowerCase() || "main";
}

function formatNativeSessionLabel(session: { id: string; title: string }): string {
  if (session.title && session.title !== session.id) return session.title;
  const parsed = parseAgentSessionKey(session.id);
  if (parsed) return parsed.rest;
  return session.title || session.id;
}

function buildRoleOptions(
  roleDirectory: CompanyRoleDirectory | undefined,
  blueprints: BlueprintDefinition[],
  copy: ReturnType<typeof chatCopy>
): SelectOption[] {
  if (!roleDirectory) {
    return [{ value: "ceo", label: copy.ceoRole, meta: copy.companyRole }];
  }
  const blueprintNames = new Map(blueprints.map((blueprint) => [blueprint.id, blueprint.name]));
  return [
    {
      value: roleDirectory.ceo.id,
      label: roleDirectory.ceo.label || copy.ceoRole,
      meta: copy.companyRole
    },
    ...roleDirectory.leaders.map((leader) => ({
      value: leader.id,
      label: leader.label,
      meta: leader.blueprintId ? blueprintNames.get(leader.blueprintId) ?? leader.blueprintId : copy.blueprintRole
    }))
  ];
}

function buildBlueprintOptions(
  role: CompanyRoleDirectory["ceo"] | CompanyRoleDirectory["leaders"][number] | undefined,
  blueprints: BlueprintDefinition[],
  copy: ReturnType<typeof chatCopy>
): SelectOption[] {
  if (role?.kind === "leader") {
    if (!role.blueprintId) {
      return [{ value: newBlueprintOptionValue, label: copy.noBlueprint, disabled: true }];
    }
    const blueprint = blueprints.find((item) => item.id === role.blueprintId);
    return [{
      value: role.blueprintId,
      label: blueprint?.name ?? role.blueprintId,
      meta: copy.blueprintRole
    }];
  }
  return [
    { value: newBlueprintOptionValue, label: copy.newBlueprint, variant: "create" },
    ...blueprints.map((blueprint) => ({
      value: blueprint.id,
      label: blueprint.name,
      meta: blueprint.description || copy.blueprintRole
    }))
  ];
}

function resolveBlueprintSelection(
  role: CompanyRoleDirectory["ceo"] | CompanyRoleDirectory["leaders"][number] | undefined,
  selectedBlueprintId: string,
  blueprints: BlueprintDefinition[]
): string {
  if (role?.kind === "leader") return role.blueprintId ?? newBlueprintOptionValue;
  if (
    selectedBlueprintId !== newBlueprintOptionValue &&
    blueprints.length > 0 &&
    !blueprints.some((blueprint) => blueprint.id === selectedBlueprintId)
  ) {
    return newBlueprintOptionValue;
  }
  return selectedBlueprintId || newBlueprintOptionValue;
}

function readSelectedBlueprintScopeId(selectedBlueprintId: string): string | undefined {
  return selectedBlueprintId === newBlueprintOptionValue ? undefined : selectedBlueprintId;
}

function buildChatRoleScope(
  selectedCompanyId: string | undefined,
  role: CompanyRoleDirectory["ceo"] | CompanyRoleDirectory["leaders"][number] | undefined,
  selectedBlueprintId?: string
): ChatRoleScope | undefined {
  if (!role) return undefined;
  return {
    companyId: selectedCompanyId,
    role: role.kind,
    leaderId: role.kind === "leader" ? role.id : undefined,
    blueprintId: role.kind === "leader" ? role.blueprintId : selectedBlueprintId
  };
}

function buildHarnessModelOptions(
  harnessId: HarnessId,
  harnessStatus: HarnessStatus | undefined,
  openClawModelOptions: SelectOption[],
  copy: ReturnType<typeof chatCopy>
): SelectOption[] {
  if (harnessId === "openclaw") return openClawModelOptions;
  const defaultModelId = harnessStatus?.defaultModelId;
  const scannedOptions = harnessStatus?.models?.length
    ? harnessStatus.models.map((model) => ({
        value: model.id,
        label: model.id === "inherit" ? `${formatHarnessLabel(harnessId)} ${copy.defaultModel}` : model.label || model.id,
        meta: model.provider ?? harnessStatus.label,
        thinkingLevels: model.thinkingLevels?.length ? model.thinkingLevels : getSdkHarnessThinkingLevels(harnessId)
      }))
    : [];
  if (scannedOptions.length) return mergeOptions(scannedOptions);
  if (!defaultModelId) return [];
  return mergeOptions([
    {
      value: defaultModelId,
      label: defaultModelId === "inherit" ? `${formatHarnessLabel(harnessId)} ${copy.defaultModel}` : defaultModelId,
      meta: harnessStatus.label,
      thinkingLevels: getSdkHarnessThinkingLevels(harnessId)
    }
  ]);
}

function getSdkHarnessThinkingLevels(harnessId: HarnessId): ChatThinkingEffort[] {
  if (harnessId === "codex") return ["low", "medium", "high", "xhigh"];
  if (harnessId === "claudeCode") return ["off", "low", "medium", "high", "xhigh", "max", "adaptive"];
  if (harnessId === "google" || harnessId === "cursor" || harnessId === "opencode" || harnessId === "hermes") return ["off", "minimal", "low", "medium", "high", "xhigh"];
  return fallbackThinkingLevels;
}

function buildOpenClawModelOptions(catalog?: CatalogSnapshot, openClawConfig?: OpenClawConfigState): SelectOption[] {
  const catalogModelsById = new Map((catalog?.models ?? []).map((model) => [model.id, model]));
  const options = [
    ...(openClawConfig?.configuredModels.map((model) => ({
      value: model.id,
      label: model.label || model.id,
      meta: model.provider,
      thinkingLevels: model.thinkingLevels ?? catalogModelsById.get(model.id)?.thinkingLevels
    })) ?? []),
    ...(catalog?.models.map((model) => ({
      value: model.id,
      label: model.label || model.id,
      meta: model.provider,
      thinkingLevels: model.thinkingLevels
    })) ?? [])
  ];
  const defaultModel = openClawConfig?.defaultModelId ? catalogModelsById.get(openClawConfig.defaultModelId) : undefined;
  return mergeOptions(
    options,
    openClawConfig?.defaultModelId
      ? [{
          value: openClawConfig.defaultModelId,
          label: defaultModel?.label ?? openClawConfig.defaultModelId,
          meta: defaultModel?.provider,
          thinkingLevels: defaultModel?.thinkingLevels
        }]
      : []
  );
}

function buildAgentOptions(catalog?: CatalogSnapshot, openClawConfig?: OpenClawConfigState): SelectOption[] {
  const options = [
    ...(openClawConfig?.configuredAgents.map((agent) => ({
      value: agent.id,
      label: agent.name || agent.id
    })) ?? []),
    ...(catalog?.agents.map((agent) => ({
      value: agent.id,
      label: agent.label || agent.id
    })) ?? [])
  ];
  return mergeOptions(options, [{ value: "main", label: "main" }]);
}

function mergeOptions(primary: SelectOption[], fallbacks: SelectOption[] = []): SelectOption[] {
  const merged: SelectOption[] = [];
  const indexesByValue = new Map<string, number>();
  for (const option of [...primary, ...fallbacks]) {
    if (!option.value) continue;
    const existingIndex = indexesByValue.get(option.value);
    if (existingIndex === undefined) {
      indexesByValue.set(option.value, merged.length);
      merged.push(option);
      continue;
    }
    const existing = merged[existingIndex]!;
    merged[existingIndex] = {
      ...existing,
      meta: existing.meta ?? option.meta,
      thinkingLevels: existing.thinkingLevels ?? option.thinkingLevels
    };
  }
  return merged;
}

const fallbackThinkingLevels: ChatThinkingEffort[] = ["off", "minimal", "low", "medium", "high"];
const thinkingEffortRank: Record<ChatThinkingEffort, number> = {
  off: 0,
  minimal: 10,
  low: 20,
  medium: 30,
  high: 40,
  adaptive: 50,
  xhigh: 60,
  max: 70
};

function buildThinkingOptions(
  thinkingLevels: ChatThinkingEffort[] | undefined,
  copy: ReturnType<typeof chatCopy>
): SelectOption[] {
  return normalizeThinkingLevels(thinkingLevels).map((level) => ({
    value: level,
    label: formatThinkingEffortLabel(level, copy)
  }));
}

function normalizeThinkingLevels(thinkingLevels: ChatThinkingEffort[] | undefined): ChatThinkingEffort[] {
  const levels = thinkingLevels?.length ? thinkingLevels : fallbackThinkingLevels;
  return [...new Set(levels)].sort((left, right) => thinkingEffortRank[left] - thinkingEffortRank[right]);
}

function resolveSupportedThinkingEffort(
  availableLevels: ChatThinkingEffort[],
  requestedLevel: ChatThinkingEffort
): ChatThinkingEffort {
  const levels = normalizeThinkingLevels(availableLevels);
  if (levels.includes(requestedLevel)) return requestedLevel;
  const requestedRank = thinkingEffortRank[requestedLevel];
  const rankedAscending = levels.filter((level) => level !== "off").sort((left, right) => thinkingEffortRank[left] - thinkingEffortRank[right]);
  return [...rankedAscending].reverse().find((level) => thinkingEffortRank[level] <= requestedRank)
    ?? rankedAscending[0]
    ?? "off";
}

function formatThinkingEffortLabel(level: ChatThinkingEffort, copy: ReturnType<typeof chatCopy>): string {
  if (level === "off") return copy.thinkingOff;
  if (level === "minimal") return copy.thinkingMinimal;
  if (level === "low") return copy.thinkingLow;
  if (level === "medium") return copy.thinkingMedium;
  if (level === "high") return copy.thinkingHigh;
  if (level === "adaptive") return copy.thinkingAdaptive;
  if (level === "max") return copy.thinkingMax;
  return copy.thinkingXHigh;
}

async function readChatAttachment(file: File): Promise<ChatAttachment> {
  const shouldReadText = isReadableTextFile(file);
  let text: string | undefined;
  let truncated = false;

  if (shouldReadText) {
    const raw = await file.text();
    text = raw.slice(0, maxReadableFileChars);
    truncated = raw.length > maxReadableFileChars;
  }

  return {
    id: makeLocalId("chat-file"),
    name: file.name,
    mediaType: file.type || "application/octet-stream",
    size: file.size,
    text,
    truncated
  };
}

function isReadableTextFile(file: File): boolean {
  return (
    file.type.startsWith("text/") ||
    /\.(css|csv|html?|json|log|md|mdx|ts|tsx|js|jsx|txt|xml|ya?ml)$/i.test(file.name)
  );
}

function deriveSessionViewTitle(sessionView: HivewardSessionView, messages: ChatMessage[], copy: ReturnType<typeof chatCopy>): string {
  if (sessionView.messages.length > 0 && sessionView.title !== copy.newSessionViewTitle) return sessionView.title;
  const firstUserMessage = messages.find((message) => message.role === "user")?.content.trim();
  if (!firstUserMessage) return sessionView.title || copy.newSessionViewTitle;
  return firstUserMessage.length > 24 ? `${firstUserMessage.slice(0, 24)}...` : firstUserMessage;
}

function formatHarnessSpeaker(harnessId: string, agentId?: string): string {
  const harnessLabel = formatHarnessLabel(harnessId);
  return agentId ? `${harnessLabel} / ${agentId}` : harnessLabel;
}

function formatHarnessLabel(harnessId: string): string {
  return harnessLikeDisplayLabel(harnessId);
}

function resolveHarnessPermissionMode(
  harnessId: HarnessId,
  harnessPermissionModes: Partial<Record<HarnessId, ChatPermissionMode>> | undefined,
  session?: HivewardChatSession
): ChatPermissionMode | undefined {
  if (!supportsChatPermissionMode(harnessId)) return undefined;
  return session?.permissionMode ?? harnessPermissionModes?.[harnessId] ?? "safe";
}

function supportsChatPermissionMode(harnessId: HarnessId): boolean {
  return harnessId === "codex" || harnessId === "claudeCode" || harnessId === "google" || harnessId === "cursor" || harnessId === "opencode" || harnessId === "hermes";
}

function formatHarnessStatusMeta(status: HarnessStatus | undefined, copy: ReturnType<typeof chatCopy>): string {
  if (!status) return copy.harnessUnknown;
  if (status.connectionState === "connected") return copy.harnessConnected;
  if (status.connectionState === "available") return copy.harnessAvailable;
  if (status.connectionState === "needs_config") return copy.harnessNeedsConfig;
  return copy.harnessUnavailable;
}

function formatBytes(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} MB`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)} KB`;
  return `${value} B`;
}

function makeLocalId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function chatCopy(language: Language) {
  if (language === "zh-CN") {
    return {
      title: "\u804a\u5929",
      settings: "\u8bbe\u7f6e\u9762\u677f",
      collapseSettings: "\u6536\u8d77",
      expandSettings: "\u5c55\u5f00",
      sessionView: "\u4f1a\u8bdd",
      noSessionView: "\u6682\u65e0\u4f1a\u8bdd",
      sessionsLoading: "\u6b63\u5728\u8bfb\u53d6\u4f1a\u8bdd",
      editSessionTitle: "\u4fee\u6539\u4f1a\u8bdd\u540d\u79f0",
      saveSessionTitle: "\u4fdd\u5b58\u4f1a\u8bdd\u540d\u79f0",
      cancelEditSessionTitle: "\u53d6\u6d88\u4fee\u6539",
      titleUpdateFailed: "\u4fee\u6539\u4f1a\u8bdd\u540d\u79f0\u5931\u8d25\u3002",
      endSession: "\u7ed3\u675f\u4f1a\u8bdd",
      ended: "\u5df2\u7ed3\u675f",
      sessionEnded: "\u8fd9\u4e2a\u4f1a\u8bdd\u5df2\u7ed3\u675f\uff0c\u9700\u8981\u65b0\u5efa\u4f1a\u8bdd\u540e\u7ee7\u7eed\u3002",
      sessionEndFailed: "\u7ed3\u675f\u4f1a\u8bdd\u5931\u8d25\u3002",
      newSessionView: "\u65b0\u4f1a\u8bdd",
      newSessionViewTitle: "\u65b0\u804a\u5929",
      messagesUnit: "\u6761\u6d88\u606f",
      nativeSessionBound: "\u5df2\u7ed1\u5b9a\u539f\u751f\u4f1a\u8bdd",
      nativeSessionDraft: "\u8349\u7a3f\u89c6\u56fe",
      nativeSessionMissing: "\u539f\u751f\u4f1a\u8bdd\u4e0d\u53ef\u6062\u590d\uff0c\u53ea\u80fd\u67e5\u770b HiveWard \u5386\u53f2\u6216\u660e\u786e\u7528\u5386\u53f2\u91cd\u5efa\u4e0a\u4e0b\u6587\u3002",
      rebuildFromHistory: "\u7528 HiveWard \u5386\u53f2\u91cd\u5efa",
      rebuildFromHistoryEnabled: "\u4e0b\u6b21\u53d1\u9001\u5c06\u91cd\u5efa",
      historyLoading: "\u6b63\u5728\u8bfb\u53d6\u539f\u751f\u5386\u53f2",
      historyLoadFailed: "\u8bfb\u53d6\u539f\u751f\u5386\u53f2\u5931\u8d25\u3002",
      sessionCreateFailed: "\u65b0\u5efa\u4f1a\u8bdd\u5931\u8d25\u3002",
      contextSummary: "\u4e0a\u4e0b\u6587\u6982\u89c8",
      noAgent: "\u672a\u9009 Agent",
      noModel: "\u672a\u9009\u6a21\u578b",
      defaultModel: "\u9ed8\u8ba4\u6a21\u578b",
      harness: "Harness",
      harnessConnected: "\u5df2\u8fde\u63a5",
      harnessAvailable: "\u53ef\u7528",
      harnessNeedsConfig: "\u9700\u8981\u914d\u7f6e",
      harnessUnavailable: "\u4e0d\u53ef\u7528",
      harnessUnknown: "\u72b6\u6001\u672a\u77e5",
      soon: "\u7a0d\u540e",
      role: "\u89d2\u8272",
      ceoRole: "CEO",
      companyRole: "\u516c\u53f8\u7ea7",
      blueprintRole: "\u4e1a\u52a1\u84dd\u56fe",
      blueprint: "\u84dd\u56fe",
      newBlueprint: "\u65b0\u84dd\u56fe",
      noBlueprint: "\u672a\u7ed1\u5b9a\u84dd\u56fe",
      agent: "Agent",
      model: "\u6a21\u578b",
      thinking: "\u601d\u8003\u5f3a\u5ea6",
      thinkingOff: "\u5173\u95ed",
      thinkingMinimal: "\u6700\u5c0f",
      thinkingLow: "\u4f4e",
      thinkingMedium: "\u4e2d",
      thinkingHigh: "\u9ad8",
      thinkingAdaptive: "\u81ea\u9002\u5e94",
      thinkingXHigh: "\u6781\u9ad8",
      thinkingMax: "\u6700\u5927",
      permission: "\u6743\u9650",
      permissionSafe: "\u5b89\u5168\u6a21\u5f0f",
      permissionFull: "\u5168\u6743\u9650",
      permissionUpdateFailed: "\u4f1a\u8bdd\u6743\u9650\u66f4\u65b0\u5931\u8d25\u3002",
      mode: "\u6a21\u5f0f",
      modeChat: "\u804a\u5929",
      modeBlueprint: "\u6784\u5efa\u84dd\u56fe",
      modeSkillSplit: "\u62c6\u5206 Skill",
      emptyTitle: "\u7b49\u5f85\u6d88\u606f",
      emptyBody: "\u5f53\u524d\u89c6\u56fe\u8fd8\u6ca1\u6709\u6d88\u606f\u3002",
      you: "\u4f60",
      youAvatar: "\u4f60",
      assistant: "Harness",
      streaming: "\u8f93\u51fa\u4e2d",
      failed: "\u5931\u8d25",
      waiting: (harnessLabel: string) => `\u7b49\u5f85 ${harnessLabel} \u8fd4\u56de...`,
      acceptedWaiting: (harnessLabel: string) => `\u5df2\u53d1\u7ed9 ${harnessLabel}\uff0c\u7b49\u5f85\u6a21\u578b\u6216\u5de5\u5177\u5b8c\u6210...`,
      runtimeThinking: "\u6b63\u5728\u5904\u7406...",
      runtimeTool: "\u6b63\u5728\u4f7f\u7528\u5de5\u5177...",
      runtimeCommand: "\u6b63\u5728\u6267\u884c\u547d\u4ee4...",
      usageSummary: "\u6a21\u578b\u548c Token \u6d88\u8017",
      usageModel: "\u6a21\u578b",
      usageTokens: "Token \u6d88\u8017",
      tokensUnit: "tokens",
      runtimeError: "\u8fd0\u884c\u9519\u8bef",
      runtimeSucceeded: "\u6210\u529f",
      runtimeFailed: "\u5931\u8d25",
      runtimeCancelled: "\u5df2\u53d6\u6d88",
      runtimeQueued: "\u6392\u961f\u4e2d",
      runtimeRunning: "\u8fd0\u884c\u4e2d",
      timingTotal: "\u603b\u8017\u65f6",
      timingHiveward: "Hiveward",
      timingAccepted: "\u63a5\u53d7",
      timingFirstToken: "\u9996\u6bb5",
      attachmentOnlyMessage: "\u5df2\u4e0a\u4f20\u6587\u4ef6",
      removeAttachment: "\u79fb\u9664\u9644\u4ef6",
      upload: "\u4e0a\u4f20\u6587\u4ef6",
      placeholder: (harnessLabel: string) => `\u53d1\u9001\u7ed9 ${harnessLabel}\uff0cShift+Enter \u6362\u884c...`,
      stop: "\u505c\u6b62",
      stopped: "\u5df2\u505c\u6b62",
      send: "\u53d1\u9001",
      sendFailed: "\u53d1\u9001\u5931\u8d25\u3002"
    };
  }

  return {
    title: "Chat",
    settings: "Settings panel",
    collapseSettings: "Collapse",
    expandSettings: "Expand",
    sessionView: "Chat session",
    noSessionView: "No session",
    sessionsLoading: "Loading sessions",
    editSessionTitle: "Edit session title",
    saveSessionTitle: "Save session title",
    cancelEditSessionTitle: "Cancel title edit",
    titleUpdateFailed: "Failed to update session title.",
    endSession: "End session",
    ended: "ended",
    sessionEnded: "This session has ended. Create a new session to continue.",
    sessionEndFailed: "Failed to end session.",
    newSessionView: "New session",
    newSessionViewTitle: "New chat",
    messagesUnit: "messages",
    nativeSessionBound: "Native session bound",
    nativeSessionDraft: "Draft view",
    nativeSessionMissing: "The native session is not recoverable. HiveWard history remains available.",
    rebuildFromHistory: "Use HiveWard history",
    rebuildFromHistoryEnabled: "History rebuild enabled",
    historyLoading: "Loading native history",
    historyLoadFailed: "Failed to load native history.",
    sessionCreateFailed: "Failed to create a chat session.",
    contextSummary: "Context summary",
    noAgent: "No agent",
    noModel: "No model",
    defaultModel: "default model",
    harness: "Harness",
    harnessConnected: "connected",
    harnessAvailable: "available",
    harnessNeedsConfig: "needs config",
    harnessUnavailable: "unavailable",
    harnessUnknown: "unknown",
    soon: "soon",
    role: "Role",
    ceoRole: "CEO",
    companyRole: "Company",
    blueprintRole: "Business blueprint",
    blueprint: "Blueprint",
    newBlueprint: "New blueprint",
    noBlueprint: "No blueprint",
    agent: "Agent",
    model: "Model",
    thinking: "Thinking",
    thinkingOff: "Off",
    thinkingMinimal: "Minimal",
    thinkingLow: "Low",
    thinkingMedium: "Medium",
    thinkingHigh: "High",
    thinkingAdaptive: "Adaptive",
    thinkingXHigh: "Extra high",
    thinkingMax: "Max",
    permission: "Permission",
    permissionSafe: "Safe mode",
    permissionFull: "Full access",
    permissionUpdateFailed: "Failed to update session permission.",
    mode: "Mode",
    modeChat: "Chat",
    modeBlueprint: "Build blueprint",
    modeSkillSplit: "Split skill",
    emptyTitle: "Waiting for messages",
    emptyBody: "This session has no messages yet.",
    you: "You",
    youAvatar: "You",
    assistant: "Harness",
    streaming: "Streaming",
    failed: "Failed",
    waiting: (harnessLabel: string) => `Waiting for ${harnessLabel}...`,
    acceptedWaiting: (harnessLabel: string) => `Sent to ${harnessLabel}. Waiting for the model or tools to finish...`,
    runtimeThinking: "Working...",
    runtimeTool: "Using tools...",
    runtimeCommand: "Running command...",
    usageSummary: "Model and token usage",
    usageModel: "Model",
    usageTokens: "Token usage",
    tokensUnit: "tokens",
    runtimeError: "Runtime error",
    runtimeSucceeded: "succeeded",
    runtimeFailed: "failed",
    runtimeCancelled: "cancelled",
    runtimeQueued: "queued",
    runtimeRunning: "running",
    timingTotal: "Total",
    timingHiveward: "Hiveward",
    timingAccepted: "accepted",
    timingFirstToken: "first chunk",
    attachmentOnlyMessage: "Uploaded files",
    removeAttachment: "Remove attachment",
    upload: "Upload files",
    placeholder: (harnessLabel: string) => `Send to ${harnessLabel}, Shift+Enter for a new line...`,
    stop: "Stop",
    stopped: "Stopped",
    send: "Send",
    sendFailed: "Failed to send message."
  };
}
