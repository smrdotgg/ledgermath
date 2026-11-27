#!/usr/bin/env bash
# Deploys a built site to the Vercel project as prebuilt files: Vercel builds
# nothing. SITE_DIR is what `bun run build` writes (site/dist/client), or the
# workflow's artifact `site`. The script lays it out as the Build Output API
# asks, .vercel/output/static plus a config.json (version 3, with the routes
# that serve each documentation page's Markdown at its address to a request
# that says Accept: text/markdown: site/deploy/vercel-config.ts, which needs
# Bun, and refuses a site with a documentation page that has no Markdown), in
# a new temporary directory, and runs `vercel deploy --prebuilt` on it.
#
#     site/deploy/deploy.sh SITE_DIR production|preview
#
# production moves ledgermath.com to the new deployment; preview does not.
# Needs VERCEL_TOKEN, VERCEL_ORG_ID and VERCEL_PROJECT_ID in the environment
# (the CLI reads all three from there), and `bun install --frozen-lockfile`
# run in site/deploy, which installs the CLI at the version package.json pins.
# Needs jq, and checks for it before the CLI runs. Prints the deployment as
# one JSON object on stdout (its `url`, `target`, `inspectorUrl` and so on);
# the CLI's progress goes to stderr. `vercel deploy --json` prints that object
# bare, or under `deployment` when it takes itself to be run by an AI agent;
# the script prints it the same way either way. It fails, saying what was
# wrong, unless the CLI printed exactly one JSON value holding one deployment
# object whose readyState is READY and whose url is an absolute https:// URL.
# .github/workflows/site.yml runs it.
set -euo pipefail

if [ $# -ne 2 ] || { [ "$2" != production ] && [ "$2" != preview ]; }; then
  echo "usage: $0 SITE_DIR production|preview" >&2
  exit 2
fi
site=$1
target=$2
for name in VERCEL_TOKEN VERCEL_ORG_ID VERCEL_PROJECT_ID; do
  if [ -z "${!name:-}" ]; then
    echo "$name is not set" >&2
    exit 2
  fi
done
if [ ! -f "$site/index.html" ]; then
  echo "$site/index.html is missing: build the site first (bun run build in site/)" >&2
  exit 2
fi

if ! command -v jq >/dev/null; then
  echo "jq is not installed: it reads the CLI's result" >&2
  exit 2
fi

here=$(cd "$(dirname "$0")" && pwd)
vercel=$here/node_modules/.bin/vercel
if [ ! -x "$vercel" ]; then
  echo "the Vercel CLI is not installed: run bun install --frozen-lockfile in site/deploy" >&2
  exit 2
fi

if ! command -v bun >/dev/null; then
  echo "bun is not installed: it writes the deployment's routes (vercel-config.ts)" >&2
  exit 2
fi

out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
mkdir -p "$out/.vercel/output"
cp -R "$site/." "$out/.vercel/output/static"
bun "$here/vercel-config.ts" "$site" >"$out/.vercel/output/config.json"

args=(deploy "$out" --prebuilt --yes --json)
if [ "$target" = production ]; then
  args+=(--prod)
fi
# The deployment records the commit of the checkout this script is in, which is
# the one the site was built from: the runs workflow's site job checks out main
# as it is when the job starts, which can be newer than the run's GITHUB_SHA.
# GITHUB_SHA only when the script is not in a git checkout.
commit=$(git -C "$here" rev-parse HEAD 2>/dev/null || true)
commit=${commit:-${GITHUB_SHA:-}}
if [ -n "$commit" ]; then
  args+=(--meta "commit=$commit")
fi
VERCEL_TELEMETRY_DISABLED=1 "$vercel" "${args[@]}" >"$out/deployment.json"
# Slurped, so two objects, or none, are caught rather than each passed on.
jq -s '
  def fail(why): "vercel deploy --json printed \(why)\n" | halt_error(2);
  if length != 1 then fail("\(length) JSON values, not one deployment object") else .[0] end
  | if type == "object" and has("deployment") then .deployment else . end
  | if type != "object" then fail("something other than a deployment object: \(tojson)")
    elif .readyState != "READY" then fail("a deployment whose readyState is \(.readyState | tojson), not READY")
    elif (.url | type) != "string" or (.url | test("^https://[^/?#@\\s]+(/|$)") | not) then
      fail("a deployment whose url \(.url | tojson) is not an absolute https:// URL")
    else . end
' "$out/deployment.json"
