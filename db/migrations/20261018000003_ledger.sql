-- Expenses (versioned), settlements, the journal, and the triggers that keep them honest.
-- See docs/SCHEMA.md §2-§7.

-- migrate:up

create table expenses (
  id            uuid primary key default uuidv7(),
  group_id      uuid not null references groups (id),
  head_version  integer not null default 0 check (head_version >= 0),
  created_seq   bigint not null,
  created_at    timestamptz not null default now(),
  unique (group_id, id),
  foreign key (group_id, created_seq) references activity_log (group_id, seq) deferrable initially deferred
);
create index expenses_group_idx on expenses (group_id);

create table expense_versions (
  expense_id      uuid not null,
  version         integer not null check (version >= 1),
  group_id        uuid not null,
  currency        char(3) not null,
  kind            text not null check (kind in ('create', 'edit', 'delete')),
  description     text check (char_length(description) between 1 and 200),
  total_minor     bigint check (total_minor between 1 and 100000000000),
  split_method    text check (split_method in ('equal', 'exact', 'percent', 'shares')),
  occurred_on     date,
  author_user_id  uuid not null references users (id),
  seq             bigint not null,
  created_at      timestamptz not null default now(),
  primary key (expense_id, version),
  unique (group_id, expense_id, version),
  foreign key (group_id, expense_id) references expenses (group_id, id),
  foreign key (group_id, currency) references groups (id, currency),
  foreign key (group_id, seq) references activity_log (group_id, seq) deferrable initially deferred,
  check ((kind = 'create') = (version = 1)),
  check (
    (kind = 'delete' and description is null and total_minor is null and split_method is null and occurred_on is null)
    or (kind <> 'delete' and description is not null and total_minor is not null
        and split_method is not null and occurred_on is not null)
  )
);
create index expense_versions_group_seq_idx on expense_versions (group_id, seq);

create table expense_lines (
  expense_id  uuid not null,
  version     integer not null,
  group_id    uuid not null,
  member_id   uuid not null,
  paid_minor  bigint not null default 0 check (paid_minor >= 0),
  owed_minor  bigint not null default 0 check (owed_minor >= 0),
  weight      bigint check (weight between 1 and 100000000000),
  primary key (expense_id, version, member_id),
  foreign key (group_id, expense_id, version) references expense_versions (group_id, expense_id, version),
  foreign key (group_id, member_id) references memberships (group_id, id),
  check (weight is not null or (owed_minor = 0 and paid_minor > 0))
);
create index expense_lines_member_idx on expense_lines (member_id);

create table settlements (
  id              uuid primary key default uuidv7(),
  group_id        uuid not null,
  currency        char(3) not null,
  from_member_id  uuid not null,
  to_member_id    uuid not null,
  amount_minor    bigint not null check (amount_minor between 1 and 100000000000),
  note            text check (char_length(note) <= 200),
  author_user_id  uuid not null references users (id),
  seq             bigint not null,
  created_at      timestamptz not null default now(),
  unique (group_id, id),
  foreign key (group_id, currency) references groups (id, currency),
  foreign key (group_id, from_member_id) references memberships (group_id, id),
  foreign key (group_id, to_member_id) references memberships (group_id, id),
  foreign key (group_id, seq) references activity_log (group_id, seq) deferrable initially deferred,
  check (from_member_id <> to_member_id)
);
create index settlements_group_seq_idx on settlements (group_id, seq);

create table settlement_voids (
  settlement_id   uuid primary key,
  group_id        uuid not null,
  author_user_id  uuid not null references users (id),
  seq             bigint not null,
  created_at      timestamptz not null default now(),
  foreign key (group_id, settlement_id) references settlements (group_id, id),
  foreign key (group_id, seq) references activity_log (group_id, seq) deferrable initially deferred
);

create table ledger_entries (
  id               bigint generated always as identity primary key,
  group_id         uuid not null,
  seq              bigint not null,
  member_id        uuid not null,
  delta_minor      bigint not null check (delta_minor <> 0),
  source           text not null check (source in ('expense', 'expense_reversal', 'settlement', 'settlement_reversal')),
  expense_id       uuid,
  expense_version  integer,
  settlement_id    uuid,
  created_at       timestamptz not null default now(),
  foreign key (group_id, member_id) references memberships (group_id, id),
  foreign key (group_id, seq) references activity_log (group_id, seq) deferrable initially deferred,
  foreign key (expense_id, expense_version) references expense_versions (expense_id, version),
  foreign key (settlement_id) references settlements (id),
  check (
    (source in ('expense', 'expense_reversal')
       and expense_id is not null and expense_version is not null and settlement_id is null)
    or (source in ('settlement', 'settlement_reversal')
       and settlement_id is not null and expense_id is null and expense_version is null)
  )
);
create index ledger_entries_member_idx on ledger_entries (member_id) include (delta_minor);
create index ledger_entries_group_seq_idx on ledger_entries (group_id, seq);
create index ledger_entries_expense_idx on ledger_entries (expense_id, expense_version) where expense_id is not null;
create index ledger_entries_settlement_idx on ledger_entries (settlement_id) where settlement_id is not null;

-- Append-only guards.
create trigger expense_versions_append_only before update or delete on expense_versions
  for each row execute function forbid_mutation();
create trigger expense_lines_append_only before update or delete on expense_lines
  for each row execute function forbid_mutation();
create trigger settlements_append_only before update or delete on settlements
  for each row execute function forbid_mutation();
create trigger settlement_voids_append_only before update or delete on settlement_voids
  for each row execute function forbid_mutation();
create trigger ledger_entries_append_only before update or delete on ledger_entries
  for each row execute function forbid_mutation();
create trigger expense_versions_no_truncate before truncate on expense_versions
  for each statement execute function forbid_mutation();
create trigger expense_lines_no_truncate before truncate on expense_lines
  for each statement execute function forbid_mutation();
create trigger settlements_no_truncate before truncate on settlements
  for each statement execute function forbid_mutation();
create trigger settlement_voids_no_truncate before truncate on settlement_voids
  for each statement execute function forbid_mutation();
create trigger ledger_entries_no_truncate before truncate on ledger_entries
  for each statement execute function forbid_mutation();
create trigger expenses_no_truncate before truncate on expenses
  for each statement execute function forbid_mutation();

create function expenses_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE'
     or (new.id, new.group_id, new.created_seq, new.created_at)
        is distinct from (old.id, old.group_id, old.created_seq, old.created_at) then
    raise exception 'expenses rows are immutable apart from head_version' using errcode = 'ZA001';
  end if;
  return new;
end $$;
create trigger expenses_guard before update or delete on expenses
  for each row execute function expenses_guard();

create trigger expenses_seq before insert on expenses
  for each row execute function assert_write_seq('created_seq');
create trigger expense_versions_seq before insert on expense_versions
  for each row execute function assert_write_seq('seq');
create trigger settlements_seq before insert on settlements
  for each row execute function assert_write_seq('seq');
create trigger settlement_voids_seq before insert on settlement_voids
  for each row execute function assert_write_seq('seq');

-- A merged ghost acts through the member it was merged into: its status is that member's status.
create function effective_member(p_member uuid, out member_id uuid, out status text)
language sql stable as $$
  select coalesce(t.id, m.id), coalesce(t.status, m.status)
    from memberships m
    left join memberships t on t.id = m.merged_into
   where m.id = p_member
$$;

-- Versioning: advance the head and reverse the previous head's postings.
create function expense_versions_apply() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_head integer;
  v_head_kind text;
begin
  select head_version into v_head from expenses where id = new.expense_id for update;
  if new.version <> v_head + 1 then
    raise exception 'expense % is at version %, cannot write version %', new.expense_id, v_head, new.version
      using errcode = 'ZV001';
  end if;
  if v_head > 0 then
    select kind into v_head_kind from expense_versions where expense_id = new.expense_id and version = v_head;
    if v_head_kind = 'delete' and new.kind = 'delete' then
      raise exception 'expense % is already deleted', new.expense_id using errcode = 'ZV002';
    end if;
    -- A member who left has a zero balance by rule; reversing their postings would break that.
    if exists (select 1 from ledger_entries le cross join lateral effective_member(le.member_id) e
                where le.expense_id = new.expense_id and le.expense_version = v_head
                  and le.source = 'expense' and e.status = 'left') then
      raise exception 'expense % involves a member who has left; re-add them first', new.expense_id
        using errcode = 'ZM001';
    end if;
    insert into ledger_entries (group_id, seq, member_id, delta_minor, source, expense_id, expense_version)
    select group_id, new.seq, member_id, -delta_minor, 'expense_reversal', expense_id, expense_version
      from ledger_entries
     where expense_id = new.expense_id and expense_version = v_head and source = 'expense';
  end if;
  update expenses set head_version = new.version where id = new.expense_id;
  return null;
end $$;
create trigger expense_versions_apply after insert on expense_versions
  for each row execute function expense_versions_apply();

-- Lines post to the journal, only in the version's own transaction, only for active (effective) members.
create function expense_lines_post() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_seq bigint;
  v_current bigint;
  v_status text;
begin
  select seq into v_seq from expense_versions where expense_id = new.expense_id and version = new.version;
  select last_seq into v_current from groups where id = new.group_id;
  if v_seq <> v_current then
    raise exception 'lines for %/% can only be added in the transaction that created the version',
      new.expense_id, new.version using errcode = 'ZS001';
  end if;
  select status into v_status from effective_member(new.member_id);
  if v_status <> 'active' then
    raise exception 'member % is %, not active', new.member_id, v_status using errcode = 'ZM001';
  end if;
  if new.paid_minor <> new.owed_minor then
    insert into ledger_entries (group_id, seq, member_id, delta_minor, source, expense_id, expense_version)
    values (new.group_id, v_seq, new.member_id, new.paid_minor - new.owed_minor, 'expense', new.expense_id, new.version);
  end if;
  return null;
end $$;
create trigger expense_lines_post after insert on expense_lines
  for each row execute function expense_lines_post();

create function settlements_post() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_from record;
  v_to record;
begin
  select * into v_from from effective_member(new.from_member_id);
  select * into v_to from effective_member(new.to_member_id);
  if v_from.status <> 'active' or v_to.status <> 'active' then
    raise exception 'settlement members must be active' using errcode = 'ZM001';
  end if;
  if v_from.member_id = v_to.member_id then
    raise exception 'settlement between a member and a ghost merged into them' using errcode = 'ZM003';
  end if;
  insert into ledger_entries (group_id, seq, member_id, delta_minor, source, settlement_id)
  values (new.group_id, new.seq, new.from_member_id,  new.amount_minor, 'settlement', new.id),
         (new.group_id, new.seq, new.to_member_id,   -new.amount_minor, 'settlement', new.id);
  return null;
end $$;
create trigger settlements_post after insert on settlements
  for each row execute function settlements_post();

create function settlement_voids_post() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if exists (select 1 from ledger_entries le cross join lateral effective_member(le.member_id) e
              where le.settlement_id = new.settlement_id and le.source = 'settlement' and e.status = 'left') then
    raise exception 'settlement % involves a member who has left; re-add them first', new.settlement_id
      using errcode = 'ZM001';
  end if;
  insert into ledger_entries (group_id, seq, member_id, delta_minor, source, settlement_id)
  select group_id, new.seq, member_id, -delta_minor, 'settlement_reversal', settlement_id
    from ledger_entries
   where settlement_id = new.settlement_id and source = 'settlement';
  return null;
end $$;
create trigger settlement_voids_post after insert on settlement_voids
  for each row execute function settlement_voids_post();

-- Deferred to COMMIT: a version's lines sum to its total and match the allocation rule.
create function check_expense_version() returns trigger
language plpgsql as $$
declare
  v         expense_versions%rowtype;
  n_lines   integer;
  n_part    integer;
  s_paid    numeric;
  s_owed    numeric;
  s_weight  numeric;
begin
  select * into v from expense_versions where expense_id = new.expense_id and version = new.version;
  select count(*), count(weight), coalesce(sum(paid_minor), 0), coalesce(sum(owed_minor), 0), coalesce(sum(weight), 0)
    into n_lines, n_part, s_paid, s_owed, s_weight
    from expense_lines where expense_id = v.expense_id and version = v.version;

  if v.kind = 'delete' then
    if n_lines > 0 then
      raise exception 'delete version %/% must not have lines', v.expense_id, v.version using errcode = 'ZL002';
    end if;
    return null;
  end if;

  if n_part = 0 then
    raise exception 'expense %/% has no participants', v.expense_id, v.version using errcode = 'ZL002';
  end if;
  if s_paid <> v.total_minor then
    raise exception 'expense %/%: payers sum to % but total is %', v.expense_id, v.version, s_paid, v.total_minor
      using errcode = 'ZL002';
  end if;
  if s_owed <> v.total_minor then
    raise exception 'expense %/%: splits sum to % but total is %', v.expense_id, v.version, s_owed, v.total_minor
      using errcode = 'ZL002';
  end if;

  if (v.split_method = 'equal' and exists (
        select 1 from expense_lines where expense_id = v.expense_id and version = v.version and weight <> 1))
     or (v.split_method = 'exact' and exists (
        select 1 from expense_lines where expense_id = v.expense_id and version = v.version and weight <> owed_minor))
     or (v.split_method = 'percent' and s_weight <> 10000) then
    raise exception 'expense %/%: weights do not match split method %', v.expense_id, v.version, v.split_method
      using errcode = 'ZL002';
  end if;

  -- The allocation function's guarantee: every share is floor or ceil of total * weight / sum(weight).
  if exists (
    select 1 from expense_lines
     where expense_id = v.expense_id and version = v.version and weight is not null
       and abs(owed_minor::numeric * s_weight - v.total_minor::numeric * weight) >= s_weight) then
    raise exception 'expense %/%: a share is outside its floor/ceil bound', v.expense_id, v.version
      using errcode = 'ZL002';
  end if;
  return null;
end $$;
create constraint trigger expense_versions_valid after insert on expense_versions
  deferrable initially deferred for each row execute function check_expense_version();
create constraint trigger expense_lines_valid after insert on expense_lines
  deferrable initially deferred for each row execute function check_expense_version();

-- Deferred: every write transaction's postings net to zero.
create function check_seq_balanced() returns trigger
language plpgsql as $$
declare
  v_sum numeric;
begin
  select sum(delta_minor) into v_sum from ledger_entries where group_id = new.group_id and seq = new.seq;
  if v_sum <> 0 then
    raise exception 'ledger postings for group % seq % sum to %, not 0', new.group_id, new.seq, v_sum
      using errcode = 'ZL001';
  end if;
  return null;
end $$;
create constraint trigger ledger_entries_balanced after insert on ledger_entries
  deferrable initially deferred for each row execute function check_seq_balanced();

-- Membership rules: never deleted; identity only null -> user (claim); leaving needs a zero balance.
create function memberships_guard() returns trigger
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
create trigger memberships_guard before update or delete on memberships
  for each row execute function memberships_guard();

grant select, insert on expenses, expense_versions, expense_lines, settlements, settlement_voids to hisaab_app;
grant select on ledger_entries to hisaab_app;
grant execute on function effective_member(uuid) to hisaab_app;

-- migrate:down

drop trigger memberships_guard on memberships;
drop function memberships_guard();
drop table ledger_entries;
drop table settlement_voids;
drop table settlements;
drop table expense_lines;
drop table expense_versions;
drop table expenses;
drop function check_seq_balanced();
drop function check_expense_version();
drop function settlement_voids_post();
drop function settlements_post();
drop function expense_lines_post();
drop function expense_versions_apply();
drop function effective_member(uuid);
drop function expenses_guard();
