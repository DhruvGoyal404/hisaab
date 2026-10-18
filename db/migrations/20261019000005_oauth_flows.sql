-- Pending OAuth / OIDC sign-in and link flows (Phase 6). A row lives from "start" to "callback" and
-- is consumed by DELETE ... RETURNING, so a replayed state finds nothing.

-- migrate:up

create table oauth_flows (
  state_hash     bytea primary key check (octet_length(state_hash) = 32),  -- sha256(state)
  provider       text not null check (provider in ('google', 'github')),
  purpose        text not null check (purpose in ('login', 'link')),
  user_id        uuid references users (id) on delete cascade,               -- who is linking
  code_verifier  text not null check (char_length(code_verifier) between 43 and 128),  -- PKCE
  nonce          text check (char_length(nonce) <= 128),                     -- OIDC (Google)
  return_to      text not null default '/' check (return_to ~ '^/' and return_to !~ '^//'),
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null default now() + interval '10 minutes',
  check ((purpose = 'link') = (user_id is not null))
);
create index oauth_flows_expires_idx on oauth_flows (expires_at);

grant select, insert, delete on oauth_flows to hisaab_app;

-- migrate:down

drop table oauth_flows;
