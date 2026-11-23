import type { AccountsActions, AccountsData, ActionResult } from "@/components/accounts/types";
import type { AvatarsClient } from "@/lib/agent/avatars-client";
import type { AgentSettingsPatch, AgentSettingsResult, ModelKeysClient } from "@/lib/agent/settings-client";
import type { Entity, TaxShape } from "@/lib/entities/model";

export type { ActionResult };
type WithActivity<R> = R & { activityId?: string | null };

/** One row on Businesses: the entity, whether anything uses it (then Delete is off) and its account count. */
export interface BusinessRow extends Entity {
  inUse: boolean;
  accounts: number;
}

export interface SettingsData {
  businesses: BusinessRow[];
  /** settings.time_zone; null until a sign-in or the owner sets it. */
  timeZone: string | null;
  /** Connections and the idle lock read the Accounts data they always did. */
  accounts: AccountsData;
}

/** Everything the Settings page writes. The live page brings the server actions; /dev/settings brings memory ones. */
export interface SettingsActions {
  addBusiness(input: { name: string; taxShape: TaxShape }): Promise<WithActivity<ActionResult<Entity>>>;
  updateBusiness(input: { id: string; name?: string; taxShape?: TaxShape }): Promise<WithActivity<ActionResult<Entity>>>;
  closeBusiness(input: { id: string }): Promise<WithActivity<ActionResult<Entity>>>;
  reopenBusiness(input: { id: string }): Promise<WithActivity<ActionResult<Entity>>>;
  deleteBusiness(input: { id: string }): Promise<WithActivity<ActionResult<null>>>;
  setTimeZone(input: { timeZone: string | null }): Promise<ActionResult<{ timeZone: string | null }>>;
  /** GET and PATCH /api/agent/state (the shared agent settings contract). */
  agentSettings(): Promise<AgentSettingsResult>;
  saveAgentSettings(patch: AgentSettingsPatch): Promise<AgentSettingsResult>;
  /** 0220: the avatars (/api/agent/avatars, the Fish voice check and preview). The Agent tab shows them when given. */
  avatars?: AvatarsClient;
  /** 0225: the provider keys (/api/agent/models/keys). The Agent tab shows the Models card when given. */
  modelKeys?: ModelKeysClient;
  accounts: AccountsActions;
}
