#!/bin/bash
# deb/rpm must register hiwd (and its alias hiveward) for headless hosts where the in-app installer cannot run.
# The shim resolves the app relative to itself, so a symlink works; discover the install directory
# because electron-builder sanitizes productName.
set -e

is_owned_link() {
  local link="$1" name="$2"
  [ -L "$link" ] || return 1
  local link_target candidate candidate_target
  link_target="$(readlink -f -- "$link" 2>/dev/null || true)"
  for candidate in "/opt/HiveWard/resources/bin/$name" "/opt/hiveward/resources/bin/$name"; do
    candidate_target="$(readlink -f -- "$candidate" 2>/dev/null || true)"
    if [ -n "$candidate_target" ] && [ "$link_target" = "$candidate_target" ]; then
      return 0
    fi
  done
  return 1
}

for dir in /opt/HiveWard /opt/hiveward; do
  sandbox="$dir/chrome-sandbox"
  if [ -f "$sandbox" ]; then
    # Why: packaged Linux installs must leave Chromium's sandbox helper usable
    # on hosts where unprivileged user namespaces are unavailable.
    chmod 4755 "$sandbox" || true
  fi

  if [ -x "$dir/resources/bin/hiwd" ]; then
    for name in hiwd hiveward; do
      shim="$dir/resources/bin/$name"
      link="/usr/bin/$name"
      # Only manage our own symlink; never clobber an unrelated /usr/bin command.
      if [ -x "$shim" ] && { { [ ! -e "$link" ] && [ ! -L "$link" ]; } || is_owned_link "$link" "$name"; }; then
        ln -sfn -- "$shim" "$link"
      fi
    done
    break
  fi
done

exit 0
