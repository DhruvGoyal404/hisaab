-- Account deletion (Phase 6). Users are never deleted (the ledger, the activity log and groups
-- point at them); a deleted account is anonymised and marked deleted_at, its memberships become
-- placeholders ("Deleted user") so every balance stays where it was, and its sign-in identities and
-- sessions are removed. The membership guard now allows exactly one new move: a membership may let
-- go of its user, and only when that user's account is deleted.

-- migrate:up

alter table users add column deleted_at timestamptz;
alter table users add constraint users_deleted_anonymous
  check (deleted_at is null or (disabled_at is not null and email is null and avatar_url is null));
grant update (deleted_at) on users to hisaab_app;

create or replace function memberships_guard() returns trigger
language plpgsql as $$
declare
  v_balance numeric;
begin
  if tg_op = 'DELETE' then
    raise exception 'memberships are never deleted; set status = ''left''' using errcode = 'ZA001';
  end if;
  if new.group_id <> old.group_id or new.created_seq <> old.created_seq or new.created_at <> old.created_at then
    raise exception 'immutable membership column changed' using errcode = 'ZM004';
  end if;
  if old.user_id is not null and new.user_id is distinct from old.user_id then
    -- The only way out: the account was deleted and the membership becomes a placeholder.
    if new.user_id is not null or not exists (select 1 from users where id = old.user_id and deleted_at is not null) then
      raise exception 'membership % already belongs to a user', old.id using errcode = 'ZM004';
    end if;
  end if;
  if old.status = 'merged' then
    raise exception 'membership % was merged and is final', old.id using errcode = 'ZM003';
  end if;

  if old.status = 'active' and new.status = 'left' then
    if old.role = 'owner' then
      raise exception 'the owner must transfer ownership before leaving' using errcode = 'ZM002';
    end if;
    select coalesce(sum(le.delta_minor), 0) into v_balance
      from memberships m join ledger_entries le on le.member_id = m.id
     where m.id = old.id or m.merged_into = old.id;
    if v_balance <> 0 then
      raise exception 'member % has a non-zero balance (% paise); settle up before leaving', old.id, v_balance
        using errcode = 'ZB001';
    end if;
  end if;

  if new.status = 'merged' and old.status <> 'merged' then
    if old.user_id is not null or old.status <> 'active' then
      raise exception 'only an active ghost can be merged' using errcode = 'ZM003';
    end if;
    perform 1 from memberships t
     where t.id = new.merged_into and t.status = 'active' and t.user_id is not null;
    if not found then
      raise exception 'merge target must be an active real member of the same group' using errcode = 'ZM003';
    end if;
  end if;
  return new;
end $$;

-- migrate:down

create or replace function memberships_guard() returns trigger
language plpgsql as $$
declare
  v_balance numeric;
begin
  if tg_op = 'DELETE' then
    raise exception 'memberships are never deleted; set status = ''left''' using errcode = 'ZA001';
  end if;
  if new.group_id <> old.group_id or new.created_seq <> old.created_seq or new.created_at <> old.created_at then
    raise exception 'immutable membership column changed' using errcode = 'ZM004';
  end if;
  if old.user_id is not null and new.user_id is distinct from old.user_id then
    raise exception 'membership % already belongs to a user', old.id using errcode = 'ZM004';
  end if;
  if old.status = 'merged' then
    raise exception 'membership % was merged and is final', old.id using errcode = 'ZM003';
  end if;

  if old.status = 'active' and new.status = 'left' then
    if old.role = 'owner' then
      raise exception 'the owner must transfer ownership before leaving' using errcode = 'ZM002';
    end if;
    select coalesce(sum(le.delta_minor), 0) into v_balance
      from memberships m join ledger_entries le on le.member_id = m.id
     where m.id = old.id or m.merged_into = old.id;
    if v_balance <> 0 then
      raise exception 'member % has a non-zero balance (% paise); settle up before leaving', old.id, v_balance
        using errcode = 'ZB001';
    end if;
  end if;

  if new.status = 'merged' and old.status <> 'merged' then
    if old.user_id is not null or old.status <> 'active' then
      raise exception 'only an active ghost can be merged' using errcode = 'ZM003';
    end if;
    perform 1 from memberships t
     where t.id = new.merged_into and t.status = 'active' and t.user_id is not null;
    if not found then
      raise exception 'merge target must be an active real member of the same group' using errcode = 'ZM003';
    end if;
  end if;
  return new;
end $$;

alter table users drop constraint users_deleted_anonymous;
alter table users drop column deleted_at;
