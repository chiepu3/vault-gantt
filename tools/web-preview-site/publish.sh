#!/usr/bin/env bash
# Force-pushes <site dir> as a single orphan commit to gh-pages (skips if the tree is unchanged).
# Usage: GITHUB_TOKEN=... GITHUB_REPOSITORY=o/r publish.sh <site dir>
set -euo pipefail
site=$(realpath "$1")
url="https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"
work=$(mktemp -d)
cd "$work"
git init -q -b gh-pages
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
cp -a "$site"/. .
git add -A -f
git commit -q -m "Preview site for ${GITHUB_SHA:-local}"
new_tree=$(git rev-parse 'HEAD^{tree}')
old_tree=""
if git fetch -q --depth 1 "$url" gh-pages 2>/dev/null; then old_tree=$(git rev-parse 'FETCH_HEAD^{tree}'); fi
if [ "$new_tree" = "$old_tree" ]; then echo "gh-pages unchanged; skipping push"; exit 0; fi
git push -q --force "$url" HEAD:refs/heads/gh-pages
echo "pushed gh-pages"
