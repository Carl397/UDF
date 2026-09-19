ALTER TABLE resident_reports
  ADD COLUMN c3_requirement text NOT NULL DEFAULT 'needs_assessment'
    CHECK (c3_requirement IN ('needs_assessment','required','not_required')),
  ADD COLUMN c3_reason text,
  ADD COLUMN reference_kind text NOT NULL DEFAULT 'service_provider'
    CHECK (reference_kind IN ('service_provider','c3'));
ALTER TABLE resident_report_events ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE resident_report_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id uuid NOT NULL REFERENCES resident_reports(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  instructions text CHECK (char_length(instructions) <= 4000),
  assignee_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  due_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','done','cancelled')),
  outcome text CHECK (char_length(outcome) <= 4000),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 0,
  request_id uuid NOT NULL,
  UNIQUE (report_id, request_id)
);
CREATE INDEX resident_report_tasks_report_idx ON resident_report_tasks(report_id, created_at, id);
CREATE INDEX resident_report_tasks_due_idx ON resident_report_tasks(due_at, id) WHERE status IN ('todo','in_progress');
CREATE INDEX resident_report_tasks_assignee_idx ON resident_report_tasks(assignee_id, status);
CREATE INDEX resident_report_c3_idx ON resident_reports(c3_requirement, reference_kind);
CREATE INDEX resident_report_councillor_idx ON resident_reports(councillor_user_id, created_at);

CREATE TABLE resident_report_task_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES resident_report_tasks(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  from_status text,
  to_status text NOT NULL,
  outcome text,
  assignee_id uuid REFERENCES users(id) ON DELETE SET NULL,
  due_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  request_id uuid NOT NULL,
  UNIQUE (task_id, request_id)
);
CREATE INDEX resident_report_task_events_task_idx ON resident_report_task_events(task_id, created_at, id);
