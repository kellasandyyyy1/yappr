-- =============================================================================
-- Consent timestamps must come from the server
-- =============================================================================
-- WHY
--   `recordConsent()` wrote `termsAcceptedAt: serverTimestamp()` under
--   Firestore. That was not decoration: the row is a compliance record, and its
--   value is that the *server* says when consent happened. A client-supplied
--   timestamp can be back-dated by anyone with a modified device or a REST
--   client, which is exactly the claim the record is supposed to withstand.
--
--   The ported code was about to send `new Date().toISOString()` from the
--   browser. Same column, quietly worthless.
--
-- WHAT THIS DOES
--   1. A trigger stamps `terms_accepted_at = now()` whenever `terms_version`
--      changes, and preserves the old value when it does not. The client cannot
--      influence it either way.
--   2. `terms_accepted_at` is removed from the column grant, so an UPDATE that
--      names it is rejected outright rather than silently overwritten. Belt and
--      braces — the trigger already wins, but a rejected write is a clearer
--      signal than an ignored one.
--
--   This is strictly stronger than the Firestore behaviour it replaces:
--   serverTimestamp() still required the client to *ask* for a server clock.
--
-- Idempotent — safe to run repeatedly.
-- =============================================================================

begin;

create or replace function stamp_consent_time()
returns trigger
language plpgsql
as $$
begin
  if new.terms_version is distinct from old.terms_version then
    new.terms_accepted_at := now();
  else
    -- Not a consent event: keep whatever was already recorded, regardless of
    -- what the update statement tried to put there.
    new.terms_accepted_at := old.terms_accepted_at;
  end if;
  return new;
end;
$$;

drop trigger if exists users_stamp_consent_time on users;
create trigger users_stamp_consent_time
  before update on users
  for each row
  execute function stamp_consent_time();

-- Signup writes both columns in the INSERT, which the trigger does not touch —
-- an insert is the account's first consent and its own timestamp is correct.

-- Re-issue the column grant without terms_accepted_at. Restating the whole list
-- rather than revoking one column: a column-level revoke is a no-op while a
-- table-level grant exists, which is the trap documented in 0003.
revoke update on users from authenticated;
grant update (display_name, photo_url, bio, theme_song_id, status, last_active,
              terms_version, updated_at)
  on users to authenticated;

commit;
