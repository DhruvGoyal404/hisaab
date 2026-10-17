-- Groups, activity log, memberships, invites, idempotency keys. See docs/SCHEMA.md §5, §7, §8.

-- migrate:up

create table groups (
  id              uuid primary key default uuidv7(),
  name            text not null check (char_length(name) between 1 and 80),
  currency        char(3) not null default 'INR' check (currency = 'INR'),
  simplify_debts  boolean not null default true,
  created_by      uuid not null references users (id),
  created_at      timestamptz not null default now(),
  archived_at     timestamptz,
  last_seq        bigint not null default 0 check (last_seq >= 0),
  unique (id, currency)
);

create table activity_log (
  group_id       uuid not null references groups (id),
  seq            bigint not null check (seq > 0),
  id             uuid not null default uuidv7() unique,
  actor_user_id  uuid references users (id),
  type           text not null check (type ~ '^[a-z]+\.[a-z_]+$'),
  subject_id     uuid,
  payload        jsonb not null default '{}' check (jsonb_typeof(payload) = 'object'),
  created_at     timestamptz not null default now(),
  primary key (group_id, seq)
);

create table memberships (
  id            uuid primary key default uuidv7(),
  group_id      uuid not null references groups (id),
  user_id       uuid references users (id),
  display_name  text check (char_length(display_name) between 1 and 60),
  role          text not null default 'member' check (role in ('owner', 'admin', 'member')),
  status        text not null default 'active' check (status in ('active', 'left', 'merged')),
  merged_into   uuid,
  created_seq   bigint not null,
  updated_seq   bigint not null,
  created_at    timestamptz not null default now(),
  left_at       timestamptz,
  unique (group_id, id),
  foreign key (group_id, merged_into) references memberships (group_id, id),
  foreign key (group_id, created_seq) references activity_log (group_id, seq) deferrable initially deferred,
  foreign key (group_id, updated_seq) references activity_log (group_id, seq) deferrable initially deferred,
  check (user_id is not null or display_name is not null),
  check ((status = 'merged') = (merged_into is not null)),
  check (status <> 'merged' or user_id is null),
  check (merged_into <> id),
  check ((status = 'left') = (left_at is not null)),
  check (user_id is not null or role = 'member')
);
create unique index memberships_group_user_key on memberships (group_id, user_id) where user_id is not null;
create index memberships_user_idx on memberships (user_id) where user_id is not null;
create index memberships_merged_into_idx on memberships (merged_into) where merged_into is not null;
create unique index memberships_one_owner_key on memberships (group_id) where role = 'owner' and status = 'active';
create unique index memberships_ghost_name_key on memberships (group_id, lower(display_name))
  where user_id is null and status = 'active';

create table invites (
  id               uuid primary key default uuidv7(),
  group_id         uuid not null references groups (id),
  token_hash       bytea not null unique check (octet_length(token_hash) = 32),
  ghost_member_id  uuid,
  created_by       uuid not null references users (id),
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  used_at          timestamptz,
  used_by          uuid references users (id),
  revoked_at       timestamptz,
  foreign key (group_id, ghost_member_id) references memberships (group_id, id),
  check (expires_at > created_at and expires_at <= created_at + interval '30 days'),
  check ((used_at is null) = (used_by is null)),
  check (used_at is null or revoked_at is null)
);
create index invites_group_idx on invites (group_id);
create unique index invites_one_open_per_ghost_key on invites (ghost_member_id)
  where ghost_member_id is not null and used_at is null and revoked_at is null;

create table idempotency_keys (
  user_id       uuid not null references users (id) on delete cascade,
  key           uuid not null,
  scope         text not null check (scope in ('expense.create', 'settlement.create')),
  request_hash  bytea not null check (octet_length(request_hash) = 32),
  resource_id   uuid not null,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '24 hours',
  primary key (user_id, key)
);
create index idempotency_keys_expires_idx on idempotency_keys (expires_at);

-- Custom SQLSTATEs (class Z) are listed in docs/SCHEMA.md §12.
create function forbid_mutation() returns trigger
language plpgsql as $$
begin
  raise exception '% is append-only: % rejected', tg_table_name, tg_op using errcode = 'ZA001';
end $$;

create trigger activity_log_append_only before update or delete on activity_log
  for each row execute function forbid_mutation();
create trigger activity_log_no_truncate before truncate on activity_log
  for each statement execute function forbid_mutation();

-- Every ledger-affecting write carries the group's current seq, which only the transaction that
-- just ran `update groups set last_seq = last_seq + 1` (and so holds the row lock) can know.
create function assert_write_seq() returns trigger
language plpgsql as $$
declare
  v_seq bigint := (to_jsonb(new) ->> tg_argv[0])::bigint;
  v_current bigint;
begin
  select last_seq into v_current from groups where id = new.group_id;
  if v_seq is distinct from v_current then
    raise exception '% write uses seq % but group % is at %; bump groups.last_seq first',
      tg_table_name, v_seq, new.group_id, v_current using errcode = 'ZS001';
  end if;
  return new;
end $$;
create trigger activity_log_seq before insert on activity_log
  for each row execute function assert_write_seq('seq');
create trigger memberships_seq before insert or update on memberships
  for each row execute function assert_write_seq('updated_seq');

create function groups_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'groups are archived, never deleted' using errcode = 'ZA001';
  end if;
  if new.id <> old.id or new.currency <> old.currency or new.created_by <> old.created_by
     or new.created_at <> old.created_at then
    raise exception 'immutable group column changed' using errcode = 'ZG001';
  end if;
  if new.last_seq not in (old.last_seq, old.last_seq + 1) then
    raise exception 'last_seq may only advance by 1' using errcode = 'ZG001';
  end if;
  return new;
end $$;
create trigger groups_guard before update or delete on groups
  for each row execute function groups_guard();

grant select, insert on groups, activity_log, memberships, invites, idempotency_keys to hisaab_app;
grant update (name, simplify_debts, archived_at, last_seq) on groups to hisaab_app;
grant update (user_id, display_name, role, status, merged_into, left_at, updated_seq) on memberships to hisaab_app;
grant update (used_at, used_by, revoked_at) on invites to hisaab_app;
grant delete on idempotency_keys to hisaab_app;

-- migrate:down

drop table idempotency_keys;
drop table invites;
drop table memberships;
drop table activity_log;
drop table groups;
drop function groups_guard();
drop function assert_write_seq();
drop function forbid_mutation();
