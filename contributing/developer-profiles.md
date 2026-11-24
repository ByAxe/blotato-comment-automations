# Pick up your work in another session

A developer profile saves your current objective, next step and review preferences across checkouts of this project on the same account. You can start work with an empty profile. The service, CI and the eight-role design runner all work without one.

## Leave a handoff

From the repository root, start the profile command before entering your handoff text.

```sh
node agents/context.mjs set --handoff-stdin --detail concise --review-focus reliability
```

When the running command prompts for input, type or paste a JSON object like this one. Press Enter after the closing brace, then press Ctrl+D on the empty line to save.

```json
{
  "objective": "Check how an expired delivery lease is recovered",
  "nextStep": "Read the outbox recovery test, then compare it with the worker query"
}
```

Keep notes out of shell command arguments and shell history. To use an existing private local file, redirect it into the command on standard input.

```sh
node agents/context.mjs set --handoff-stdin < /path/to/local/handoff.json
```

Open another terminal or session on the same account and read the handoff locally.

```sh
node agents/context.mjs show
```

To bring it into an ordinary coding-agent chat, explicitly ask the agent to run the show command and use the result. Its output, including the objective and next step, will then be visible in that chat. Read it in your own terminal when you want to keep the text local. Avoid putting credentials or customer data in a handoff.

To update a single handoff field, run `node agents/context.mjs set --handoff-stdin` again and enter one key. The other fields keep their values.

```json
{"nextStep":"Run the isolated recovery check"}
```

The context CLI uses the profile named `default`. Add `--profile NAME` to `set` and `show` to keep a second handoff, for example one for an ongoing data review. To change only writing detail or review focus, pass `--detail` or `--review-focus` to `set`.

## Choose what the design runner receives

```sh
node agents/run.mjs run /tmp/design-01 --profile default
node agents/run.mjs resume /tmp/design-01 /tmp/design-02 --profile default
```

The runner reads a profile only when you supply its name. It translates two optional settings into fixed role instructions.

| Option | Values | Effect |
| --- | --- | --- |
| `--detail` | `concise`, `expanded`, `default` | Requests compact explanations or additional rationale and examples from the roles. |
| `--review-focus` | `reliability`, `data`, `operations`, `default` | Directs the technical reviewer's attention to recovery, data integrity or operator diagnosis. |

Use `default` to clear an individual preference, or an empty string to clear a handoff field. Repository instructions, role requirements and permissions take precedence over personal preferences. The runner keeps the name, objective and next step out of model inputs, Markdown artifacts and receipts. It saves a digest of the selected non-default settings in `run.json`. The role signature also covers the instructions actually sent to that role. If your shared settings changed, start a new run or restore the original settings before resuming. Updating a private handoff permits reuse. Runs created without shared preferences, including older manifests, resume without a profile.

## Local storage

The helper uses `$XDG_CONFIG_HOME/blotato-comment-automations/NAME.json`, falling back to `~/.config/blotato-comment-automations/NAME.json`. It creates an owner-only directory and file on first write. The version 1 JSON contains `version`, `objective`, `nextStep`, `detail` and `reviewFocus`. Each handoff field holds up to 2,000 characters. The UTF-8 JSON provided on standard input can be up to 32 KiB. The helper reads the named file directly and never searches the machine for accounts or credentials.

Updates validate the current file and replacement before an atomic rename. Concurrent writers receive a busy error and can retry. If a writer is forcibly stopped and leaves a `NAME.json.lock` directory, confirm the update process has exited, then remove that lock directory and retry. The last completed profile remains readable. To discard a profile, delete its JSON file locally.
