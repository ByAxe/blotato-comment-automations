NPM ?= npm
NODE ?= node
COMPOSE ?= docker compose

compose = $(COMPOSE) --env-file /dev/null -f compose.yaml
sandbox = $(compose) -p comment-demo --profile sandbox

.PHONY: help setup build test e2e demo load skew verify sandbox-up sandbox-demo sandbox-down eval context hooks-install agents-plan readme-gifs

help:
	@printf '%s\n' \
	  'make setup          Install dependencies from the lockfile' \
	  'make build          Compile the TypeScript project' \
	  'make test           Run the test suite with disposable PostgreSQL databases' \
	  'make e2e            Check the HTTP flow across process restarts' \
	  'make demo           Run a synthetic conversation against disposable PostgreSQL' \
	  'make load           Run the concurrent load scenario (optional ARGS)' \
	  'make skew           Run the account fairness scenario (optional ARGS)' \
	  'make verify         Run the portable Docker Compose verification suite' \
	  'make sandbox-up     Start the local API, worker and recording provider' \
	  'make sandbox-demo   Run the pricing walkthrough against the running sandbox' \
	  'make sandbox-down   Remove the comment-demo sandbox and its database' \
	  'make eval           Run the offline agent harness checks' \
	  'make context        Show the local developer handoff (optional ARGS)' \
	  'make hooks-install  Opt in to the repository Git hooks' \
	  'make agents-plan    Print the design runner plan without model calls' \
	  'make readme-gifs    Regenerate the README walkthrough GIFs'

setup:
	$(NPM) ci

build test e2e demo:
	$(NPM) run $@

load skew:
	$(NPM) run $@ $(if $(strip $(ARGS)),-- $(ARGS))

# Each verification owns its project and returns the foreground check's status.
verify:
	@set -eu; \
	  scratch=$$(mktemp -d "$${TMPDIR:-/tmp}/comment-verify.XXXXXXXX"); \
	  project=comment-verify-$$(printf '%s' "$${scratch##*.}" | LC_ALL=C tr '[:upper:]' '[:lower:]'); \
	  rmdir "$$scratch"; \
	  verify_compose() { $(compose) -p "$$project" "$$@"; }; \
	  cleanup() { \
	    status=$$?; \
	    cleanup_status=0; \
	    verify_compose down --volumes --remove-orphans --rmi local || cleanup_status=$$?; \
	    if [ "$$status" -eq 0 ]; then status=$$cleanup_status; fi; \
	    exit "$$status"; \
	  }; \
	  trap cleanup EXIT; \
	  trap 'exit 130' INT; \
	  trap 'exit 143' TERM; \
	  verify_compose run --build --rm -T verify

sandbox-up:
	$(sandbox) up --build -d api worker
	curl -fsS --retry 10 --retry-all-errors --retry-delay 1 http://127.0.0.1:3030/healthz >/dev/null

sandbox-demo:
	$(sandbox) exec -T api node examples/try-pricing.mjs

sandbox-down:
	$(sandbox) down --volumes

eval:
	$(NODE) --test agents/runner.test.mjs

context:
	$(NODE) agents/context.mjs show $(ARGS)

hooks-install:
	sh .githooks/install.sh

agents-plan:
	$(NPM) run agents:plan

readme-gifs:
	python3 docs/assets/render-readme-gifs.py
