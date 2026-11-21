# Deploying kd-learn with Docker Compose

One container runs the whole app: the web UI, the guest API and accounts. Data is one SQLite file on a Docker volume. HTTPS comes from a reverse proxy you run in front.

## Requirements

- Docker with Compose v2.
- A domain name and a reverse proxy for HTTPS (examples below). Browsers need HTTPS for the local database of guest mode (OPFS) everywhere except `localhost`.

## Quick start

```sh
git clone https://github.com/kd-labs-io/kd-learn.git
cd kd-learn
cp .env.example .env
openssl rand -base64 32   # paste into KD_LEARN_SECRET_KEY in .env
# set KD_LEARN_ADMIN_EMAIL and KD_LEARN_ADMIN_PASSWORD in .env
docker compose up -d --build
docker compose ps         # wait for "healthy"
```

The app listens on `127.0.0.1:3000`. Point the reverse proxy at it, open the site, and sign in with the admin email and password. The admin is created on the first request when no admin exists yet. After that you can remove the two admin lines from `.env`.

**Keep a copy of `KD_LEARN_SECRET_KEY`.** It encrypts the provider keys users save. If it is lost or changed, every saved key becomes unreadable and users must add them again. Without it, accounts are off and only guest mode runs.

## Settings

Set these in `.env`. The server reads them at start.

| Variable                                                                 | Default  | Meaning                                                                                                                                                                                      |
| ------------------------------------------------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KD_LEARN_SECRET_KEY`                                                    | none     | 32 bytes in base64. Required for accounts.                                                                                                                                                   |
| `KD_LEARN_ADMIN_EMAIL`, `KD_LEARN_ADMIN_PASSWORD`                        | none     | First admin. Set both or neither. Password: 8 characters or more.                                                                                                                            |
| `KD_LEARN_REGISTRATION`                                                  | `invite` | `open`, `invite` or `closed`.                                                                                                                                                                |
| `KD_LEARN_GUEST_MODE`                                                    | `on`     | Guests use their own key; sessions stay on their device.                                                                                                                                     |
| `KD_LEARN_DEMO_MODE`                                                     | `off`    | Anyone can try the app on the server's key, within the budget.                                                                                                                               |
| `KD_LEARN_DEMO_PROVIDER`, `KD_LEARN_DEMO_MODEL`, `KD_LEARN_DEMO_API_KEY` | none     | Demo model: `anthropic`, `gemini` or `openai-compatible`. All three or none.                                                                                                                 |
| `KD_LEARN_DEMO_ENDPOINT`                                                 | none     | Endpoint id, only with `openai-compatible`.                                                                                                                                                  |
| `KD_LEARN_DEMO_BUDGET`                                                   | `0`      | Model calls per period for all demo users together. `0` closes the demo.                                                                                                                     |
| `KD_LEARN_DEMO_BUDGET_PERIOD`                                            | `day`    | `day`, `month` or `none` (UTC).                                                                                                                                                              |
| `KD_LEARN_TRUST_PROXY`                                                   | off      | `1` behind a reverse proxy: the client address comes from `X-Forwarded-For`, so rate limits apply per user and not to the proxy. Do not set it when the port is reachable without the proxy. |
| `KD_OPENAI_COMPATIBLE_ENDPOINTS`                                         | none     | JSON array of `{"id", "baseURL", "label"?}` that users may pick.                                                                                                                             |
| `KD_CORS_ORIGINS`                                                        | none     | Extra origins allowed to call the API, comma separated (the mobile app).                                                                                                                     |
| `KD_MAX_REQUEST_BYTES`                                                   | 1 MiB    | Request size limit.                                                                                                                                                                          |

The registration, guest, demo and budget values are **defaults for the first start**. After that they live in the database and the admin screen changes them; editing `.env` no longer changes them.

Compose also reads `KD_LEARN_BIND` (default `127.0.0.1`) and `KD_LEARN_PORT` (default `3000`) from `.env` for the published port.

Not in the image: ACP agents (Claude Code, opencode, Antigravity CLI). They need the agent's CLI installed and signed in on the host, so they only work when the server runs outside Docker. The admin screen warns when an agent is enabled but the server cannot load it.

## HTTPS with a reverse proxy

The learning screen streams with server-sent events. The proxy must not buffer responses. The server sends `X-Accel-Buffering: no`; an account stream also sends a ping every 15 seconds. A guest turn streams without pings until it ends, so keep the proxy's read timeout at 5 minutes or more.

Caddy (gets certificates by itself):

```caddyfile
learn.example.com {
	reverse_proxy 127.0.0.1:3000
}
```

nginx:

```nginx
server {
    listen 443 ssl;
    server_name learn.example.com;
    # ssl_certificate ... ; ssl_certificate_key ... ;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_read_timeout 300s;
    }
}
```

Set `KD_LEARN_TRUST_PROXY=1` in both cases.

## Backup and restore

The database is `/data/kd-learn.db` on the `kd-learn-data` volume. Take a consistent copy while the app runs:

```sh
docker compose exec web node -e "const s=require('node:sqlite');s.backup(new s.DatabaseSync('/data/kd-learn.db'),'/data/backup.db').then(()=>console.log('done'))"
docker compose cp web:/data/backup.db ./kd-learn-$(date +%F).db
docker compose exec web rm /data/backup.db
```

There is no automatic backup. Run the commands from cron if you need one, and keep `KD_LEARN_SECRET_KEY` with the backups: the saved provider keys in the file can only be read with it.

To restore, stop the app, replace the file (and drop the old write-ahead log next to it), and start again:

```sh
docker compose stop web
docker compose run --rm --no-deps -v "$PWD/kd-learn-2026-11-21.db:/restore.db:ro" web \
  sh -c 'cp /restore.db /data/kd-learn.db && rm -f /data/kd-learn.db-wal /data/kd-learn.db-shm'
docker compose start web
```

## Upgrading

```sh
git pull
docker compose up -d --build
```

The database is migrated at start. Take a backup first.

## Checking the stack

`scripts/compose-smoke.sh` builds the image and starts a throwaway stack on port 3999. It waits for the healthcheck, signs in as the first admin, checks that data survives `down` and `up`, runs the backup and restore commands above, and checks that the admin password is not in the log. CI runs it on every pull request.
