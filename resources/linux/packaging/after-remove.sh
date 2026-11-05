#!/bin/bash
# Remove only our install-owned symlinks; preserve any unrelated /usr/bin/hiwd or /usr/bin/hiveward.
set -e

# RPM passes an instance count; dpkg passes the package lifecycle action.
case "${1-}" in
  0 | remove | purge) ;;
  *) exit 0 ;;
esac

for link in /usr/bin/hiwd /usr/bin/hiveward; do
  if [ -L "$link" ]; then
    target="$(readlink "$link" || true)"
    case "$target" in
      /opt/HiveWard/*|/opt/hiveward/*)
        rm -f "$link"
        ;;
    esac
  fi
done

exit 0
