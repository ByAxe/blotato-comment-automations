-- One row per UTC run-start date and published version of an account's rule.
CREATE INDEX runs_funnel_cohort_idx ON runs
    (tenant_id, account_id, ((started_at AT TIME ZONE 'UTC')::date), version_id);

CREATE VIEW automation_daily_funnel AS
SELECT
    r.tenant_id,
    r.account_id,
    r.version_id,
    (r.started_at AT TIME ZONE 'UTC')::date AS cohort_day,
    count(*) AS started_runs,
    count(*) FILTER (WHERE reply.status = 'sent') AS public_replies_sent,
    count(*) FILTER (WHERE prompt.status = 'sent') AS email_prompts_sent,
    count(link.id) AS emails_captured,
    count(*) FILTER (WHERE link.status = 'sent') AS links_sent,
    count(*) FILTER (
        WHERE 'uncertain' IN (reply.status, prompt.status, link.status)
    ) AS uncertain_runs,
    count(*) FILTER (WHERE r.state = 'failed') AS failed_runs,
    count(*) FILTER (WHERE r.state = 'expired') AS expired_runs
FROM runs AS r
LEFT JOIN outbox AS reply ON reply.run_id = r.id AND reply.kind = 'comment_reply'
LEFT JOIN outbox AS prompt ON prompt.run_id = r.id AND prompt.kind = 'email_prompt'
LEFT JOIN outbox AS link ON link.run_id = r.id AND link.kind = 'link_dm'
GROUP BY r.tenant_id, r.account_id, r.version_id, cohort_day;
