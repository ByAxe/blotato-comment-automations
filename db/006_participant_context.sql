-- Existing versions and runs collect no participant content.
ALTER TABLE automation_versions
    ADD COLUMN collect_participant_context boolean NOT NULL DEFAULT false,
    ADD COLUMN returning_email_prompt text,
    ADD CHECK (returning_email_prompt IS NULL OR
        (collect_participant_context AND char_length(btrim(returning_email_prompt)) BETWEEN 1 AND 2000));

ALTER TABLE runs
    ADD COLUMN collect_participant_context boolean NOT NULL DEFAULT false,
    ADD UNIQUE (tenant_id, account_id, participant_id, id);

CREATE TABLE participant_interactions (
    tenant_id text NOT NULL,
    account_id text NOT NULL,
    participant_id text NOT NULL,
    run_id uuid NOT NULL,
    event_id text NOT NULL,
    occurred_at timestamptz NOT NULL,
    excerpt text NOT NULL CHECK (char_length(excerpt) <= 500 AND position('@' in excerpt) = 0),
    pending_prompt boolean NOT NULL DEFAULT false,
    PRIMARY KEY (tenant_id, account_id, event_id),
    FOREIGN KEY (tenant_id, account_id, participant_id, run_id)
        REFERENCES runs (tenant_id, account_id, participant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, account_id, event_id)
        REFERENCES inbox (tenant_id, account_id, event_id) ON DELETE CASCADE
);

CREATE INDEX participant_interactions_timeline ON participant_interactions
    (tenant_id, account_id, participant_id, occurred_at DESC, event_id COLLATE "C" DESC);
CREATE INDEX participant_interactions_expiry ON participant_interactions (occurred_at);
CREATE INDEX participant_interactions_staged ON participant_interactions (run_id) WHERE pending_prompt;
