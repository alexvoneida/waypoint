-- Phase 6: comment soft deletion (S-3).
--
-- §6 gives entry_comments a deleted_by alongside deleted_at; 0002 carried the
-- timestamp and dropped the attribution. Without it a soft-deleted comment
-- records that it went and not who took it, and the two deleters S-3 allows --
-- the comment's author, and the entry's -- are exactly the distinction worth
-- being able to make afterwards.
--
-- Nullable, and set null when the deleter's own account is removed: this is a
-- record of an action, not a dependency of the row.
alter table comments
  add column deleted_by uuid references users on delete set null;

-- comments_visible has to change with it, and the reason is not obvious.
--
-- Postgres applies a table's SELECT policies to the row an UPDATE produces,
-- not only to the row it started from. 0003 wrote comments_visible with
-- `deleted_at is null`, which means the soft delete S-3 asks for -- an update
-- that sets deleted_at -- produces a row the updater may no longer see, and
-- Postgres refuses it outright: "new row violates row-level security policy".
-- Every soft delete failed, by the policy that exists to hide the result of a
-- soft delete.
--
-- Letting the deleter still see the row they just hid is the smallest fix that
-- keeps the body hidden from everyone else. The read path filters deleted rows
-- itself (lib/social.ts), so this widens what the policy permits without
-- widening what anybody is shown.
drop policy comments_visible on comments;
create policy comments_visible on comments
  for select using (
    (deleted_at is null or deleted_by = current_app_user())
    and (
      exists (select 1 from visible_entries v where v.id = comments.entry_id)
      or exists (select 1 from entries e
                 where e.id = comments.entry_id and e.user_id = current_app_user())
    )
  );
