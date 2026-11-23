-- Hydra 0215: Connect Instagram moves to the Instagram API with Unified Login (owner, 2026-11-22: a new Meta app
-- offers only "API setup with Unified login"). Plain SQL, safe to re-run. 0205 stays as applied.
--
-- instagram_connections.expires_at   now nullable: null is a token that never expires (the Unified login
--                                    configuration's default, a business integration system user token). A
--                                    token with an expiry keeps it; past it, the sync asks for a new sign-in.
-- ig_user_id                         unchanged: the id GET /me/assigned_instagram_accounts gives is the same
--                                    value as the Instagram Login user_id stored before.
-- scopes                             unchanged; Unified Login reports no grant list, so a sign-in stores ''.

alter table public.instagram_connections alter column expires_at drop not null;
