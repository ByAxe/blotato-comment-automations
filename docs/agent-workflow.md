# Rebuild the design with agents

The reviewer can read the service design and run its tests without a model account. To generate another design from a particular revision, use the eight-role runner. It captures the committed application source and sends a different engineering question to each specialist. The writer combines their handoffs into one document. A technical reviewer and an English editor read that draft independently before the final revision.

| Role | Inputs from other roles | Output |
| --- | --- | --- |
| Requirements | Product requirements | Observable acceptance conditions |
| Architecture | Requirements | UML 2 component and sequence views |
| Data | Requirements | Relational classes and association multiplicities |
| Reliability | Requirements | State transitions, failure windows and recovery |
| Draft | Requirements, architecture, data and reliability | Combined design |
| Technical review | Draft | Corrections grounded in the source snapshot |
| English review | Draft | Wording changes that preserve technical meaning |
| Final design | Draft and both reviews | `design.md` |

## Run it

Node.js 22 and Git suffice for the offline plan and transport tests. Live generation uses an authenticated Codex CLI. The command-line options were checked with version 0.171.0.

```sh
node agents/run.mjs plan
node --test agents/runner.test.mjs
```

From a committed checkout, pick an unused output directory whose parent exists. The runner sends source to the configured model provider. A fresh run uses eight calls with at most two in flight by default. Set `--jobs` between one and four to change the bound.

GPT-6.2 Sol extracts requirements and edits English. GPT-6.2 Astra handles architecture, data, reliability, design synthesis and technical review. Run `node agents/run.mjs plan` to see the model for each role. Accounts with different model access can select available IDs with `--fast-model` and `--reasoning-model`. A single `--model MODEL_ID` overrides both. The CLI exposes its model catalog through `codex debug models`. A provider rejection identifies the failed role so the operator can resume with the appropriate model.

```sh
node agents/run.mjs run /tmp/blotato-design-01
```

Read `design.md` in the output directory. Check its worked Instagram example, numbered requirements, UML 2 component, sequence, state machine and class diagrams, failure handling and test evidence against the source commit. Each role leaves its own Markdown handoff and a JSON receipt with its requested model, dependencies and digests. The root `run.json` records the source commit, included files, CLI version, model routes, deadline and job limit.

Each model call has a 600-second deadline. Override it with `--timeout-seconds` from 1 to 3600. At the deadline the runner stops its own CLI process and treats the role as failed. If a role fails, the runner finishes its running siblings and exits with an error. To continue after a failure or interruption, use a fresh destination.

```sh
node agents/run.mjs resume /tmp/blotato-design-01 /tmp/blotato-design-02
```

A resume requires the same source commit. The runner reuses a handoff when its Markdown still matches its recorded digest and the input signature matches the new request. That signature covers the product requirements, role instructions, source context, predecessor text, CLI version and role-specific model. A change to an upstream answer reruns the stages that consume it. Starting a new run forces fresh model calls.

## Evidence and permissions

Each role receives the [product requirements](../agents/problem.md), its [role instructions](../agents/roles.mjs) and the handoffs listed in the dependency table. Engineering roles also receive a snapshot of the tracked README, package metadata, implementation, SQL, tests, scripts, design documentation and PlantUML sources at HEAD. The snapshot omits agent-process documentation. The English reviewer sees the product requirements and draft. Working-tree edits enter the snapshot after a commit.

The parent process starts each CLI in a fresh temporary directory with a read-only sandbox. It passes source through standard input, ignores user configuration, and disables shell execution, connected apps, plugins, browser use, web search and nested agents. The parent saves outputs in the selected directory. Application changes, database checks and GitHub publication belong to the separate implementation workflow.

A receipt records which inputs produced a handoff. The technical reviewer can cite a SQL constraint or a test definition from the snapshot. A passing test claim needs separate execution evidence. The offline transport tests use a mock CLI to exercise a failed role, reuse, corruption detection, context isolation and the concurrency bound.
