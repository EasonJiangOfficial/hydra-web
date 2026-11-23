import type { AgentStore, Delivery, NewNotification } from "./store";

/**
 * Delivery of a reminder or a routine result. The notification row is the in-app list, and Hydra
 * Desktop pulls it (shown, and spoken when "spoken" is asked for). Push and email are channel
 * implementations passed in by whoever wires them (web push later, Gmail via U15); a channel that
 * is not passed is recorded as not_configured, never silently dropped.
 */

export interface Delivered {
  id: string;
  title: string;
  body: string;
  href: string | null;
}
export type Channel = (n: Delivered) => Promise<void>;
export type Channels = Partial<Record<Exclude<Delivery, "notification" | "spoken">, Channel>>;

/** Store once per occurrence (dedupe_key), then fan out. Null when this occurrence was already delivered. */
export async function deliver(store: AgentStore, n: NewNotification, channels: Channels = {}): Promise<Record<string, string> | null> {
  const wanted = n.channels?.length ? n.channels : (["notification"] as Delivery[]);
  const id = await store.notify({ ...n, channels: wanted });
  if (!id) return null;
  const item: Delivered = { id, title: n.title, body: n.body ?? "", href: n.href ?? null };
  const status: Record<string, string> = {};
  for (const channel of wanted) {
    const send = channel === "notification" || channel === "spoken" ? null : channels[channel];
    if (channel === "notification" || channel === "spoken") status[channel] = "stored";
    else if (!send) status[channel] = "not_configured";
    else {
      try {
        await send(item);
        status[channel] = "sent";
      } catch (error) {
        console.error(`[agent] deliver ${channel}: ${(error as Error).message}`);
        status[channel] = "failed";
      }
    }
    await store.markDelivered(id, channel, status[channel]);
  }
  return status;
}
