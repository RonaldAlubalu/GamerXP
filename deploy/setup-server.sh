#!/bin/sh
# Sets up a fresh Ubuntu server and starts the site. Run as root:
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

echo "==> Installing Docker, git and the firewall"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q docker.io docker-compose-v2 git ufw openssl curl

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

echo "==> Building and starting the site (the first time takes a few minutes)"
docker compose up -d --build

DOMAIN=$(grep '^DOMAIN=' .env | cut -d= -f2)
cat <<DONE

Done. The site is starting at:  https://$DOMAIN
(The first visit can take a minute while the HTTPS certificate is fetched.)

Create your admin login:
  cd $DIR && docker compose exec app npm run create-admin -- you@example.com
DONE
