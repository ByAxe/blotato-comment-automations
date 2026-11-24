CREATE TABLE automations (
    tenant_id text NOT NULL,
    account_id text NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    current_version_id uuid,
    PRIMARY KEY (tenant_id, account_id)
);

CREATE TABLE automation_versions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id text NOT NULL,
    account_id text NOT NULL,
    revision integer NOT NULL CHECK (revision > 0),
    keyword text NOT NULL,
    public_reply text NOT NULL,
    email_prompt text NOT NULL,
    link_url text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (tenant_id, account_id) REFERENCES automations,
    UNIQUE (tenant_id, account_id, revision),
    UNIQUE (tenant_id, account_id, id)
);

ALTER TABLE automations ADD FOREIGN KEY (tenant_id, account_id, current_version_id)
    REFERENCES automation_versions (tenant_id, account_id, id);

CREATE TABLE inbox (
    tenant_id text NOT NULL,
    account_id text NOT NULL,
    event_id text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('comment', 'message')),
    object_id text NOT NULL,
    occurred_at timestamptz NOT NULL,
    received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, account_id, event_id),
    UNIQUE (tenant_id, account_id, kind, object_id)
);

CREATE TABLE runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id text NOT NULL,
    account_id text NOT NULL,
    participant_id text NOT NULL,
    comment_id text NOT NULL,
    comment_occurred_at timestamptz NOT NULL,
    response_object_id text,
    response_occurred_at timestamptz,
    version_id uuid NOT NULL,
    state text NOT NULL CHECK (state IN ('reply_pending','prompt_pending','waiting',
                                         'link_pending','completed','failed','expired')),
    started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    prompt_started_at timestamptz,
    expires_at timestamptz,
    finished_at timestamptz,
    FOREIGN KEY (tenant_id, account_id, version_id)
        REFERENCES automation_versions (tenant_id, account_id, id),
    UNIQUE (tenant_id, account_id, comment_id),
    CHECK ((response_object_id IS NULL) = (response_occurred_at IS NULL)),
    CHECK ((prompt_started_at IS NULL) = (expires_at IS NULL)),
    CHECK (expires_at > prompt_started_at),
    CHECK ((state IN ('completed','failed','expired')) = (finished_at IS NOT NULL))
);

CREATE UNIQUE INDEX runs_one_active_conversation
    ON runs (tenant_id, account_id, participant_id)
    WHERE state IN ('reply_pending','prompt_pending','waiting','link_pending');
CREATE INDEX runs_wait_deadline ON runs (expires_at, id) WHERE state = 'waiting';

-- Inbound DM text never enters the ledger. Hold only the first qualifying address
-- while a prompt is in flight. A definitive send failure discards it.
CREATE TABLE buffered_emails (
    run_id uuid PRIMARY KEY REFERENCES runs ON DELETE CASCADE,
    object_id text NOT NULL,
    email text NOT NULL,
    occurred_at timestamptz NOT NULL,
    received_at timestamptz NOT NULL
);

CREATE TABLE leads (
    run_id uuid PRIMARY KEY REFERENCES runs ON DELETE CASCADE,
    email text NOT NULL,
    captured_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE outbox (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id uuid NOT NULL REFERENCES runs ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('comment_reply','email_prompt','link_dm')),
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','leased','sent','uncertain','failed')),
    send_before timestamptz NOT NULL,
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    lease_token uuid,
    lease_until timestamptz,
    first_attempt_at timestamptz,
    provider_id text,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (run_id, kind)
);
