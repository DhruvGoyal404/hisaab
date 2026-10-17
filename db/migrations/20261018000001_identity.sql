-- Roles, users, OAuth identities, sessions. See docs/SCHEMA.md §10.

-- migrate:up

-- hisaab_app is a cluster-wide NOLOGIN role; the API's login role is a member of it
-- (created outside migrations). Down migrations revoke but never drop it, because other
-- databases in the same cluster (dev, test) may still hold grants to it.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'hisaab_app') then
    create role hisaab_app nologin;
  end if;
end $$;
grant usage on schema public to hisaab_app;

create table users (
  id            uuid primary key default uuidv7(),
  display_name  text not null check (char_length(display_name) between 1 and 60),
  email         citext check (char_length(email) <= 254),
  avatar_url    text check (avatar_url ~ '^https://'),
  created_at    timestamptz not null default now(),
  disabled_at   timestamptz
);
create unique index users_email_key on users (email) where email is not null;

create table oauth_identities (
  id              uuid primary key default uuidv7(),
  user_id         uuid not null references users (id) on delete cascade,
  provider        text not null check (provider in ('google', 'github')),
  subject         text not null check (char_length(subject) between 1 and 255),
  email           citext,
  email_verified  boolean not null,
  created_at      timestamptz not null default now(),
  last_login_at   timestamptz not null default now(),
  unique (provider, subject),
  unique (user_id, provider),
  check (provider <> 'google' or email_verified)
);

create table sessions (
  id            uuid primary key default uuidv7(),
  user_id       uuid not null references users (id) on delete cascade,
  token_hash    bytea not null unique check (octet_length(token_hash) = 32),
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  expires_at    timestamptz not null,
  revoked_at    timestamptz,
  user_agent    text check (char_length(user_agent) <= 200),
  check (expires_at > created_at)
);
create index sessions_user_idx on sessions (user_id);
create index sessions_expires_idx on sessions (expires_at);

grant select, insert on users, oauth_identities, sessions to hisaab_app;
grant update (display_name, email, avatar_url, disabled_at) on users to hisaab_app;
grant update (email, email_verified, last_login_at) on oauth_identities to hisaab_app;
grant delete on oauth_identities to hisaab_app;
grant update (last_seen_at, revoked_at) on sessions to hisaab_app;
grant delete on sessions to hisaab_app;

-- migrate:down

drop table sessions;
drop table oauth_identities;
drop table users;
revoke usage on schema public from hisaab_app;
