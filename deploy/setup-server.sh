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

echo "==> Firewall: only SSH and the website are reachable"
ufw allow OpenSSH >/dev/null
ufw allow 80 >/dev/null
ufw allow 443 >/dev/null
ufw --force enable >/dev/null

echo "==> Getting the code"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only
else
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
if [ -n "${MOLLIE_API_KEY:-}" ]; then
  echo "==> Online payments: Mollie key set (${MOLLIE_API_KEY%%_*} mode)"
  set_env MOLLIE_API_KEY "$MOLLIE_API_KEY"
fi
if [ -n "${GMAIL_USER:-}" ] && [ -n "${GMAIL_APP_PASSWORD:-}" ]; then
  echo "==> Email: sending and reading through the Google mailbox $GMAIL_USER"
  set_env SMTP_HOST smtp.gmail.com
  set_env SMTP_PORT 587
  set_env SMTP_SECURE false
  set_env SMTP_USER "$GMAIL_USER"
  set_env SMTP_PASS "$GMAIL_APP_PASSWORD"
  set_env MAIL_FROM "Gamer Xperience <$GMAIL_USER>"
  set_env OWNER_EMAIL "$GMAIL_USER"
  set_env IMAP_HOST imap.gmail.com
  set_env IMAP_PORT 993
  set_env IMAP_SECURE true
  set_env IMAP_USER "$GMAIL_USER"
  set_env IMAP_PASS "$GMAIL_APP_PASSWORD"
fi

echo "==> Building and starting the site (the first time takes a few minutes)"
docker compose up -d --build

DOMAIN=$(grep '^DOMAIN=' .env | cut -d= -f2)
cat <<DONE

Done. The site is starting at:  https://$DOMAIN
(The first visit can take a minute while the HTTPS certificate is fetched.)

Create your admin login:
  cd $DIR && docker compose exec app npm run create-admin -- you@example.com
DONE
