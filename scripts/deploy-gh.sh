#!/usr/bin/env bash
# scripts/deploy-gh.sh — publish this repo to GitHub + enable Pages.
#
#   ./scripts/deploy-gh.sh                 # -> https://<GH_OWNER>.github.io/event-horizon/
#   GH_OWNER=me REPO_NAME=bh ./scripts/deploy-gh.sh
#
# Needs an authenticated gh CLI:  gh auth login -h github.com
# Idempotent: safe to re-run; it creates the repo only if missing, enables Pages
# only if missing, then pushes and waits for the deploy workflow.
set -euo pipefail

OWNER="${GH_OWNER:-whobutsb}"
REPO="${REPO_NAME:-event-horizon}"
DESC="Event Horizon — real-time procedural black hole: null-geodesic raymarching, Doppler beaming, lensed starfield. Three.js + Vite, no assets. Built by a local LLM."
cd "$(dirname "$0")/.."

if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI not found — install from https://cli.github.com" >&2
  exit 1
fi

if ! LOGIN=$(gh api user --jq .login 2>/dev/null); then
  cat >&2 <<'MSG'
gh is not authenticated (the stored token was rejected).

  gh auth login -h github.com          # interactive browser flow
  # or, with a fine-grained PAT that has repo + administration + Pages scope:
  export GH_TOKEN=github_pat_...       # then re-run this script

Scopes needed when using a classic token: repo, workflow (and write public key is not required).
MSG
  exit 1
fi
echo "authenticated as ${LOGIN}"
# let git push over https with gh's credential helper (no SSH keys needed)
gh auth setup-git >/dev/null 2>&1 || true
if [ "${LOGIN}" != "${OWNER}" ]; then
  echo "note: gh user '${LOGIN}' != GH_OWNER '${OWNER}' — publishing under '${OWNER}' if you have access" >&2
fi

# ---------------------------------------------------------------- repo ------
if gh repo view "${OWNER}/${REPO}" >/dev/null 2>&1; then
  echo "repo ${OWNER}/${REPO} already exists"
else
  echo "creating public repo ${OWNER}/${REPO}"
  # NOTE: gh has no --owner flag; the owner is part of the name argument
  gh repo create "${OWNER}/${REPO}" --public \
    --description "${DESC}" --source=. --remote=origin
fi

git remote get-url origin >/dev/null 2>&1 || git remote add origin \
  "https://github.com/${OWNER}/${REPO}.git"
if [ -z "$(git status --porcelain)" ] && [ -n "$(git log --oneline -1 2>/dev/null)" ]; then
  echo "nothing to commit"
else
  git add -A
  git commit -m "Publish: GitHub Actions Pages deploy" || true
fi
BRANCH=$(git rev-parse --abbrev-ref HEAD)
echo "pushing ${BRANCH} -> origin"
git push -u origin "${BRANCH}"

# --------------------------------------------------------------- pages ------
URL="https://${OWNER}.github.io/${REPO}/"
if gh api "repos/${OWNER}/${REPO}/pages" >/dev/null 2>&1; then
  echo "Pages already enabled"
else
  echo "enabling Pages (build type: workflow)"
  gh api -X POST "repos/${OWNER}/${REPO}/pages" -f build_type=workflow >/dev/null
fi
gh repo edit "${OWNER}/${REPO}" --homepage "${URL}" >/dev/null 2>&1 || true

# ------------------------------------------------------- wait for deploy ----
echo "waiting for the deploy workflow to finish..."
for _ in $(seq 1 20); do
  RUN_ID=$(gh api "repos/${OWNER}/${REPO}/actions/runs?per_page=1&event=push" \
    --jq '.workflow_runs[0].id // empty' 2>/dev/null || true)
  [ -n "${RUN_ID}" ] && break
  sleep 3
done
if [ -z "${RUN_ID:-}" ]; then
  echo "no workflow run showed up — check https://github.com/${OWNER}/${REPO}/actions" >&2
  exit 1
fi
echo "run: https://github.com/${OWNER}/${REPO}/actions/runs/${RUN_ID}"
gh run watch "${RUN_ID}" --exit-status >/dev/null && echo "workflow succeeded"

echo "waiting for ${URL} to serve..."
for _ in $(seq 1 40); do
  if curl -sfL "${URL}" | grep -qi "Event Horizon"; then
    echo
    echo "✅ live: ${URL}"
    echo "   share it: gh api repos/${OWNER}/${REPO} --jq .html_url"
    exit 0
  fi
  sleep 5
done
echo "the deploy succeeded but ${URL} is not answering yet — Pages can take another minute; retry in a moment." >&2
exit 1
