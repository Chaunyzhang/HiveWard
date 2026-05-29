import { harnessDisplayLabels } from "./harness-labels";

export type AppNavSectionId =
  | "company"
  | "chat"
  | "blueprint"
  | "runs"
  | "approvals"
  | "models"
  | "agents"
  | "skills"
  | "schedule"
  | "channels"
  | "openclaw"
  | "claudeCodeConfig"
  | "claudeCodeModels"
  | "codexConfig"
  | "googleConfig"
  | "cursorConfig"
  | "opencodeConfig"
  | "hermesConfig"
  | "hermesModels"
  | "hermesAgents"
  | "hermesSkills"
  | "hermesChannels";

export type AppSectionId = AppNavSectionId | "companyDirectory" | "hivewardHome";

export type AppSystemId = "hiveward" | "openclaw" | "claudeCode" | "codex" | "google" | "cursor" | "opencode" | "hermes";

export type AppSectionGroup = {
  id: AppSystemId;
  sections: AppNavSectionId[];
};

export const appSystemLabels = {
  hiveward: "Hiveward",
  ...harnessDisplayLabels
} satisfies Record<AppSystemId, string>;

export const appSectionGroups = [
  {
    id: "hiveward",
    sections: ["company", "chat", "blueprint", "runs", "approvals", "schedule"]
  },
  {
    id: "openclaw",
    sections: ["openclaw", "models", "agents", "skills", "channels"]
  },
  {
    id: "hermes",
    sections: ["hermesConfig", "hermesModels", "hermesAgents", "hermesSkills", "hermesChannels"]
  },
  {
    id: "claudeCode",
    sections: ["claudeCodeConfig", "claudeCodeModels"]
  },
  {
    id: "codex",
    sections: ["codexConfig"]
  },
  {
    id: "google",
    sections: ["googleConfig"]
  },
  {
    id: "cursor",
    sections: ["cursorConfig"]
  },
  {
    id: "opencode",
    sections: ["opencodeConfig"]
  }
] satisfies AppSectionGroup[];
