# Actual Budget Tools

A self-hosted companion app, **Runway**, and a handful of command-line
tools to supplement an [Actual Budget](https://actualbudget.org) instance.

CLI features:
- Bulk budget edits
- Spending-anomaly detection

Runway features:
- A UI for bulk budget edits, with a live preview
- Retirement/FIRE planning and projections against your real accounts
- Retirement/FIRE planning also works with no Actual connection at all —
  import a plain CSV/TSV of account balances instead
- Or skip data entirely and explore the same engine with made-up numbers —
  a standalone FIRE calculator, nothing sent to or held by the server

All data stays local — nothing is sent anywhere but your own servers.
Both the CLI and Runway depend on a running instance of the
[Actual Budget REST API](https://github.com/jhonderson/actual-http-api)
companion service, which itself talks to your self-hosted Actual Budget
server; see that project for how to deploy it if you don't have one yet.

Retirement/FIRE projections against your real accounts, with markers for
a Rule of 55 boost, a debt payoff, and guaranteed income kicking in:

![Retirement page](docs/images/retirement.png)

Bulk budget edits with a live preview, styled after Actual's own budget
table:

![Budget page](docs/images/budget.png)

## Getting Started

### Before you start

- [Docker](https://docs.docker.com/get-docker/) installed and running.
- A self-hosted Actual Budget server already running, with a budget open
  on it.
- A self-hosted [Actual Budget REST API](https://github.com/jhonderson/actual-http-api)
  server deployed and pointed at that Actual server.
- Your budget's **Sync ID**, found under Settings → Show advanced
  settings in Actual itself, and the **API key** you set for your
  actual-http-api server (its own `API_KEY` environment variable — not
  something Actual generates).

Once you have those, start the container:

```sh
mkdir -p data
docker run -d --name actual-tools -p 4276:4276 \
  --add-host actual-api.local:host-gateway \
  -v "$(pwd)/data:/app/data" ghcr.io/tartale/actual-tools:latest
```

Replace `actual-api.local` with the hostname from your REST API server's
own URL (e.g. if you'll log in with `http://myserver.local:5007/v1`,
that's `myserver.local`) — this is what lets the container reach a
server running on your own machine or LAN by that name; skip the whole
`--add-host` flag if your REST API server is reachable by a plain IP
address instead. Once it's up:

1. Open **http://localhost:4276** in your browser.
2. Log in with your Actual Budget REST API server's own **URL**, your
   budget's **Sync ID** (from Actual's own Settings → Show advanced
   settings), and the **API key** you set for that server. The app checks
   them against that server before saving, so a typo shows up
   immediately.
3. You're in. Everything autosaves as you go — there's no separate save
   step.

Don't have an Actual server (or would rather not connect one)? Retirement
planning works standalone too — pick **Import files** on that same login
screen instead, and upload a plain CSV/TSV of your account balances (a
transactions export is optional, for a real computed spend figure instead
of a manual one). No REST API server needed for that path; Budget stays
disabled, since it has nothing live to edit.

Just want to try the calculator with made-up numbers, no data of any kind?
Pick **Enter manually** instead — nothing is sent to or held by the server
at all; your plan and account list live only in this browser's own local
storage. Still early: a plain account list (name, balance, type) for now,
no CSV upload or richer per-account editor yet.

Check on it any time with `docker ps`, stop it with `docker stop
actual-tools`.

### Building it from source

Prefer to build the image yourself, or plan to make changes? Clone the
repo instead — Node isn't needed even here, the container has everything
it needs to run:

```sh
git clone https://github.com/tartale/actual-tools.git
cd actual-tools
./actual service start
```

The first run builds the container image automatically (a minute or so);
after that, starting is instant, and you log in the same way as above.
Check on it any time with `./actual service status`, stop it with
`./actual service stop`. Sensible defaults cover the common case (running
Docker locally, both servers reachable by a normal URL); if you're
deploying to a NAS/remote Docker host instead, see
[docs/reference.md](docs/reference.md#actual-service--actual-build-image)
for the two environment variables that fix it.

Detailed documentation on the CLI tools, the Runway app, file formats, and
development notes can be found in
[docs/reference.md](docs/reference.md).

**A note on security**: this app has no login of its own protecting it on
the network — anyone who can reach its port can open it and use your
saved Actual login. That's a deliberate tradeoff for a simple, single-user
home setup, not an oversight. Keep it on a trusted home network, and never
expose it to the public internet without adding real authentication first.
