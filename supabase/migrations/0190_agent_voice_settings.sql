-- Hydra 0190: the voice settings every surface shares (W5 contract section 1, W6 contract, 2026-11-22).
-- Owner: "allow me to change the starting phrase too". agent_settings gains the wake phrase (Hydra
-- Desktop wakes on it; the web shows it) and the clap sensitivity (Hydra Desktop's double clap), next
-- to sleep_word, model, effort_live, effort_routine and brain. The server is the source of truth:
-- GET and PATCH /api/agent/state read and write them; Hydra Desktop applies them on change.
-- Owner-only RLS and the grants are 0070's (the table is not new). Plain SQL, safe to re-run.

alter table public.agent_settings add column if not exists wake_phrase text not null default 'Hey Hydra';
alter table public.agent_settings drop constraint if exists agent_settings_wake_phrase_check;
alter table public.agent_settings add constraint agent_settings_wake_phrase_check check (char_length(trim(wake_phrase)) between 2 and 40);

alter table public.agent_settings add column if not exists clap_sensitivity text not null default 'medium';
alter table public.agent_settings drop constraint if exists agent_settings_clap_sensitivity_check;
alter table public.agent_settings add constraint agent_settings_clap_sensitivity_check check (clap_sensitivity in ('low', 'medium', 'high'));
