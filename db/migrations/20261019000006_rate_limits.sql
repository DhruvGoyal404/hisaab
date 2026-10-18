-- Counters for rate-limiter-flexible's Postgres store (Phase 6). The schema is the library's own;
-- it is created here so the app role never needs CREATE. Keys are "<limiter>:<ip or user id>".

-- migrate:up

create table rate_limits (
  key     varchar(255) primary key,
  points  integer not null default 0,
  expire  bigint  -- epoch milliseconds
);
create index rate_limits_expire_idx on rate_limits (expire);

grant select, insert, update, delete on rate_limits to hisaab_app;

-- migrate:down

drop table rate_limits;
