ALTER TABLE outbox
    ADD COLUMN sent_at timestamptz,
    ADD CONSTRAINT outbox_lease_fields CHECK (
        (lease_token IS NOT NULL) = (status = 'leased')
        AND (lease_until IS NOT NULL) = (status = 'leased')
    ),
    ADD CONSTRAINT outbox_receipt_fields CHECK (
        (provider_id IS NOT NULL) = (status = 'sent')
        AND (sent_at IS NOT NULL) = (status = 'sent')
    );

CREATE INDEX outbox_send_deadline ON outbox (send_before, id) WHERE status = 'pending';
CREATE INDEX outbox_due ON outbox (available_at, id) WHERE status = 'pending';
CREATE INDEX outbox_held ON outbox (id) WHERE status = 'uncertain';
CREATE INDEX outbox_expiring ON outbox (lease_until, id) WHERE status = 'leased';

-- A provider rate limit applies to sibling actions on the same connected account.
CREATE TABLE delivery_cooldowns (
    tenant_id text NOT NULL,
    account_id text NOT NULL,
    until_at timestamptz NOT NULL,
    PRIMARY KEY (tenant_id, account_id),
    FOREIGN KEY (tenant_id, account_id) REFERENCES automations ON DELETE CASCADE
);

CREATE TABLE delivery_reconciliations (
    action_id uuid NOT NULL REFERENCES outbox ON DELETE CASCADE,
    attempt integer NOT NULL CHECK (attempt > 0),
    operator_id text NOT NULL,
    evidence text NOT NULL,
    decision text NOT NULL CHECK (decision IN ('confirmed_sent', 'confirmed_absent', 'abandon')),
    quiescence_evidence text,
    CHECK ((quiescence_evidence IS NOT NULL) = (decision = 'confirmed_absent')),
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (action_id, attempt)
);
