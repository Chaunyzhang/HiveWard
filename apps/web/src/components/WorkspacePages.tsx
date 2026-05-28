import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import {
  Activity,
  ArrowLeft,
  BadgeCheck,
  Check,
  ChevronRight,
  Clock3,
  Database,
  FolderKanban,
  KeyRound,
  LayoutTemplate,
  Loader2,
  MessageSquareText,
  PanelsTopLeft,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Send,
  Trash2,
  X
} from "lucide-react";
import type {
  CatalogSnapshot,
  ConfigureOpenClawChannelRequest,
  ConfigureOpenClawModelAuthRequest,
  CompanyDirectoryResponse,
  CreateCompanyRequest,
  OpenClawChannelSetupOption,
  OpenClawConfigWizardMetadata,
  OpenClawConfigState,
  OpenClawModelUsageSummary,
  OpenClawWizardField,
  OpenClawWizardValue,
  CompanyOverview,
  DashboardWidget,
  DashboardWidgetType,
  InboxItem,
  PendingApprovalItem,
  RuntimeOverview,
  UpdateCompanyRequest,
  WorkspaceDashboard,
  BlueprintDefinition,
  BlueprintNode,
  BlueprintNodeEvent,
  BlueprintNodeRun,
  BlueprintNodeRunStatus,
  BlueprintRunStatus,
  BlueprintRunView
} from "@hiveward/shared";
import type { Language, Messages } from "../lib/i18n";
import {
  isTerminalBlueprintRunStatus,
  readAcknowledgedTerminalRunIds,
  resolveBlueprintActivityState,
  resolveRunViewDisplayStatus,
  writeAcknowledgedTerminalRunIds
} from "../lib/run-state";
import { harnessLikeDisplayLabel } from "../lib/harness-labels";
import { formatWorkspacePathPlaceholder, joinWorkspacePath } from "../lib/workspace-path";
import { MarkdownRenderer } from "./MarkdownRenderer";

type TraceIssueStatus = "completed" | "in_progress" | "pending" | "failed";
type IdentityKind = "model" | "agent" | "channel" | "provider";

type IdentitySpec = {
  key: string;
  label: string;
  initials: string;
  logoUrl?: string;
};

const OPENAI_PRODUCT_ICON =
  "https://images.ctfassets.net/j22is2dtoxu1/intercom-img-d177d076c9a5453052925143/49d5d812b0a6fcc20a14faa8c629d9fb/icon-ios-1024_401x.png";
const OPENCLAW_ICON = "/favicon.svg";

function lobeIcon(name: string): string {
  return `https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/${name}.svg`;
}

function simpleIcon(name: string): string {
  return `https://cdn.simpleicons.org/${name}`;
}

const KNOWN_IDENTITIES: Record<string, { label: string; initials: string; logoUrl?: string }> = {
  anthropic: { label: "Anthropic", initials: "A", logoUrl: lobeIcon("claude-color") },
  arcee: { label: "Arcee", initials: "AR", logoUrl: lobeIcon("arcee-color") },
  baidu: { label: "Baidu", initials: "BD", logoUrl: lobeIcon("baidu-color") },
  byteplus: { label: "BytePlus", initials: "BP", logoUrl: lobeIcon("bytedance-color") },
  cerebras: { label: "Cerebras", initials: "CB", logoUrl: lobeIcon("cerebras-color") },
  chutes: { label: "Chutes", initials: "CH", logoUrl: OPENCLAW_ICON },
  clickclack: { label: "ClickClack", initials: "CC", logoUrl: OPENCLAW_ICON },
  cloudflare: { label: "Cloudflare", initials: "CF", logoUrl: lobeIcon("cloudflare-color") },
  codex: { label: "Codex", initials: "CX", logoUrl: lobeIcon("codex-color") },
  deepseek: { label: "DeepSeek", initials: "DS", logoUrl: "https://cdn.deepseek.com/chat/icon.png" },
  deepinfra: { label: "DeepInfra", initials: "DI", logoUrl: lobeIcon("deepinfra-color") },
  discord: { label: "Discord", initials: "D", logoUrl: simpleIcon("discord") },
  feishu: { label: "Feishu", initials: "FS", logoUrl: "https://www.larksuite.com/favicon.ico" },
  fireworks: { label: "Fireworks", initials: "FW", logoUrl: lobeIcon("fireworks-color") },
  github: { label: "GitHub", initials: "GH", logoUrl: simpleIcon("github") },
  "github-copilot": { label: "GitHub Copilot", initials: "GC", logoUrl: lobeIcon("githubcopilot") },
  google: { label: "Google", initials: "G", logoUrl: lobeIcon("google-color") },
  "google-chat": {
    label: "Google Chat",
    initials: "GC",
    logoUrl: "https://fonts.gstatic.com/s/i/productlogos/chat_2020q4/v1/web-64dp/logo_chat_2020q4_color_2x_web_64dp.png"
  },
  "google-vertex": { label: "Google Vertex AI", initials: "GV", logoUrl: lobeIcon("vertexai-color") },
  groq: { label: "Groq", initials: "GQ", logoUrl: lobeIcon("groq") },
  huggingface: { label: "Hugging Face", initials: "HF", logoUrl: lobeIcon("huggingface-color") },
  imessage: { label: "iMessage", initials: "IM", logoUrl: simpleIcon("imessage") },
  irc: { label: "IRC", initials: "IR", logoUrl: simpleIcon("liberadotchat") },
  kilocode: { label: "Kilo Code", initials: "KC", logoUrl: lobeIcon("kilocode") },
  line: { label: "LINE", initials: "LN", logoUrl: "https://line.me/static/img/apple-touch-icon-180x180.png" },
  litellm: { label: "LiteLLM", initials: "LL", logoUrl: "https://docs.litellm.ai/img/favicon.ico" },
  lmstudio: { label: "LM Studio", initials: "LM", logoUrl: lobeIcon("lmstudio") },
  matrix: { label: "Matrix", initials: "MX", logoUrl: "https://matrix.org/assets/favicon.svg" },
  mattermost: { label: "Mattermost", initials: "MM", logoUrl: simpleIcon("mattermost") },
  "microsoft-teams": {
    label: "Microsoft Teams",
    initials: "MT",
    logoUrl: "https://static2.sharepointonline.com/files/fabric/assets/brand-icons/product/svg/teams_48x1.svg"
  },
  "microsoft-foundry": { label: "Microsoft Foundry", initials: "MF", logoUrl: lobeIcon("microsoft-color") },
  minimax: { label: "MiniMax", initials: "MM", logoUrl: "/brand/minimax.svg" },
  mistral: { label: "Mistral AI", initials: "MI", logoUrl: lobeIcon("mistral-color") },
  moonshot: { label: "Moonshot", initials: "MS", logoUrl: lobeIcon("moonshot") },
  "nextcloud-talk": { label: "Nextcloud Talk", initials: "NT", logoUrl: simpleIcon("nextcloud") },
  nostr: { label: "Nostr", initials: "NO", logoUrl: "https://nostr.com/favicon.ico" },
  nvidia: { label: "NVIDIA", initials: "NV", logoUrl: lobeIcon("nvidia-color") },
  ollama: { label: "Ollama", initials: "OL", logoUrl: "https://ollama.com/public/ollama.png" },
  openai: { label: "OpenAI", initials: "OA", logoUrl: OPENAI_PRODUCT_ICON },
  "openai-codex": { label: "OpenAI Codex", initials: "OC", logoUrl: OPENAI_PRODUCT_ICON },
  opencode: { label: "OpenCode", initials: "OC", logoUrl: lobeIcon("opencode") },
  openrouter: { label: "OpenRouter", initials: "OR", logoUrl: lobeIcon("openrouter") },
  "qa-channel": { label: "QA Channel", initials: "QA", logoUrl: OPENCLAW_ICON },
  qianfan: { label: "Qianfan", initials: "QF", logoUrl: lobeIcon("baiducloud-color") },
  qq: { label: "QQ", initials: "QQ", logoUrl: simpleIcon("qq") },
  qwen: { label: "Qwen", initials: "QW", logoUrl: lobeIcon("qwen-color") },
  signal: { label: "Signal", initials: "SG", logoUrl: "https://signal.org/assets/images/favicon/favicon.svg" },
  sglang: {
    label: "SGLang",
    initials: "SG",
    logoUrl: "https://mintcdn.com/lmsysorg/iZdDMbLWP1BLEIzC/favicon.png?fit=max&auto=format&n=iZdDMbLWP1BLEIzC&q=85&s=5524ba9694253eabf4da70fafa1db208"
  },
  slack: { label: "Slack", initials: "SL", logoUrl: "https://slack.com/img/icons/app-256.png" },
  stepfun: { label: "StepFun", initials: "SF", logoUrl: lobeIcon("stepfun-color") },
  synology: { label: "Synology Chat", initials: "SY", logoUrl: simpleIcon("synology") },
  synthetic: { label: "Synthetic", initials: "SY", logoUrl: OPENCLAW_ICON },
  telegram: { label: "Telegram", initials: "TG", logoUrl: "https://telegram.org/img/website_icon.svg" },
  tencent: { label: "Tencent", initials: "TE", logoUrl: lobeIcon("tencent-color") },
  tlon: { label: "Tlon", initials: "TL", logoUrl: "https://tlon.io/favicon.ico" },
  together: { label: "Together AI", initials: "TO", logoUrl: lobeIcon("together-color") },
  twitch: { label: "Twitch", initials: "TW", logoUrl: simpleIcon("twitch") },
  venice: { label: "Venice AI", initials: "VE", logoUrl: lobeIcon("venice-color") },
  vercel: { label: "Vercel", initials: "VC", logoUrl: lobeIcon("vercel") },
  vllm: { label: "vLLM", initials: "VL", logoUrl: lobeIcon("vllm-color") },
  volcengine: { label: "Volcengine", initials: "VE", logoUrl: lobeIcon("volcengine-color") },
  whatsapp: { label: "WhatsApp", initials: "WA", logoUrl: "https://static.whatsapp.net/rsrc.php/y1/r/FJbTMJqMap7.svg" },
  xai: { label: "xAI", initials: "XA", logoUrl: lobeIcon("xai") },
  xiaomi: { label: "Xiaomi", initials: "MI", logoUrl: simpleIcon("xiaomi") },
  zai: { label: "ZAI", initials: "ZA", logoUrl: lobeIcon("zai") },
  zalo: { label: "Zalo", initials: "ZA", logoUrl: "https://stc-zaloprofile.zdn.vn/favicon.ico" },
  "zalo-user": { label: "Zalo User", initials: "ZU", logoUrl: "https://stc-zaloprofile.zdn.vn/favicon.ico" }
};

type TraceIssue = {
  key: string;
  index: number;
  label: string;
  kind: "node" | "slot_input" | "slot_output";
  depth: number;
  node?: BlueprintNode;
  nodeRun?: BlueprintNodeRun;
  issueStatus: TraceIssueStatus;
  statusLabel: string;
  outputPreview: string;
  outputBody?: string;
  events: BlueprintNodeEvent[];
};

export function CompanyDirectoryPage({
  companies,
  selectedCompanyId,
  language,
  busy,
  onEnterCompany,
  onCreateCompany,
  onUpdateCompany,
  onDeleteCompany
}: {
  companies: CompanyOverview[];
  selectedCompanyId?: string;
  language: Language;
  busy: boolean;
  onEnterCompany: (companyId: string) => void;
  onCreateCompany: (input: CreateCompanyRequest) => Promise<CompanyDirectoryResponse | undefined>;
  onUpdateCompany: (companyId: string, input: UpdateCompanyRequest) => Promise<CompanyDirectoryResponse | undefined>;
  onDeleteCompany: (companyId: string) => void;
}) {
  const [editingCompanyId, setEditingCompanyId] = useState<string | undefined>();
  const [renameValue, setRenameValue] = useState("");
  const copy =
    language === "zh-CN"
      ? {
          noCompanies: "\u5F53\u524D\u6CA1\u6709\u53EF\u7528\u516C\u53F8\u3002",
          active: "\u5F53\u524D\u516C\u53F8",
          switchTitle: "\u516C\u53F8\u5217\u8868",
          switchSubtitle: "\u9009\u62E9\u516C\u53F8\u540E\uff0c\u5176\u4ED6\u5DE5\u4F5C\u533A\u4F1A\u5207\u5230\u8BE5\u516C\u53F8\u7684\u6570\u636E\u8303\u56F4\u3002",
          addCompany: "\u6DFB\u52A0\u516C\u53F8",
          draftCompanyName: "\u65B0\u516C\u53F8",
          companyName: "\u516C\u53F8\u540D\u79F0",
          namePlaceholder: "\u8F93\u5165\u516C\u53F8\u540D\u79F0",
          renameTitle: "\u91CD\u547D\u540D\u516C\u53F8",
          rename: "\u6539\u540D",
          save: "\u4FDD\u5B58",
          cancel: "\u53D6\u6D88",
          enter: "\u8FDB\u5165\u516C\u53F8",
          delete: "\u5220\u9664\u516C\u53F8",
          deleteConfirm: (name: string) => `\u5220\u9664\u516C\u53F8\u201C${name}\u201D\u4F1A\u79FB\u9664\u8BE5\u516C\u53F8\u4E0B\u7684\u84DD\u56FE\u548C\u8FD0\u884C\u8BB0\u5F55\u3002\u786E\u8BA4\u5220\u9664\uFF1F`
        }
      : {
          noCompanies: "No companies are available.",
          active: "Current company",
          switchTitle: "Companies",
          switchSubtitle: "Choosing a company updates the scope for the rest of the workspace.",
          addCompany: "Add company",
          draftCompanyName: "New Company",
          companyName: "Company name",
          namePlaceholder: "Enter company name",
          renameTitle: "Rename company",
          rename: "Rename",
          save: "Save",
          cancel: "Cancel",
          enter: "Enter company",
          delete: "Delete company",
          deleteConfirm: (name: string) => `Deleting "${name}" removes its blueprints and run history. Delete this company?`
        };

  const editingCompany = editingCompanyId ? companies.find((company) => company.id === editingCompanyId) : undefined;
  const canRenameCompany = Boolean(editingCompanyId && renameValue.trim()) && !busy;

  useEffect(() => {
    if (!editingCompany) return;
    setRenameValue(editingCompany.name);
  }, [editingCompany]);

  const openRenameDialog = useCallback(
    (companyId: string, initialName?: string) => {
      const company = companies.find((item) => item.id === companyId);
      setEditingCompanyId(companyId);
      setRenameValue(initialName ?? company?.name ?? "");
    },
    [companies]
  );

  const closeRenameDialog = () => {
    setEditingCompanyId(undefined);
    setRenameValue("");
  };

  const createCompany = () => {
    if (busy) return;
    void onCreateCompany({ name: nextDraftCompanyName(companies, copy.draftCompanyName) }).then((directory) => {
      const companyId = directory?.selectedCompanyId;
      const company = directory?.companies.find((item) => item.id === companyId);
      if (companyId) openRenameDialog(companyId, company?.name);
    });
  };

  const submitRename = () => {
    const companyId = editingCompanyId;
    const name = renameValue.trim();
    if (!companyId || !name || busy) return;

    void onUpdateCompany(companyId, { name }).then((directory) => {
      if (directory) closeRenameDialog();
    });
  };

  const deleteCompany = (company: CompanyOverview) => {
    if (busy || !window.confirm(copy.deleteConfirm(company.name))) return;
    onDeleteCompany(company.id);
  };

  return (
    <section className="page-grid company-page-grid">
      <div className="company-directory-header">
        <div className="card-title-block">
          <h3>{copy.switchTitle}</h3>
          <p>{copy.switchSubtitle}</p>
        </div>
        <button
          type="button"
          className="primary-action"
          disabled={busy}
          onClick={createCompany}
        >
          {busy ? <Loader2 className="spin" size={16} /> : <Plus size={16} />}
          {copy.addCompany}
        </button>
      </div>

      <div className="content-card stack-card company-selector-card">
        {companies.length === 0 ? (
          <div className="empty-state page-empty">{copy.noCompanies}</div>
        ) : (
          <div className="company-list-grid">
            {companies.map((company) => (
              <article
                key={company.id}
                className={`company-list-card ${company.id === selectedCompanyId ? "selected" : ""}`}
              >
                <div className="company-list-card-top">
                  <div className="company-logo-small">
                    {company.logoUrl ? <img src={company.logoUrl} alt={company.name} /> : companyMonogram(company)}
                  </div>
                  <div className="company-list-card-copy">
                    <strong>{company.name}</strong>
                    <span>{company.businessGoal}</span>
                  </div>
                </div>
                {company.id === selectedCompanyId && <span className="company-list-card-status">{copy.active}</span>}
                <div className="company-list-card-actions">
                  <button type="button" className="primary-action" onClick={() => onEnterCompany(company.id)} disabled={busy}>
                    <ChevronRight size={16} />
                    {copy.enter}
                  </button>
                  <button type="button" onClick={() => openRenameDialog(company.id)} disabled={busy}>
                    <Pencil size={16} />
                    {copy.rename}
                  </button>
                  <button type="button" className="danger-action" onClick={() => deleteCompany(company)} disabled={busy}>
                    <Trash2 size={16} />
                    {copy.delete}
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      {editingCompanyId && (
        <div className="node-modal-backdrop company-rename-backdrop" role="presentation" onMouseDown={closeRenameDialog}>
          <section
            className="node-modal company-rename-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="company-rename-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="node-modal-header">
              <div>
                <h3 id="company-rename-title">{copy.renameTitle}</h3>
                <p>{editingCompany?.name ?? copy.draftCompanyName}</p>
              </div>
              <button type="button" className="node-modal-close" onClick={closeRenameDialog} disabled={busy} aria-label={copy.cancel}>
                <X size={18} />
              </button>
            </div>
            <form
              className="node-modal-form company-rename-form"
              onSubmit={(event) => {
                event.preventDefault();
                submitRename();
              }}
            >
              <label>
                <span>{copy.companyName}</span>
                <input
                  autoFocus
                  value={renameValue}
                  onChange={(event) => setRenameValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") closeRenameDialog();
                  }}
                  placeholder={copy.namePlaceholder}
                />
              </label>
              <div className="node-modal-actions">
                <button type="button" onClick={closeRenameDialog} disabled={busy}>
                  {copy.cancel}
                </button>
                <button type="submit" className="primary-action" disabled={!canRenameCompany}>
                  {busy ? <Loader2 className="spin" size={16} /> : <Check size={16} />}
                  {copy.save}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </section>
  );
}

function nextDraftCompanyName(companies: CompanyOverview[], baseName: string): string {
  const used = new Set(companies.map((company) => company.name.trim()).filter(Boolean));
  if (!used.has(baseName)) return baseName;

  let index = 2;
  let candidate = `${baseName} ${index}`;
  while (used.has(candidate)) {
    index += 1;
    candidate = `${baseName} ${index}`;
  }
  return candidate;
}

export function CompanyPage({
  companies,
  selectedCompanyId,
  language
}: {
  companies: CompanyOverview[];
  selectedCompanyId?: string;
  language: Language;
}) {
  const copy =
    language === "zh-CN"
      ? {
          choose: "\u9009\u62E9\u516C\u53F8",
          noSelection: "\u5F53\u524D\u8FD8\u6CA1\u6709\u9009\u4E2D\u516C\u53F8\u3002\u8BF7\u5148\u4ECE\u5DE6\u4E0B\u89D2\u7684\u516C\u53F8\u5165\u53E3\u5207\u6362\u3002",
          noCompanies: "\u5F53\u524D\u6CA1\u6709\u53EF\u7528\u516C\u53F8\u3002"
        }
      : {
          choose: "Choose company",
          noSelection: "No company is selected yet. Use the company entry at the lower left to choose one first.",
          noCompanies: "No companies are available."
        };

  const selectedCompany = companies.find((company) => company.id === selectedCompanyId);

  return (
    <section className="page-grid company-page-grid">
      <div className="content-card stack-card company-hero-card">
        {selectedCompany ? (
          <div className="company-brand-poster" aria-label={selectedCompany.name}>
            <div className="company-brand-block">
              <div className="company-logo-large">
                {selectedCompany.logoUrl ? <img src={selectedCompany.logoUrl} alt={selectedCompany.name} /> : companyMonogram(selectedCompany)}
              </div>
              <div className="company-brand-copy">
                <h3>{selectedCompany.name}</h3>
                <p>{selectedCompany.businessGoal}</p>
              </div>
            </div>
          </div>
        ) : (
          <div className="empty-state company-empty-state">
            <strong>{copy.choose}</strong>
            <span>{companies.length === 0 ? copy.noCompanies : copy.noSelection}</span>
          </div>
        )}
      </div>
    </section>
  );
}

export function RunsPage({
  runs,
  blueprints,
  blueprint,
  selectedRunId,
  language,
  t,
  onSelectBlueprint,
  onSelectRun
}: {
  runs: BlueprintRunView[];
  blueprints: BlueprintDefinition[];
  blueprint?: BlueprintDefinition;
  selectedRunId?: string;
  language: Language;
  t: Messages;
  onSelectBlueprint: (blueprintId: string) => void;
  onSelectRun: (runId: string) => void;
}) {
  const blueprintRuns = useMemo(
    () =>
      blueprint
        ? runs
            .filter((runView) => runView.run.blueprintId === blueprint.id)
            .sort((left, right) => new Date(right.run.startedAt).getTime() - new Date(left.run.startedAt).getTime())
        : [],
    [runs, blueprint]
  );
  const activeRun = selectedRunId ? blueprintRuns.find((runView) => runView.run.id === selectedRunId) : undefined;
  const [activeIssueKey, setActiveIssueKey] = useState<string | undefined>();
  const [blueprintPickerOpen, setBlueprintPickerOpen] = useState(false);
  const [runHistoryOpen, setRunHistoryOpen] = useState(false);
  const [acknowledgedTerminalRunIds, setAcknowledgedTerminalRunIds] = useState<Set<string>>(() =>
    readAcknowledgedTerminalRunIds(getBrowserStorage())
  );
  const orderedNodes = useMemo(() => getBlueprintNodeOrder(blueprint), [blueprint]);
  const blueprintRunStats = useMemo(() => {
    const stats = new Map<string, { latestRunId?: string; latestStatus?: BlueprintRunStatus; latestRawStatus?: BlueprintRunStatus; lastUsedAt: number }>();
    for (const runView of runs) {
      const startedAt = toSafeTimestamp(runView.run.startedAt);
      const current = stats.get(runView.run.blueprintId);
      if (!current || startedAt >= current.lastUsedAt) {
        stats.set(runView.run.blueprintId, {
          latestRunId: runView.run.id,
          latestStatus: resolveRunViewDisplayStatus(runView),
          latestRawStatus: runView.run.status,
          lastUsedAt: startedAt
        });
      }
    }
    return stats;
  }, [runs]);
  const currentBlueprintRunStats = blueprint ? blueprintRunStats.get(blueprint.id) : undefined;

  const issues = useMemo<TraceIssue[]>(() => {
    return buildTraceIssues(activeRun, blueprint, orderedNodes, t);
  }, [activeRun?.events, activeRun?.nodeRuns, orderedNodes, t, blueprint?.nodes]);

  const activeIssue = activeIssueKey ? issues.find((issue) => issue.key === activeIssueKey) : undefined;
  const activeIssueOutput =
    activeIssue?.outputBody !== undefined
      ? activeIssue.outputBody
      : activeIssue?.nodeRun?.output !== undefined
        ? formatOutput(activeIssue.nodeRun.output)
        : activeIssue?.nodeRun?.error;
  const isActiveIssueError = activeIssue?.outputBody === undefined && activeIssue?.nodeRun?.output === undefined && Boolean(activeIssue?.nodeRun?.error);
  const runRecordButtonLabel = language === "zh-CN" ? "选择记录" : "Run history";
  const runFrameState = traceRunFrameState(resolveRunViewDisplayStatus(activeRun));

  useEffect(() => {
    if (!activeIssueKey || issues.some((issue) => issue.key === activeIssueKey)) return;
    setActiveIssueKey(undefined);
  }, [activeIssueKey, issues]);

  useEffect(() => {
    if (!activeRun || activeIssueKey || issues.length === 0) return;
    const firstIssueWithDetail = issues.find(
      (issue) => issue.outputBody !== undefined || issue.nodeRun?.output !== undefined || issue.nodeRun?.error
    );
    setActiveIssueKey((firstIssueWithDetail ?? issues[0])?.key);
  }, [activeIssueKey, activeRun?.run.id, issues]);

  const acknowledgeTerminalRun = useCallback(
    (blueprintId: string) => {
      const stats = blueprintRunStats.get(blueprintId);
      if (!stats?.latestRunId || !isTerminalBlueprintRunStatus(stats.latestRawStatus)) return;
      setAcknowledgedTerminalRunIds((current) => {
        if (current.has(stats.latestRunId!)) return current;
        const next = new Set(current);
        next.add(stats.latestRunId!);
        return next;
      });
    },
    [blueprintRunStats]
  );

  useEffect(() => {
    if (!blueprint?.id) return;
    acknowledgeTerminalRun(blueprint.id);
  }, [acknowledgeTerminalRun, blueprint?.id, currentBlueprintRunStats?.latestRunId, currentBlueprintRunStats?.latestRawStatus]);

  useEffect(() => {
    writeAcknowledgedTerminalRunIds(getBrowserStorage(), acknowledgedTerminalRunIds);
  }, [acknowledgedTerminalRunIds]);

  useEffect(() => {
    if (runs.length === 0) return;
    const runIds = new Set(runs.map((runView) => runView.run.id));
    setAcknowledgedTerminalRunIds((current) => {
      const next = new Set([...current].filter((runId) => runIds.has(runId)));
      return next.size === current.size ? current : next;
    });
  }, [runs]);

  const selectBlueprintForRunPage = (blueprintId: string) => {
    acknowledgeTerminalRun(blueprintId);
    onSelectBlueprint(blueprintId);
    const latestRun = runs
      .filter((runView) => runView.run.blueprintId === blueprintId)
      .sort((left, right) => toSafeTimestamp(right.run.startedAt) - toSafeTimestamp(left.run.startedAt))[0];
    if (latestRun) {
      onSelectRun(latestRun.run.id);
    }
    setBlueprintPickerOpen(false);
    setRunHistoryOpen(false);
    setActiveIssueKey(undefined);
  };

  const selectRunHistoryItem = (runId: string) => {
    onSelectRun(runId);
    setRunHistoryOpen(false);
    setActiveIssueKey(undefined);
  };

  return (
    <section className="page-grid trace-page-grid">
      <div className="trace-page-title">
        <h2>{t.navigation.runs}</h2>
        <div className="run-top-actions">
          <div className="run-picker-wrap">
            <button
              type="button"
              className="run-record-selector blueprint-selector-button"
              title={activeRun ? t.trace.runOption(activeRun.run.id, formatDateTime(activeRun.run.startedAt, language)) : runRecordButtonLabel}
              onClick={() => {
                setRunHistoryOpen((current) => !current);
                setBlueprintPickerOpen(false);
              }}
              disabled={!blueprint || blueprintRuns.length === 0}
            >
              <Clock3 size={16} />
              <span>{runRecordButtonLabel}</span>
            </button>
            {runHistoryOpen && (
              <div className="run-selection-panel run-history-panel">
                <div className="run-history-list">
                  {blueprintRuns.map((runView) => {
                    const selected = runView.run.id === activeRun?.run.id;
                    return (
                      <button
                        key={runView.run.id}
                        type="button"
                        className={`blueprint-card-button run-history-button${selected ? " selected" : ""}`}
                        onClick={() => selectRunHistoryItem(runView.run.id)}
                      >
                        <span className="blueprint-card-icon">
                          <Clock3 size={17} />
                        </span>
                        <strong>{t.trace.runOption(runView.run.id, formatDateTime(runView.run.startedAt, language))}</strong>
                        {selected && <Check className="blueprint-card-check" size={14} />}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
          <div className="run-picker-wrap">
            <button
              type="button"
              className="run-blueprint-selector blueprint-selector-button"
              title={t.fields.blueprint}
              onClick={() => {
                setBlueprintPickerOpen((current) => !current);
                setRunHistoryOpen(false);
              }}
              disabled={blueprints.length === 0}
            >
              <LayoutTemplate size={16} />
              <span>{blueprint?.name ?? t.empty.selectBlueprint}</span>
            </button>
            {blueprintPickerOpen && (
              <div className="run-selection-panel run-blueprint-panel">
                <div className="run-blueprint-card-list blueprint-card-list">
                  {blueprints.length === 0 ? (
                    <div className="empty-state compact-empty-state">{t.empty.selectBlueprint}</div>
                  ) : (
                    blueprints.map((item) => {
                      const selected = item.id === blueprint?.id;
                      const stats = blueprintRunStats.get(item.id);
                      const terminalStatusSeen =
                        item.id === blueprint?.id || (stats?.latestRunId ? acknowledgedTerminalRunIds.has(stats.latestRunId) : false);
                      const activity = resolveBlueprintActivityState(stats?.latestStatus, terminalStatusSeen);
                      return (
                        <button
                          key={item.id}
                          type="button"
                          className={`blueprint-card-button blueprint-run-state-${activity}${selected ? " selected" : ""}`}
                          onClick={() => selectBlueprintForRunPage(item.id)}
                        >
                          <span className="blueprint-card-icon">
                            <LayoutTemplate size={17} />
                          </span>
                          <strong>{item.name}</strong>
                          {selected && <Check className="blueprint-card-check" size={14} />}
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <section className="trace-layout">
        <div className="trace-column-shell">
          <div className="trace-column-header">
            <h3>{t.trace.issueList}</h3>
          </div>
          <div className={`content-card stack-card trace-issue-column trace-run-frame-${runFrameState}`}>
            <div className="trace-issue-list">
              {!blueprint ? (
                <div className="empty-state page-empty">{t.empty.selectBlueprint}</div>
              ) : issues.length === 0 ? (
                <div className="empty-state page-empty">{t.empty.noRunHistory}</div>
              ) : (
                issues.map((issue) => (
                  <button
                    key={issue.key}
                    type="button"
                    className={`trace-issue-card trace-issue-${issue.kind} trace-issue-depth-${issue.depth} ${activeIssue?.key === issue.key ? "selected" : ""}`}
                    onClick={() => setActiveIssueKey(issue.key)}
                  >
                    <div className="trace-issue-index">{issue.index}</div>
                    <div className="trace-issue-main">
                      <div className="trace-issue-topline">
                        <strong>{issue.label}</strong>
                        <span className={`trace-status-chip trace-${issue.issueStatus}`}>{traceIssueStatusLabel(issue.issueStatus, language)}</span>
                      </div>
                      <MarkdownRenderer value={issue.outputPreview} className="trace-issue-preview" />
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="trace-column-shell">
          <div className="trace-column-header">
            <h3>{t.trace.modelOutput}</h3>
          </div>
          <div className="content-card stack-card trace-output-column">
            {activeIssue ? (
              activeIssueOutput !== undefined ? (
                <MarkdownRenderer
                  value={activeIssueOutput}
                  className={`trace-output-body ${isActiveIssueError ? "trace-output-body-error" : ""}`}
                />
              ) : (
                <div className="empty-state compact-empty-state">{t.empty.noNodeOutput}</div>
              )
            ) : !blueprint ? (
              <div className="empty-state page-empty">{t.empty.selectBlueprint}</div>
            ) : activeRun ? (
              <div className="empty-state page-empty">{t.empty.selectNode}</div>
            ) : (
              <div className="empty-state page-empty">{t.empty.noRunHistory}</div>
            )}
          </div>
        </div>
      </section>
    </section>
  );
}

export function ApprovalsPage({
  approvals,
  inboxItems,
  language,
  t,
  onApprove,
  onReject,
  onReply,
  onSelectApprovalReply,
  onReplyInboxItem,
  onApproveInboxItem,
  onRejectInboxItem
}: {
  approvals: PendingApprovalItem[];
  inboxItems: InboxItem[];
  language: Language;
  t: Messages;
  onApprove: (blueprintRunId: string, nodeRunId: string, comment?: string, selectedReplyId?: string) => void;
  onReject: (blueprintRunId: string, nodeRunId: string, comment?: string) => void;
  onReply: (blueprintRunId: string, nodeRunId: string, message: string) => void;
  onSelectApprovalReply: (blueprintRunId: string, nodeRunId: string, selectedReplyId: string) => void;
  onReplyInboxItem: (itemId: string, message: string) => void;
  onApproveInboxItem: (itemId: string, comment?: string) => void;
  onRejectInboxItem: (itemId: string, comment?: string) => void;
}) {
  const approvalsPage = t.pages.approvals ?? { title: "Approvals", description: "" };
  const inboxCopy = getInboxCopy(language);
  const [blueprintFilter, setBlueprintFilter] = useState(allInboxBlueprintFilterValue);
  const [timeFilter, setTimeFilter] = useState<InboxTimeFilter>("all");
  const blueprintFilterOptions = useMemo(
    () => buildInboxBlueprintFilterOptions(inboxItems, approvals, inboxCopy),
    [approvals, inboxCopy, inboxItems]
  );
  const inboxThreadItems = useMemo(
    () => buildInboxThreadItems(inboxItems, approvals, blueprintFilter, timeFilter),
    [approvals, blueprintFilter, inboxItems, timeFilter]
  );
  const totalInboxItems = inboxItems.length + approvals.length;
  const pendingInboxCount =
    inboxItems.filter((item) => item.status === "pending").length +
    approvals.filter(isActionableApprovalThread).length;
  const [selectedThread, setSelectedThread] = useState<InboxThreadSelection | undefined>(() =>
    firstInboxThreadSelection(inboxItems, approvals)
  );
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [localReplies, setLocalReplies] = useState<Record<string, InboxLocalReply[]>>({});
  const [pendingHarnessReplies, setPendingHarnessReplies] = useState<Record<string, InboxPendingHarnessReply>>({});
  const selectedInboxItem =
    selectedThread?.kind === "inbox"
      ? inboxItems.find((item) => item.id === selectedThread.id)
      : undefined;
  const selectedApproval =
    selectedThread?.kind === "approval"
      ? approvals.find((approval) => approval.nodeRunId === selectedThread.id)
      : undefined;
  const selectedInboxApproved = selectedInboxItem?.status === "approved";
  const selectedInboxOperable = Boolean(selectedInboxItem && !selectedInboxApproved);
  const canReplyToSelection = Boolean(selectedApproval?.canReply || selectedInboxOperable);
  const canApproveSelection = Boolean(
    selectedApproval ? selectedApproval.canApprove !== false : selectedInboxOperable
  );
  const canRejectSelection = Boolean((selectedApproval && selectedApproval.canReject) || selectedInboxOperable);
  const selectedThreadKey = selectedThread ? inboxThreadKey(selectedThread) : undefined;
  const selectedReplyDraft = selectedThreadKey ? (replyDrafts[selectedThreadKey] ?? "") : "";
  const selectedMessages = useMemo(
    () =>
      selectedThread
        ? buildInboxConversationMessages({
            selection: selectedThread,
            inboxItem: selectedInboxItem,
            approval: selectedApproval,
            replies: selectedThreadKey ? (localReplies[selectedThreadKey] ?? []) : [],
            pendingHarnessReply: selectedThreadKey ? pendingHarnessReplies[selectedThreadKey] : undefined,
            copy: inboxCopy,
            t,
            language
          })
        : [],
    [inboxCopy, language, localReplies, pendingHarnessReplies, selectedApproval, selectedInboxItem, selectedThread, selectedThreadKey, t]
  );

  useEffect(() => {
    if (
      blueprintFilter !== allInboxBlueprintFilterValue &&
      !blueprintFilterOptions.some((option) => option.value === blueprintFilter)
    ) {
      setBlueprintFilter(allInboxBlueprintFilterValue);
    }
  }, [blueprintFilter, blueprintFilterOptions]);

  useEffect(() => {
    setSelectedThread((current) => {
      if (current && hasInboxThread(current, inboxThreadItems)) return current;
      return firstInboxThreadListSelection(inboxThreadItems);
    });
  }, [inboxThreadItems]);

  useEffect(() => {
    setPendingHarnessReplies((current) => {
      let next = current;
      for (const approval of approvals) {
        const key = inboxThreadKey({ kind: "approval", id: approval.nodeRunId });
        const pending = current[key];
        if (!pending || !hasAssistantReplyAfter(approval, pending.createdAt)) continue;
        if (next === current) next = { ...current };
        delete next[key];
      }
      return next;
    });
  }, [approvals]);

  const updateReplyDraft = (value: string) => {
    if (!selectedThreadKey) return;
    setReplyDrafts((current) => ({ ...current, [selectedThreadKey]: value }));
  };

  const clearReplyDraft = () => {
    if (!selectedThreadKey) return;
    setReplyDrafts((current) => ({ ...current, [selectedThreadKey]: "" }));
  };

  const sendLocalReply = () => {
    if (!selectedThreadKey || !canReplyToSelection) return;
    const body = selectedReplyDraft.trim();
    if (!body) return;
    const reply = {
      id: makeLocalInboxReplyId(),
      body,
      createdAt: new Date().toISOString()
    };
    if (selectedApproval?.canReply) {
      const pendingHarnessReply = {
        id: `${reply.id}:pending`,
        harnessLabel: formatInboxHarnessLabel(selectedApproval.harnessId),
        createdAt: reply.createdAt
      };
      flushSync(() => {
        setLocalReplies((current) => ({
          ...current,
          [selectedThreadKey]: [
            ...(current[selectedThreadKey] ?? []),
            reply
          ]
        }));
        setPendingHarnessReplies((current) => ({ ...current, [selectedThreadKey]: pendingHarnessReply }));
        setReplyDrafts((current) => ({ ...current, [selectedThreadKey]: "" }));
      });
      window.setTimeout(() => {
        onReply(selectedApproval.blueprintRunId, selectedApproval.nodeRunId, body);
      }, 0);
      return;
    }
    flushSync(() => {
      setLocalReplies((current) => ({
        ...current,
        [selectedThreadKey]: [
          ...(current[selectedThreadKey] ?? []),
          reply
        ]
      }));
      setReplyDrafts((current) => ({ ...current, [selectedThreadKey]: "" }));
    });
    if (selectedInboxItem && !selectedInboxApproved) {
      window.setTimeout(() => {
        onReplyInboxItem(selectedInboxItem.id, body);
      }, 0);
    }
  };

  const approveSelectedThread = () => {
    const comment = selectedReplyDraft.trim() || undefined;
    if (selectedInboxItem && !selectedInboxApproved) {
      onApproveInboxItem(selectedInboxItem.id, comment);
      clearReplyDraft();
      return;
    }
    if (selectedApproval && selectedApproval.canApprove !== false) {
      onApprove(selectedApproval.blueprintRunId, selectedApproval.nodeRunId, comment, selectedApproval.selectedReplyId);
      clearReplyDraft();
    }
  };

  const selectApprovalSolution = (solutionId: string) => {
    if (!selectedApproval || selectedApproval.canApprove === false) return;
    onSelectApprovalReply(selectedApproval.blueprintRunId, selectedApproval.nodeRunId, solutionId);
  };

  const rejectSelectedThread = () => {
    const comment = selectedReplyDraft.trim() || undefined;
    if (selectedInboxItem && !selectedInboxApproved) {
      onRejectInboxItem(selectedInboxItem.id, comment);
      clearReplyDraft();
      return;
    }
    if (selectedApproval?.canReject) {
      onReject(selectedApproval.blueprintRunId, selectedApproval.nodeRunId, comment);
    }
    clearReplyDraft();
  };

  return (
    <section className="page-grid trace-page-grid inbox-page-grid">
      <div className="trace-page-title inbox-page-title">
        <h2>{approvalsPage.title}</h2>
        <p>{inboxCopy.listMetric(inboxThreadItems.length, totalInboxItems, pendingInboxCount)}</p>
      </div>

      <section className="trace-layout inbox-layout">
        <div className="trace-column-shell inbox-column-shell">
          <div className="trace-column-header inbox-column-header">
            <h3>{inboxCopy.listTitle}</h3>
            <div className="inbox-filters">
              <label className="inbox-filter-field">
                <span>{inboxCopy.blueprintFilter}</span>
                <select value={blueprintFilter} onChange={(event) => setBlueprintFilter(event.target.value)}>
                  {blueprintFilterOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="inbox-filter-field">
                <span>{inboxCopy.timeFilter}</span>
                <select value={timeFilter} onChange={(event) => setTimeFilter(event.target.value as InboxTimeFilter)}>
                  {inboxTimeFilterOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {inboxTimeFilterLabel(option.value, language)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>
          <div className="content-card stack-card inbox-list-column">
            <div className="inbox-list" role="list" aria-label={inboxCopy.listTitle}>
              {inboxThreadItems.length === 0 ? (
                <div className="inbox-empty-copy">
                  <strong>{totalInboxItems === 0 ? inboxCopy.emptyListTitle : inboxCopy.emptyFilterTitle}</strong>
                  <p>{totalInboxItems === 0 ? inboxCopy.emptyListBody : inboxCopy.emptyFilterBody}</p>
                </div>
              ) : (
                <>
                {inboxThreadItems.map((thread, index) => {
                  if (thread.kind === "inbox") {
                    const item = thread.item;
                    const selected = selectedThread?.kind === "inbox" && item.id === selectedThread.id;
                    const processed = item.status === "approved";
                    return (
                      <article
                        key={item.id}
                        className={`inbox-row inbox-formal-row inbox-row-${item.status}${processed ? " processed" : ""}${selected ? " selected" : ""}`}
                        role="listitem"
                      >
                        <button
                          type="button"
                          className="inbox-row-main"
                          aria-pressed={selected}
                          onClick={() => setSelectedThread({ kind: "inbox", id: item.id })}
                        >
                          <span className="inbox-row-index">{index + 1}</span>
                          <span className="inbox-row-content">
                            <span className="inbox-row-topline">
                              <strong>{item.title}</strong>
                              <span className={`status-pill ${inboxStatusClassName(item.status)}`}>
                                {inboxStatusLabel(item.status, language)}
                              </span>
                            </span>
                            <span className="inbox-row-preview">{item.summary}</span>
                            <span className="inbox-row-meta">
                              <span>{inboxItemContextLabel(item, language)}</span>
                              <time dateTime={item.createdAt}>{formatDateTime(item.createdAt, language)}</time>
                            </span>
                          </span>
                        </button>
                        <div className="inbox-row-actions">
                          <button
                            type="button"
                            className="inbox-row-action primary-action"
                            title={processed ? inboxCopy.processedAction : t.actions.approve}
                            aria-label={t.actions.approve}
                            disabled={processed}
                            onClick={() => onApproveInboxItem(item.id)}
                          >
                            <BadgeCheck size={16} />
                          </button>
                          <button
                            type="button"
                            className="inbox-row-action danger-action"
                            title={processed ? inboxCopy.processedAction : inboxCopy.reject}
                            aria-label={inboxCopy.reject}
                            disabled={processed}
                            onClick={() => onRejectInboxItem(item.id)}
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </article>
                    );
                  }

                  const approval = thread.approval;
                  const selected = selectedThread?.kind === "approval" && approval.nodeRunId === selectedThread.id;
                  const processed = approval.status === "approved" || approval.status === "rejected";
                  return (
                    <article
                      key={approval.nodeRunId}
                      className={`inbox-row inbox-row-${approval.status ?? "pending"}${processed ? " processed" : ""}${selected ? " selected" : ""}`}
                      role="listitem"
                    >
                      <button
                        type="button"
                        className="inbox-row-main"
                        aria-pressed={selected}
                        onClick={() => setSelectedThread({ kind: "approval", id: approval.nodeRunId })}
                      >
                        <span className="inbox-row-index">{index + 1}</span>
                        <span className="inbox-row-content">
                          <span className="inbox-row-topline">
                            <strong>{approvalSubject(approval)}</strong>
                            <span className={`status-pill ${approvalStatusClassName(approval)}`}>
                              {approvalStatusLabel(approval, language, t)}
                            </span>
                          </span>
                          <span className="inbox-row-preview">{approvalPreviewText(approval, inboxCopy, t)}</span>
                          <span className="inbox-row-meta">
                            <span>{approval.blueprintName}</span>
                            <time dateTime={approval.requestedAt}>{formatDateTime(approval.requestedAt, language)}</time>
                          </span>
                        </span>
                      </button>
                      <div className="inbox-row-actions">
                        <button
                          type="button"
                          className="inbox-row-action primary-action"
                          title={approval.canApprove === false ? inboxCopy.processedAction : t.actions.approve}
                          aria-label={t.actions.approve}
                          disabled={approval.canApprove === false}
                          onClick={() =>
                            onApprove(approval.blueprintRunId, approval.nodeRunId, undefined, approval.selectedReplyId)
                          }
                        >
                          <BadgeCheck size={16} />
                        </button>
                        <button
                          type="button"
                          className="inbox-row-action danger-action"
                          title={inboxCopy.reject}
                          aria-label={inboxCopy.reject}
                          disabled={!approval.canReject}
                          onClick={() => onReject(approval.blueprintRunId, approval.nodeRunId)}
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </article>
                  );
                })}
                </>
              )}
            </div>
          </div>
        </div>

        <div className="trace-column-shell inbox-column-shell">
          <div className="trace-column-header inbox-column-header">
            <h3>{inboxCopy.detailTitle}</h3>
          </div>
          <InboxConversationPanel
            approval={selectedApproval}
            copy={inboxCopy}
            inboxItem={selectedInboxItem}
            language={language}
            messages={selectedMessages}
            onApprove={approveSelectedThread}
            canApprove={canApproveSelection}
            canReject={canRejectSelection}
            canReply={canReplyToSelection}
            onReject={rejectSelectedThread}
            onReplyDraftChange={updateReplyDraft}
            onSelectSolution={selectApprovalSolution}
            onSendReply={sendLocalReply}
            replyDraft={selectedReplyDraft}
          />
        </div>
      </section>
    </section>
  );
}

type InboxThreadSelection = {
  kind: "approval" | "inbox";
  id: string;
};

type InboxTimeFilter = "all" | "today" | "last7" | "last30";

type InboxBlueprintFilterOption = {
  value: string;
  label: string;
};

type InboxThreadListItem =
  | {
      kind: "inbox";
      id: string;
      timestamp: string;
      blueprintKey: string;
      item: InboxItem;
    }
  | {
      kind: "approval";
      id: string;
      timestamp: string;
      blueprintKey: string;
      approval: PendingApprovalItem;
    };

const allInboxBlueprintFilterValue = "__all_blueprints__";
const approvalReviewOutputSolutionId = "reviewOutput";

const inboxTimeFilterOptions = [
  { value: "all" },
  { value: "today" },
  { value: "last7" },
  { value: "last30" }
] satisfies Array<{ value: InboxTimeFilter }>;

type InboxLocalReply = {
  id: string;
  body: string;
  createdAt: string;
};

type InboxPendingHarnessReply = {
  id: string;
  harnessLabel: string;
  createdAt: string;
};

type InboxConversationMessage = {
  id: string;
  role: "assistant" | "user";
  speaker: string;
  body: string;
  createdAt?: string;
  progressText?: string;
  pending?: boolean;
  solutionId?: string;
  selectedSolution?: boolean;
  canUseAsSolution?: boolean;
};

function InboxConversationPanel({
  approval,
  copy,
  inboxItem,
  language,
  messages,
  replyDraft,
  canApprove,
  canReject,
  canReply,
  onApprove,
  onReject,
  onReplyDraftChange,
  onSelectSolution,
  onSendReply
}: {
  approval?: PendingApprovalItem;
  copy: InboxCopy;
  inboxItem?: InboxItem;
  language: Language;
  messages: InboxConversationMessage[];
  replyDraft: string;
  canApprove: boolean;
  canReject: boolean;
  canReply: boolean;
  onApprove: () => void;
  onReject: () => void;
  onReplyDraftChange: (value: string) => void;
  onSelectSolution: (solutionId: string) => void;
  onSendReply: () => void;
}) {
  const threadRef = useRef<HTMLDivElement | null>(null);
  const hasSelection = Boolean(inboxItem || approval);
  const title = inboxItem?.title ?? (approval ? approvalSubject(approval) : copy.noSelectionTitle);
  const subtitle = inboxItem
    ? inboxItem.blueprintName ?? inboxItem.targetRoleId ?? inboxItem.createdByRoleId
    : approval
      ? approval.blueprintName
      : "";
  const statusLabel = inboxItem ? inboxStatusLabel(inboxItem.status, language) : approval ? copy.approvalRequest : "";
  const typeLabel = inboxItem ? formalInboxTypeLabel(inboxItem.type, language) : undefined;

  useEffect(() => {
    const thread = threadRef.current;
    if (!thread) return;
    thread.scrollTop = thread.scrollHeight;
  }, [messages.length]);

  return (
    <section className="content-card inbox-workspace-column inbox-conversation-card" aria-label={copy.detailTitle}>
      <div className="chat-window-header inbox-conversation-header">
        <div className="chat-session-view-heading">
          <span>{copy.conversation}</span>
          <strong>{title}</strong>
        </div>
        <div className="chat-context-strip">
          {statusLabel && <span className="bound">{statusLabel}</span>}
          {typeLabel && <span>{typeLabel}</span>}
          {subtitle && <span>{subtitle}</span>}
        </div>
      </div>

      <div className="chat-thread inbox-conversation-thread" ref={threadRef}>
        {!hasSelection ? (
          <div className="chat-empty-state">
            <MessageSquareText size={22} />
            <strong>{copy.noSelectionTitle}</strong>
            <span>{copy.noSelectionBody}</span>
          </div>
        ) : (
          messages.map((message) => (
            <article key={message.id} className={`chat-message-row chat-message-row-${message.role}`}>
              <div className={`chat-avatar chat-avatar-${message.role}`} aria-label={message.speaker}>
                {message.role === "user" ? copy.youAvatar : <MessageSquareText size={16} />}
              </div>
              <div className={`chat-message chat-message-${message.role}`}>
                <div className="chat-message-speaker">
                  <strong>{message.speaker}</strong>
                  {message.createdAt && <span>{formatDateTime(message.createdAt, language)}</span>}
                </div>
                {message.pending ? (
                  <div className="chat-message-pending">
                    <Loader2 className="spin" size={15} />
                    {message.progressText ?? copy.waitingHarness(message.speaker)}
                  </div>
                ) : (
                  <MarkdownRenderer value={message.body} className="chat-message-body" />
                )}
                {message.canUseAsSolution && message.solutionId && (
                  <div className="inbox-message-actions">
                    <button
                      type="button"
                      className={`inbox-solution-button${message.selectedSolution ? " selected" : ""}`}
                      disabled={!canApprove || message.selectedSolution}
                      onClick={() => onSelectSolution(message.solutionId!)}
                    >
                      <Check size={14} />
                      {message.selectedSolution ? copy.solutionSelected : copy.useSolution}
                    </button>
                  </div>
                )}
              </div>
            </article>
          ))
        )}
      </div>

      <div className="chat-composer inbox-conversation-composer">
        <textarea
          value={replyDraft}
          disabled={!canReply}
          placeholder={!hasSelection ? copy.noSelectionBody : canReply ? copy.replyPlaceholder : copy.processedPlaceholder}
          onChange={(event) => onReplyDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onSendReply();
            }
          }}
        />
        <div className="inbox-conversation-actions">
          <button type="button" disabled={!canReply || !replyDraft.trim()} onClick={onSendReply}>
            <Send size={15} />
            {copy.sendReply}
          </button>
          <button type="button" className="primary-action" disabled={!canApprove} onClick={onApprove}>
            <BadgeCheck size={15} />
            {copy.approve}
          </button>
          <button type="button" className="danger-action" disabled={!canReject} onClick={onReject}>
            <Trash2 size={15} />
            {copy.reject}
          </button>
        </div>
      </div>
    </section>
  );
}

type InboxCopy = {
  allBlueprints: string;
  approvalRequest: string;
  approve: string;
  blueprintFilter: string;
  conversation: string;
  decidedAt: string;
  decisionComment: string;
  detailTitle: string;
  emptyFilterBody: string;
  emptyFilterTitle: string;
  emptyListBody: string;
  emptyListTitle: string;
  from: string;
  listTitle: string;
  listMetric: (visibleCount: number, totalCount: number, pendingCount: number) => string;
  noSelectionBody: string;
  noSelectionTitle: string;
  noUpstreamOutput: string;
  openedAt: string;
  payload: string;
  processedAction: string;
  processedPlaceholder: string;
  reject: string;
  replyPlaceholder: string;
  sendReply: string;
  solutionSelected: string;
  status: string;
  system: string;
  timeFilter: string;
  to: string;
  useSolution: string;
  waitingHarness: (harnessLabel: string) => string;
  you: string;
  youAvatar: string;
};

type InboxContentBlock = {
  key: string;
  label: string;
  body: string;
};

function getInboxCopy(language: Language): InboxCopy {
  if (language === "zh-CN") {
    return {
      allBlueprints: "全部蓝图",
      approvalRequest: "\u5ba1\u6279\u8bf7\u6c42",
      approve: "\u6279\u51c6",
      blueprintFilter: "蓝图",
      conversation: "\u5bf9\u8bdd",
      decidedAt: "处理时间",
      decisionComment: "处理备注",
      detailTitle: "\u5bf9\u8bdd\u8be6\u60c5",
      emptyFilterBody: "调整蓝图或时间筛选后可以继续查看历史收件。",
      emptyFilterTitle: "当前筛选没有收件",
      emptyListBody: "\u65b0\u7684\u4eba\u5de5\u5ba1\u6279\u4f1a\u6309\u65f6\u95f4\u51fa\u73b0\u5728\u8fd9\u91cc\u3002",
      emptyListTitle: "当前没有收件",
      from: "\u6765\u81ea",
      listTitle: "\u6536\u4ef6",
      listMetric: (visibleCount, totalCount, pendingCount) =>
        `显示 ${visibleCount}/${totalCount} 封，${pendingCount} 封待处理`,
      noSelectionBody: "\u4ece\u5de6\u4fa7\u9009\u62e9\u4e00\u5c01\u90ae\u4ef6\u540e\uff0c\u8fd9\u91cc\u4f1a\u663e\u793a\u5b83\u7684\u5bf9\u8bdd\u548c\u56de\u590d\u6846\u3002",
      noSelectionTitle: "\u9009\u62e9\u4e00\u5c01\u90ae\u4ef6",
      noUpstreamOutput: "\u6ca1\u6709\u62ff\u5230\u4e0a\u4e00\u4e2a\u8282\u70b9\u8f93\u51fa\u3002",
      openedAt: "\u53d1\u8d77\u65f6\u95f4",
      payload: "\u8be6\u7ec6\u5185\u5bb9",
      processedAction: "已处理，不能重复操作",
      processedPlaceholder: "这封收件已经处理，不能继续回复或再次审批。",
      reject: "\u9a73\u56de",
      replyPlaceholder: "\u8f93\u5165\u56de\u590d\uff0cShift+Enter \u6362\u884c...",
      sendReply: "\u56de\u590d",
      solutionSelected: "\u5df2\u9009\u7528",
      status: "状态",
      system: "HiveWard",
      timeFilter: "时间",
      to: "\u53d1\u7ed9",
      useSolution: "\u4f7f\u7528\u6b64\u65b9\u6848",
      waitingHarness: (harnessLabel) => `\u6b63\u5728\u7b49\u5f85 ${harnessLabel} \u56de\u590d...`,
      you: "\u4f60",
      youAvatar: "\u4f60"
    };
  }

  return {
    allBlueprints: "All blueprints",
    approvalRequest: "Approval request",
    approve: "Approve",
    blueprintFilter: "Blueprint",
    conversation: "Conversation",
    decidedAt: "Decided",
    decisionComment: "Decision note",
    detailTitle: "Conversation detail",
    emptyFilterBody: "Change the blueprint or time filter to view more inbox history.",
    emptyFilterTitle: "No inbox items match this filter",
    emptyListBody: "New human approvals will appear here by request time.",
    emptyListTitle: "No inbox items",
    from: "From",
    listTitle: "Messages",
    listMetric: (visibleCount, totalCount, pendingCount) =>
      `${visibleCount}/${totalCount} shown, ${pendingCount} pending`,
    noSelectionBody: "Select a message on the left to show its conversation and reply box here.",
    noSelectionTitle: "Select a message",
    noUpstreamOutput: "No previous node output was captured.",
    openedAt: "Opened",
    payload: "Payload",
    processedAction: "Already processed",
    processedPlaceholder: "This inbox item has already been processed.",
    reject: "Reject",
    replyPlaceholder: "Reply, Shift+Enter for a new line...",
    sendReply: "Reply",
    solutionSelected: "Selected",
    status: "Status",
    system: "HiveWard",
    timeFilter: "Time",
    to: "To",
    useSolution: "Use this option",
    waitingHarness: (harnessLabel) => `Waiting for ${harnessLabel}...`,
    you: "You",
    youAvatar: "You"
  };
}

function buildInboxBlueprintFilterOptions(
  inboxItems: InboxItem[],
  approvals: PendingApprovalItem[],
  copy: InboxCopy
): InboxBlueprintFilterOption[] {
  const options = new Map<string, string>();
  for (const item of inboxItems) {
    const key = inboxItemBlueprintKey(item);
    if (key) options.set(key, item.blueprintName ?? item.blueprintId ?? key);
  }
  for (const approval of approvals) {
    const key = approval.blueprintId || approval.blueprintName;
    if (key) options.set(key, approval.blueprintName || approval.blueprintId);
  }
  return [
    { value: allInboxBlueprintFilterValue, label: copy.allBlueprints },
    ...[...options.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((left, right) => left.label.localeCompare(right.label, undefined, { numeric: true, sensitivity: "base" }))
  ];
}

function buildInboxThreadItems(
  inboxItems: InboxItem[],
  approvals: PendingApprovalItem[],
  blueprintFilter: string,
  timeFilter: InboxTimeFilter
): InboxThreadListItem[] {
  const threads: InboxThreadListItem[] = [
    ...inboxItems.map((item) => ({
      kind: "inbox" as const,
      id: item.id,
      timestamp: item.createdAt,
      blueprintKey: inboxItemBlueprintKey(item),
      item
    })),
    ...approvals.map((approval) => ({
      kind: "approval" as const,
      id: approval.nodeRunId,
      timestamp: approval.requestedAt,
      blueprintKey: approval.blueprintId || approval.blueprintName,
      approval
    }))
  ];

  return threads
    .filter((thread) => blueprintFilter === allInboxBlueprintFilterValue || thread.blueprintKey === blueprintFilter)
    .filter((thread) => isInboxTimestampInTimeFilter(thread.timestamp, timeFilter))
    .sort((left, right) => toSafeTimestamp(right.timestamp) - toSafeTimestamp(left.timestamp));
}

function firstInboxThreadListSelection(items: InboxThreadListItem[]): InboxThreadSelection | undefined {
  const first = items[0];
  return first ? { kind: first.kind, id: first.id } : undefined;
}

function inboxItemBlueprintKey(item: InboxItem): string {
  return item.blueprintId || item.blueprintName || "";
}

function inboxItemContextLabel(item: InboxItem, language: Language): string {
  return [
    item.blueprintName ?? item.blueprintId ?? item.targetRoleId ?? item.createdByRoleId,
    formalInboxTypeLabel(item.type, language)
  ].filter(Boolean).join(" / ");
}

function inboxStatusClassName(status: InboxItem["status"]): string {
  if (status === "approved") return "status-approved";
  if (status === "rejected") return "status-rejected";
  return "status-waiting_approval";
}

function inboxStatusLabel(status: InboxItem["status"], language: Language): string {
  if (language === "zh-CN") {
    if (status === "approved") return "已批准";
    if (status === "rejected") return "已驳回";
    return "待处理";
  }
  if (status === "approved") return "Approved";
  if (status === "rejected") return "Rejected";
  return "Pending";
}

function isActionableApprovalThread(approval: PendingApprovalItem): boolean {
  return approval.status !== "approved" && approval.status !== "rejected" && approval.status !== "replying";
}

function approvalStatusClassName(approval: PendingApprovalItem): string {
  if (approval.status === "approved") return "status-approved";
  if (approval.status === "rejected") return "status-rejected";
  if (approval.status === "replying") return "status-running";
  return "status-waiting_approval";
}

function approvalStatusLabel(approval: PendingApprovalItem, language: Language, t: Messages): string {
  if (language === "zh-CN") {
    if (approval.status === "approved") return "已批准";
    if (approval.status === "rejected") return "已驳回";
    if (approval.status === "replying") return "回复中";
    return "待处理";
  }
  if (approval.status === "approved") return "Approved";
  if (approval.status === "rejected") return "Rejected";
  if (approval.status === "replying") return "Replying";
  return t.status.waiting_approval;
}

function inboxTimeFilterLabel(filter: InboxTimeFilter, language: Language): string {
  if (language === "zh-CN") {
    if (filter === "today") return "今天";
    if (filter === "last7") return "最近 7 天";
    if (filter === "last30") return "最近 30 天";
    return "全部时间";
  }
  if (filter === "today") return "Today";
  if (filter === "last7") return "Last 7 days";
  if (filter === "last30") return "Last 30 days";
  return "All time";
}

function isInboxTimestampInTimeFilter(timestamp: string, filter: InboxTimeFilter): boolean {
  if (filter === "all") return true;
  const value = toSafeTimestamp(timestamp);
  if (!value) return false;
  const today = startOfLocalDay(new Date()).getTime();
  if (filter === "today") return value >= today;
  if (filter === "last7") return value >= addDays(new Date(today), -6).getTime();
  return value >= addDays(new Date(today), -29).getTime();
}

function formalInboxTypeLabel(type: InboxItem["type"], language: Language): string {
  const labels =
    language === "zh-CN"
      ? {
          leader_delegation: "召集 Leader",
          blueprint_proposal: "蓝图内容包",
          run_request: "运行请求",
          report: "报告",
          company_config: "公司配置"
        }
      : {
          leader_delegation: "Leader delegation",
          blueprint_proposal: "Blueprint package",
          run_request: "Run request",
          report: "Report",
          company_config: "Company config"
        };
  return labels[type];
}

function approvalSubject(approval: PendingApprovalItem): string {
  return approval.nodeLabel || approval.blueprintName;
}

function approvalPreviewText(approval: PendingApprovalItem, copy: InboxCopy, t: Messages): string {
  return approvalContentBlocks(approval, copy, t)
    .map((block) => block.body)
    .join("\n\n");
}

function approvalContentBlocks(approval: PendingApprovalItem, copy: InboxCopy, t: Messages): InboxContentBlock[] {
  if (approval.reviewOutput !== undefined) {
    const formatted = (formatOutput(approval.reviewOutput) ?? "").trim();
    return [
      {
        key: `${approval.nodeRunId}:review-output`,
        label: approval.nodeLabel || t.trace.modelOutput,
        body: formatted || t.trace.noOutput
      }
    ];
  }

  const upstream = approval.upstream ?? [];
  if (!upstream.length) {
    return [
      {
        key: `${approval.nodeRunId}:empty`,
        label: t.trace.modelOutput,
        body: copy.noUpstreamOutput
      }
    ];
  }

  return upstream.map((item) => {
    const formatted = (formatOutput(item.output) ?? "").trim();
    return {
      key: item.nodeRunId,
      label: item.nodeLabel,
      body: formatted || t.trace.noOutput
    };
  });
}

function firstInboxThreadSelection(inboxItems: InboxItem[], approvals: PendingApprovalItem[]): InboxThreadSelection | undefined {
  const firstInboxItem = inboxItems[0];
  if (firstInboxItem) return { kind: "inbox", id: firstInboxItem.id };
  const firstApproval = approvals[0];
  if (firstApproval) return { kind: "approval", id: firstApproval.nodeRunId };
  return undefined;
}

function hasInboxThread(selection: InboxThreadSelection, items: InboxThreadListItem[]): boolean {
  return items.some((item) => item.kind === selection.kind && item.id === selection.id);
}

function inboxThreadKey(selection: InboxThreadSelection): string {
  return `${selection.kind}:${selection.id}`;
}

function hasAssistantReplyAfter(approval: PendingApprovalItem, createdAt: string): boolean {
  const pendingTimestamp = toSafeTimestamp(createdAt);
  return (approval.replies ?? []).some(
    (reply) => reply.role === "assistant" && toSafeTimestamp(reply.createdAt) >= pendingTimestamp
  );
}

function formatInboxHarnessLabel(harnessId: string | undefined): string {
  return harnessLikeDisplayLabel(harnessId);
}

function makeLocalInboxReplyId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `inbox-reply-${crypto.randomUUID()}`;
  }
  return `inbox-reply-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function buildInboxConversationMessages({
  selection,
  inboxItem,
  approval,
  replies,
  pendingHarnessReply,
  copy,
  t,
  language
}: {
  selection: InboxThreadSelection;
  inboxItem?: InboxItem;
  approval?: PendingApprovalItem;
  replies: InboxLocalReply[];
  pendingHarnessReply?: InboxPendingHarnessReply;
  copy: InboxCopy;
  t: Messages;
  language: Language;
}): InboxConversationMessage[] {
  const baseMessages =
    selection.kind === "inbox" && inboxItem
      ? buildFormalInboxConversation(inboxItem, copy, language)
      : selection.kind === "approval" && approval
        ? buildApprovalConversation(approval, copy, t)
        : [];
  const approvalReplies =
    selection.kind === "approval"
      ? (approval?.replies ?? []).map((reply) => ({
          id: reply.id,
          role: reply.role,
          speaker: reply.role === "user" ? copy.you : approval?.nodeLabel ?? copy.system,
          body: reply.body,
          createdAt: reply.createdAt,
          ...(reply.role === "assistant"
            ? {
                solutionId: reply.id,
                selectedSolution: approval?.selectedReplyId === reply.id || reply.selected === true,
                canUseAsSolution: true
              }
            : {})
        }))
      : [];
  const serverUserReplyBodies = new Set(
    selection.kind === "approval"
      ? (approval?.replies ?? [])
          .filter((reply) => reply.role === "user")
          .map((reply) => reply.body.trim())
      : (inboxItem?.replies ?? []).map((reply) => reply.body.trim())
  );
  const visibleLocalReplies = replies.filter((reply) => !serverUserReplyBodies.has(reply.body.trim()));
  const pendingMessages =
    pendingHarnessReply && selection.kind === "approval"
      ? [
          {
            id: pendingHarnessReply.id,
            role: "assistant" as const,
            speaker: pendingHarnessReply.harnessLabel,
            body: "",
            createdAt: pendingHarnessReply.createdAt,
            progressText: copy.waitingHarness(pendingHarnessReply.harnessLabel),
            pending: true
          }
        ]
      : [];

  return [
    ...baseMessages,
    ...approvalReplies,
    ...visibleLocalReplies.map((reply) => ({
      id: reply.id,
      role: "user" as const,
      speaker: copy.you,
      body: reply.body,
      createdAt: reply.createdAt
    })),
    ...pendingMessages
  ];
}

function buildFormalInboxConversation(item: InboxItem, copy: InboxCopy, language: Language): InboxConversationMessage[] {
  const facts = [
    `${copy.from}: ${item.createdByRoleId}`,
    item.targetRoleId ? `${copy.to}: ${item.targetRoleId}` : undefined,
    item.blueprintName ? `${copy.conversation}: ${item.blueprintName}` : undefined,
    `${copy.status}: ${inboxStatusLabel(item.status, language)}`,
    `${copy.openedAt}: ${formatDateTime(item.createdAt, language)}`,
    item.decidedAt ? `${copy.decidedAt}: ${formatDateTime(item.decidedAt, language)}` : undefined,
    item.decisionComment ? `${copy.decisionComment}: ${item.decisionComment}` : undefined
  ].filter((fact): fact is string => Boolean(fact));
  const messages: InboxConversationMessage[] = [
    {
      id: `${item.id}:summary`,
      role: "assistant",
      speaker: copy.system,
      body: [`### ${item.title}`, item.summary, ...facts.map((fact) => `- ${fact}`)].join("\n\n"),
      createdAt: item.createdAt
    }
  ];

  const payloadBody = formatInboxPayload(item.payload, copy);
  if (payloadBody) {
    messages.push({
      id: `${item.id}:payload`,
      role: "assistant",
      speaker: copy.system,
      body: payloadBody,
      createdAt: item.createdAt
    });
  }

  messages.push(
    ...(item.replies ?? []).map((reply) => ({
      id: reply.id,
      role: "user" as const,
      speaker: copy.you,
      body: reply.body,
      createdAt: reply.createdAt
    }))
  );

  return messages;
}

function buildApprovalConversation(
  approval: PendingApprovalItem,
  copy: InboxCopy,
  t: Messages
): InboxConversationMessage[] {
  const selectedReplyId = approval.selectedReplyId ?? approvalReviewOutputSolutionId;
  return approvalContentBlocks(approval, copy, t).map((block) => ({
    id: block.key,
    role: "assistant" as const,
    speaker: block.label,
    body: block.body,
    createdAt: approval.requestedAt,
    solutionId: approvalReviewOutputSolutionId,
    selectedSolution: selectedReplyId === approvalReviewOutputSolutionId,
    canUseAsSolution: true
  }));
}

function formatInboxPayload(payload: Record<string, unknown> | undefined, copy: InboxCopy): string {
  if (!payload) return "";
  const visiblePayload = compactInboxPayload(payload);
  const formatted = formatOutput(visiblePayload);
  if (!formatted.trim() || formatted.trim() === "{}") return "";
  const trimmed = formatted.length > 6_000 ? `${formatted.slice(0, 6_000)}\n...` : formatted;
  return [copy.payload, "", "```json", trimmed, "```"].join("\n");
}

function compactInboxPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const compacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === "blueprintPackage") {
      compacted[key] = summarizeBlueprintPackagePayload(value);
      continue;
    }
    compacted[key] = value;
  }
  return compacted;
}

function summarizeBlueprintPackagePayload(value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  const blueprints = Array.isArray(value.blueprints) ? value.blueprints : [];
  return {
    blueprints: blueprints.map((blueprint) =>
      isPlainObject(blueprint)
        ? {
            id: blueprint.id,
            name: blueprint.name,
            nodes: Array.isArray(blueprint.nodes) ? blueprint.nodes.length : undefined,
            edges: Array.isArray(blueprint.edges) ? blueprint.edges.length : undefined
          }
        : blueprint
    ),
    exportedAt: value.exportedAt,
    version: value.version
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function DashboardPage({
  dashboard,
  blueprints,
  runs,
  approvals,
  catalog,
  runtime,
  language,
  t,
  onAddWidget,
  onRemoveWidget
}: {
  dashboard?: WorkspaceDashboard;
  blueprints: BlueprintDefinition[];
  runs: BlueprintRunView[];
  approvals: PendingApprovalItem[];
  catalog?: CatalogSnapshot;
  runtime?: RuntimeOverview;
  language: Language;
  t: Messages;
  onAddWidget: (type: DashboardWidgetType) => void;
  onRemoveWidget: (widgetId: string) => void;
}) {
  const widgets = (dashboard?.dashboardWidgets ?? []).filter((widget) => widget.type !== "notes");
  const summary = [
    { icon: FolderKanban, label: t.metrics.blueprints(blueprints.length) },
    { icon: Activity, label: t.metrics.runs(runs.length) },
    { icon: Clock3, label: t.metrics.approvals(approvals.length) },
    { icon: Database, label: t.metrics.models(catalog?.models.length ?? 0) }
  ];

  return (
    <section className="page-grid">
      <div className="content-card stack-card">
        <div className="metric-strip">
          {summary.map((item) => {
            const Icon = item.icon;
            return (
              <div key={item.label} className="metric-chip">
                <Icon size={16} />
                <span>{item.label}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="content-card stack-card">
        <div className="card-toolbar">
          <div className="card-title-block">
            <h3>{t.tables.widgets}</h3>
            <p>{t.metrics.widgets(widgets.length)}</p>
          </div>
          <div className="toolbar-cluster wrap">
            {(["recent_runs", "pending_approvals", "runtime_overview", "catalog_status"] as DashboardWidgetType[]).map((type) => (
              <button key={type} type="button" onClick={() => onAddWidget(type)}>
                <PanelsTopLeft size={16} />
                {widgetTypeLabel(type, t)}
              </button>
            ))}
          </div>
        </div>
        <div className="card-grid widget-grid">
          {widgets.length === 0 ? (
            <div className="empty-state page-empty">{t.empty.noWidgets}</div>
          ) : (
            widgets.map((widget) => (
              <WidgetCard
                key={widget.id}
                widget={widget}
                dashboard={dashboard}
                runs={runs}
                approvals={approvals}
                catalog={catalog}
                runtime={runtime}
                language={language}
                t={t}
                onRemove={() => onRemoveWidget(widget.id)}
              />
            ))
          )}
        </div>
      </div>
    </section>
  );
}

export function ModelsPage({
  catalog,
  openClawConfig,
  wizard,
  language,
  t,
  busy,
  busyAction,
  runs,
  openClawModelUsage,
  onRefreshCatalog,
  onConfigureModelAuth,
  onSetDefaultModel
}: {
  catalog?: CatalogSnapshot;
  openClawConfig?: OpenClawConfigState;
  wizard?: OpenClawConfigWizardMetadata;
  language: Language;
  t: Messages;
  busy: boolean;
  busyAction?: string;
  runs: BlueprintRunView[];
  openClawModelUsage: OpenClawModelUsageSummary[];
  onRefreshCatalog: () => void;
  onConfigureModelAuth: (input: ConfigureOpenClawModelAuthRequest) => void;
  onSetDefaultModel: (modelId: string) => void;
}) {
  const [modelStep, setModelStep] = useState<"provider" | "method" | "details">("provider");
  const [providerSearch, setProviderSearch] = useState("");
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [selectedMethodId, setSelectedMethodId] = useState("");
  const [modelValues, setModelValues] = useState<Record<string, OpenClawWizardValue>>({});
  const modelCopy =
    language === "zh-CN"
      ? {
          configuredModels: "\u5df2\u914d\u7f6e\u6a21\u578b",
          usage: "\u7528\u91cf",
          calls: "\u8c03\u7528",
          tokens: "Token",
          cost: "\u8d39\u7528",
          recent7d: "\u6700\u8fd1 7 \u5929",
          setDefault: "\u8bbe\u4e3a\u9ed8\u8ba4"
        }
      : {
          configuredModels: "Configured models",
          usage: "Usage",
          calls: "Calls",
          tokens: "Tokens",
          cost: "Cost",
          recent7d: "Last 7 days",
          setDefault: "Set default"
        };
  const modelCardCopy = { ...modelCopy, defaultOption: t.common.defaultOption };

  const configuredModels = openClawConfig?.configuredModels ?? [];
  const usageByModel = useMemo(
    () => buildModelUsageIndex(runs, openClawModelUsage, openClawConfig?.defaultModelId),
    [openClawModelUsage, runs, openClawConfig?.defaultModelId]
  );
  const orderedConfiguredModels = useMemo(
    () =>
      [...configuredModels].sort((left, right) => {
        if (left.id === openClawConfig?.defaultModelId) return -1;
        if (right.id === openClawConfig?.defaultModelId) return 1;
        return left.label.localeCompare(right.label);
      }),
    [configuredModels, openClawConfig?.defaultModelId]
  );
  const wizardCopy =
    language === "zh-CN"
      ? {
          title: "\u914d\u7f6e\u6a21\u578b",
          providerStep: "Model/auth provider",
          methodStep: "auth method",
          detailsStep: "\u586b\u5199\u914d\u7f6e",
          search: "\u641c\u7d22",
          chooseMethod: "\u9009\u62e9\u8ba4\u8bc1\u65b9\u5f0f",
          configure: "\u5199\u5165\u914d\u7f6e",
          back: "\u8fd4\u56de",
          empty: "\u672a\u52a0\u8f7d OpenClaw \u5411\u5bfc\u5143\u6570\u636e",
          interactiveHint:
            "OAuth / Device Pairing \u65b9\u5f0f\u4f1a\u7ed1\u5b9a\u4e3b\u673a\u4e0a\u5df2\u5b58\u5728\u7684 OpenClaw \u767b\u5f55\u8bb0\u5f55\uff1b\u771f\u6b63\u767b\u5f55\u4ecd\u7531 openclaw models auth login \u5728\u4ea4\u4e92\u7ec8\u7aef\u4e2d\u5b8c\u6210\u3002"
        }
      : {
          title: "Configure model",
          providerStep: "Model/auth provider",
          methodStep: "auth method",
          detailsStep: "Configuration",
          search: "Search",
          chooseMethod: "Choose auth method",
          configure: "Write config",
          back: "Back",
          empty: "OpenClaw wizard metadata is not loaded.",
          interactiveHint:
            "OAuth / Device Pairing methods bind to an existing OpenClaw login on this host; the actual sign-in still runs through openclaw models auth login in an interactive terminal."
        };
  const modelProviders = wizard?.modelProviders ?? [];
  const selectedProvider = modelProviders.find((provider) => provider.id === selectedProviderId);
  const selectedMethod = selectedProvider?.methods.find((method) => method.id === selectedMethodId);
  const selectedModelFields = useMemo(
    () => mergeModelCatalogOptions(selectedMethod?.fields ?? [], selectedProvider?.id, catalog),
    [catalog, selectedMethod?.fields, selectedProvider?.id]
  );
  const filteredProviders = useMemo(
    () => filterWizardOptions(modelProviders, providerSearch),
    [modelProviders, providerSearch]
  );

  useEffect(() => {
    if (!selectedMethod) {
      setModelValues({});
      return;
    }
    setModelValues(defaultWizardValues(selectedModelFields));
  }, [selectedMethod?.id, selectedProvider?.id, selectedModelFields]);

  const submitModelConfig = () => {
    if (!selectedProvider || !selectedMethod) return;
    onConfigureModelAuth({
      providerId: selectedProvider.id,
      methodId: selectedMethod.id,
      values: modelValues
    });
  };

  return (
    <section className="page-grid">
      <div className="content-card stack-card">
        <div className="card-toolbar">
          <div className="card-title-block">
            <h3>{modelCopy.configuredModels}</h3>
          </div>
          <button type="button" title={t.actions.refreshCatalog} disabled={busy} onClick={onRefreshCatalog}>
            {busyAction === "refreshCatalog" ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
            {t.actions.refreshCatalog}
          </button>
        </div>
        <div className="model-card-grid">
          {orderedConfiguredModels.length ? (
            orderedConfiguredModels.map((model) => {
              const isDefault = model.id === openClawConfig?.defaultModelId;
              const usage = modelUsageFor(model.id, usageByModel);

              return (
                <ConfiguredModelCard
                  key={model.id}
                  model={{ id: model.id, provider: model.provider, label: model.label }}
                  usage={usage}
                  isDefault={isDefault}
                  copy={modelCardCopy}
                  language={language}
                  actions={
                    <button type="button" className={isDefault ? "default-action" : undefined} disabled={busy || isDefault} onClick={() => onSetDefaultModel(model.id)}>
                      {busyAction === `setOpenClawDefaultModel:${model.id}` && !isDefault ? <Loader2 className="spin" size={16} /> : <BadgeCheck size={16} />}
                      {isDefault ? t.common.defaultOption : modelCopy.setDefault}
                    </button>
                  }
                />
              );
            })
          ) : (
            <div className="empty-state page-empty">{t.empty.noCatalog}</div>
          )}
        </div>
      </div>

      <div className="content-card stack-card">
        <div className="card-toolbar">
          <div className="card-title-block">
            <h3>{wizardCopy.title}</h3>
          </div>
        </div>

        <div className="wizard-shell">
          <WizardPath
            items={[
              wizardCopy.providerStep,
              selectedProvider?.label,
              selectedMethod ? `${selectedProvider?.label} ${wizardCopy.methodStep}` : undefined,
              selectedMethod?.label
            ]}
          />

          {modelProviders.length === 0 ? (
            <div className="empty-state page-empty">{wizardCopy.empty}</div>
          ) : modelStep === "provider" ? (
            <>
              <label className="wizard-search">
                <Search size={16} />
                <input value={providerSearch} onChange={(event) => setProviderSearch(event.target.value)} placeholder={wizardCopy.search} />
              </label>
              <WizardChoiceList
                options={filteredProviders}
                selectedId={selectedProviderId}
                emptyText={wizardCopy.empty}
                identityKind="provider"
                onSelect={(provider) => {
                  setSelectedProviderId(provider.id);
                  setSelectedMethodId("");
                  setModelStep("method");
                }}
              />
            </>
          ) : modelStep === "method" && selectedProvider ? (
            <>
              <div className="wizard-stage-toolbar">
                <button
                  type="button"
                  onClick={() => {
                    setModelStep("provider");
                    setSelectedMethodId("");
                  }}
                >
                  <ArrowLeft size={16} />
                  {wizardCopy.back}
                </button>
                <div>
                  <strong>{selectedProvider.label}</strong>
                  <span>{wizardCopy.chooseMethod}</span>
                </div>
              </div>
              <WizardChoiceList
                options={selectedProvider.methods}
                selectedId={selectedMethodId}
                emptyText={wizardCopy.empty}
                identityKind="provider"
                getIdentityId={() => selectedProvider.id}
                onSelect={(method) => {
                  setSelectedMethodId(method.id);
                  setModelStep("details");
                }}
              />
            </>
          ) : selectedProvider && selectedMethod ? (
            <>
              <div className="wizard-stage-toolbar">
                <button type="button" onClick={() => setModelStep("method")}>
                  <ArrowLeft size={16} />
                  {wizardCopy.back}
                </button>
                <div>
                  <strong>{selectedMethod.label}</strong>
                  <span>{selectedMethod.hint ?? wizardCopy.detailsStep}</span>
                </div>
              </div>
              {["oauth", "device_code", "custom", "local"].includes(selectedMethod.kind) && <p className="wizard-note">{wizardCopy.interactiveHint}</p>}
              <WizardFieldList fields={selectedModelFields} values={modelValues} onChange={setModelValues} />
              <div className="card-actions">
                <button
                  type="button"
                  className="primary-action"
                  disabled={busy || !wizardFieldsReady(selectedModelFields, modelValues)}
                  onClick={submitModelConfig}
                >
                  {busy ? <Loader2 className="spin" size={16} /> : <KeyRound size={16} />}
                  {selectedMethod.submitLabel ?? wizardCopy.configure}
                </button>
              </div>
            </>
          ) : null}
        </div>
      </div>

    </section>
  );
}

export type ConfiguredModelCardModel = {
  id: string;
  provider: string;
  label: string;
};

export type ConfiguredModelCardCopy = {
  usage: string;
  calls: string;
  tokens: string;
  cost: string;
  recent7d: string;
  defaultOption: string;
};

export function ConfiguredModelCard({
  model,
  usage,
  isDefault = false,
  badgeLabel,
  copy,
  language,
  actions,
  children,
  className
}: {
  model: ConfiguredModelCardModel;
  usage?: ModelUsageSummary;
  isDefault?: boolean;
  badgeLabel?: string;
  copy: ConfiguredModelCardCopy;
  language: Language;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const usageSummary = usage ?? createEmptyModelUsageSummary();
  const recentDays = recentModelUsageDays(usageSummary, language);
  const recentTotal = summarizeRecentModelUsage(recentDays);
  const maxDailyTokens = Math.max(1, ...recentDays.map((day) => day.totalTokens));
  const visibleBadge = badgeLabel ?? (isDefault ? copy.defaultOption : undefined);

  return (
    <article className={`model-card${className ? ` ${className}` : ""}`}>
      <div className="model-card-head">
        <IdentityTitle kind="model" id={model.provider} label={model.label} />
        {visibleBadge && <span className="status-pill status-default">{visibleBadge}</span>}
      </div>
      <div className="model-card-usage" aria-label={copy.usage}>
        <div className="model-usage-head">
          <span>{copy.recent7d}</span>
          <strong>{`${formatCompactTokenValue(recentTotal.totalTokens)} ${copy.tokens}`}</strong>
        </div>
        <div className="model-usage-chart">
          {recentDays.map((day) => (
            <div
              key={day.dateKey}
              className="model-usage-day"
              title={`${day.fullLabel}: ${day.totalTokens.toLocaleString(language)} ${copy.tokens}, $${day.costUsd.toFixed(4)}`}
            >
              <div className="model-usage-bar-track">
                <span
                  className={`model-usage-bar ${day.totalTokens === 0 ? "empty" : ""}`}
                  style={{ height: `${modelUsageBarHeight(day.totalTokens, maxDailyTokens)}%` }}
                />
              </div>
              <span className="model-usage-value">{formatCompactTokenValue(day.totalTokens)}</span>
              <span className="model-usage-label">{day.label}</span>
            </div>
          ))}
        </div>
        <div className="model-usage-foot">
          <span>{`${copy.calls}: ${recentTotal.calls.toLocaleString(language)}`}</span>
          <span>{`${copy.cost}: $${recentTotal.costUsd.toFixed(4)}`}</span>
        </div>
      </div>
      {children}
      {actions && <div className="model-card-actions">{actions}</div>}
    </article>
  );
}

export function AgentsPage({
  catalog,
  openClawConfig,
  language,
  t,
  busy,
  onAddAgent
}: {
  catalog?: CatalogSnapshot;
  openClawConfig?: OpenClawConfigState;
  language: Language;
  t: Messages;
  busy: boolean;
  onAddAgent: (input: { name: string; workspace?: string; modelId?: string }) => void;
}) {
  const [agentName, setAgentName] = useState("");
  const [agentWorkspace, setAgentWorkspace] = useState("");
  const [agentModelId, setAgentModelId] = useState("");
  const copy =
    language === "zh-CN"
      ? {
          configuredAgents: "已配置 Agent"
        }
      : {
          configuredAgents: "Configured agents"
        };

  useEffect(() => {
    setAgentModelId(openClawConfig?.defaultModelId ?? catalog?.models[0]?.id ?? "");
  }, [catalog?.models, openClawConfig?.defaultModelId]);

  useEffect(() => {
    if (!agentName.trim()) {
      setAgentWorkspace("");
      return;
    }
    if (agentWorkspace.trim()) return;
    if (openClawConfig?.defaultWorkspace) {
      setAgentWorkspace(joinWorkspacePath(openClawConfig.defaultWorkspace, normalizeAgentId(agentName)));
    }
  }, [agentName, agentWorkspace, openClawConfig?.defaultWorkspace]);

  const configuredAgents = openClawConfig?.configuredAgents ?? [];

  return (
    <section className="page-grid">
      <div className="content-card stack-card">
        <div className="card-toolbar">
          <div className="card-title-block">
            <h3>{copy.configuredAgents}</h3>
          </div>
        </div>
        <div className="model-card-grid">
          {configuredAgents.length ? (
            configuredAgents.map((agent) => (
              <article key={agent.id} className="model-card">
                <div className="model-card-head">
                  <IdentityTitle kind="agent" id={agent.id} label={agent.name ?? agent.id} />
                  {agent.isDefault && <span className="status-pill status-default">{t.common.defaultOption}</span>}
                </div>
                <div className="model-card-main">
                  <code>{agent.agentDir}</code>
                </div>
                <div className="model-card-meta">
                  <span>{`${t.fields.model}: ${agent.modelId ?? t.common.defaultModel}`}</span>
                  <span>{`${t.fields.workspace}: ${agent.workspace}`}</span>
                </div>
              </article>
            ))
          ) : (
            <div className="empty-state page-empty">{t.empty.noCatalog}</div>
          )}
        </div>
      </div>

      <div className="content-card stack-card">
        <div className="card-toolbar">
          <div className="card-title-block">
            <h3>{t.actions.addAgent}</h3>
          </div>
        </div>
        <div className="form-grid">
          <label>
            <span>{t.fields.agentName}</span>
            <input value={agentName} onChange={(event) => setAgentName(event.target.value)} placeholder="researcher" />
          </label>
          <label>
            <span>{t.fields.model}</span>
            <select value={agentModelId} onChange={(event) => setAgentModelId(event.target.value)}>
              <option value="">{t.common.defaultModel}</option>
              {(catalog?.models ?? []).map((model) => (
                <option key={model.id} value={model.id}>
                  {`${model.label} (${model.id})`}
                </option>
              ))}
            </select>
          </label>
          <label className="field-span-full">
            <span>{t.fields.workspace}</span>
            <input
              value={agentWorkspace}
              onChange={(event) => setAgentWorkspace(event.target.value)}
              placeholder={
                openClawConfig?.defaultWorkspace
                  ? formatWorkspacePathPlaceholder(openClawConfig.defaultWorkspace)
                  : t.catalogConfig.workspacePlaceholder
              }
            />
          </label>
        </div>
        <div className="card-actions">
          <button
            type="button"
            className="primary-action"
            disabled={!agentName.trim() || busy}
            onClick={() => {
              onAddAgent({
                name: agentName.trim(),
                workspace: agentWorkspace.trim() || undefined,
                modelId: agentModelId || undefined
              });
              setAgentName("");
              setAgentWorkspace("");
              setAgentModelId(openClawConfig?.defaultModelId ?? catalog?.models[0]?.id ?? "");
            }}
          >
            {busy ? <Loader2 className="spin" size={16} /> : <FolderKanban size={16} />}
            {t.actions.addAgent}
          </button>
        </div>
      </div>
    </section>
  );
}

export function SkillsPage({
  catalog,
  language,
  t
}: {
  catalog?: CatalogSnapshot;
  language: Language;
  t: Messages;
}) {
  const copy =
    language === "zh-CN"
      ? {
          source: "\u6570\u636e\u6e90",
          openclawCatalog: "OpenClaw \u76ee\u5f55",
          count: (value: number) => `${value.toLocaleString(language)} Skills`
        }
      : {
          source: "Source",
          openclawCatalog: "OpenClaw catalog",
          count: (value: number) => `${value.toLocaleString(language)} Skills`
        };
  const skills = catalog?.tools ?? [];

  return (
    <section className="page-grid">
      <div className="content-card stack-card">
        <div className="card-toolbar">
          <div className="card-title-block">
            <h3>{t.pages.skills?.title ?? "Skills"}</h3>
            <p>{t.pages.skills?.description ?? copy.openclawCatalog}</p>
          </div>
          <span className="status-pill status-running">{copy.count(skills.length)}</span>
        </div>

        <div className="model-card-grid">
          {skills.length ? (
            skills.map((skill) => (
              <article key={skill.id} className="model-card">
                <div className="model-card-head">
                  <div className="model-card-main">
                    <strong>{skill.label}</strong>
                    <code>{skill.id}</code>
                  </div>
                  <span className="status-pill status-succeeded">{skill.category || "Skill"}</span>
                </div>
                <div className="model-card-main">
                  <p>{skill.description || "-"}</p>
                </div>
                <div className="model-card-meta">
                  <span>{`${copy.source}: ${copy.openclawCatalog}`}</span>
                  <span>{`${t.fields.category}: ${skill.category || "-"}`}</span>
                </div>
              </article>
            ))
          ) : (
            <div className="empty-state page-empty">{t.empty.noSkills}</div>
          )}
        </div>
      </div>
    </section>
  );
}

function runResultTitle(runView: BlueprintRunView, blueprints: BlueprintDefinition[]): string {
  return (
    runView.finalResult?.candidates[0]?.nodeLabel ??
    runView.finalResult?.failedNode?.nodeLabel ??
    runView.finalResult?.waitingApprovalNode?.nodeLabel ??
    blueprintNameFor(blueprints, runView.run.blueprintId)
  );
}

function runResultPreview(runView: BlueprintRunView, t: Messages): string {
  const result = runView.finalResult;
  if (!result) return t.trace.noOutput;
  if (result.state === "available") {
    return summarizeOutput(result.candidates[0]?.output, t);
  }
  if (result.state === "failed") {
    return result.failedNode?.error || summarizeOutput(result.failedNode?.output, t);
  }
  if (result.state === "waiting_approval") {
    return result.waitingApprovalNode?.nodeLabel ?? t.status.waiting_approval;
  }
  return t.trace.noOutput;
}

function runResultStatusClassName(runView: BlueprintRunView): string {
  const state = runView.finalResult?.state;
  if (state === "available") return "status-succeeded";
  if (state === "failed") return "status-failed";
  if (state === "waiting_approval") return "status-waiting_approval";
  if (state === "empty") return "status-empty";
  return `status-${runView.run.status}`;
}

function runResultStatusLabel(runView: BlueprintRunView, t: Messages, language: Language): string {
  const state = runView.finalResult?.state;
  if (state === "available") return language === "zh-CN" ? "已生成" : "Available";
  if (state === "failed") return t.status.failed;
  if (state === "waiting_approval") return t.status.waiting_approval;
  if (state === "empty") return language === "zh-CN" ? "无输出" : "No output";
  return t.status[runView.run.status];
}

export function HistoryPage({
  runs,
  approvals: _approvals,
  blueprints,
  language,
  t,
  onOpenRun
}: {
  runs: BlueprintRunView[];
  approvals: PendingApprovalItem[];
  blueprints: BlueprintDefinition[];
  language: Language;
  t: Messages;
  onOpenRun: (runId: string, blueprintId: string) => void;
}) {
  const copy =
    language === "zh-CN"
        ? {
            title: "\u5386\u53f2",
            runHistory: "\u8fd0\u884c\u5386\u53f2",
            runResults: "运行结果",
            fromDate: "\u5f00\u59cb\u65e5\u671f",
            toDate: "\u7ed3\u675f\u65e5\u671f",
            noRecords: "\u8be5\u65f6\u95f4\u8303\u56f4\u6ca1\u6709\u76f8\u5173\u8bb0\u5f55\u3002",
            noResults: "该时间范围没有运行结果。",
            openRun: "\u67e5\u770b\u8fd0\u884c\u8be6\u60c5",
            startedAt: "\u542f\u52a8\u65f6\u95f4"
          }
        : {
            title: "History",
            runHistory: "Run history",
            runResults: "Run results",
            fromDate: "Start date",
            toDate: "End date",
            noRecords: "No records for this date range.",
            noResults: "No run results for this date range.",
            openRun: "View run detail",
            startedAt: "Started"
          };
  const [startDate, setStartDate] = useState(() => toDateInputValue(addDays(new Date(), -6)));
  const [endDate, setEndDate] = useState(() => toDateInputValue(new Date()));
  const [rangeStart, rangeEnd] = normalizeDateRange(startDate, endDate);
  const runHistoryForRange = useMemo(
    () =>
      runs.filter((runView) =>
        isRunInDateRange(runView, rangeStart, rangeEnd)
      ),
    [runs, rangeStart, rangeEnd]
  );

  return (
    <section className="page-grid trace-page-grid history-page-grid">
      <div className="trace-page-title history-page-title">
        <h2>{copy.title}</h2>
        <div className="history-date-range">
          <label className="date-picker-field">
            <span>{copy.fromDate}</span>
            <input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value || toDateInputValue(new Date()))} />
          </label>
          <label className="date-picker-field">
            <span>{copy.toDate}</span>
            <input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value || toDateInputValue(new Date()))} />
          </label>
        </div>
      </div>

      <section className="trace-layout history-layout">
        <div className="trace-column-shell history-column-shell">
          <div className="trace-column-header history-column-header">
            <h3>{copy.runHistory}</h3>
          </div>
          <div className="content-card stack-card history-card">
            <div className="table-stack history-list">
              {runHistoryForRange.length ? (
                runHistoryForRange.map((runView) => (
                  <button
                    key={runView.run.id}
                    type="button"
                    className="table-row history-list-row history-list-button"
                    title={copy.openRun}
                    onClick={() => onOpenRun(runView.run.id, runView.run.blueprintId)}
                  >
                    <div className="history-list-main">
                      <strong>{blueprintNameFor(blueprints, runView.run.blueprintId)}</strong>
                      <p>{runView.run.id}</p>
                    </div>
                    <span className={`status-pill history-list-status status-${runView.run.status}`}>{t.status[runView.run.status]}</span>
                    <div className="history-list-meta">
                      <span>{copy.startedAt}</span>
                      <time dateTime={runView.run.startedAt}>{formatDateTime(runView.run.startedAt, language)}</time>
                    </div>
                  </button>
                ))
              ) : (
                <div className="empty-state page-empty">{copy.noRecords}</div>
              )}
            </div>
          </div>
        </div>

        <div className="trace-column-shell history-column-shell">
          <div className="trace-column-header history-column-header">
            <h3>{copy.runResults}</h3>
          </div>
          <div className="content-card stack-card history-card">
            <div className="table-stack history-list">
              {runHistoryForRange.length ? (
                runHistoryForRange.map((runView) => (
                  <button
                    key={runView.run.id}
                    type="button"
                    className="table-row history-list-row history-list-button"
                    title={copy.openRun}
                    onClick={() => onOpenRun(runView.run.id, runView.run.blueprintId)}
                  >
                    <div className="history-list-main">
                      <strong>{runResultTitle(runView, blueprints)}</strong>
                      <p>{runResultPreview(runView, t)}</p>
                    </div>
                    <span className={`status-pill history-list-status ${runResultStatusClassName(runView)}`}>
                      {runResultStatusLabel(runView, t, language)}
                    </span>
                    <div className="history-list-meta">
                      <span>{blueprintNameFor(blueprints, runView.run.blueprintId)}</span>
                      <time dateTime={runView.run.endedAt ?? runView.run.startedAt}>
                        {formatDateTime(runView.run.endedAt ?? runView.run.startedAt, language)}
                      </time>
                    </div>
                  </button>
                ))
              ) : (
                <div className="empty-state page-empty">{copy.noResults}</div>
              )}
            </div>
          </div>
        </div>
      </section>
    </section>
  );
}

export function ChannelsPage({
  catalog,
  openClawConfig,
  wizard,
  language,
  t,
  busy,
  onConfigureChannel
}: {
  catalog?: CatalogSnapshot;
  openClawConfig?: OpenClawConfigState;
  wizard?: OpenClawConfigWizardMetadata;
  language: Language;
  t: Messages;
  busy: boolean;
  onConfigureChannel: (input: ConfigureOpenClawChannelRequest) => void;
}) {
  const copy =
    language === "zh-CN"
      ? {
          enabled: "已启用",
          disabled: "已停用"
        }
      : {
          enabled: "Enabled",
          disabled: "disabled"
        };
  const configCopy =
    language === "zh-CN"
      ? {
          addChannel: "添加频道配置",
          configuredChannels: "已配置频道",
          channel: "频道",
          account: "账号 ID",
          accountName: "显示名称",
          credentialKind: "凭据字段",
          credentialValue: "凭据值",
          useEnv: "使用环境变量",
          noCredential: "不写入凭据",
          defaultAccount: "默认账号",
          credentialKeys: "凭据字段"
        }
      : {
          addChannel: "Add channel config",
          configuredChannels: "Configured channels",
          channel: "Channel",
          account: "Account ID",
          accountName: "Display name",
          credentialKind: "Credential field",
          credentialValue: "Credential value",
          useEnv: "Use environment",
          noCredential: "No credential",
          defaultAccount: "Default account",
          credentialKeys: "Credential keys"
        };
  const wizardCopy =
    language === "zh-CN"
      ? {
          title: "\u6309 CLI \u8def\u5f84\u6dfb\u52a0\u9891\u9053",
          channelStep: "\u9891\u9053",
          detailsStep: "\u914d\u7f6e\u9009\u9879",
          search: "\u641c\u7d22",
          configure: "\u5199\u5165\u914d\u7f6e",
          back: "\u8fd4\u56de",
          empty: "\u672a\u52a0\u8f7d OpenClaw \u9891\u9053\u5411\u5bfc\u5143\u6570\u636e"
        }
      : {
          title: "Add channel through the CLI path",
          channelStep: "Channel",
          detailsStep: "Setup options",
          search: "Search",
          configure: "Write config",
          back: "Back",
          empty: "OpenClaw channel wizard metadata is not loaded."
        };
  const channelOptions = useMemo(() => {
    const byId = new Map<string, OpenClawChannelSetupOption>();
    for (const option of wizard?.channels ?? []) byId.set(option.id, option);
    for (const channel of catalog?.channels ?? []) {
      if (!byId.has(channel.id)) byId.set(channel.id, { id: channel.id, label: channel.label, fields: [] });
    }
    return [...byId.values()].sort((left, right) => left.label.localeCompare(right.label));
  }, [catalog?.channels, wizard?.channels]);
  const [channelStep, setChannelStep] = useState<"channel" | "details">("channel");
  const [channelSearch, setChannelSearch] = useState("");
  const [selectedChannelId, setSelectedChannelId] = useState("");
  const [channelValues, setChannelValues] = useState<Record<string, OpenClawWizardValue>>({});
  const selectedChannel = channelOptions.find((channel) => channel.id === selectedChannelId);
  const filteredChannels = useMemo(() => filterWizardOptions(channelOptions, channelSearch), [channelOptions, channelSearch]);
  const configuredChannels = openClawConfig?.configuredChannels ?? [];

  useEffect(() => {
    if (!selectedChannel) {
      setChannelValues({});
      return;
    }
    setChannelValues(defaultWizardValues(selectedChannel.fields));
  }, [selectedChannel?.id]);

  const submitChannelConfig = () => {
    if (!selectedChannel) return;
    onConfigureChannel({
      channelId: selectedChannel.id,
      values: channelValues
    });
  };

  return (
    <section className="page-grid">
      <div className="content-card stack-card">
        <div className="card-toolbar">
          <div className="card-title-block">
            <h3>{configCopy.configuredChannels}</h3>
          </div>
        </div>
        <div className="model-card-grid">
          {configuredChannels.length ? (
            configuredChannels.flatMap((channel) =>
              channel.accounts.map((account) => (
                <article key={`${channel.id}:${account.id}`} className="model-card">
                  <div className="model-card-head">
                    <IdentityTitle kind="channel" id={channel.id} label={account.name ?? `${channel.label} / ${account.id}`} />
                    <span className={`status-pill ${account.enabled && channel.enabled ? "status-succeeded" : "status-cancelled"}`}>
                      {account.enabled && channel.enabled ? copy.enabled : copy.disabled}
                    </span>
                  </div>
                  <div className="model-card-main">
                    <code>{`${channel.id}:${account.id}`}</code>
                  </div>
                  <div className="model-card-meta">
                    <span className={account.isDefault ? "default-label" : undefined}>
                      {account.isDefault ? configCopy.defaultAccount : `${configCopy.account}: ${account.id}`}
                    </span>
                    <span>{`${configCopy.credentialKeys}: ${account.credentialKeys.length ? account.credentialKeys.join(", ") : "-"}`}</span>
                  </div>
                </article>
              ))
            )
          ) : (
            <div className="empty-state page-empty">{t.empty.noCatalog}</div>
          )}
        </div>
      </div>

      <div className="content-card stack-card">
        <div className="card-toolbar">
          <div className="card-title-block">
            <h3>{wizardCopy.title}</h3>
          </div>
        </div>

        <div className="wizard-shell">
          <WizardPath items={[wizardCopy.channelStep, selectedChannel?.label, selectedChannel ? wizardCopy.detailsStep : undefined]} />

          {channelOptions.length === 0 ? (
            <div className="empty-state page-empty">{wizardCopy.empty}</div>
          ) : channelStep === "channel" ? (
            <>
              <label className="wizard-search">
                <Search size={16} />
                <input value={channelSearch} onChange={(event) => setChannelSearch(event.target.value)} placeholder={wizardCopy.search} />
              </label>
              <WizardChoiceList
                options={filteredChannels}
                selectedId={selectedChannelId}
                emptyText={wizardCopy.empty}
                identityKind="channel"
                onSelect={(channel) => {
                  setSelectedChannelId(channel.id);
                  setChannelStep("details");
                }}
              />
            </>
          ) : selectedChannel ? (
            <>
              <div className="wizard-stage-toolbar">
                <button type="button" onClick={() => setChannelStep("channel")}>
                  <ArrowLeft size={16} />
                  {wizardCopy.back}
                </button>
                <div>
                  <strong>{selectedChannel.label}</strong>
                  <span>{selectedChannel.hint ?? wizardCopy.detailsStep}</span>
                </div>
              </div>
              <WizardFieldList fields={selectedChannel.fields} values={channelValues} onChange={setChannelValues} />
              <div className="card-actions">
                <button
                  type="button"
                  className="primary-action"
                  disabled={busy || !wizardFieldsReady(selectedChannel.fields, channelValues)}
                  onClick={submitChannelConfig}
                >
                  {busy ? <Loader2 className="spin" size={16} /> : <MessageSquareText size={16} />}
                  {wizardCopy.configure}
                </button>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function WidgetCard({
  widget,
  dashboard,
  runs,
  approvals,
  catalog,
  runtime,
  language,
  t,
  onRemove
}: {
  widget: DashboardWidget;
  dashboard?: WorkspaceDashboard;
  runs: BlueprintRunView[];
  approvals: PendingApprovalItem[];
  catalog?: CatalogSnapshot;
  runtime?: RuntimeOverview;
  language: Language;
  t: Messages;
  onRemove: () => void;
}) {
  return (
    <article className="feature-card widget-card">
      <div className="feature-card-header">
        <div>
          <strong>{widget.title}</strong>
          <p>{widgetTypeLabel(widget.type, t)}</p>
        </div>
        <button type="button" className="icon-button" onClick={onRemove}>
          <Trash2 size={16} />
        </button>
      </div>
      {widget.type === "recent_runs" && (
        <div className="widget-list">
          {runs.slice(0, 3).map((run) => (
            <div key={run.run.id} className="mini-row">
              <span>{run.run.id}</span>
              <code>{t.status[run.run.status]}</code>
            </div>
          ))}
        </div>
      )}
      {widget.type === "pending_approvals" && (
        <div className="widget-list">
          <div className="metric-chip emphasize">
            <Clock3 size={16} />
            <span>{t.metrics.approvals(approvals.length)}</span>
          </div>
          {approvals.slice(0, 3).map((approval) => (
            <div key={approval.nodeRunId} className="mini-row">
              <span>{approval.blueprintName}</span>
              <code>{approval.nodeLabel}</code>
            </div>
          ))}
        </div>
      )}
      {widget.type === "runtime_overview" && (
        <div className="widget-list">
          <div className="mini-row">
            <span>{t.tables.sessions}</span>
            <code>{runtime?.sessions.length ?? 0}</code>
          </div>
          <div className="mini-row">
            <span>{t.tables.tasks}</span>
            <code>{runtime?.tasks.length ?? 0}</code>
          </div>
        </div>
      )}
      {widget.type === "catalog_status" && (
        <div className="widget-list">
          <div className="mini-row">
            <span>{t.tables.models}</span>
            <code>{catalog?.models.length ?? 0}</code>
          </div>
          <div className="mini-row">
            <span>{t.tables.agents}</span>
            <code>{catalog?.agents.length ?? 0}</code>
          </div>
          <div className="mini-row">
            <span>{t.fields.updatedAt}</span>
            <code>{catalog ? formatDateTime(catalog.refreshedAt, language) : t.common.unknown}</code>
          </div>
        </div>
      )}
      {widget.type === "notes" && (
        <div className="widget-list">
          {(dashboard?.notes ?? []).slice(0, 3).map((note) => (
            <div key={note.id} className="mini-column">
              <strong>{note.title}</strong>
              <p>{note.body}</p>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

function mergeModelCatalogOptions(fields: OpenClawWizardField[], providerId: string | undefined, catalog: CatalogSnapshot | undefined): OpenClawWizardField[] {
  if (!providerId) return fields;
  const catalogOptions =
    catalog?.models
      .filter((model) => model.provider === providerId || model.id.startsWith(`${providerId}/`))
      .map((model) => {
        const value = model.id.startsWith(`${providerId}/`) ? model.id.slice(providerId.length + 1) : model.id;
        return { value, label: model.label === model.id ? value : `${model.label} (${value})` };
      }) ?? [];

  return fields.map((field) => {
    if (field.id !== "modelId") return field;
    const optionsByValue = new Map<string, { value: string; label: string; hint?: string }>();
    for (const option of field.options ?? []) optionsByValue.set(option.value, option);
    for (const option of catalogOptions) optionsByValue.set(option.value, option);
    const options = [...optionsByValue.values()];
    return {
      ...field,
      options,
      defaultValue: options.some((option) => option.value === field.defaultValue) ? field.defaultValue : options[0]?.value ?? field.defaultValue
    };
  });
}

export function IdentityTitle({ kind, id, label }: { kind: IdentityKind; id: string; label: string }) {
  return (
    <div className="identity-title">
      <IdentityMark kind={kind} id={id} label={label} />
      <strong>{label}</strong>
    </div>
  );
}

function IdentityMark({ kind, id, label }: { kind: IdentityKind; id: string; label: string }) {
  const identity = identitySpecFor(kind, id, label);
  const [logoFailed, setLogoFailed] = useState(false);
  useEffect(() => setLogoFailed(false), [identity.logoUrl]);
  const hasLogo = Boolean(identity.logoUrl && !logoFailed);
  return (
    <span
      className={`identity-mark identity-${kind} identity-${identity.key} ${hasLogo ? "identity-has-logo" : "identity-avatar"}`}
      title={identity.label}
      aria-label={identity.label}
    >
      {hasLogo ? (
        <img
          src={identity.logoUrl}
          alt=""
          aria-hidden="true"
          onError={(event) => {
            event.currentTarget.style.display = "none";
            setLogoFailed(true);
          }}
        />
      ) : (
        <span className="identity-initials" aria-hidden="true">
          {identity.initials}
        </span>
      )}
    </span>
  );
}

function identitySpecFor(kind: IdentityKind, id: string, label: string): IdentitySpec {
  if (kind === "agent") {
    return {
      key: sanitizeIdentityKey(id || label),
      label,
      initials: initialsFor(label || id, "AG")
    };
  }

  const normalized = normalizeIdentityKey(id || label);
  const known = KNOWN_IDENTITIES[normalized] ?? KNOWN_IDENTITIES[normalized.replace(/_/g, "-")];
  if (known) {
    return {
      key: sanitizeIdentityKey(normalized),
      label: known.label,
      initials: known.initials,
      logoUrl: known.logoUrl
    };
  }

  return {
    key: sanitizeIdentityKey(normalized || label),
    label: label || id,
    initials: initialsFor(label || id, kind === "channel" ? "CH" : "AI")
  };
}

function normalizeIdentityKey(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/\\/g, "/")
    .split("/")
    .find(Boolean) ?? value.trim().toLowerCase();

  const compact = normalized.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (compact.includes("openai")) return "openai";
  if (compact.includes("codex")) return "openai";
  if (compact.includes("deepseek")) return "deepseek";
  if (compact.includes("minimax")) return "minimax";
  if (compact.includes("zhipu")) return "zai";
  if (compact.includes("kimi")) return "moonshot";
  if (compact.includes("claude") || compact.includes("anthropic")) return "anthropic";
  if (compact.includes("feishu") || compact.includes("lark")) return "feishu";
  if (compact.includes("google-chat") || compact.includes("googlechat")) return "google-chat";
  if (compact.includes("mattermost")) return "mattermost";
  if (compact.includes("nostr")) return "nostr";
  if (compact.includes("tlon")) return "tlon";
  if (compact.includes("whatsapp") || compact.includes("whats-app")) return "whatsapp";
  if (compact.includes("zalo-user") || compact.includes("zalouser")) return "zalo-user";
  if (compact.includes("zalo")) return "zalo";
  if (compact.includes("microsoft-teams") || compact.includes("teams")) return "microsoft-teams";
  if (compact.includes("nextcloud")) return "nextcloud-talk";
  if (compact.includes("qa-channel")) return "qa-channel";
  if (compact.includes("synology")) return "synology";
  if (compact.includes("qq")) return "qq";
  return compact;
}

function sanitizeIdentityKey(value: string): string {
  return normalizeIdentityKey(value).replace(/[^a-z0-9_-]/g, "-") || "generic";
}

function initialsFor(value: string, fallback: string): string {
  const clean = value.trim().replace(/[_/\\.-]+/g, " ");
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]![0] ?? ""}${parts[1]![0] ?? ""}`.toUpperCase();
  return (parts[0]?.slice(0, 2) || fallback).toUpperCase();
}

function WizardPath({ items }: { items: Array<string | undefined> }) {
  const visibleItems = items.filter((item): item is string => Boolean(item?.trim()));
  return (
    <div className="wizard-path">
      {visibleItems.map((item, index) => (
        <span key={`${item}:${index}`} className="wizard-path-item">
          {index > 0 && <ChevronRight size={14} />}
          <span>{item}</span>
        </span>
      ))}
    </div>
  );
}

function WizardChoiceList<T extends { id: string; label: string; hint?: string }>({
  options,
  selectedId,
  emptyText,
  identityKind,
  getIdentityId,
  onSelect
}: {
  options: T[];
  selectedId?: string;
  emptyText: string;
  identityKind?: IdentityKind;
  getIdentityId?: (option: T) => string;
  onSelect: (option: T) => void;
}) {
  if (options.length === 0) return <div className="empty-state page-empty">{emptyText}</div>;

  return (
    <div className="wizard-option-list">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          className={`wizard-option ${option.id === selectedId ? "selected" : ""}`}
          onClick={() => onSelect(option)}
        >
          {identityKind && <IdentityMark kind={identityKind} id={getIdentityId?.(option) ?? option.id} label={option.label} />}
          <span className="wizard-option-main">
            <strong>{option.label}</strong>
            <span>{option.hint ?? option.id}</span>
          </span>
          <ChevronRight size={16} />
        </button>
      ))}
    </div>
  );
}

function WizardFieldList({
  fields,
  values,
  onChange
}: {
  fields: OpenClawWizardField[];
  values: Record<string, OpenClawWizardValue>;
  onChange: (values: Record<string, OpenClawWizardValue>) => void;
}) {
  const visibleFields = fields.filter((field) => isWizardFieldVisible(field, values));
  if (visibleFields.length === 0) return <div className="empty-state compact-empty-state">No additional options.</div>;

  return (
    <div className="form-grid form-grid-wide wizard-field-grid">
      {visibleFields.map((field) => {
        const value = values[field.id] ?? field.defaultValue ?? (field.type === "checkbox" ? false : "");
        return (
          <label key={field.id} className={field.type === "checkbox" ? "checkbox-field" : undefined}>
            {field.type !== "checkbox" && <span>{field.label}</span>}
            {field.type === "select" ? (
              <select value={String(value ?? "")} onChange={(event) => onChange({ ...values, [field.id]: event.target.value })}>
                {(field.options ?? []).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : field.type === "checkbox" ? (
              <>
                <input type="checkbox" checked={value === true} onChange={(event) => onChange({ ...values, [field.id]: event.target.checked })} />
                <span>{field.label}</span>
              </>
            ) : (
              <input
                type={field.type === "password" ? "password" : field.type === "number" ? "number" : "text"}
                inputMode={field.type === "number" ? "numeric" : undefined}
                value={String(value ?? "")}
                onChange={(event) => onChange({ ...values, [field.id]: event.target.value })}
                placeholder={field.placeholder}
              />
            )}
            {field.hint && <small className="field-hint">{field.hint}</small>}
          </label>
        );
      })}
    </div>
  );
}

function filterWizardOptions<T extends { label: string; id: string; hint?: string }>(options: T[], search: string): T[] {
  const normalized = search.trim().toLowerCase();
  if (!normalized) return options;
  return options.filter((option) => [option.label, option.id, option.hint].some((value) => value?.toLowerCase().includes(normalized)));
}

function defaultWizardValues(fields: OpenClawWizardField[]): Record<string, OpenClawWizardValue> {
  return Object.fromEntries(
    fields.map((field) => [field.id, field.defaultValue ?? (field.type === "checkbox" ? false : "")])
  );
}

function wizardFieldsReady(fields: OpenClawWizardField[], values: Record<string, OpenClawWizardValue>): boolean {
  return fields.every((field) => {
    if (!isWizardFieldVisible(field, values) || !field.required) return true;
    const value = values[field.id] ?? field.defaultValue;
    if (field.type === "checkbox") return value === true;
    if (typeof value === "string") return value.trim().length > 0;
    if (typeof value === "number") return Number.isFinite(value);
    return value !== undefined;
  });
}

function isWizardFieldVisible(field: OpenClawWizardField, values: Record<string, OpenClawWizardValue>): boolean {
  if (!field.visibleWhen) return true;
  const actual = values[field.visibleWhen.fieldId];
  return actual === field.visibleWhen.equals;
}

function buildTraceIssues(
  activeRun: BlueprintRunView | undefined,
  blueprint: BlueprintDefinition | undefined,
  orderedNodes: BlueprintNode[],
  t: Messages
): TraceIssue[] {
  if (!activeRun?.nodeRuns.length) {
    return buildPendingTraceIssues(blueprint, orderedNodes, t);
  }

  const nodesById = new Map((blueprint?.nodes ?? []).map((node) => [node.id, node]));
  const childrenBySlotId = new Map<string, Set<string>>();
  for (const node of blueprint?.nodes ?? []) {
    if (!node.parentId) continue;
    const parent = nodesById.get(node.parentId);
    if (parent?.type !== "manager_slot") continue;
    childrenBySlotId.set(node.parentId, new Set([...(childrenBySlotId.get(node.parentId) ?? []), node.id]));
  }

  const issues: TraceIssue[] = [];
  let issueIndex = 1;
  for (let runIndex = 0; runIndex < activeRun.nodeRuns.length; runIndex += 1) {
    const nodeRun = activeRun.nodeRuns[runIndex]!;
    const node = nodesById.get(nodeRun.nodeId);
    if (node?.type !== "manager_slot") {
      issues.push(createNodeTraceIssue(activeRun, nodeRun, node, issueIndex, node?.parentId ? 1 : 0, t));
      issueIndex += 1;
      continue;
    }

    const slotLabel = nodeRun.nodeLabel || node.config.label || nodeRun.nodeId;
    const slotEvents = activeRun.events.filter((event) => event.nodeRunId === nodeRun.id);
    const slotInputStatus = nodeRun.startedAt ? "completed" : toIssueStatus(nodeRun.status);
    issues.push({
      key: `${nodeRun.id}:input`,
      index: issueIndex,
      label: `${slotLabel} ${t.trace.slotInputSuffix}`,
      kind: "slot_input",
      depth: 0,
      node,
      nodeRun,
      issueStatus: slotInputStatus,
      statusLabel: nodeRun.startedAt ? t.trace.completed : statusLabelForNodeRun(nodeRun.status, t),
      outputPreview: t.trace.managerInputPreview,
      outputBody: t.trace.managerInputBody,
      events: slotEvents.filter((event) => event.type !== "node.run.completed")
    });
    issueIndex += 1;

    const childIds = childrenBySlotId.get(node.id) ?? new Set<string>();
    let childRunIndex = runIndex + 1;
    while (childRunIndex < activeRun.nodeRuns.length) {
      const childRun = activeRun.nodeRuns[childRunIndex]!;
      if (!childIds.has(childRun.nodeId)) break;
      const childNode = nodesById.get(childRun.nodeId);
      issues.push(createNodeTraceIssue(activeRun, childRun, childNode, issueIndex, 1, t));
      issueIndex += 1;
      childRunIndex += 1;
    }

    const slotOutputStatus = toSlotOutputIssueStatus(nodeRun);
    issues.push({
      key: `${nodeRun.id}:output`,
      index: issueIndex,
      label: `${slotLabel} ${t.trace.slotOutputSuffix}`,
      kind: "slot_output",
      depth: 0,
      node,
      nodeRun,
      issueStatus: slotOutputStatus,
      statusLabel: labelForIssueStatus(slotOutputStatus, t),
      outputPreview: nodeRun.output === undefined ? t.trace.waitingNestedNodes : summarizeOutput(nodeRun.output, t),
      events: slotEvents
    });
    issueIndex += 1;
    runIndex = childRunIndex - 1;
  }

  return issues;
}

function buildPendingTraceIssues(blueprint: BlueprintDefinition | undefined, orderedNodes: BlueprintNode[], t: Messages): TraceIssue[] {
  if (!blueprint) return [];

  const childrenBySlotId = new Map<string, BlueprintNode[]>();
  for (const node of blueprint.nodes) {
    if (!node.parentId) continue;
    const parent = blueprint.nodes.find((candidate) => candidate.id === node.parentId);
    if (parent?.type !== "manager_slot") continue;
    childrenBySlotId.set(node.parentId, [...(childrenBySlotId.get(node.parentId) ?? []), node]);
  }

  const visited = new Set<string>();
  const issues: TraceIssue[] = [];
  let issueIndex = 1;
  for (const node of orderedNodes) {
    if (visited.has(node.id) || node.parentId) continue;
    visited.add(node.id);
    if (node.type !== "manager_slot") {
      issues.push(createPendingTraceIssue(node, issueIndex, 0, t));
      issueIndex += 1;
      continue;
    }

    issues.push(createPendingSlotBoundaryIssue(node, issueIndex, "slot_input", t));
    issueIndex += 1;
    for (const child of childrenBySlotId.get(node.id) ?? []) {
      visited.add(child.id);
      issues.push(createPendingTraceIssue(child, issueIndex, 1, t));
      issueIndex += 1;
    }
    issues.push(createPendingSlotBoundaryIssue(node, issueIndex, "slot_output", t));
    issueIndex += 1;
  }
  return issues;
}

function createNodeTraceIssue(
  activeRun: BlueprintRunView,
  nodeRun: BlueprintNodeRun,
  node: BlueprintNode | undefined,
  index: number,
  depth: number,
  t: Messages
): TraceIssue {
  const label = nodeRun.nodeLabel || node?.config.label || nodeRun.nodeId;
  return {
    key: nodeRun.id,
    index,
    label,
    kind: "node",
    depth,
    node,
    nodeRun,
    issueStatus: toIssueStatus(nodeRun.status),
    statusLabel: statusLabelForNodeRun(nodeRun.status, t),
    outputPreview: summarizeOutput(nodeRun.output, t),
    events: activeRun.events.filter((event) => event.nodeRunId === nodeRun.id)
  };
}

function createPendingTraceIssue(node: BlueprintNode, index: number, depth: number, t: Messages): TraceIssue {
  return {
    key: `node:${node.id}`,
    index,
    label: node.config.label,
    kind: "node",
    depth,
    node,
    issueStatus: "pending",
    statusLabel: t.trace.pending,
    outputPreview: summarizeOutput(undefined, t),
    events: []
  };
}

function createPendingSlotBoundaryIssue(node: BlueprintNode, index: number, kind: "slot_input" | "slot_output", t: Messages): TraceIssue {
  const isInput = kind === "slot_input";
  return {
    key: `node:${node.id}:${kind}`,
    index,
    label: `${node.config.label} ${isInput ? t.trace.slotInputSuffix : t.trace.slotOutputSuffix}`,
    kind,
    depth: 0,
    node,
    issueStatus: "pending",
    statusLabel: t.trace.pending,
    outputPreview: isInput ? t.trace.managerInputWaiting : t.trace.waitingNestedNodes,
    events: []
  };
}

function toIssueStatus(status?: BlueprintNodeRunStatus): TraceIssueStatus {
  if (status === "queued" || status === "running" || status === "waiting_approval") return "in_progress";
  if (status === "succeeded" || status === "skipped") return "completed";
  if (status === "failed" || status === "cancelled") return "failed";
  return "pending";
}

function toSlotOutputIssueStatus(nodeRun: BlueprintNodeRun): TraceIssueStatus {
  if (nodeRun.status === "failed" || nodeRun.status === "cancelled") return "failed";
  if (nodeRun.output !== undefined || nodeRun.status === "succeeded" || nodeRun.status === "skipped") return "completed";
  if (nodeRun.status === "queued" || nodeRun.status === "running" || nodeRun.status === "waiting_approval") return "in_progress";
  return "pending";
}

function labelForIssueStatus(status: TraceIssueStatus, t: Messages): string {
  if (status === "completed") return t.trace.completed;
  if (status === "in_progress") return t.trace.inProgress;
  if (status === "failed") return t.status.failed;
  return t.trace.pending;
}

function traceIssueStatusLabel(status: TraceIssueStatus, language: Language): string {
  const zh = language === "zh-CN";
  if (status === "completed") return zh ? "成功" : "Success";
  if (status === "failed") return zh ? "失败" : "Failed";
  if (status === "in_progress") return zh ? "运行中" : "Running";
  return zh ? "等待中" : "Waiting";
}

function traceRunFrameState(status?: BlueprintRunStatus): "static" | "running" | "succeeded" | "failed" {
  if (status === "queued" || status === "running" || status === "waiting_approval") return "running";
  if (status === "succeeded") return "succeeded";
  if (status === "failed" || status === "cancelled") return "failed";
  return "static";
}

function statusLabelForNodeRun(status: BlueprintNodeRunStatus | undefined, t: Messages): string {
  return status ? t.status[status] : t.trace.pending;
}

function summarizeOutput(output: unknown, t: Messages): string {
  const normalized = formatOutput(output ?? "");
  if (!normalized.trim()) return t.trace.noOutput;
  const previewLines = normalized
    .split("\n")
    .map(toTracePreviewLine)
    .filter(Boolean)
    .slice(0, 2);
  if (!previewLines.length) return t.trace.noOutput;
  return previewLines.map((line) => (line.length > 120 ? `${line.slice(0, 117)}...` : line)).join("\n");
}

function toTracePreviewLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("```")) return "";
  if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) return "";
  if (isTracePreviewTableSeparator(trimmed)) return "";

  const tableCells = parseTracePreviewTableCells(trimmed);
  if (tableCells.length > 1) return tableCells.filter(Boolean).join(" ");

  return trimmed
    .replace(/^#{1,6}\s+/, "")
    .replace(/^>\s?/, "")
    .replace(/^\s{0,3}[-*+]\s+/, "")
    .replace(/^\s{0,3}\d+[.)]\s+/, "")
    .trim();
}

function parseTracePreviewTableCells(line: string): string[] {
  if (!line.includes("|")) return [];
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|")) row = row.slice(0, -1);
  return row.split("|").map((cell) => cell.trim());
}

function isTracePreviewTableSeparator(line: string): boolean {
  const cells = parseTracePreviewTableCells(line);
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function getBlueprintNodeOrder(blueprint?: BlueprintDefinition): BlueprintNode[] {
  if (!blueprint) return [];

  const nodesById = new Map(blueprint.nodes.map((node) => [node.id, node]));
  const indegree = new Map<string, number>(blueprint.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map<string, string[]>();

  for (const edge of blueprint.edges) {
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target]);
  }

  const queue = blueprint.nodes.filter((node) => (indegree.get(node.id) ?? 0) === 0).map((node) => node.id);
  const ordered: BlueprintNode[] = [];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const currentId = queue.shift();
    if (!currentId || visited.has(currentId)) continue;
    visited.add(currentId);
    const node = nodesById.get(currentId);
    if (node) ordered.push(node);

    for (const targetId of outgoing.get(currentId) ?? []) {
      const nextDegree = (indegree.get(targetId) ?? 1) - 1;
      indegree.set(targetId, nextDegree);
      if (nextDegree === 0) queue.push(targetId);
    }
  }

  for (const node of blueprint.nodes) {
    if (!visited.has(node.id)) ordered.push(node);
  }

  return ordered;
}

function widgetTypeLabel(type: DashboardWidgetType, t: Messages): string {
  if (type === "recent_runs") return t.widgetTypes.runs;
  if (type === "pending_approvals") return t.widgetTypes.approvals;
  if (type === "runtime_overview") return t.common.realTime;
  if (type === "catalog_status") return t.widgetTypes.catalog;
  return t.widgetTypes.notes;
}

function blueprintNameFor(blueprints: BlueprintDefinition[], blueprintId: string): string {
  return blueprints.find((blueprint) => blueprint.id === blueprintId)?.name ?? blueprintId;
}

export type ModelUsageSummary = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  days: Map<string, ModelUsageDay>;
};

export type ModelUsageDay = {
  dateKey: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
};

type ModelUsageDayView = ModelUsageDay & {
  label: string;
  fullLabel: string;
};

function createEmptyModelUsageSummary(): ModelUsageSummary {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    days: new Map<string, ModelUsageDay>()
  };
}

function buildModelUsageIndex(
  runs: BlueprintRunView[],
  openClawUsage: OpenClawModelUsageSummary[],
  fallbackModelId?: string
): Map<string, ModelUsageSummary> {
  const usageByModel = new Map<string, ModelUsageSummary>();

  for (const usage of openClawUsage) {
    if (!usage.modelId) continue;
    const current = usageByModel.get(usage.modelId) ?? createEmptyModelUsageSummary();
    for (const day of usage.days) {
      addUsageFactToModelSummary(
        current,
        day.date,
        day.inputTokens,
        day.outputTokens,
        day.costUsd,
        day.calls,
        day.totalTokens
      );
    }
    usageByModel.set(usage.modelId, current);
  }

  for (const runView of runs) {
    let hasNodeUsage = false;
    for (const nodeRun of runView.nodeRuns) {
      const usage = nodeRun.usage;
      if (!usage?.modelId) continue;
      hasNodeUsage = true;
      const current = usageByModel.get(usage.modelId) ?? createEmptyModelUsageSummary();
      addUsageFactToModelSummary(current, usage.recordedAt, usage.inputTokens, usage.outputTokens, usage.costUsd);
      usageByModel.set(usage.modelId, current);
    }

    const totalTokens = runView.run.totalInputTokens + runView.run.totalOutputTokens;
    if (!hasNodeUsage && fallbackModelId && totalTokens > 0) {
      const current = usageByModel.get(fallbackModelId) ?? createEmptyModelUsageSummary();
      addUsageFactToModelSummary(
        current,
        runView.run.endedAt ?? runView.run.startedAt,
        runView.run.totalInputTokens,
        runView.run.totalOutputTokens,
        runView.run.totalCostUsd
      );
      usageByModel.set(fallbackModelId, current);
    }
  }

  return usageByModel;
}

function modelUsageFor(modelId: string, usageByModel: Map<string, ModelUsageSummary>): ModelUsageSummary {
  const direct = usageByModel.get(modelId);
  if (direct) return direct;

  const modelName = lastModelPathSegment(modelId);
  let summary: ModelUsageSummary | undefined;
  for (const [usageModelId, usage] of usageByModel) {
    if (usageModelId !== modelName && lastModelPathSegment(usageModelId) !== modelName) continue;
    summary ??= createEmptyModelUsageSummary();
    mergeModelUsageSummary(summary, usage);
  }

  return summary ?? createEmptyModelUsageSummary();
}

function addUsageFactToModelSummary(
  summary: ModelUsageSummary,
  recordedAt: string,
  inputTokens: number,
  outputTokens: number,
  costUsd: number,
  calls = 1,
  totalTokens = inputTokens + outputTokens
): void {
  summary.calls += calls;
  summary.inputTokens += inputTokens;
  summary.outputTokens += outputTokens;
  summary.costUsd += costUsd;

  const dateKey = toUsageDateKey(recordedAt);
  if (!dateKey) return;

  const currentDay = summary.days.get(dateKey) ?? {
    dateKey,
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0
  };
  currentDay.calls += calls;
  currentDay.inputTokens += inputTokens;
  currentDay.outputTokens += outputTokens;
  currentDay.totalTokens += totalTokens;
  currentDay.costUsd += costUsd;
  summary.days.set(dateKey, currentDay);
}

function toUsageDateKey(recordedAt: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(recordedAt)) return recordedAt;
  return toDateInputValue(recordedAt);
}

function mergeModelUsageSummary(target: ModelUsageSummary, source: ModelUsageSummary): void {
  target.calls += source.calls;
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.costUsd += source.costUsd;

  for (const [dateKey, sourceDay] of source.days) {
    const targetDay = target.days.get(dateKey) ?? {
      dateKey,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0
    };
    targetDay.calls += sourceDay.calls;
    targetDay.inputTokens += sourceDay.inputTokens;
    targetDay.outputTokens += sourceDay.outputTokens;
    targetDay.totalTokens += sourceDay.totalTokens;
    targetDay.costUsd += sourceDay.costUsd;
    target.days.set(dateKey, targetDay);
  }
}

function recentModelUsageDays(usage: ModelUsageSummary, language: Language): ModelUsageDayView[] {
  const today = new Date();
  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(today);
    day.setDate(today.getDate() - (6 - index));
    const dateKey = toDateInputValue(day);
    const usageDay = usage.days.get(dateKey) ?? {
      dateKey,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0
    };
    return {
      ...usageDay,
      label: formatCompactDayLabel(dateKey, language),
      fullLabel: formatDateLabel(dateKey, language)
    };
  });
}

function summarizeRecentModelUsage(days: ModelUsageDay[]): ModelUsageDay {
  return days.reduce<ModelUsageDay>(
    (summary, day) => ({
      dateKey: summary.dateKey,
      calls: summary.calls + day.calls,
      inputTokens: summary.inputTokens + day.inputTokens,
      outputTokens: summary.outputTokens + day.outputTokens,
      totalTokens: summary.totalTokens + day.totalTokens,
      costUsd: summary.costUsd + day.costUsd
    }),
    {
      dateKey: "recent",
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0
    }
  );
}

function modelUsageBarHeight(totalTokens: number, maxDailyTokens: number): number {
  if (totalTokens <= 0) return 3;
  return Math.max(16, Math.round((totalTokens / maxDailyTokens) * 100));
}

function formatCompactTokenValue(value: number): string {
  if (value >= 1_000_000) return `${trimFixed(value / 1_000_000, value >= 10_000_000 ? 1 : 2)}M`;
  if (value >= 1_000) return `${trimFixed(value / 1_000, value >= 10_000 ? 1 : 2)}K`;
  return Math.round(value).toLocaleString();
}

function trimFixed(value: number, digits: number): string {
  return value.toFixed(digits).replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1");
}

function lastModelPathSegment(modelId: string): string {
  return modelId.split("/").pop() ?? modelId;
}

function isActiveRunStatus(status: BlueprintRunStatus): boolean {
  return status === "queued" || status === "running" || status === "waiting_approval";
}

function companyMonogram(company: Pick<CompanyOverview, "logoLabel" | "name">): string {
  if (company.logoLabel?.trim()) return company.logoLabel.trim().slice(0, 2).toUpperCase();
  const parts = company.name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return parts
    .slice(0, 2)
    .map((part) => part[0] ?? "")
    .join("")
    .toUpperCase();
}

function formatOutput(output: unknown): string {
  if (typeof output === "string") {
    const trimmed = output.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return JSON.stringify(JSON.parse(trimmed), null, 2);
      } catch {
        return output;
      }
    }
    return output;
  }
  return JSON.stringify(output, null, 2);
}

function addDays(value: Date, days: number): Date {
  const next = new Date(value);
  next.setDate(next.getDate() + days);
  return next;
}

function startOfLocalDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function normalizeDateRange(startDate: string, endDate: string): [string, string] {
  if (!startDate) return [endDate, endDate];
  if (!endDate) return [startDate, startDate];
  return startDate <= endDate ? [startDate, endDate] : [endDate, startDate];
}

function isRunInDateRange(runView: BlueprintRunView, startDate: string, endDate: string): boolean {
  const startedAt = toDateInputValue(runView.run.startedAt);
  const endedAt = toDateInputValue(runView.run.endedAt ?? runView.run.startedAt);
  if (!startedAt || !endedAt) return false;
  return endedAt >= startDate && startedAt <= endDate;
}

function isLocalDateInRange(value: string, startDate: string, endDate: string): boolean {
  const dateKey = toDateInputValue(value);
  return Boolean(dateKey && dateKey >= startDate && dateKey <= endDate);
}

function toDateInputValue(value: string | Date): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "";
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return localDate.toISOString().slice(0, 10);
}

function formatDateLabel(value: string, language: Language): string {
  if (!value) return "-";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(language, { year: "numeric", month: "short", day: "numeric" });
}

function formatCompactDayLabel(value: string, language: Language): string {
  if (!value) return "-";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  if (language === "zh-CN") return `${date.getMonth() + 1}/${date.getDate()}`;
  return date.toLocaleDateString(language, { month: "numeric", day: "numeric" });
}

function formatDateTime(value: string, language: Language): string {
  return new Date(value).toLocaleString(language);
}

function toSafeTimestamp(value: string): number {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function getBrowserStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function normalizeAgentId(value: string): string {
  const trimmed = value.trim().toLowerCase();
  return trimmed.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+/g, "").replace(/-+$/g, "").slice(0, 64) || "main";
}
