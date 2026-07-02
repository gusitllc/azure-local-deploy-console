-- 001_init.sql — schema `console`, per blueprint 03 §3 + 09 (DB-DATA-EXCELLENCE).
-- Additive/backward-compatible. Parameterized access only via lib/db.js.
-- Status enum discipline: pending|running|awaiting-approval|failed|succeeded|skipped.

CREATE SCHEMA IF NOT EXISTS console;

-- ── Identity / billing ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS console.customers (
  id                 BIGSERIAL PRIMARY KEY,
  email              TEXT NOT NULL,
  company            TEXT,
  stripe_customer_id TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS console.orders (
  id                BIGSERIAL PRIMARY KEY,
  customer_id       BIGINT REFERENCES console.customers(id) ON DELETE CASCADE,
  stripe_session_id TEXT UNIQUE,
  amount_cents      INTEGER NOT NULL DEFAULT 0,
  clusters_qty      INTEGER NOT NULL DEFAULT 1,
  status            TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('paid','refunded')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Worker devstations (per-run, ephemeral) ───────────────────────────────
CREATE TABLE IF NOT EXISTS console.workers (
  id                BIGSERIAL PRIMARY KEY,
  order_id          BIGINT REFERENCES console.orders(id) ON DELETE SET NULL,
  provider_ref      TEXT,
  status            TEXT NOT NULL DEFAULT 'provisioning'
                      CHECK (status IN ('provisioning','ready','draining','gone')),
  enroll_token_hash TEXT,
  mtls_fp           TEXT,
  vpn_verified      BOOLEAN NOT NULL DEFAULT false,
  enrolled_at       TIMESTAMPTZ,
  last_seen_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Clusters + servers ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS console.clusters (
  id          BIGSERIAL PRIMARY KEY,
  customer_id BIGINT REFERENCES console.customers(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS console.servers (
  id                BIGSERIAL PRIMARY KEY,
  cluster_id        BIGINT REFERENCES console.clusters(id) ON DELETE SET NULL,
  idrac_ip          TEXT NOT NULL,
  idrac_user        TEXT,
  cred_ref          TEXT,                 -- worker key-store handle, NEVER a password
  model             TEXT,
  service_tag       TEXT,
  health            TEXT,
  bios_ver          TEXT,
  fw_json           JSONB NOT NULL DEFAULT '{}'::jsonb,
  storage_count     INTEGER,
  last_inventory_at TIMESTAMPTZ,
  locked_by_run_id  BIGINT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (idrac_ip)
);
-- One active run per server (partial unique index).
CREATE UNIQUE INDEX IF NOT EXISTS servers_one_active_run
  ON console.servers(locked_by_run_id) WHERE locked_by_run_id IS NOT NULL;

-- ── Runs / phases / steps ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS console.runs (
  id             BIGSERIAL PRIMARY KEY,
  cluster_id     BIGINT REFERENCES console.clusters(id) ON DELETE SET NULL,
  worker_id      BIGINT REFERENCES console.workers(id) ON DELETE SET NULL,
  status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','running','awaiting-approval','failed','succeeded','skipped')),
  gates_json     JSONB NOT NULL DEFAULT '{}'::jsonb,
  phase_from     INTEGER NOT NULL DEFAULT 1,
  phase_to       INTEGER NOT NULL DEFAULT 5,
  current_phase  INTEGER,
  error_verbatim TEXT,                    -- secret-scrubbed before insert
  halt_requested BOOLEAN NOT NULL DEFAULT false,
  created_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at     TIMESTAMPTZ,
  finished_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS runs_status_idx ON console.runs(status);

CREATE TABLE IF NOT EXISTS console.phases (
  id          BIGSERIAL PRIMARY KEY,
  run_id      BIGINT NOT NULL REFERENCES console.runs(id) ON DELETE CASCADE,
  idx         INTEGER NOT NULL,           -- 1..5
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','running','awaiting-approval','failed','succeeded','skipped')),
  started_at  TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  UNIQUE (run_id, idx)
);

CREATE TABLE IF NOT EXISTS console.steps (
  id            BIGSERIAL PRIMARY KEY,
  phase_id      BIGINT NOT NULL REFERENCES console.phases(id) ON DELETE CASCADE,
  idx           INTEGER NOT NULL,
  name          TEXT NOT NULL,
  stage_cmd     TEXT,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','running','awaiting-approval','failed','succeeded','skipped')),
  exit_code     INTEGER,
  attempt       INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 1,
  timeout_s     INTEGER NOT NULL DEFAULT 3600,
  log_ref       TEXT,
  error_excerpt TEXT,
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  UNIQUE (phase_id, idx)
);
CREATE INDEX IF NOT EXISTS steps_phase_idx ON console.steps(phase_id, idx);

-- ── Append-only event log (SSE source) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS console.events (
  id        BIGSERIAL PRIMARY KEY,        -- monotonic; SSE resumes from Last-Event-ID
  run_id    BIGINT NOT NULL REFERENCES console.runs(id) ON DELETE CASCADE,
  ts        TIMESTAMPTZ NOT NULL DEFAULT now(),
  level     TEXT NOT NULL DEFAULT 'info',
  phase_idx INTEGER,
  step_id   BIGINT,
  type      TEXT NOT NULL DEFAULT 'log'
              CHECK (type IN ('state','log','gate','error','audit')),
  message   TEXT
);
CREATE INDEX IF NOT EXISTS events_run_id_idx ON console.events(run_id, id);

-- ── Worker job queue (console -> worker long-poll dispatch) ───────────────
-- The console records JOB intents here; the worker claims them by long-poll
-- (FOR UPDATE SKIP LOCKED). payload_json carries non-secret config + cred_ref
-- HANDLES only — never a secret value.
CREATE TABLE IF NOT EXISTS console.worker_jobs (
  id           BIGSERIAL PRIMARY KEY,
  run_id       BIGINT NOT NULL REFERENCES console.runs(id) ON DELETE CASCADE,
  worker_id    BIGINT REFERENCES console.workers(id) ON DELETE SET NULL,
  step_id      BIGINT REFERENCES console.steps(id) ON DELETE SET NULL,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  status       TEXT NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued','claimed','done','cancelled')),
  claimed_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS worker_jobs_claim_idx
  ON console.worker_jobs(worker_id, status, id);

-- ── Operators / sessions / settings ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS console.operators (
  id                BIGSERIAL PRIMARY KEY,
  username          TEXT NOT NULL UNIQUE,
  pass_hash         TEXT NOT NULL,        -- scrypt: salt:hash (hex)
  role              TEXT NOT NULL DEFAULT 'viewer',
  capabilities_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  disabled          BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS console.sessions (
  token       TEXT PRIMARY KEY,
  operator_id BIGINT NOT NULL REFERENCES console.operators(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON console.sessions(expires_at);

CREATE TABLE IF NOT EXISTS console.settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);