#!/usr/bin/env bash
# Sync the Logarium backend, apply migrations, and restart its user service.
set -euo pipefail

# The ssh alias, not a raw IP: the server's LAN address changes now and then and
# ~/.ssh/config is the one place that should know it.
SERVER="${LOGARIUM_SERVER:-homeserver}"
# Key-based auth, so a deploy never stops to ask for a password. Point
# LOGARIUM_SSH_KEY somewhere else (or at a nonexistent path) to fall back to
# whatever ~/.ssh/config says for the host.
SSH_KEY="${LOGARIUM_SSH_KEY:-$HOME/.ssh/homeserver_ed25519}"
DEST="LOG_Project/"
SERVICE="logarium-api"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# BatchMode makes a missing/rejected key fail immediately instead of dropping to
# a password prompt half way through a deploy.
SSH_OPTS=(-o BatchMode=yes)
if [[ -f "$SSH_KEY" ]]; then
  SSH_OPTS+=(-i "$SSH_KEY" -o IdentitiesOnly=yes)
else
  echo "No SSH key at $SSH_KEY, falling back to ~/.ssh/config for $SERVER" >&2
fi

# Same options for rsync's transport, quoted so a path with spaces survives.
RSYNC_SSH="ssh"
for opt in "${SSH_OPTS[@]}"; do
  RSYNC_SSH+=" $(printf '%q' "$opt")"
done

echo "Syncing backend to $SERVER:~/$DEST"
rsync -avz --delete -e "$RSYNC_SSH" \
  --exclude-from="$HERE/deploy-exclude.txt" \
  "$HERE/backend/" "$SERVER:$DEST"

echo "Installing the $SERVICE user service"
ssh "${SSH_OPTS[@]}" "$SERVER" 'mkdir -p "$HOME/.config/systemd/user"'
rsync -avz -e "$RSYNC_SSH" "$HERE/logarium-api.service" \
  "$SERVER:.config/systemd/user/$SERVICE.service"

echo "Checking the backend and applying database migrations"
ssh "${SSH_OPTS[@]}" "$SERVER" bash -s -- "$DEST" "$SERVICE" <<'REMOTE'
set -euo pipefail
dest="$1"
service="$2"
cd "$HOME/$dest"
"$HOME/venv-LOG/bin/python" -m compileall -q .
"$HOME/venv-LOG/bin/python" -m alembic upgrade head
chmod 600 .env
systemctl --user daemon-reload
systemctl --user enable "$service" >/dev/null
systemctl --user restart "$service"
systemctl --user is-active "$service"
for _ in {1..20}; do
  if curl --fail --silent http://127.0.0.1:8001/ >/dev/null; then
    exit 0
  fi
  sleep 0.5
done
systemctl --user status "$service" --no-pager -n 30
echo "The API did not pass its health check." >&2
exit 1
REMOTE

echo "Done."
