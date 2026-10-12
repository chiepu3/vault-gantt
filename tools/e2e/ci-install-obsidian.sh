#!/usr/bin/env bash
# tools/e2e/ci-install-obsidian.sh
# GitHub Actions ONLY (disposable runner; refuses to run elsewhere).
# Installs the pinned official Obsidian AppImage so that Chromium's sandbox
# stays ENABLED: SHA256-verified, extracted by root into a root-owned,
# non-user-writable tree, and only the bundled chrome-sandbox helper is made
# root:root 4755 (the official Chromium SUID sandbox setup). The app itself is
# later run as the ordinary runner user; logs go to a separate writable dir.
set -euo pipefail

if [[ "${GITHUB_ACTIONS:-}" != "true" ]]; then
  echo "refusing to run outside GitHub Actions" >&2
  exit 1
fi

VERSION="1.13.4"
SHA256="b66f01d2a6afbb6b7abd93e4b5c6602645f03c16ad2d6dd49fd5a90dddd87872"
URL="https://github.com/obsidianmd/obsidian-releases/releases/download/v${VERSION}/Obsidian-${VERSION}.AppImage"
ROOT="/var/lib/obsidian-e2e"
DEST="${ROOT}/${VERSION}"
BIN="${DEST}/squashfs-root/obsidian"
HELPER="${DEST}/squashfs-root/chrome-sandbox"
LOGS="${RUNNER_TEMP}/e2e-cache"

# Root-owned install dir; nothing user-writable (and no actions/cache) is trusted.
sudo rm -rf "${ROOT}"
sudo install -d -m 0755 -o root -g root "${ROOT}" "${DEST}"

# Download as the runner user into scratch, then move into the root-owned dir
# BEFORE hashing so the verified bytes cannot be swapped afterwards.
scratch="$(mktemp -d)"
curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 \
  --output "${scratch}/Obsidian.AppImage" "${URL}"
sudo install -m 0755 -o root -g root "${scratch}/Obsidian.AppImage" "${DEST}/Obsidian.AppImage"
rm -rf "${scratch}"
echo "${SHA256}  ${DEST}/Obsidian.AppImage" | sudo sha256sum --check --strict -

# FUSE-free extraction (root, into the root-owned dir), then lock the tree.
(cd "${DEST}" && sudo ./Obsidian.AppImage --appimage-extract >/dev/null)
sudo chown -R root:root "${DEST}"
# Ordinary runner needs read + traverse/execute (X: dirs and already-executable
# files only), never write.
sudo chmod -R a+rX,go-w "${DEST}"
sudo chown root:root "${HELPER}"
sudo chmod 4755 "${HELPER}"

# Verify: helper owner/mode, no nosuid mount, every parent root-owned and not
# group/other-writable, and nothing in the tree non-root-owned or writable.
test "$(stat -c '%U:%G %a' "${HELPER}")" = "root:root 4755" \
  || { echo "bad chrome-sandbox owner/mode" >&2; exit 1; }
if findmnt -no OPTIONS -T "${HELPER}" | tr ',' '\n' | grep -qx nosuid; then
  echo "install path is on a nosuid mount" >&2
  exit 1
fi
dir="$(dirname "${BIN}")"
while :; do
  read -r owner mode < <(stat -c '%U %a' "${dir}")
  echo "parent ${dir}: ${owner} ${mode}"
  [[ "${owner}" == "root" ]] || { echo "${dir} not root-owned" >&2; exit 1; }
  (( (8#${mode} & 8#022) == 0 )) || { echo "${dir} is group/other-writable" >&2; exit 1; }
  (( (8#${mode} & 8#005) == 8#005 )) || { echo "${dir} not other-readable/traversable" >&2; exit 1; }
  [[ "${dir}" == "/" ]] && break
  dir="$(dirname "${dir}")"
done
if [[ -n "$(find "${DEST}" \( ! -user root -o ! -group root \) -print -quit)" ]]; then
  echo "non-root-owned entry in install tree" >&2
  exit 1
fi
if [[ -n "$(find "${DEST}" ! -type l -perm /022 -print -quit)" ]]; then
  echo "group/other-writable entry in install tree" >&2
  exit 1
fi
test -x "${BIN}"

# Runner-writable logs/artifacts, separate from the locked install tree.
mkdir -p "${LOGS}/logs"
{
  echo "E2E_OBSIDIAN_BIN=${BIN}"
  echo "E2E_CACHE_DIR=${LOGS}"
} >> "${GITHUB_ENV}"
echo "Obsidian ${VERSION} installed with sandbox helper root:root 4755"
