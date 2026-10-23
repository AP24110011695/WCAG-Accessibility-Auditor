-- Sunflower Audit — Supabase Postgres schema (source of truth, architecture.md §5).
-- Apply via the Supabase SQL editor (P0-T3). The service key bypasses RLS;
-- the anon key (dashboard) gets read-only access plus the two gate RPCs.

create table runs (
  run_id text primary key,
  created_at timestamptz not null default now(),
  target_level text not null,
  status text not null,              -- pending|collecting|planning|finding|awaiting_approval|done|failed
  config_json jsonb not null,
  trigger_source text not null default 'edge_function', -- 'edge_function'|'manual_dispatch'|'local'
  plan_json jsonb                 -- per-page conditional check plan (FR-02)
);

create table page_inputs (
  input_id text primary key,
  run_id text not null references runs,
  url text not null,
  label text,
  validation_status text not null,   -- valid|invalid
  validation_errors jsonb
);

create table sources (
  source_id text primary key,
  input_id text not null references page_inputs,
  url text not null,
  retrieved_at timestamptz not null,
  http_status integer,
  fetch_method text not null,        -- 'cheerio'|'playwright'
  content_hash text not null,
  snapshot_path text not null        -- Storage object path
);

create table findings (
  finding_id text primary key,
  run_id text not null references runs,
  input_id text not null references page_inputs,
  source_id text not null references sources,
  rule_id text not null,
  wcag_criterion text not null,
  selector text,
  check_type text not null,          -- 'axe'|'keyboard'|'contrast'|'heuristic'|'collect'
  state text not null,               -- fail|pass|uncertain
  reason text not null,
  evidence_ids jsonb not null default '[]'::jsonb
);

create table evidence (
  evidence_id text primary key,
  run_id text not null references runs,
  finding_id text references findings,
  type text not null,                -- screenshot|video|dom_snippet|keystroke_trace|pixel_sample|axe_report
  storage_path text not null,
  checksum text not null,
  created_at timestamptz not null default now(),
  metadata jsonb
);

create table decisions (
  decision_id text primary key,
  finding_id text references findings,  -- null = page-level aggregate pass
  input_id text not null references page_inputs,
  outcome text not null,             -- fail|pass|uncertain
  rule text not null,
  reason text not null,
  input_evidence_ids jsonb not null,
  llm_involved integer not null default 0,
  llm_status text not null default 'none', -- ok|quota_exhausted|disabled|none
  llm_model text,
  llm_confidence real
);

-- The only write paths for the dashboard. Payload contracts:
--   log_issue:  {finding_id, run_id, title, description, wcag_criterion, severity}
--   close_issue:{issue_id}
create table actions (
  action_id text primary key,
  idempotency_key text not null unique, -- sha256(run_id|finding_ids|action_type|payload_hash)
  action_type text not null,         -- 'log_issue'|'close_issue'
  status text not null,              -- proposed|approved|executing|executed|failed|rejected
  payload_json jsonb not null,
  created_at timestamptz not null default now(),
  executed_at timestamptz
);

create table approvals (
  approval_id text primary key,
  action_id text not null references actions,
  decision text not null,            -- approve|reject
  approver text not null,
  reason text,
  approved_at timestamptz not null default now()
);

create table issues (
  issue_id text primary key,
  finding_id text not null references findings,
  action_id text not null references actions,
  title text not null,
  description text not null,
  wcag_criterion text not null,
  severity text not null,            -- critical|serious|moderate
  status text not null,              -- open|retest_pass|closed|retest_failed
  created_at timestamptz not null default now()
);

create table retests (
  retest_id text primary key,
  issue_id text not null references issues,
  run_id text not null references runs,
  intended text not null,
  observed text not null,
  outcome text not null,             -- pass|fail|uncertain
  evidence_ids jsonb not null,
  created_at timestamptz not null default now()
);

create table test_case_runs (
  tc_id text primary key,            -- 'TC1'|'TC2'|'TC3'|'TC4'
  run_id text not null references runs,
  input_json jsonb not null,
  expected text not null,
  actual text not null,
  matches_expected integer not null,
  explanation text not null,
  evidence_paths jsonb not null
);

create table llm_cache (
  cache_key text primary key,        -- sha256(model + prompt)
  model text not null,
  response_json jsonb not null,
  created_at timestamptz not null default now()
);

-- Access control: dashboard (anon) reads everything except llm_cache; all
-- writes go through the two SECURITY DEFINER RPCs below. The worker uses the
-- service key, which bypasses RLS.
alter table runs            enable row level security;
alter table page_inputs     enable row level security;
alter table sources         enable row level security;
alter table findings        enable row level security;
alter table evidence        enable row level security;
alter table decisions       enable row level security;
alter table actions         enable row level security;
alter table approvals       enable row level security;
alter table issues          enable row level security;
alter table retests         enable row level security;
alter table test_case_runs  enable row level security;
alter table llm_cache       enable row level security;

create policy anon_read_runs           on runs            for select to anon using (true);
create policy anon_read_page_inputs    on page_inputs     for select to anon using (true);
create policy anon_read_sources        on sources         for select to anon using (true);
create policy anon_read_findings       on findings        for select to anon using (true);
create policy anon_read_evidence       on evidence        for select to anon using (true);
create policy anon_read_decisions      on decisions       for select to anon using (true);
create policy anon_read_actions        on actions         for select to anon using (true);
create policy anon_read_approvals      on approvals       for select to anon using (true);
create policy anon_read_issues         on issues          for select to anon using (true);
create policy anon_read_retests        on retests         for select to anon using (true);
create policy anon_read_test_case_runs on test_case_runs  for select to anon using (true);

grant select on runs, page_inputs, sources, findings, evidence, decisions,
  actions, approvals, issues, retests, test_case_runs to anon;

-- Gate RPC 1: record an approval and move a proposed action to approved/rejected.
create or replace function approve_action(p_action_id text, p_decision text, p_approver text, p_reason text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_status text;
begin
  if p_decision not in ('approve', 'reject') then
    raise exception 'decision must be approve or reject';
  end if;
  if p_approver is null or length(btrim(p_approver)) < 2 or length(btrim(p_approver)) > 40 then
    raise exception 'approver name required (2-40 characters)';
  end if;
  select status into v_status from actions where action_id = p_action_id for update;
  if v_status is null then
    raise exception 'action not found';
  end if;
  if v_status <> 'proposed' then
    raise exception 'action % is not proposed (status: %)', p_action_id, v_status;
  end if;
  insert into approvals (approval_id, action_id, decision, approver, reason)
  values ('apr-' || substr(md5(random()::text || clock_timestamp()::text), 1, 8),
          p_action_id, p_decision, btrim(p_approver), p_reason);
  update actions
  set status = case when p_decision = 'approve' then 'approved' else 'rejected' end
  where action_id = p_action_id;
end;
$$;

-- Gate RPC 2: execute an approved action exactly once. A repeated call with the
-- same action returns the original result and writes nothing (idempotency_key
-- unique constraint is the backstop). APPROVAL_MODE is structurally required:
-- there is no path here that executes without an approval row.
create or replace function execute_approved_action(p_action_id text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_action actions%rowtype;
  v_issue_id text;
  v_approved integer;
begin
  select * into v_action from actions where action_id = p_action_id for update;
  if not found then
    raise exception 'action not found';
  end if;
  if v_action.status = 'executed' then
    select issue_id into v_issue_id from issues where action_id = v_action.action_id limit 1;
    return jsonb_build_object('status', 'executed', 'duplicate', true, 'issue_id', v_issue_id);
  end if;
  if v_action.status <> 'approved' then
    raise exception 'action % is not approved (status: %)', p_action_id, v_action.status;
  end if;
  select count(*) into v_approved from approvals
  where action_id = p_action_id and decision = 'approve';
  if v_approved = 0 then
    raise exception 'action % has no approval record', p_action_id;
  end if;

  if v_action.action_type = 'log_issue' then
    v_issue_id := 'issue-' || substr(md5(random()::text || clock_timestamp()::text), 1, 8);
    insert into issues (issue_id, finding_id, action_id, title, description, wcag_criterion, severity, status)
    values (v_issue_id,
            v_action.payload_json->>'finding_id',
            v_action.action_id,
            v_action.payload_json->>'title',
            v_action.payload_json->>'description',
            v_action.payload_json->>'wcag_criterion',
            v_action.payload_json->>'severity',
            'open');
  elsif v_action.action_type = 'close_issue' then
    v_issue_id := v_action.payload_json->>'issue_id';
    update issues set status = 'closed' where issue_id = v_issue_id;
  else
    raise exception 'unknown action_type: %', v_action.action_type;
  end if;

  update actions set status = 'executed', executed_at = now() where action_id = p_action_id;
  return jsonb_build_object('status', 'executed', 'duplicate', false, 'issue_id', v_issue_id);
end;
$$;

-- Public dashboard clients can read only. Approval/execute are mediated by the
-- approve-action Edge Function, which checks APPROVER_PASSCODE server-side.
revoke execute on function approve_action(text, text, text, text) from anon;
revoke execute on function execute_approved_action(text) from anon;
revoke insert, update, delete on actions, issues from anon;
