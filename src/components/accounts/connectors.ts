/** The connector rows on Settings > Connections, in order. Their state comes from AccountsData; `info` sits behind an InfoDot. */
export const CONNECTORS = {
  google: { name: "Google", info: "Gmail and Google Calendar, one sign-in. Routines and the Hydra Agent read mail and write events through it." },
  instagram: {
    name: "Instagram",
    info: "Your own Instagram for Personal Brand: followers, posts, views, likes and comments, synced daily. Read only. It needs a Business or Creator account.",
  },
  grokbot: { name: "Grokbot", info: "Adds video links and updates views. Its key can write UGC posts and views only; it cannot read your finances. A key is shown once." },
  claudeCode: { name: "Claude Code", info: "Claude Code uses the Hydra Agent's tools over MCP. Its key reaches the agent only, and deletes still ask you. Pair it, then run the two lines under the code." },
  desktop: {
    name: "Hydra Agent",
    info: "Where the Hydra Agent thinks: your server when it is online, else your Mac (Hydra Desktop: the clap wake and control of the Mac). A pairing code works once, for 10 minutes.",
  },
  notifications: { name: "Notifications", info: "Reminders and routine results on this phone or browser, by web push." },
} as const;
