# How to work with coding agents

Start with [AGENTS.md](../AGENTS.md) and the acceptance scenario the task affects. Give the agent a completion condition, the inputs it needs, and the actions it may take. Choose a [repository skill](../evals/README.md) that fits the task. Split work when different parts can proceed from a shared contract and each result can be checked on its own. Review the integrated diff and the check output. Record the command, result and any remaining gap with the change. Developers can keep their own next step in an [opt-in local handoff](developer-context.md).

## Checks on code

Enable the optional Git checks from a clone with `make hooks-install` or `sh scripts/install-hooks.sh`. The installer preserves an existing hooks path and declines to replace active native hooks.

- Pre-commit runs `git diff --cached --check` against the index. It catches Git-detected whitespace errors and conflict markers in staged edits.
- Pre-push typechecks the pushed commit snapshot with `tsc --noEmit` when a branch update changes TypeScript, the compiler configuration or package inputs. New branches and unavailable remote commits compare against an empty tree. The check uses the checkout’s installed dependencies. Run `npm ci` when those dependencies change. Commits with only documentation updates on an existing branch skip the compiler. Push checks use no database.

Use the [project setup](../README.md) for runtime checks. `make test` (`npm test`) builds the code and verifies the runner and the database-backed behavior. `make e2e` (`npm run e2e`) isolates the HTTP flow, including restart and the recording adapter. `make verify` runs the Compose verification suite used by [CI](../.github/workflows/verify.yml) with PostgreSQL 17. When changing a transition, verify the changed behavior through the closest existing fixture. If the change can fail differently during replay, concurrency, expiry or restart, exercise that condition. A simulated receipt establishes the behavior of the test flow with that adapter. Live provider acceptance requires evidence from the connected provider.

## Checks on agent decisions

`make eval` runs the offline agent harness tests with a mock CLI. To evaluate decisions, prepare one fresh session and score its answer using the [case index and rubric](../evals/README.md). Use the written cases when changing a skill or investigating a decision that repeatedly goes wrong.

In the initial evaluation, three fresh sessions met the original E1–E3 rubric on synthetic snapshots. A separate fresh session met E4's criteria using only the fairness skill and a small source snapshot. It identified the idle return in the proposed claim, traced quiet-account dispatch in the current query and found the existing locked-head regression. These sessions inspected supplied inputs. They ran no database checks and had no skill-free comparison.
