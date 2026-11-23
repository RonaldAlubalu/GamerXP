# Backups between two servers

Two servers each keep a copy of the other's backups, sent directly from server to server over SSH. If one server is lost, its latest backups are still on the other one.

This page is the setup for the team that runs the second server. The Gamer Xperience side is already set up.

## How it works

- Every night at 04:40 each server sends its three newest backup files to the other one with `rsync` over SSH. Files the other side already has are skipped.
- Each server has a separate user, `backupdrop`, that only receives. Incoming files land in `/home/backupdrop/incoming` and are removed after 35 days.
- Each server has its own SSH key for sending (`/root/.ssh/backup_peer`). On the receiving side that key is limited to **adding files to the incoming folder**: no shell, no port forwarding, no reading, changing or deleting what is already there. A compromised server therefore cannot read or wipe the other server's copies.
- Nothing passes through a third party. The only thing the two teams exchange is each server's address and **public** key.

Everything is done by one script, [`deploy/backup-peer.sh`](../deploy/backup-peer.sh). It works on Debian and Ubuntu and needs root. It installs `rsync` and `cron` if they are missing.

## Details of the Gamer Xperience server

| | |
|---|---|
| Address | `37.97.128.88` |
| Receiving user | `backupdrop` |
| Public backup key | `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJsUfQ+reQ8AjCvcHVkIzZaQ3zlcyFQttUKU9mMJ8eFT backup-from-cloud.example.com` |
| SSH port | 22 |

## Setup on your server

Run these as root.

**1. Get the script**

```sh
curl -fsSL https://raw.githubusercontent.com/RonaldAlubalu/GamerXP/claude/gamerxp-backend-migration-ew43zk/deploy/backup-peer.sh -o /usr/local/sbin/backup-peer
chmod +x /usr/local/sbin/backup-peer
```

Read it before you run it; it is about a hundred lines.

**2. Accept backups from the Gamer Xperience server**

```sh
backup-peer receive "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJsUfQ+reQ8AjCvcHVkIzZaQ3zlcyFQttUKU9mMJ8eFT backup-from-cloud.example.com"
```

This creates the `backupdrop` user, the incoming folder and the nightly clean-up. From the next night on, Gamer Xperience backups arrive in `/home/backupdrop/incoming` as `gamerxp-<date>.sql.gz`.

**3. Send your own backups to the Gamer Xperience server**

Point it at the folder where your backups are written. The optional third argument is a file name pattern.

```sh
backup-peer send 37.97.128.88 /path/to/your/backups '*.sql.gz'
```

It prints your server's public key. **Send that one line, and your server's address, to Ronald.** He adds it on the Gamer Xperience side (as the GitHub secret `BACKUP_PEER_PUBKEY` plus a deploy). Until then your nightly push is refused, which is harmless.

To see the key again later: `backup-peer key`.

**4. Test**

After the key has been added on the other side:

```sh
backup-peer push
```

It should print one `sent <file> to 37.97.128.88` line per file. The nightly runs are logged in `/var/log/backup-peer.log`.

## Good to know

- **Firewall:** each server must be able to reach the other on SSH (port 22). If you limit SSH by source address, allow `37.97.128.88`.
- **Disk space:** you keep 35 days of the other side's backups. The Gamer Xperience database backups are small (well under 100 MB each).
- **Personal data:** the backups contain customers' names and contact details. Keep `/home/backupdrop/incoming` readable by root and `backupdrop` only (the script sets this), and don't copy the files elsewhere.
- **Only complete files:** send finished backup files, not a folder a database is writing to.
- **Changing things:** running `backup-peer receive` again replaces the accepted key; running `backup-peer send` again replaces the destination or folder.
- **Stopping:** remove `/etc/cron.d/backup-peer` to stop sending, and `/home/backupdrop/.ssh/authorized_keys` to stop receiving.

## Getting a backup back

On the server that holds the copy:

```sh
ls -lt /home/backupdrop/incoming
```

Copy the file you need back to its own server (for example with `scp` from an administrator's machine) and restore it there. For Gamer Xperience that is:

```sh
gunzip -c gamerxp-<date>.sql.gz | docker compose exec -T db psql -U gamerxp gamerxp
```

The receiving key cannot fetch files, by design, so a restore is always done by an administrator.
