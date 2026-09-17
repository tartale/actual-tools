# The companion app as a single container. There is no build stage and no dependency install: this
# repo has zero runtime dependencies (see package.json -- typescript/vitest/eslint/playwright are all
# devDependencies, used for checks, never to run anything), and Node executes the TypeScript sources
# directly by stripping types. So the image is the base plus the sources, and `docker build` does not
# touch the network after pulling the base.
#
# Pinned by major, matching this repo's standing policy for every other tool.
FROM node:22-alpine

# Type stripping is on by default from Node 22.18, and everything here depends on it -- without it
# the app doesn't start. Caught at build time rather than as a baffling syntax error at run time,
# since `node:22` floats and could in principle resolve to something older.
RUN printf 'const answer: number = 42\nprocess.stdout.write(String(answer))\n' > /tmp/probe.ts; \
    if [ "$(node /tmp/probe.ts 2>/dev/null)" != "42" ]; then \
      echo "This base image's Node ($(node --version)) cannot run TypeScript directly; 22.18+ is required." >&2; \
      exit 1; \
    fi; \
    rm /tmp/probe.ts

WORKDIR /app

# package.json earns its place for "type": "module" alone -- without it Node reads the sources as
# CommonJS and every import fails. src/ carries the server, the shared modules and app-ui/ (the page
# is served from a path resolved relative to the module, so it needs no separate arrangement).
COPY package.json ./
COPY irs-limits.json ./
COPY federal-tax-brackets.json ./
COPY irs-life-expectancy.json ./
COPY federal-poverty-guidelines.json ./
COPY src/ ./src/

# Written to as well as read, so it is a mounted directory rather than a baked-in file: config.json
# is rewritten on every edit in the app, and session.json (the Actual credentials entered through
# the app's own login form) is written on login and deleted on logout. See compose.yaml.
VOLUME ["/app/data"]

EXPOSE 4276

# Binds every interface because the point of running it here is to reach it from another device --
# and there is no authentication, so the network it is published on is the whole of the security
# boundary. compose.yaml says the same thing at greater length.
CMD ["node", "src/app.ts", "--no-open", "--config", "/app/data/config.json", "--session", "/app/data/session.json"]
