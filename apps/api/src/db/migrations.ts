import type { Db } from "./db.js";

/**
 * Forward-only migrations. One Postgres schema per module; only the owning module writes to it.
 * Kept in TypeScript so the same SQL runs against Cloud SQL, local Postgres and PGlite without file lookups.
 */
export const MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: "001_schemas",
    sql: `
CREATE SCHEMA IF NOT EXISTS reference;
CREATE SCHEMA IF NOT EXISTS inventory;
CREATE SCHEMA IF NOT EXISTS planning;
CREATE SCHEMA IF NOT EXISTS purchasing;
CREATE SCHEMA IF NOT EXISTS identity;
CREATE SCHEMA IF NOT EXISTS audit;
CREATE SCHEMA IF NOT EXISTS messaging;
`,
  },
  {
    id: "002_reference",
    sql: `
CREATE TABLE reference.location (
  location_id text PRIMARY KEY,
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('STORE', 'DC')),
  region text,
  serving_dc_id text,
  fulfils_online boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE reference.supplier (
  supplier_id text PRIMARY KEY,
  name text NOT NULL,
  lead_time_days integer NOT NULL CHECK (lead_time_days >= 0),
  lead_time_std_days numeric(6,2) NOT NULL DEFAULT 0 CHECK (lead_time_std_days >= 0),
  order_weekdays integer[] NOT NULL,
  delivery_weekdays integer[],
  currency char(3) NOT NULL DEFAULT 'GBP',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE reference.product (
  sku text PRIMARY KEY,
  name text NOT NULL,
  category text NOT NULL,
  subcategory text NOT NULL,
  brand text NOT NULL,
  colour_family text NOT NULL,
  unit_price numeric(12,2) NOT NULL CHECK (unit_price >= 0),
  status text NOT NULL CHECK (status IN ('ACTIVE', 'NEW', 'DISCONTINUED')),
  launch_date date,
  end_of_life_date date,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE reference.sourcing (
  sku text NOT NULL REFERENCES reference.product,
  supplier_id text NOT NULL REFERENCES reference.supplier,
  destination_location_id text NOT NULL REFERENCES reference.location,
  unit_cost numeric(12,4) NOT NULL CHECK (unit_cost >= 0),
  pack_size integer NOT NULL CHECK (pack_size > 0),
  moq integer NOT NULL DEFAULT 0 CHECK (moq >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sku, destination_location_id)
);
CREATE TABLE reference.item_location (
  sku text NOT NULL REFERENCES reference.product,
  location_id text NOT NULL REFERENCES reference.location,
  replenishment_source text NOT NULL CHECK (replenishment_source IN ('SUPPLIER', 'DC_TRANSFER')),
  service_level numeric(5,4) NOT NULL CHECK (service_level > 0 AND service_level < 1),
  capacity_units integer CHECK (capacity_units >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sku, location_id)
);
CREATE TABLE reference.order_constraint (
  supplier_id text NOT NULL REFERENCES reference.supplier,
  destination_location_id text NOT NULL REFERENCES reference.location,
  min_order_value numeric(14,2) NOT NULL DEFAULT 0,
  budget numeric(14,2),
  PRIMARY KEY (supplier_id, destination_location_id)
);
`,
  },
  {
    id: "003_inventory",
    sql: `
CREATE TABLE inventory.snapshot (
  sku text NOT NULL,
  location_id text NOT NULL,
  as_of_date date NOT NULL,
  on_hand integer NOT NULL,
  reserved integer NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  in_transit integer NOT NULL DEFAULT 0 CHECK (in_transit >= 0),
  damaged integer NOT NULL DEFAULT 0 CHECK (damaged >= 0),
  returns_pending integer NOT NULL DEFAULT 0 CHECK (returns_pending >= 0),
  import_batch_id uuid NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sku, location_id)
);
CREATE TABLE inventory.legacy_open_order (
  po_reference text NOT NULL,
  sku text NOT NULL,
  supplier_id text NOT NULL,
  destination_location_id text NOT NULL,
  quantity integer NOT NULL CHECK (quantity >= 0),
  order_date date,
  expected_date date NOT NULL,
  import_batch_id uuid NOT NULL,
  PRIMARY KEY (po_reference, sku)
);
`,
  },
  {
    id: "004_planning",
    sql: `
CREATE TABLE planning.planning_run (
  run_id uuid PRIMARY KEY,
  as_of_date date NOT NULL,
  status text NOT NULL CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED')),
  scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  requested_by text NOT NULL,
  engine_version text,
  contract_version text,
  input jsonb,
  input_hash text,
  accuracy jsonb,
  stats jsonb,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE TABLE planning.order_proposal (
  proposal_id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES planning.planning_run,
  supplier_id text NOT NULL,
  destination_location_id text NOT NULL,
  order_date date NOT NULL,
  expected_delivery_date date NOT NULL,
  status text NOT NULL CHECK (status IN ('PROPOSED', 'AWAITING_APPROVAL', 'APPROVED', 'REJECTED', 'SUPERSEDED')),
  version integer NOT NULL DEFAULT 1,
  currency char(3) NOT NULL DEFAULT 'GBP',
  recommended_value numeric(14,2) NOT NULL,
  solver_status text,
  notes jsonb NOT NULL DEFAULT '[]'::jsonb,
  order_exceptions jsonb NOT NULL DEFAULT '[]'::jsonb,
  escalated_by text,
  escalated_at timestamptz,
  decided_by text,
  decided_at timestamptz,
  decision_reason text,
  decision_comment text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- At most one open proposal per supplier, destination and order date; a new run supersedes the old one.
CREATE UNIQUE INDEX order_proposal_one_open
  ON planning.order_proposal (supplier_id, destination_location_id, order_date)
  WHERE status IN ('PROPOSED', 'AWAITING_APPROVAL');
CREATE INDEX order_proposal_status ON planning.order_proposal (status);

CREATE TABLE planning.proposal_line (
  line_id uuid PRIMARY KEY,
  proposal_id uuid NOT NULL REFERENCES planning.order_proposal ON DELETE CASCADE,
  sku text NOT NULL,
  unit_cost numeric(12,4) NOT NULL,
  pack_size integer NOT NULL,
  moq integer NOT NULL,
  recommended_qty integer NOT NULL CHECK (recommended_qty >= 0),
  final_qty integer NOT NULL CHECK (final_qty >= 0),
  override_reason text,
  override_note text,
  overridden_by text,
  overridden_at timestamptz,
  forecast_over_period numeric NOT NULL,
  order_up_to numeric NOT NULL,
  safety_stock numeric NOT NULL,
  inventory_position numeric NOT NULL,
  protection_period_days integer NOT NULL,
  days_of_supply_after_order numeric,
  projected_stockout_date date,
  avg_daily_forecast numeric NOT NULL,
  severity text NOT NULL CHECK (severity IN ('none', 'info', 'warning', 'blocking')),
  exception_codes text[] NOT NULL DEFAULT '{}',
  explanation jsonb NOT NULL,
  chart jsonb NOT NULL,
  accuracy jsonb,
  UNIQUE (proposal_id, sku)
);
`,
  },
  {
    id: "005_purchasing",
    sql: `
CREATE SEQUENCE purchasing.po_number_seq START 100001;
CREATE TABLE purchasing.purchase_order (
  po_id uuid PRIMARY KEY,
  po_number text NOT NULL UNIQUE,
  source_proposal_id uuid NOT NULL UNIQUE,
  supplier_id text NOT NULL,
  destination_location_id text NOT NULL,
  order_date date NOT NULL,
  expected_delivery_date date NOT NULL,
  currency char(3) NOT NULL DEFAULT 'GBP',
  status text NOT NULL CHECK (status IN ('CREATED', 'SUBMITTED', 'SUBMISSION_FAILED', 'CONFIRMED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED')),
  erp_po_number text,
  submission_attempts integer NOT NULL DEFAULT 0,
  last_error text,
  last_error_retryable boolean,
  last_attempt_at timestamptz,
  total_value numeric(14,2) NOT NULL,
  version integer NOT NULL DEFAULT 1,
  approved_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE purchasing.purchase_order_line (
  po_id uuid NOT NULL REFERENCES purchasing.purchase_order ON DELETE CASCADE,
  line_no integer NOT NULL,
  sku text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_cost numeric(12,4) NOT NULL,
  received_qty integer NOT NULL DEFAULT 0,
  PRIMARY KEY (po_id, line_no)
);
CREATE TABLE purchasing.receipt_history (
  po_reference text PRIMARY KEY,
  supplier_id text NOT NULL,
  destination_location_id text NOT NULL,
  order_date date NOT NULL,
  promised_date date NOT NULL,
  received_date date NOT NULL,
  ordered_units integer NOT NULL,
  received_units integer NOT NULL
);
`,
  },
  {
    id: "006_identity",
    sql: `
CREATE TABLE identity.app_user (
  user_id text PRIMARY KEY,
  display_name text NOT NULL,
  roles text[] NOT NULL,
  approval_limit numeric(14,2),
  active boolean NOT NULL DEFAULT true
);
-- Synthetic users for the slice. Limits follow assumption A-46. Names are fictional.
INSERT INTO identity.app_user (user_id, display_name, roles, approval_limit) VALUES
  ('viewer.vic', 'Vic Viewer', ARRAY['viewer'], 0),
  ('planner.priya', 'Priya Planner', ARRAY['planner'], 5000),
  ('planner.omar', 'Omar Planner', ARRAY['planner'], 5000),
  ('senior.sam', 'Sam Senior Planner', ARRAY['senior_planner'], 50000),
  ('head.hana', 'Hana Head of Replenishment', ARRAY['head_of_replenishment'], NULL),
  ('admin.ada', 'Ada Platform Admin', ARRAY['admin'], 0);
`,
  },
  {
    id: "007_audit",
    sql: `
CREATE TABLE audit.audit_event (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id uuid NOT NULL UNIQUE,
  occurred_at timestamptz NOT NULL,
  actor text NOT NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  correlation_id text,
  before jsonb,
  after jsonb,
  metadata jsonb,
  prev_hash text,
  hash text NOT NULL
);
CREATE INDEX audit_event_entity ON audit.audit_event (entity_type, entity_id);
CREATE TABLE audit.chain_head (
  id integer PRIMARY KEY CHECK (id = 1),
  last_hash text
);
INSERT INTO audit.chain_head (id, last_hash) VALUES (1, NULL);
CREATE FUNCTION audit.forbid_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit.audit_event is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER audit_event_append_only BEFORE UPDATE OR DELETE ON audit.audit_event
  FOR EACH ROW EXECUTE FUNCTION audit.forbid_change();
`,
  },
  {
    id: "008_messaging",
    sql: `
CREATE TABLE messaging.outbox (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id uuid NOT NULL UNIQUE,
  type text NOT NULL,
  subject text NOT NULL,
  ordering_key text NOT NULL,
  aggregate_version integer NOT NULL,
  envelope jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  dead_lettered_at timestamptz
);
CREATE INDEX outbox_pending ON messaging.outbox (seq) WHERE published_at IS NULL AND dead_lettered_at IS NULL;
CREATE TABLE messaging.inbox (
  consumer text NOT NULL,
  event_id uuid NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);
CREATE TABLE messaging.idempotency_key (
  idempotency_key text NOT NULL,
  actor text NOT NULL,
  method text NOT NULL,
  path text NOT NULL,
  request_hash text NOT NULL,
  status_code integer,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (idempotency_key, actor)
);
`,
  },
  {
    id: "009_demo_and_erp_simulator",
    sql: `
-- Hosted-demo support. Not part of the production design.
CREATE SCHEMA IF NOT EXISTS mock_erp;
CREATE SEQUENCE mock_erp.po_number_seq START 4500100001;
CREATE TABLE mock_erp.purchase_order (
  client_reference text PRIMARY KEY,
  erp_po_number text NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.demo_state (
  id integer PRIMARY KEY CHECK (id = 1),
  status text NOT NULL CHECK (status IN ('seeding', 'ready')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
`,
  },
];

export async function migrate(db: Db): Promise<string[]> {
  await db.query(
    "CREATE TABLE IF NOT EXISTS public.schema_migration (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const done = new Set((await db.query<{ id: string }>("SELECT id FROM public.schema_migration")).map((r) => r.id));
  const applied: string[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    // Serverless instances may start together: the advisory lock serialises them and the re-check skips
    // migrations another instance applied while this one waited.
    const ran = await db.tx(async (q) => {
      await q.query("SELECT pg_advisory_xact_lock(727274)");
      const exists = await q.query("SELECT 1 FROM public.schema_migration WHERE id = $1", [m.id]);
      if (exists.length) return false;
      await q.exec(m.sql);
      await q.query("INSERT INTO public.schema_migration (id) VALUES ($1)", [m.id]);
      return true;
    });
    if (ran) applied.push(m.id);
  }
  return applied;
}
