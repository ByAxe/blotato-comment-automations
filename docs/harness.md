# How to work with coding agents

Start with [AGENTS.md](../AGENTS.md) and the acceptance scenario the task affects. Give the agent one completion condition, the inputs it needs, and the actions it may take. Use the workflow skill for a state change and the reconciliation skill when a provider might already have accepted a send. A small change can fit in one task with one check. Split work when different parts can proceed from a shared contract and each result can be checked on its own. Read the integrated diff and observed output after the last edit. Save the check command, result and any remaining gap with the change so another session can pick it up.

## Checks on code

Enable the optional Git checks from a clone with `sh scripts/install-hooks.sh`. The installer preserves an existing hooks path and declines to replace active native hooks.

- Pre-commit runs `git diff --cached --check` against the index. It catches Git-detected whitespace errors and conflict markers in staged edits.
- Pre-push typechecks the pushed commit snapshot with `tsc --noEmit` when a branch update changes TypeScript, the compiler configuration or package inputs. New branches and unavailable remote commits compare against an empty tree. The check uses the checkout’s installed dependencies. Run `npm ci` when those dependencies change. Commits with only documentation updates on an existing branch skip the compiler. Push checks use no database.

Use the [project setup](../README.md) for runtime checks. `npm test` builds the code and verifies the runner and the database-backed behavior. `npm run e2e` isolates the HTTP flow, including restart and the recording adapter. The [CI workflow](../.github/workflows/verify.yml) runs the portable suite with PostgreSQL 17. When changing a transition, verify the changed behavior through the closest existing fixture. If the change can fail differently during replay, concurrency, expiry or restart, exercise that condition. A simulated receipt proves the behavior of the test flow with that adapter. Live provider acceptance requires evidence from the connected provider.

## Checks on agent decisions

Run a case from [the evaluation prompts](../evals/cases.md) in a fresh session with the minimum project context. Use a local snapshot and synthetic records for recovery cases. If a tool exposes live services, keep them outside the evaluator's scope. Keep the rubric out of the working snapshot. Read the response against [the scoring criteria](../evals/rubric.md) and inspect any resulting diff or tool activity. The cases exercise a proposed timing change, an inconclusive send investigation and an evidence-backed operator handoff. They are separate from the runtime tests, which are the check on executed application behavior.

In the first evaluation, three fresh sessions each received one case and its skill. All three met the rubric on the supplied snapshots. E1 located the deadline writer and proposed checks that separated new waits from stored deadlines. E2 kept the uncertain send held. E3 supplied the guarded command and required refreshed evidence after a stale attempt. The sessions used no shared database or connected provider. This run had no skill-free comparison.

Use these cases when revising a relevant skill or investigating a decision that keeps going wrong. For an important change, compare responses with and without the skill on the same case and inputs. Report which decisions held and which failed. A fresh-session result covers that case and session. Several runs would be needed to estimate reliability across sessions or models.
