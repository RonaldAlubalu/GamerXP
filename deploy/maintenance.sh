#!/bin/sh
# Weekly maintenance, run as root on the server: makes a database backup, installs
# system updates, refreshes the site's containers and writes a report to
# /opt/gamerxp/reports. The report is also printed, so the caller can keep it.
set -u
cd /opt/gamerxp
export DEBIAN_FRONTEND=noninteractive
STAMP=$(date +%Y-%m-%d_%H%M)
mkdir -p backups reports
REPORT="reports/$STAMP.md"
PROBLEMS=0
note() { echo "$*" >> "$REPORT"; }
problem() { PROBLEMS=$((PROBLEMS + 1)); note "- **PROBLEM:** $*"; }

note "# Weekly maintenance $(date '+%Y-%m-%d %H:%M %Z')"
note ""
note "Server: $(hostname), $(. /etc/os-release && echo "$PRETTY_NAME"), kernel $(uname -r)"
note ""

# 1. Backup first, so there is always a copy from before the updates.
note "## Backup"
BACKUP="backups/gamerxp-$STAMP-weekly.sql.gz"
if docker compose exec -T db pg_dump -U gamerxp --no-owner gamerxp | gzip > "$BACKUP.tmp" && [ "$(gzip -dc "$BACKUP.tmp" | head -c 2000 | wc -c)" -gt 100 ]; then
  mv "$BACKUP.tmp" "$BACKUP"
  note "- Written: \`$BACKUP\` ($(du -h "$BACKUP" | cut -f1))"
else
  rm -f "$BACKUP.tmp"
  problem "the database backup failed. Updates were skipped."
fi
# Weekly backups are kept for about three months; the daily ones clean up after themselves.
find backups -name 'gamerxp-*-weekly.sql.gz' -mtime +92 -delete
# Straight to the second server over SSH, when that is set up (deploy/backup-peer.sh).
if [ -f /etc/backup-peer.conf ] && [ "$PROBLEMS" -eq 0 ]; then
  if /usr/local/sbin/backup-peer push > /tmp/gamerxp-push.log 2>&1; then
    note "- Copy on the second server: yes"
  else
    problem "the backup could not be copied to the second server: $(tail -n 1 /tmp/gamerxp-push.log)"
  fi
fi
note "- Backups on this server: $(find backups -name 'gamerxp-*.sql.gz' | wc -l), $(du -sh backups | cut -f1) in total"
note ""

if [ "$PROBLEMS" -eq 0 ]; then
  # 2. System updates.
  note "## System updates"
  if apt-get update -q >/dev/null 2>&1; then
    UPGRADES=$(apt-get -s -o Dpkg::Options::=--force-confold upgrade | grep -c '^Inst ' || true)
    if apt-get -y -q -o Dpkg::Options::=--force-confold upgrade > /tmp/gamerxp-upgrade.log 2>&1; then
      note "- Packages updated: $UPGRADES"
      apt-get -y -q autoremove >/dev/null 2>&1 || true
    else
      problem "installing system updates failed: $(tail -n 2 /tmp/gamerxp-upgrade.log | tr '\n' ' ')"
    fi
  else
    problem "could not fetch the list of system updates."
  fi
  note ""

  # 3. Newer database and web server images. The site itself is updated by the deploys.
  note "## Site"
  if docker compose pull -q db caddy backup >/dev/null 2>&1 && docker compose up -d >/dev/null 2>&1; then
    note "- Containers refreshed"
  else
    problem "refreshing the site's containers failed."
  fi
  docker image prune -f >/dev/null 2>&1 || true
fi

# 4. Is the site healthy?
HEALTHY=no
for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
  if docker compose exec -T app wget -qO- http://127.0.0.1:3000/api/health 2>/dev/null | grep -q '"ok"'; then
    HEALTHY=yes
    break
  fi
  sleep 5
done
if [ "$HEALTHY" = yes ]; then note "- Site answers: yes"; else problem "the site does not answer after the maintenance."; fi
note ""
note "## State"
note "- Disk: $(df -h / | awk 'NR==2 {print $3 " used of " $2 " (" $5 ")"}')"
note "- Memory: $(free -m | awk 'NR==2 {print $3 " MB used of " $2 " MB"}')"
note "- Containers:"
docker compose ps --format '  - {{.Service}}: {{.Status}}' >> "$REPORT" 2>/dev/null || true
if [ -f /var/run/reboot-required ]; then
  note "- Restart: needed for the updates; the server restarts in one minute and the site comes back by itself."
  shutdown -r +1 >/dev/null 2>&1 || true
else
  note "- Restart: not needed"
fi
note ""
if [ "$PROBLEMS" -eq 0 ]; then note "**Result: all good.**"; else note "**Result: $PROBLEMS problem(s), see above.**"; fi

# Keep half a year of reports.
ls -1t reports/*.md 2>/dev/null | tail -n +27 | xargs -r rm -f
cat "$REPORT"
echo "LATEST_BACKUP=$BACKUP"
[ "$PROBLEMS" -eq 0 ]
