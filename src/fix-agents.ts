// Coding agents a finding can be handed to from the Fix page. Local agents run on the developer's
// machine through the OpenReview bridge (or open from a deep link); the stored values match
// convex/schema.ts codingAgentValidator.
export const localAgents = ["claude", "codex", "cursor"] as const;
export type LocalAgent = (typeof localAgents)[number];
export const defaultLocalAgent: LocalAgent = "claude";
export const localAgentLabels: Record<LocalAgent, string> = { claude: "Claude Code", codex: "Codex", cursor: "Cursor Agent" };
export const isLocalAgent = (value: unknown): value is LocalAgent => typeof value === "string" && (localAgents as readonly string[]).includes(value);
/** The personal choice, then the workspace default, then Claude Code. */
export function resolveLocalAgent(personal?: string | null, workspace?: string | null): LocalAgent {
  return isLocalAgent(personal) ? personal : isLocalAgent(workspace) ? workspace : defaultLocalAgent;
}
