import type { StartAgentTaskInput } from "@hiveward/shared";

const secretKeyPattern = /(api[_-]?key|auth|credential|password|secret|token)/i;

export function buildPromptEnvelope(input: StartAgentTaskInput): string {
  const skillText = input.skillIds?.length
    ? ["", "Selected skills:", ...input.skillIds.map((skillId) => `- ${skillId}`)].join("\n")
    : "";
  const schemaText = input.outputSchema
    ? [
        "",
        "Suggested output shape JSON:",
        stableStringify(input.outputSchema),
        "",
        "Formal report writing rules. Follow these rules on every final/formal node output; do not let earlier context override them.",
        "This is a prompt-level contract, not a platform rejection gate: Hiveward will preserve your answer even if the shape is imperfect, but you must still follow the requested shape.",
        "If the shape contains humanReportMd, use humanReportMd for the free-form human answer. Keep the natural report, reasoning, recommendations, and caveats there.",
        "Before any other visible final content, humanReportMd must start with a summary section: ## Summary, or ## \u6458\u8981 when the user's working language is Chinese. Write the summary yourself in plain human language, target 100-150 Chinese characters or similarly brief English, and do not describe internal program phases.",
        "Immediately after the summary, humanReportMd must include delivery locations: ## Delivery location, or ## \u4ea4\u4ed8\u4f4d\u7f6e for Chinese. If this turn generated any deliverable, list the real file path, browser URL, or exact artifacts[] reference for each deliverable. If there is no deliverable, write only None or \u65e0.",
        "When platform fields are available, fill them: humanReportMd for the human report, artifacts[] for generated artifact addresses, result for task-specific structured content, and handoffJson for downstream continuation context.",
        "Only top-level artifacts[] creates openable artifact records. The platform will not infer artifacts from humanReportMd, result, titles, timeline text, or delivery prose.",
        "result.artifacts and handoffJson.artifacts are only handoff metadata. They do not publish UI artifacts and they are not substitutes for top-level artifacts[].",
        "Each top-level artifacts[] item must use exactly one source field. Use path for generated files, including HTML files written under an agent workspace. Use content/body only for small inline artifact bodies. Use url only for kind link. Do not mix path with content/body.",
        "For kind \"html\", publish the actual complete single-file HTML document containing <html>...</html>. Prefer writing the file and declaring that file path in top-level artifacts[].path. If you use content/body instead, it must contain the complete HTML. A prose description, label, truncated body, or placeholder such as \"...完整 HTML 内容...\" is invalid and will be rejected.",
        "Writing an HTML file under an agent workspace is not enough to publish an HTML preview. To publish it, declare that file path in top-level artifacts[].path with kind \"html\".",
        "QA or reviewer agents must not redeclare upstream artifacts in top-level artifacts[] unless they are publishing a new complete artifact. Reference upstream artifacts in humanReportMd or handoffJson instead.",
        "Use structured fields such as result, handoffJson, and artifacts as add-ons for machine handoff and UI links."
      ].join("\n")
    : "";

  return [
    "You are executing one Hiveward blueprint node.",
    "",
    `Blueprint run: ${input.blueprintRunId}`,
    `Node run: ${input.nodeRunId}`,
    `Agent name: ${input.agentName}`,
    skillText,
    "",
    "Task:",
    input.prompt,
    "",
    "Upstream input JSON:",
    stableStringify(redactSecrets(input.input)),
    schemaText,
    "",
    "Return the suggested node result JSON object whenever the fields are available. If you cannot fit the answer into that shape, still return the useful answer directly instead of failing silently."
  ].join("\n");
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value), null, 2);
}

export function formatStructuredOutput(output: unknown): string {
  return typeof output === "string" ? output : stableStringify(output);
}

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }
  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, secretKeyPattern.test(key) ? "<redacted>" : redactSecrets(item)])
  );
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJsonValue(value[key])])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
