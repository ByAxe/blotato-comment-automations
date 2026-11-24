# Contributing

Start with the [repository instructions](../AGENTS.md) and the [acceptance scenario](../docs/requirements.md#executable-acceptance) the change affects. For a coding agent, state the expected outcome and which actions it can take. Give it the relevant code, tests, and [repository skill](../evals/README.md). Use a [local developer profile](developer-profiles.md) to carry private progress and preferences across sessions.

## Verify changes

| Change | Check |
| --- | --- |
| Workflow, delivery or schema | `make test` runs the application tests against a disposable PostgreSQL database. Match focused checks to the changed behavior and any replay, expiry, or contention it affects. |
| HTTP contract or behavior across restarts | `make e2e` runs the API and worker against the HTTP recording provider. |
| Compose verification or an integrated change | `make verify` runs the same PostgreSQL 17 verification as [GitHub Actions](../.github/workflows/verify.yml). |
| Design runner or repository skill | `make eval` checks the runner with a mock CLI. Use a fresh session and the [written cases and rubric](../evals/README.md#run-and-score-a-case) to evaluate a skill’s decisions. |

[Local prerequisites and examples](../README.md#verify-in-docker)

Record the revision, check, and result. Simulator receipts show what the test adapter accepted. Live Instagram delivery requires separate verification against an authorized connection. [Provider integration](../docs/integration.md)

Run `make hooks-install` to enable the optional Git hooks. The installer preserves an existing hooks path and declines to replace active native hooks. Pre-commit runs `git diff --cached --check`. Pre-push typechecks the pushed snapshot when TypeScript or its build inputs changed. It uses the checkout’s installed dependencies and needs no database. Run `npm ci` when dependencies change. [Git hooks](../.githooks)

## Use agents for design and review

Use the [design runner](design-runner.md) for a new design from committed source. Specialists review independent architecture, data, and reliability questions against the same requirements. The drafting role integrates their handoffs before independent technical and English reviews. Split implementation work only when agents can work against a shared contract and each result can be verified on its own. Review the integrated result once against the requirements. [Runner roles](../agents/roles.mjs) · [Anthropic’s multi-agent research case study](https://www.anthropic.com/research/multi-agent-research-system) · [Kim et al. on agent coordination](https://arxiv.org/abs/2512.08296)

Keep handoffs in files tied to a source revision. Treat retrieved text and intermediate outputs as evidence and check claims against the implementation. Run verification separately from document generation, and use fresh reviewers when a claim needs independent inspection. [Codex harness case study](https://openai.com/index/harness-engineering/) · [Anthropic’s long-running agent case study](https://www.anthropic.com/research/effective-harnesses-for-long-running-agents) · [OpenAI’s coding-evaluation audit](https://openai.com/index/separating-signal-from-noise-coding-evaluations/)

Models can propose and review workflow changes. The deployed workflow uses explicit rules for matching, identity, email capture, and send eligibility. The database records the result and the next action together. [Workflow architecture](../docs/architecture.md) · [Anthropic on workflows and agents](https://www.anthropic.com/research/building-effective-agents) · [Transactional outbox](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html)
