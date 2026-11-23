-- Cross-posts: one video on several platforms is paid once (DESIGN.md section 8). The matcher
-- (src/lib/ugc/match.ts) links unlinked posts of a deal by title and time; the owner can link and
-- unlink by hand (src/lib/ugc/writes.ts linkPosts, unlinkPost, editPost). video_group_manual marks
-- a post whose group the owner set by hand: the matcher never moves it, and only the owner can set
-- the flag or change such a post's group. The one-time backfill is scripts/ugc-link.

alter table public.posts add column if not exists video_group_manual boolean not null default false;

-- Security definer so is_owner() runs for any caller (as posts_guard_exclude in 0010).
create or replace function private.posts_guard_group_manual()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if ((tg_op = 'INSERT' and new.video_group_manual)
      or (tg_op = 'UPDATE' and (new.video_group_manual is distinct from old.video_group_manual
                                or (old.video_group_manual and new.video_group_id is distinct from old.video_group_id))))
     and not public.is_owner() then
    raise exception 'only the owner links or unlinks a video by hand' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke execute on function private.posts_guard_group_manual() from public;

drop trigger if exists posts_guard_group_manual on public.posts;
create trigger posts_guard_group_manual
  before insert or update of video_group_id, video_group_manual on public.posts
  for each row execute function private.posts_guard_group_manual();
