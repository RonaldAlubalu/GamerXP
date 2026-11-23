#!/bin/sh
# Two servers keeping a copy of each other's backups, directly over SSH.
# Works on Debian and Ubuntu. Run as root.
#
#   backup-peer.sh key
#       Print this server's public backup key (made on first use). Give it to the other server.
#   backup-peer.sh receive "<public key of the other server>"
#       Accept backups from the other server. They land in /home/backupdrop/incoming
#       and are removed after 35 days. The key can only add files there, nothing else.
#   backup-peer.sh send <host of the other server> <directory> [name pattern]
#       Send the newest backups in <directory> to the other server every night.
#   backup-peer.sh push
#       Send now (what the nightly job runs).
set -eu

KEY=/root/.ssh/backup_peer
CONF=/etc/backup-peer.conf
DROP_USER=backupdrop
INCOMING=/home/$DROP_USER/incoming
KEEP_DAYS=35

[ "$(id -u)" = 0 ] || { echo "Run this as root." >&2; exit 1; }

need() {
  for cmd in "$@"; do
    command -v "$cmd" >/dev/null 2>&1 && continue
    apt-get update -q >/dev/null
    DEBIAN_FRONTEND=noninteractive apt-get install -y -q rsync cron openssh-client python3 >/dev/null
    break
  done
}

make_key() {
  if [ ! -f "$KEY" ]; then
    install -m 700 -d /root/.ssh
    ssh-keygen -q -t ed25519 -N '' -C "backup-from-$(hostname)" -f "$KEY"
  fi
}

# Keeps a copy of this script in a fixed place, so the nightly job doesn't depend on where it was run from.
install_self() {
  [ "$(readlink -f "$0")" = /usr/local/sbin/backup-peer ] || install -m 755 "$0" /usr/local/sbin/backup-peer
}

case "${1:-}" in
  key)
    need ssh-keygen
    make_key
    cat "$KEY.pub"
    ;;

  receive)
    PUBKEY=${2:?Give the public key of the other server, in quotes.}
    case "$PUBKEY" in ssh-*\ *) ;; *) echo "That does not look like a public key (it should start with ssh-ed25519 or ssh-rsa)." >&2; exit 1 ;; esac
    need rsync cron python3
    RRSYNC=$(command -v rrsync || true)
    [ -n "$RRSYNC" ] || RRSYNC=/usr/share/doc/rsync/scripts/rrsync
    [ -f "$RRSYNC" ] || { echo "rrsync not found; install a newer rsync package." >&2; exit 1; }
    chmod +x "$RRSYNC" 2>/dev/null || true
    id "$DROP_USER" >/dev/null 2>&1 || useradd --create-home --shell /bin/sh "$DROP_USER"
    # No password login for this user, keys only.
    usermod -p '*' "$DROP_USER"
    install -d -m 750 -o "$DROP_USER" -g "$DROP_USER" "$INCOMING"
    install -d -m 700 -o "$DROP_USER" -g "$DROP_USER" "/home/$DROP_USER/.ssh"
    # restrict: no shell, no forwarding. rrsync -wo: the key may only write files into the incoming folder.
    printf 'command="%s -wo %s",restrict %s\n' "$RRSYNC" "$INCOMING" "$PUBKEY" > "/home/$DROP_USER/.ssh/authorized_keys"
    chown "$DROP_USER:$DROP_USER" "/home/$DROP_USER/.ssh/authorized_keys"
    chmod 600 "/home/$DROP_USER/.ssh/authorized_keys"
    printf '15 5 * * * root find %s -type f -mtime +%s -delete\n' "$INCOMING" "$KEEP_DAYS" > /etc/cron.d/backup-peer-clean
    echo "Ready to receive backups in $INCOMING (kept $KEEP_DAYS days)."
    ;;

  send)
    HOST=${2:?Give the address of the other server.}
    DIR=${3:?Give the directory with your backup files.}
    PATTERN=${4:-*}
    [ -d "$DIR" ] || { echo "$DIR is not a directory." >&2; exit 1; }
    need rsync cron ssh-keygen
    make_key
    install_self
    printf 'HOST=%s\nDIR=%s\nPATTERN=%s\n' "$HOST" "$DIR" "$PATTERN" > "$CONF"
    printf '40 4 * * * root /usr/local/sbin/backup-peer push >> /var/log/backup-peer.log 2>&1\n' > /etc/cron.d/backup-peer
    echo "Backups from $DIR go to $HOST every night at 04:40."
    echo "This server's public key, for the other server:"
    cat "$KEY.pub"
    ;;

  push)
    [ -f "$CONF" ] || { echo "Not set up yet: run 'backup-peer.sh send <host> <directory>' first." >&2; exit 1; }
    . "$CONF"
    # The three newest files; ones the other server already has are skipped quickly.
    FILES=$(find "$DIR" -maxdepth 1 -type f -name "$PATTERN" -printf '%T@ %p\n' | sort -rn | head -n 3 | cut -d' ' -f2-)
    [ -n "$FILES" ] || { echo "$(date '+%F %T') no backup files in $DIR" >&2; exit 1; }
    # The outcome is kept next to the backups, for whoever wants to show it (a status page).
    STATUS="$DIR/.backup-peer-status"
    echo "$FILES" | while IFS= read -r file; do
      if ! ERROR=$(rsync -t -e "ssh -i $KEY -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20" "$file" "$DROP_USER@$HOST:" 2>&1); then
        echo "fail $(date +%s) $HOST $(echo "$ERROR" | tail -n 1)" > "$STATUS"
        echo "$(date '+%F %T') could not send $(basename "$file") to $HOST: $ERROR" >&2
        exit 1
      fi
      echo "$(date '+%F %T') sent $(basename "$file") to $HOST"
    done
    echo "ok $(date +%s) $HOST" > "$STATUS"
    ;;

  *)
    sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
