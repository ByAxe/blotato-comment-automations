-- The queue serves one claim per turn to each eligible tenant/account pair.
CREATE SEQUENCE delivery_turn_seq AS bigint;

CREATE TABLE delivery_lanes (
    tenant_id text NOT NULL,
    account_id text NOT NULL,
    pending_count bigint NOT NULL CHECK (pending_count >= 0),
    turn bigint NOT NULL DEFAULT nextval('delivery_turn_seq'),
    PRIMARY KEY (tenant_id, account_id),
    FOREIGN KEY (tenant_id, account_id) REFERENCES automations ON DELETE CASCADE
);
CREATE INDEX delivery_active_turn ON delivery_lanes (turn) WHERE pending_count > 0;

-- Keep the lane key beside the due time so looking up its head takes one index seek.
ALTER TABLE outbox ADD COLUMN tenant_id text, ADD COLUMN account_id text;
UPDATE outbox o SET tenant_id = r.tenant_id, account_id = r.account_id FROM runs r WHERE r.id = o.run_id;
ALTER TABLE outbox ALTER COLUMN tenant_id SET NOT NULL, ALTER COLUMN account_id SET NOT NULL;
CREATE INDEX outbox_lane_due ON outbox (tenant_id, account_id, available_at, id) WHERE status = 'pending';
DROP INDEX outbox_due;

CREATE FUNCTION bind_outbox_lane() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.run_id IS DISTINCT FROM OLD.run_id THEN
        RAISE EXCEPTION 'An action cannot move between runs';
    END IF;
    SELECT r.tenant_id, r.account_id INTO STRICT NEW.tenant_id, NEW.account_id
    FROM runs r WHERE r.id = NEW.run_id;
    RETURN NEW;
END $$;
CREATE TRIGGER bind_outbox_lane BEFORE INSERT OR UPDATE OF run_id, tenant_id, account_id ON outbox
FOR EACH ROW EXECUTE FUNCTION bind_outbox_lane();

INSERT INTO delivery_lanes (tenant_id, account_id, pending_count)
SELECT tenant_id, account_id, COUNT(*) FROM outbox WHERE status = 'pending'
GROUP BY tenant_id, account_id ORDER BY min(available_at), tenant_id, account_id;

CREATE FUNCTION count_pending_actions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND (NEW.status = 'pending') = (OLD.status = 'pending') THEN
        RETURN NULL;
    END IF;
    IF TG_OP <> 'DELETE' AND NEW.status = 'pending' THEN
        INSERT INTO delivery_lanes AS lane (tenant_id, account_id, pending_count)
        VALUES (NEW.tenant_id, NEW.account_id, 1)
        ON CONFLICT (tenant_id, account_id) DO UPDATE SET
            pending_count = lane.pending_count + 1,
            turn = CASE WHEN lane.pending_count = 0 THEN EXCLUDED.turn ELSE lane.turn END;
    ELSIF TG_OP <> 'INSERT' AND OLD.status = 'pending' THEN
        UPDATE delivery_lanes SET pending_count = pending_count - 1
        WHERE tenant_id = OLD.tenant_id AND account_id = OLD.account_id;
    END IF;
    RETURN NULL;
END $$;
CREATE TRIGGER count_pending_actions AFTER INSERT OR UPDATE OF status OR DELETE ON outbox
FOR EACH ROW EXECUTE FUNCTION count_pending_actions();
