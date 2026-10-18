-- Real-time signals (docs/REALTIME.md). NOTIFY is transactional: a notification is delivered only
-- when the sending transaction commits, in commit order, so rolled-back writes never signal.

-- migrate:up

-- One signal per activity row, i.e. per committed write transaction.
create function notify_group_activity() returns trigger
language plpgsql as $$
begin
  perform pg_notify('hisaab_group', json_build_object('group_id', new.group_id, 'seq', new.seq, 'type', new.type)::text);
  return null;
end $$;
create trigger activity_log_notify after insert on activity_log
  for each row execute function notify_group_activity();

-- A session being revoked (logout, "log out everywhere") disconnects its sockets on every API instance.
create function notify_session_revoked() returns trigger
language plpgsql as $$
begin
  perform pg_notify('hisaab_session', json_build_object('session_id', new.id)::text);
  return null;
end $$;
create trigger sessions_notify_revoked after update of revoked_at on sessions
  for each row when (old.revoked_at is null and new.revoked_at is not null)
  execute function notify_session_revoked();

-- migrate:down

drop trigger sessions_notify_revoked on sessions;
drop function notify_session_revoked();
drop trigger activity_log_notify on activity_log;
drop function notify_group_activity();
