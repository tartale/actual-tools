# Actual Budget Tools

A self-hosted companion app, **Runway**, and a handful of command-line
tools to supplement an [Actual Budget](https://actualbudget.org) instance.

CLI features:
- Bulk budget edits
- Spending-anomaly detection

Runway features:
- A UI for bulk budget edits, with a live preview
- Retirement/FIRE planning and projections against your real accounts

All data stays local — nothing is sent anywhere but your own servers.
Both the CLI and Runway depend on a running instance of the
[Actual Budget REST API](https://github.com/jhonderson/actual-http-api)
companion service, which itself talks to your self-hosted Actual Budget
server; see that project for how to deploy it if you don't have one yet.

## Getting Started

Requires [Docker](https://docs.docker.com/get-docker/), a running,
self-hosted Actual Budget server, and a running, self-hosted
[Actual Budget REST API](https://github.com/jhonderson/actual-http-api)
server pointed at it. That's it — Node isn't needed on your machine; the
container has everything it needs to run.

```sh
git clone https://github.com/tartale/actual-tools.git
cd actual-tools
./actual service start
```

The first run builds the container image automatically (a minute or so);
after that, starting is instant. Once it's up:

1. Open **http://localhost:4247** in your browser.
2. Log in with your Actual Budget REST API server's own **URL**, **budget
   (sync) ID**, and **API key** — all three found under Settings → Show
   advanced settings in Actual itself. The app checks them against that
   server before saving, so a typo shows up immediately.
3. You're in. Everything autosaves as you go — there's no separate save
   step.

Check on it any time with `./actual service status`, stop it with
`./actual service stop`. Sensible defaults cover the common case (running
Docker locally, both servers reachable by a normal URL); if the REST API
server isn't reachable from inside the container — a "fetch failed" error
right after logging in — or you're deploying to a NAS/remote Docker host,
see [docs/reference.md](docs/reference.md#actual-service--actual-build-image)
for the two environment variables that fix it.

### Without cloning the repo

Every push to `main` publishes a ready-to-run image, so you don't need the
source at all:

```sh
mkdir -p data
docker run -d --name actual-tools -p 4247:4247 \
  -v "$(pwd)/data:/app/data" ghcr.io/tartale/actual-tools:latest
```

Then open http://localhost:4247 and log in the same way as above. If the
REST API server isn't reachable from inside the container, add
`--add-host <hostname-in-its-url>:host-gateway` to the `docker run`
command — see [docs/reference.md](docs/reference.md#actual-service--actual-build-image)
for why this is sometimes needed and what it does.

This project also includes a few one-shot CLI tools for scripted budget
edits (`budget set-values`, `budget anomalies`, `transactions
match-uncleared`) — see [docs/reference.md](docs/reference.md) for those,
and for everything else: the full `./actual` command reference, what each
part of the Retirement page does, config file formats, and development
notes.

**A note on security**: this app has no login of its own protecting it on
the network — anyone who can reach its port can open it and use your
saved Actual login. That's a deliberate tradeoff for a simple, single-user
home setup, not an oversight. Keep it on a trusted home network, and never
expose it to the public internet without adding real authentication first.
