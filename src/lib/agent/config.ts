import Anthropic from "@anthropic-ai/sdk";
import type { ModelClient } from "./loop";
import type { ToolGroup } from "./registry";

/**
 * Server env for the agent. ANTHROPIC_API_KEY missing = the agent fails closed with
 * `agent_not_configured` (no fallback, no guessing). CRON_SECRET guards /api/cron/agent.
 */

export function anthropicKey(): string | null {
  return process.env.ANTHROPIC_API_KEY?.trim() || null;
}

/** The Messages API client, or null when the key is missing. */
export function createModelClient(): ModelClient | null {
  const apiKey = anthropicKey();
  return apiKey ? new Anthropic({ apiKey, maxRetries: 2 }) : null;
}

export const NOT_CONFIGURED = { error: "agent_not_configured" } as const;

/** What a live turn may touch (web, phone, desktop): everything. */
export const LIVE_GROUPS: ReadonlySet<ToolGroup> = new Set(["hydra", "routines", "memory", "ui", "mac", "gmail", "calendar"]);
/** MCP has no screen to drive. */
export const MCP_GROUPS: ReadonlySet<ToolGroup> = new Set(["hydra", "routines", "memory", "mac", "gmail", "calendar"]);

/** The groups a routine's allowed tools open up. Hydra data includes memory; never the interface or routines. */
export function routineGroups(tools: readonly string[]): ReadonlySet<ToolGroup> {
  const groups = new Set<ToolGroup>();
  for (const t of tools) {
    if (t === "hydra") groups.add("hydra").add("memory");
    else if (t === "mac" || t === "gmail" || t === "calendar") groups.add(t);
  }
  return groups;
}
