#!/bin/sh
# Sets up a fresh Ubuntu or Debian server and starts the site. Run as root:
#
#   sh setup-server.sh [domain]
#
# Without a domain the site gets a test address based on the server's IP
# (like 1-2-3-4.sslip.io), which works with HTTPS without changing any DNS.
# Running it again updates the code and restarts the site; .env is kept.
set -eu

DIR=/opt/gamerxp
REPO=https://github.com/RonaldAlubalu/GamerXP.git

if [ "$(id -u)" != 0 ]; then
  echo "Run this as root." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
if docker compose version >/dev/null 2>&1 && command -v ufw >/dev/null; then
  echo "==> Docker and the firewall are already installed"
else
  echo "==> Installing Docker, git and the firewall"
  apt-get update -q
  apt-get install -y -q git ufw openssl curl ca-certificates
  # Ubuntu has Docker with Compose in its own packages; elsewhere (Debian) use Docker's installer.
  if ! docker compose version >/dev/null 2>&1; then
    apt-get install -y -q docker.io docker-compose-v2 || true
  fi
  if ! docker compose version >/dev/null 2>&1; then
    curl -fsSL https://get.docker.com | sh
  fi
fi

# A small server needs swap space, or a busy moment can freeze it.
if [ -z "$(swapon --show --noheadings 2>/dev/null)" ] && [ ! -f /swapfile ]; then
  echo "==> Adding 2 GB of swap space"
  if fallocate -l 2G /swapfile 2>/dev/null && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile; then
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
  else
    rm -f /swapfile
    echo "    (could not add swap; continuing without)"
  fi
fi

echo "==> Firewall: only SSH and the website are reachable"
ufw allow OpenSSH >/dev/null
ufw allow 80 >/dev/null
ufw allow 443 >/dev/null
ufw --force enable >/dev/null

# The deploy from GitHub delivers the files itself; run by hand, this fetches them.
if [ "${FILES_DELIVERED:-}" = 1 ]; then
  echo "==> Using the files delivered by the deploy"
elif [ -d "$DIR/.git" ]; then
  echo "==> Getting the code"
  git -C "$DIR" pull --ff-only
else
  echo "==> Getting the code"
  git clone "$REPO" "$DIR"
fi
cd "$DIR"

if [ ! -f .env ]; then
  IP=$(curl -4 -fsS --max-time 10 https://api.ipify.org || hostname -I | awk '{print $1}')
  DOMAIN=${1:-$(echo "$IP" | tr . -).sslip.io}
  echo "==> Creating .env for $DOMAIN"
  cp .env.example .env
  chmod 600 .env
  PASSWORD=$(openssl rand -base64 32 | tr -d '/+=')
  sed -i "s|^DOMAIN=.*|DOMAIN=$DOMAIN|; s|^PUBLIC_URL=.*|PUBLIC_URL=https://$DOMAIN|; s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$PASSWORD|" .env
elif [ -n "${1:-}" ]; then
  echo "==> Switching to $1"
  sed -i "s|^DOMAIN=.*|DOMAIN=$1|; s|^PUBLIC_URL=.*|PUBLIC_URL=https://$1|" .env
fi

# Settings handed over by the deploy (GitHub secrets) go into .env.
set_env() {
  if grep -q "^$1=" .env; then
    sed -i "s|^$1=.*|$1=$2|" .env
  else
    echo "$1=$2" >> .env
  fi
}
# On the live site only a live key takes payments: a test key would let customers "pay" for nothing.
case "${MOLLIE_API_KEY:-}" in
  live_*) : ;;
  *) if [ "${MOLLIE_LIVE_ONLY:-}" = 1 ]; then MOLLIE_API_KEY=; set_env MOLLIE_API_KEY ""; echo "==> Online payments: off (no live Mollie key)"; fi ;;
esac
if [ -n "${MOLLIE_API_KEY:-}" ]; then
  echo "==> Online payments: Mollie key set (${MOLLIE_API_KEY%%_*} mode)"
  set_env MOLLIE_API_KEY "$MOLLIE_API_KEY"
fi
if [ -n "${EBOEKHOUDEN_TOKEN:-}" ]; then
  set_env EBOEKHOUDEN_TOKEN "$EBOEKHOUDEN_TOKEN"
fi
if [ -n "${GOOGLE_REVIEW_URL:-}" ]; then
  set_env GOOGLE_REVIEW_URL "$GOOGLE_REVIEW_URL"
fi
if [ -n "${GMAIL_USER:-}" ] && [ -n "${GMAIL_APP_PASSWORD:-}" ]; then
  echo "==> Email: sending and reading through the Google mailbox $GMAIL_USER"
  set_env SMTP_HOST smtp.gmail.com
  set_env SMTP_PORT 587
  set_env SMTP_SECURE false
  set_env SMTP_USER "$GMAIL_USER"
  set_env SMTP_PASS "$GMAIL_APP_PASSWORD"
  set_env MAIL_FROM "Gamer Xperience <${MAIL_ADDRESS:-$GMAIL_USER}>"
  set_env OWNER_EMAIL "${MAIL_ADDRESS:-$GMAIL_USER}"
  set_env IMAP_HOST imap.gmail.com
  set_env IMAP_PORT 993
  set_env IMAP_SECURE true
  set_env IMAP_USER "$GMAIL_USER"
  set_env IMAP_PASS "$GMAIL_APP_PASSWORD"
fi

# Backups to and from a second server (see docs/backup-between-servers.md).
if [ -n "${BACKUP_PEER_HOST:-}" ]; then
  echo "==> Backups: sending to $BACKUP_PEER_HOST every night"
  mkdir -p backups
  sh deploy/backup-peer.sh send "$BACKUP_PEER_HOST" "$DIR/backups" 'gamerxp-*.sql.gz' >/dev/null ||
    echo "::warning::Setting up the nightly backup copy failed; the site itself is not affected."
fi
if [ -n "${BACKUP_PEER_PUBKEY:-}" ]; then
  echo "==> Backups: accepting copies from the other server"
  sh deploy/backup-peer.sh receive "$BACKUP_PEER_PUBKEY" ||
    echo "::warning::Setting up receiving backups failed; the site itself is not affected."
fi
# Shown on the deploy's page in GitHub, so it can be passed to the other server.
if [ -n "${BACKUP_PEER_HOST:-}${BACKUP_PEER_PUBKEY:-}" ]; then
  echo "::notice title=Backup key of this server::$(sh deploy/backup-peer.sh key || echo 'could not be made')"
fi

if [ -n "${SITE_NOINDEX:-}" ]; then
  set_env SITE_NOINDEX "$SITE_NOINDEX"
fi
# A domain to take into use (SITE_DOMAIN). Until its DNS points here and its certificate works,
# the site keeps its current address and the new domain is only prepared.
CURRENT=$(grep '^DOMAIN=' .env | cut -d= -f2)
if [ -n "${SITE_DOMAIN:-}" ] && [ "$SITE_DOMAIN" != "$CURRENT" ]; then
  set_env EXTRA_DOMAINS "$SITE_DOMAIN, www.$SITE_DOMAIN"
fi

# The second site on this server (Gatra) is served from /srv/gatra/public. Its own repository puts
# the files there; the first time, the copy that used to travel with this site is moved over, so
# its test address keeps working.
mkdir -p /srv/gatra/public
if [ -z "$(ls -A /srv/gatra/public)" ] && [ -d "$DIR/gatra-site/public" ]; then
  cp -a "$DIR/gatra-site/public/." /srv/gatra/public/
fi

# The demo lives on demo.<the site's domain>, with a login of its own that the owner can look up
# in the real admin (Systeem). Its data is thrown away every night.
CUR_DOMAIN=$(grep '^DOMAIN=' .env | cut -d= -f2)
set_env DEMO_DOMAIN "demo.$CUR_DOMAIN"
if ! grep -q '^DEMO_ADMIN_PASSWORD=..' .env; then
  set_env DEMO_ADMIN_PASSWORD "$(openssl rand -base64 18 | tr -d '/+=')"
fi
chmod +x "$DIR/deploy/reset-demo.sh"
printf '%s\n' '# Fresh made-up customers in the demo, every night.' "30 3 * * * root $DIR/deploy/reset-demo.sh" > /etc/cron.d/gamerxp-demo

# The network the web server shares with Gatra's own containers.
docker network inspect gatra >/dev/null 2>&1 || docker network create gatra >/dev/null

if [ "${APP_IMAGE_LOADED:-}" = 1 ]; then
  echo "==> Starting the site with the version built by the deploy"
  docker compose up -d --no-build
else
  echo "==> Building and starting the site (this takes a few minutes)"
  docker compose up -d --build
fi
# Switch to the new domain once it really works, so the site is never left on a dead address.
if [ -n "${SITE_DOMAIN:-}" ] && [ "$SITE_DOMAIN" != "$CURRENT" ]; then
  MY_IP=$(curl -4 -fsS --max-time 10 https://api.ipify.org || true)
  # Ask a public DNS service: the server's own resolver can lag behind a fresh change.
  DNS_IP=$(curl -fsS --max-time 10 "https://dns.google/resolve?name=$SITE_DOMAIN&type=A" 2>/dev/null |
    grep -o '"data":"[0-9.]*"' | head -n 1 | cut -d'"' -f4 || true)
  [ -n "$DNS_IP" ] || DNS_IP=$(getent ahostsv4 "$SITE_DOMAIN" | awk '{print $1; exit}')
  if [ -z "$MY_IP" ] || [ "$DNS_IP" != "$MY_IP" ]; then
    echo "::notice title=$SITE_DOMAIN not in use yet::Its DNS points to ${DNS_IP:-nothing}, not to this server ($MY_IP). The site stays at https://$CURRENT. Point the A records here and deploy again."
  else
    echo "==> $SITE_DOMAIN points here; fetching its HTTPS certificate"
    docker compose restart caddy >/dev/null
    WORKS=0
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18; do
      sleep 5
      # Straight to this server, so a lagging resolver cannot send the test elsewhere.
      if curl -sS -o /dev/null --max-time 10 --resolve "$SITE_DOMAIN:443:127.0.0.1" "https://$SITE_DOMAIN/api/health" 2>/dev/null; then WORKS=1; break; fi
    done
    if [ "$WORKS" = 1 ]; then
      echo "==> Switching the site to https://$SITE_DOMAIN (the old address leads there)"
      set_env DOMAIN "$SITE_DOMAIN"
      set_env PUBLIC_URL "https://$SITE_DOMAIN"
      set_env EXTRA_DOMAINS "$CURRENT"
      docker compose up -d --no-build
      echo "::notice title=Site moved::The site now lives at https://$SITE_DOMAIN. https://$CURRENT leads there."
    else
      echo "::warning title=$SITE_DOMAIN has no certificate yet::Its DNS points here, but HTTPS does not work yet. Often an AAAA record still points elsewhere. The site stays at https://$CURRENT."
    fi
  fi
fi
# Old versions of the site would otherwise fill the disk.
docker image prune -f >/dev/null 2>&1 || true

DOMAIN=$(grep '^DOMAIN=' .env | cut -d= -f2)
cat <<DONE

Done. The site is starting at:  https://$DOMAIN
(The first visit can take a minute while the HTTPS certificate is fetched.)

Create your admin login:
  cd $DIR && docker compose exec app npm run create-admin -- you@example.com
DONE
