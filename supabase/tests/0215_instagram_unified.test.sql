-- pgTAP: Connect Instagram with Unified Login (0215). A token that never expires stores expires_at null; one with
-- an expiry still stores it; the 0205 guards (ciphertext only, one row, the token hidden) still hold.
-- Run: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(7);

select col_is_null('public', 'instagram_connections', 'expires_at', 'expires_at is nullable (null: never expires)');
select lives_ok(
  $$ insert into public.instagram_connections (id, ig_user_id, username, access_token, expires_at)
     values ('99999999-0000-0000-0000-000000000215', '17841400000000001', 'studio.notes', 'v1.aXY.dGFn.dG9r', null) $$,
  'a never-expiring token is stored with expires_at null'
);
select is((select expires_at from public.instagram_connections where id = '99999999-0000-0000-0000-000000000215'), null, 'expires_at stays null');
select lives_ok(
  $$ update public.instagram_connections set expires_at = now() + interval '60 days' where id = '99999999-0000-0000-0000-000000000215' $$,
  'a token with an expiry still stores it'
);
select throws_ok(
  $$ insert into public.instagram_connections (ig_user_id, username, access_token, expires_at)
     values ('1', 'x', 'EAAplaintext', null) $$,
  '23514', null, 'a plaintext token is still refused'
);
select throws_ok(
  $$ insert into public.instagram_connections (ig_user_id, username, access_token, expires_at)
     values ('2', 'second', 'v1.a.b.c', null) $$,
  '23505', null, 'still only one Instagram connection'
);
select ok(not has_column_privilege('hydra_ro', 'public.instagram_connections', 'access_token', 'select'), 'hydra_ro still cannot read the token');

select * from finish();
rollback;
