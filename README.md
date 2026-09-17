# actual-tools

A local companion app and a handful of command-line tools for a
self-hosted [Actual Budget](https://actualbudget.org) instance: bulk
budget edits, spending-anomaly detection, and a retirement/FIRE planning
page with real-account projections — all talking to Actual's own REST
API, with no data sent anywhere else.

## Getting Started

Requires [Docker](https://docs.docker.com/get-docker/) and a running,
self-hosted Actual Budget server. That's it — Node isn't needed on your
machine; the container has everything it needs to run.

```sh
git clone https://github.com/tartale/actual-tools.git
cd actual-tools
./actual service start
```

The first run builds the container image automatically (a minute or so);
after that, starting is instant. Once it's up:

1. Open **http://localhost:4247** in your browser.
2. Log in with your Actual server's own **URL**, **budget (sync) ID**, and
   **API key** — all three found under Settings → Show advanced settings
   in Actual itself. The app checks them against your server before
   saving, so a typo shows up immediately.
3. You're in. Everything autosaves as you go — there's no separate save
   step.

Check on it any time with `./actual service status`, stop it with
`./actual service stop`. Sensible defaults cover the common case (running
Docker locally, Actual reachable by a normal URL); if your Actual server
isn't reachable from inside the container — a "fetch failed" error right
after logging in — or you're deploying to a NAS/remote Docker host, see
[docs/reference.md](docs/reference.md#actual-service--actual-build-image)
for the two environment variables that fix it.

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
