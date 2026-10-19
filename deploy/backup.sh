#!/bin/sh
# Dumps the database once a day and keeps the last $BACKUP_KEEP_DAYS days.
set -eu
mkdir -p /backups
while true; do
  file="/backups/gamerxp-$(date +%Y-%m-%d_%H%M).sql.gz"
  if pg_dump --no-owner | gzip > "$file.tmp"; then
    mv "$file.tmp" "$file"
    echo "Backup written: $file"
  else
    rm -f "$file.tmp"
    echo "Backup FAILED" >&2
  fi
  find /backups -name 'gamerxp-*.sql.gz' -mtime "+${BACKUP_KEEP_DAYS:-14}" -delete
  sleep 86400
done
