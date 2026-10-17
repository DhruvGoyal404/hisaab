-- Baseline: extensions only. Domain tables arrive in Phase 2 after schema review.
-- uuidv7() and gen_random_uuid() are built into Postgres 18, so no uuid extension is needed.

-- migrate:up
create extension if not exists citext;  -- case-insensitive email columns

-- migrate:down
drop extension if exists citext;
