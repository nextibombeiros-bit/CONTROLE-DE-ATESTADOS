#!/usr/bin/env bash
set -euo pipefail

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Execute este script dentro de um repositorio Git." >&2
  exit 1
fi

BRANCH="${1:-$(git rev-parse --abbrev-ref HEAD)}"
COMMIT_MESSAGE="${GIT_COMMIT_MESSAGE:-update $(date +'%Y-%m-%d %H:%M:%S')}"

if [[ -n "${GITHUB_REPO_URL:-}" ]]; then
  if git remote get-url origin >/dev/null 2>&1; then
    git remote set-url origin "$GITHUB_REPO_URL"
  else
    git remote add origin "$GITHUB_REPO_URL"
  fi
fi

git add -A

if ! git diff --cached --quiet; then
  git commit -m "$COMMIT_MESSAGE"
else
  echo "Nenhuma alteracao nova para commit."
fi

if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  : "${GITHUB_USERNAME:?Defina GITHUB_USERNAME para usar GITHUB_TOKEN.}"
  : "${GITHUB_REPO_URL:?Defina GITHUB_REPO_URL para usar GITHUB_TOKEN.}"
  AUTH_URL="https://${GITHUB_USERNAME}:${GITHUB_TOKEN}@${GITHUB_REPO_URL#https://}"
  git push "$AUTH_URL" "HEAD:${BRANCH}"
else
  git push -u origin "$BRANCH"
fi
