.DEFAULT_GOAL := help
.PHONY: help install test check build build-worker run run-image dev-worker migrate deploy version

help: ## List developer and deployment commands
	@awk 'BEGIN {FS = ":.*## "} /^[a-z-]+:.*## / {printf "%-16s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install the locked npm dependencies
	npm ci

test: ## Run automated tests
	npm test

check: ## Verify the app, both runtimes, and Chromium
	npm run verify
	npm run test:browser

build: ## Build a local linux/amd64 image (optional IMAGE=name:tag)
	@version=$$(node -p 'require("./package.json").version') && \
	commit=$$(git rev-parse --verify --quiet HEAD 2>/dev/null || printf unknown) && \
	docker build --pull --platform linux/amd64 --build-arg "LOOKOUT_VERSION=$$version" \
		--build-arg "SOURCE_COMMIT=$$commit" --tag "$${IMAGE:-lookout:$$version}" .

build-worker: ## Compile and inspect the Worker offline
	npm run deploy -- --dry-run

run: ## Run the standalone app with the external monitor file
	npm start

run-image: ## Run an image with LOOKOUT_CONFIG, optional IMAGE, ENV_FILE, PORT and VOLUME
	@image=$${IMAGE:-}; \
	if [ -z "$$image" ]; then \
		version=$$(node -p 'require("./package.json").version') || exit 1; \
		image=lookout:$$version; \
	fi; \
	config=$${LOOKOUT_CONFIG:-/etc/lookout/monitors.json} && \
	case "$$config" in /*) ;; *) config="$$(pwd)/$$config" ;; esac && \
	test -f "$$config" || { printf '%s\n' 'Set LOOKOUT_CONFIG to an existing monitor JSON file.' >&2; exit 1; }; \
	set --; \
	if [ -n "$${ENV_FILE:-}" ]; then set -- --env-file "$$ENV_FILE"; fi; \
	docker run --rm --platform linux/amd64 "$$@" \
		--publish "127.0.0.1:$${PORT:-8787}:8787" \
		--mount "type=bind,source=$$config,target=/etc/lookout/monitors.json,readonly" \
		--mount "type=volume,source=$${VOLUME:-lookout-data},target=/var/lib/lookout" \
		-e LOOKOUT_HOST=0.0.0.0 -e PORT=8787 -e LOOKOUT_CONFIG=/etc/lookout/monitors.json \
		-e LOOKOUT_DB=/var/lib/lookout/lookout.sqlite "$$image"

dev-worker: ## Run Wrangler with local D1 and a scheduled test endpoint
	npm run dev:worker

migrate: ## Apply migrations to the configured Cloudflare D1 database
	npm run deploy -- --migrate-only

deploy: ## Deploy to the configured Cloudflare Worker
	npm run deploy

version: ## Update the manifest and lockfile version with V=x.y.z
	node scripts/ci/version.mjs set "$${V:-}"
