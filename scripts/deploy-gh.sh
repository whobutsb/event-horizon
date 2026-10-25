#!/usr/bin/env bash
# scripts/deploy-gh.sh — publish this repo to GitHub and deploy it to Pages.
#
#   ./scripts/deploy-gh.sh              # -> https://<GH_OWNER>.github.io/event-horizon/
#   GH_OWNER=me REPO_NAME=bh ./scripts/deploy-gh.sh
#
# Needs an authenticated gh CLI:  gh auth login -h github.com --git-protocol https --web
# Scopes: `repo` is enough. No `workflow` scope needed, because Pages publishes
# the `gh-pages` branch built here rather than a committed Actions workflow.
# (Prefer CI deploys? Copy docs/github-pages-workflow.yml to
# .github/workflows/pages.yml — that push does require the `workflow` scope.)
#
# Idempotent: creates the repo only if missing, pushes main, rebuilds and replaces
# the gh-pages branch, points Pages at it, then waits for the site to answer.
set -euo pipefail

OWNER="${GH_OWNER:-whobutsb}"
REPO="${REPO_NAME:-event-horizon}"
DESC="Event Horizon — real-time procedural black hole: null-geodesic raymarching, Doppler beaming, lensed starfield. Three.js + Vite, zero assets. Built by a local LLM."
GIT_NAME="${GIT_AUTHOR_NAME:-whobutsb}"
GIT_MAIL="${GIT_AUTHOR_EMAIL:-whobutsb@users.noreply.github.com}"
URL="https://${OWNER}.github.io/${REPO}/"
cd "$(dirname "$0")/.."

# ---------------------------------------------------------------- auth ------
if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI not found — install from https://cli.github.com" >&2
  exit 1
fi
if ! LOGIN=$(gh api user --jq .login 2>/dev/null); then
  cat >&2 <<'MSG'
gh is not authenticated (the stored token was rejected).

  gh auth login -h github.com --git-protocol https --web
  # or with a token that has the `repo` scope:
  export GH_TOKEN=github_pat_... && ./scripts/deploy-gh.sh
MSG
  exit 1
fi
echo "authenticated as ${LOGIN}"
gh auth setup-git >/dev/null 2>&1 || true   # https pushes via gh's credential helper

# ---------------------------------------------------------------- repo ------
if gh repo view "${OWNER}/${REPO}" >/dev/null 2>&1; then
  echo "repo ${OWNER}/${REPO} exists"
else
  echo "creating public repo ${OWNER}/${REPO}"
  gh repo create "${OWNER}/${REPO}" --public --description "${DESC}" --source=. --remote=origin
fi
git remote get-url origin >/dev/null 2>&1 || \
  git remote add origin "https://github.com/${OWNER}/${REPO}.git"

if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -q -m "Update before deploy $(date -u +%Y-%m-%dT%H:%MZ)"
fi
BRANCH=$(git rev-parse --abbrev-ref HEAD)
echo "pushing ${BRANCH} -> origin"
git push -q -u origin "${BRANCH}"

# ------------------------------------------------------- build + publish ----
echo "building..."
npm run build >/dev/null

echo "publishing dist/ to the gh-pages branch..."
TMP=$(mktemp -d)
if git clone -q "https://github.com/${OWNER}/${REPO}.git" "$TMP" 2>/dev/null &&
   git -C "$TMP" rev-parse --verify -q origin/gh-pages >/dev/null 2>&1; then
  git -C "$TMP" checkout -q -B gh-pages origin/gh-pages
else
  rm -rf "$TMP"; TMP=$(mktemp -d)
  git init -q -b gh-pages "$TMP"
  git -C "$TMP" remote add origin "https://github.com/${OWNER}/${REPO}.git"
fi
# Wipe everything but .git and copy fresh. Do NOT rely on rsync's size+mtime
# quick-check here: two builds of this app produce an index.html of identical
# size, and a freshly cloned worktree has the same mtime as the build output, so
# rsync happily "skips" it and Pages ends up serving HTML that points at the
# previous build's hashed assets — a blank page with 404s.
find "$TMP" -mindepth 1 -maxdepth 1 -not -name '.git' -exec rm -rf {} +
cp -R "$PWD/dist/." "$TMP/"
: > "$TMP/.nojekyll"                       # skip Jekyll processing on Pages
git -C "$TMP" add -A
git -C "$TMP" -c "user.name=${GIT_NAME}" -c "user.email=${GIT_MAIL}" \
  commit -q -m "Deploy $(git rev-parse --short HEAD) $(date -u +%Y-%m-%dT%H:%MZ)" || echo "  (no change to publish)"
git -C "$TMP" push -q -f origin gh-pages
rm -rf "$TMP"

# --------------------------------------------------------------- pages ------
# a 404 comes back as a JSON body, so match on the shape we actually expect
PAGES=$(gh api "repos/${OWNER}/${REPO}/pages" --jq 'select(.build_type) | .build_type + ":" + (.source.branch // "-")' 2>/dev/null || echo "")
if [ -z "$PAGES" ]; then
  echo "enabling Pages from the gh-pages branch..."
  gh api -X POST "repos/${OWNER}/${REPO}/pages" --input - >/dev/null <<JSON
{ "source": { "branch": "gh-pages", "path": "/" } }
JSON
elif [ "$PAGES" != "legacy:gh-pages" ]; then
  echo "pointing Pages at gh-pages (was ${PAGES})..."
  gh api -X PUT "repos/${OWNER}/${REPO}/pages" --input - >/dev/null <<JSON || \
  gh api -X POST "repos/${OWNER}/${REPO}/pages" --input - >/dev/null <<JSON2
{ "source": { "branch": "gh-pages", "path": "/" } }
JSON
{ "source": { "branch": "gh-pages", "path": "/" } }
JSON2
else
  echo "Pages already builds gh-pages"
fi
gh repo edit "${OWNER}/${REPO}" --homepage "${URL}" >/dev/null 2>&1 || true

# ---------------------------------------------------------------- verify ----
echo "waiting for ${URL} ..."
for _ in $(seq 1 60); do
  HTML=$(curl -sfL "${URL}?cb=${RANDOM}$RANDOM" || true)
  # the served HTML must reference assets that actually exist: a stale index.html
  # over fresh assets looks like a black screen with 404s, not like a failed deploy
  refs=$(printf '%s' "$HTML" | grep -oE 'assets/[A-Za-z0-9._-]+' | sort -u)
  ok=1
  [ -n "$refs" ] || ok=0
  printf '%s' "$HTML" | grep -qi "Event Horizon" || ok=0
  for a in $refs; do
    code=$(curl -s -o /dev/null -w '%{http_code}' "${URL}${a}")
    [ "$code" = "200" ] || { echo "  ${a} -> ${code}, waiting..."; ok=0; }
  done
  if [ "$ok" = 1 ]; then
    echo
    echo "✅ live: ${URL}"
    printf '   assets served: %s\n' "$(printf '%s' "$refs" | tr '\n' ' ')"
    echo "   repo:  https://github.com/${OWNER}/${REPO}"
    exit 0
  fi
  sleep 5
done
echo "published, but ${URL} is not answering yet — Pages can take another minute; re-run or check Settings → Pages." >&2
exit 1
