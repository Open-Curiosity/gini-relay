# gini-relay

Self-hosted, ngrok-style relay: sign in with Google, get a **static public HTTPS URL bound to a local port**. [frp](https://github.com/fatedier/frp) does transport, a small Bun "brain" does identity + quotas, Caddy does TLS.

The repo is **two things in one package**:

- a **client** (`src/client/`) — a Bun library + `frp` CLI that logs you in and runs a native frpc tunnel (downloads the binary; **no docker on the client**). This is the only surface the package exports.
- a **server** (`src/server/`) — the brain that runs beside frps + Caddy via `docker compose up`. It ships in the repo but is **not exported**.

```
your machine (the client package)            the relay host (docker compose)              a visitor
─────────────────────────────────           ───────────────────────────────              ─────────
frp <port>                                                                                browser
  └─ native frpc ──TLS tunnel──▶ :7000   frps ──:8080──▶ Caddy ──:443──▶ https://<you>.gini-relay.lilaclabs.ai
     serves localhost:<port>               │  (Host routing)  (wildcard TLS)              ▲
                                           ▼ asks before accept/route                     │
                                         brain — opaque-session identity · subdomain registry · bandwidth tier
```

frp and Caddy stay stock; all custom logic lives in the brain, which frps calls through its [server-plugin hook](https://gofrp.org/en/docs/features/common/server-plugin/) to decide *who* may connect and *what* they get.

## Why client + server live in one package

Bun (as of 1.3.x) has **no way to install a single sub-package out of a monorepo**: a `bun add git+ssh://…` installs the whole repo and reads its **root** `package.json`. So the repo stays a single package whose root `exports`/`main`/`types` point at `src/client/index.ts`. Importing `gini-relay` therefore yields **only the client API** — the server code is present in the repo (for `docker compose`) but never reachable through the package entry.

```
bun add git+ssh://git@github.com/Lilac-Labs/gini-relay.git    (private repo → git+ssh)
  └─ root package.json  exports "." → ./src/client/index.ts
        import { login, buildTunnel, runCli, Frpc } from "gini-relay"   // client only
```

## Repo (public files; secrets are git-ignored)

```
gini-relay/
├── src/
│   ├── client/                  # the PACKAGE: everything the root export exposes
│   │   ├── index.ts             # public barrel — the only surface consumers import
│   │   ├── bin.ts               # `frp` CLI entry (thin: runCli → exit code)
│   │   ├── cli.ts               # runCli(argv, deps): dispatch `login` | `<port>` | `devices` | `revoke` | `logout` (DI'd)
│   │   ├── auth.ts              # loopback OAuth + PKCE: loginUrl() primitive + login() CLI wrapper
│   │   ├── loopback.ts          # OS glue: 127.0.0.1 callback server + open-browser (injected)
│   │   ├── pkce.ts              # PKCE verifier/challenge + state (injectable rng)
│   │   ├── store.ts             # ~/.gini-relay device.json/session.json (atomic, 0600)
│   │   ├── config.ts            # buildFrpcConfig(session, port) → frpc config (TLS-pinned)
│   │   ├── tunnel.ts            # buildTunnel() → supervised native frpc; validatePort()
│   │   ├── defaults.ts          # public relay defaults (url, frps addr/port, frp token, CA, ports)
│   │   └── runner/              # native frpc runner (downloads + supervises the frpc binary)
│   │       ├── platform.ts      # pure: map host → frp release asset URL + local binary path
│   │       ├── checksums.ts     # pinned per-release SHA-256 table for the downloaded archive
│   │       ├── download.ts      # ensureBinary(): fetch + checksum-verify + extract the release
│   │       ├── process.ts       # bunSpawn + streamLines (injectable spawn seam)
│   │       ├── logparse.ts      # classify frpc log lines (ready / fatal)
│   │       └── supervisor.ts    # Frpc class: resolve binary, write config, spawn, stream, lifecycle
│   └── server/                  # the BRAIN (shipped, not exported; run via docker compose)
│       ├── bin.ts               # entry: Bun.serve (thin)
│       ├── handlers.ts          # createApp(deps) → fetch(req): all routes + /_frp policy
│       ├── oauth.ts             # Google loopback-redirect URL + code exchange (PKCE)
│       ├── registry.ts          # SQLite subdomain registry: owns opaque session tokens (createSession/verifyToken) + list/revoke; stores only sha256(token)
│       ├── bandwidth.ts         # bandwidth tier constants + strict parser
│       ├── config.ts            # env → ServerConfig + fail-closed assertStartable()
│       └── index.ts             # server-internal barrel (tests + bin import from here)
├── test/
│   ├── *.test.ts                # `bun test`: per-module unit tests at 100% line+function coverage
│   └── integration.ts           # `bun run test:flow`: stub-mode brain end-to-end on a temp port
├── scripts/
│   ├── postinstall.ts           # on `bun install`: download the frpc binary into bin/ (non-fatal)
│   └── reload-caddy.sh          # certbot deploy-hook: reload Caddy when the wildcard cert renews
├── frps.toml                    # frps config: http vhost :8080, control-plane TLS :7000, plugin → brain
├── frps-web/404.html            # plain 404 body frps serves for unconnected/unknown subdomains
├── Caddyfile                    # public TLS termination (wildcard): apex → brain, *.<domain> → frps
├── Dockerfile                   # brain image (oven/bun:1, zero deps) — CMD bun src/server/bin.ts
├── docker-compose.yml           # the server stack: brain + frps + caddy; named volume (persistent SQLite)
├── frps-ca.crt                  # PUBLIC CA cert the client pins for the frp control plane (:7000)
├── .github/workflows/deploy.yml # push to main → `docker compose up -d --build` on the self-hosted runner
├── bunfig.toml                  # test coverage on, 100% threshold (bin/scripts/test excluded)
├── package.json                 # root export → src/client/index.ts; bin `frp`; scripts
├── tsconfig.json                # strict TypeScript config
├── .env.example                 # env template; real secrets come from env/CI, never committed
├── .gitignore                   # ignores secrets + bin/ (downloaded binary) + coverage/
├── CLAUDE.md                    # this doc — the canonical reference
└── README.md, AGENTS.md         # symlinks → CLAUDE.md
```

Secrets (never committed — env-only or host-only):

```
GINI_GOOGLE_CLIENT_ID / _SECRET       Google OAuth client
FRP_AUTH_TOKEN                        shared frp coarse-gate token (env-supplied)
frps-ca.key                           CA private key that issued the frps cert — keep offline
/opt/gini-relay/tls/frps.{crt,key}    frps control-plane cert + key (on the host)
/etc/letsencrypt/…                    Caddy wildcard cert (certbot, on the host)
```

## Use the client as a package

Install (private repo → `git+ssh`; see *Why client + server live in one package*). `postinstall` downloads + checksum-verifies the native frpc binary, so there's nothing else to install.

```bash
bun add "git+ssh://git@github.com/Lilac-Labs/gini-relay.git"
```

Everything baked into the client is **public by design** (the shared frp token, the pinned CA, the relay defaults). The real authorization is the per-user opaque session token minted after Google sign-in — so it is safe for anyone to install and run the client.

### What the package exports

| Export | Kind | What it does |
|---|---|---|
| `runCli(argv, deps?)` | fn → `Promise<number>` | The whole `frp` CLI as a call: `["login"]`, `["<port>"]`, `["devices"]`, `["revoke", "<subdomain>"]`, `["logout"]`. Returns an exit code. |
| `loginUrl(deps)` | fn → `Promise<LoginHandle>` | **Library login primitive.** Returns `{ url, redirectUri, waitForSession(), cancel() }` — no browser, no printing. |
| `login(deps)` | fn → `Promise<number>` | CLI login: opens the browser, awaits the session, returns an exit code. Thin wrapper over `loginUrl`. |
| `createStore(opts?)` | fn → `Store` | `~/.gini-relay` (or `GINI_HOME`) credential store: `deviceId()`, `readSession()`, `writeSession()`. |
| `resolveDefaults(env?)` | fn → `RelayDefaults` | The public relay defaults (URL, frps addr/port, domain, frp token, CA path, loopback ports), with `GINI_*` overrides applied. `DEFAULTS` is the un-overridden object. |
| `buildTunnel(opts)` | fn → `Frpc` | Builds (does not start) a supervised native frpc tunnel for a session + local port. |
| `validatePort(str)` | fn → `number \| null` | Parse/validate a `1–65535` port argument. |
| `listDevices(deps)` | fn → `Promise<Device[]>` | List every device/subdomain owned by your account (Bearer session token from the store). |
| `revokeDevice(deps, subdomain)` | fn → `Promise<boolean>` | Revoke one device's subdomain (instant, per-device); re-login mints a fresh session secret. |
| `buildFrpcConfig(opts)` | fn → `FrpcConfig` | Pure: the TLS-pinned, subdomain-pinned frpc config object for one tunnel. |
| `Frpc` / `runFrpc(opts)` | class / fn | The frpc supervisor: resolve binary → write config → spawn → stream logs as events → lifecycle (`start`/`stop`/`exited`, events `log`/`ready`/`exit`/`error`). |
| `ensureBinary(opts?)` · `resolveBinary(deps?)` · `resolveTarget(opts?)` | fns | Download+verify the pinned frpc / resolve a binary path / compute the platform's release target. |
| `createPkce(rng?)` · `newState(gen?)` | fns | PKCE verifier+challenge / opaque OAuth state (used internally; exposed for custom flows). |
| `startLoopback(ports, state)` · `openBrowser(url)` | fns | The loopback-callback server and browser opener (injectable seams behind `login`). |
| `isReadyLine` · `isProxyStartLine` · `isFatalLine` | fns | Classify frpc log lines (handy for a custom `readyWhen`). |

### Log in (CLI style — opens the browser for you)

```ts
import { runCli } from "gini-relay";

process.exit(await runCli(["login"])); // opens Google sign-in, waits, persists the session to ~/.gini-relay
```

### Log in (library style — you render the URL, you await the session)

`loginUrl` is for when you want to present the consent link yourself — e.g. open it in a *specific* browser or behind a "Sign in" button. It opens nothing and prints nothing; you get the URL plus an awaitable. The URL is **machine-bound, not shareable**: it must be approved in a browser on this same machine (the auth code comes back to this host's loopback), so don't send it to another device or person.

```ts
import { createStore, resolveDefaults, loginUrl } from "gini-relay";

const d = resolveDefaults();
const { url, redirectUri, waitForSession, cancel } = await loginUrl({
  store: createStore(),
  relayUrl: d.relayUrl,
  loopbackPorts: d.loopbackPorts,
});

console.log("Sign in here:", url);   // open in a browser ON THIS MACHINE (the URL is machine-bound)
// const session = ...                // when the user finishes in the browser:
const session = await waitForSession(); // exchanges the code, persists, resolves { token, subdomain, account }
console.log(`logged in as ${session.account}`);
// cancel();                          // or abort a pending login (stops the loopback, rejects waitForSession)
```

### Open a tunnel

```ts
import { createStore, resolveDefaults, buildTunnel } from "gini-relay";

const store = createStore();
const session = store.readSession();              // { token, subdomain, account } | null
if (!session) throw new Error("not logged in — run login first");

const defaults = resolveDefaults();
const frpc = buildTunnel({
  session,
  deviceId: store.deviceId(),
  port: 8080,                                      // your local service
  defaults,
});

frpc.on("log", (line) => console.log(line));
await frpc.start();                                // resolves once the proxy is actually up
console.log(`live at https://${session.subdomain}.${defaults.relayDomain}`);

await frpc.exited;                                 // runs until frpc exits …
// await frpc.stop();                              // … or stop it yourself
```

### End to end in one process (login, then tunnel)

```ts
import { createStore, resolveDefaults, login, buildTunnel } from "gini-relay";

const store = createStore();
const defaults = resolveDefaults();

const code = await login({
  store,
  relayUrl: defaults.relayUrl,
  relayDomain: defaults.relayDomain,
  loopbackPorts: defaults.loopbackPorts,
  openBrowser: (url) => Bun.spawn(["open", url]),  // or your own opener
});
if (code !== 0) process.exit(code);

const frpc = buildTunnel({ session: store.readSession()!, deviceId: store.deviceId(), port: 8080, defaults });
frpc.on("log", console.log);
await frpc.start();
await frpc.exited;
```

### List / revoke your devices

```ts
import { createStore, resolveDefaults, listDevices, revokeDevice } from "gini-relay";

const deps = { store: createStore(), relayUrl: resolveDefaults().relayUrl };

for (const d of await listDevices(deps)) {
  console.log(`${d.subdomain}  ${d.revoked ? "(revoked)" : "(active)"}  device=${d.device_id}`);
}

// Revoke one device instantly (per-device): its token dies on the next check; others are untouched.
// Re-login keeps the subdomain but mints a fresh session secret (an old leaked token can't be revived).
await revokeDevice(deps, "k7p2m9q4xn3rs8vbcd0fgh1jzy");
```

Or via the CLI: `frp devices` lists them, `frp revoke <subdomain>` kills one device's session (then `frp login` mints a fresh secret), and `frp logout` revokes *this* device and clears the local session — other devices keep working.

### Just fetch the binary

```ts
import { ensureBinary } from "gini-relay";

const path = await ensureBinary();                 // downloads + SHA-256-verifies the pinned frpc; returns its path
```

Override any default via env (`GINI_RELAY_URL`, `GINI_FRPS_ADDR`, `GINI_FRP_TOKEN`, `GINI_CA_FILE`, `GINI_HOME`, …) or by passing explicit `deps`/`opts` — every seam (fetch, spawn, loopback, browser, store) is injectable.

## Identity & authorization

```
Google sign-in ──▶ account = Google `sub` ──issues per device──▶ opaque session token (gsk_…, random)
device   = client id at ~/.gini-relay/device.json                  │ brain stores ONLY sha256(token)
subdomain = 128-bit CSPRNG (Crockford Base32, 26 chars) keyed by (account, device_id) ┘ one per device
```

The session token is a **random opaque secret**, not a JWT. At login the brain mints `gsk_<32 random bytes>`, hands the raw token to the client once, and persists **only `sha256(token)` hex** in that device's registry row — the raw secret can't be recovered from the DB. The **brain is the sole verifier** (stateful by design): every `Login`, `NewProxy`, `/devices`, and `/devices/:subdomain` check is a single registry hash-lookup (`verifyToken` → `WHERE token_hash=sha256(token) AND revoked=0`). There is **no offline verification and no public key** — and **no expiry**: a session lives until it's revoked, so one login serves 24/7 across reconnects (network blip, frps restart, machine sleep) with no re-login.

**Revocation — per-device, instant, revival-proof.** `frp revoke <subdomain>` (or `frp logout`) flips `revoked=1` on **that one device's row**. Its token dies on the very next check (`verifyToken` excludes revoked rows), so new/reconnecting `Login`/`NewProxy` calls and `/devices` access stop immediately — an already-established tunnel keeps serving only until its control connection drops (frp has no evict hook). Other devices are **untouched** (revocation is keyed by subdomain/row, not by account). And it's **revival-proof**: re-login (`frp login`) reuses the device's subdomain but mints a **fresh** `gsk_` secret with a new `token_hash`, so an old leaked token — whose hash no longer matches any active row — can never be revived. Treat `session.json` (0600) as the credential it is.

Every tunnel is authorized server-side in `/_frp/handler` — reject, never trust:

```
frps ──Login(token)───▶ brain:  token hashes to an active device row?              ─┐
frps ──NewProxy(cfg)──▶ brain:  proxy_type == http?   custom_domains empty?         ├─▶ reject on any miss
                                bandwidth ≤ tier AND mode=server?                   │
                                subdomain == owned?   proxy_name == subdomain?     ─┘
```

(`proxy_name == subdomain` + frps's unique-name rule ⇒ one proxy per device, so the bandwidth tier can't be multiplied with extra proxies.)

## Login — OAuth 2.0 loopback redirect (RFC 8252) + PKCE

The CLI opens the browser on the same machine, so the user only approves the Google consent — nothing to type:

```
frp login
  │  start throwaway  http://127.0.0.1:<port>/cb   + PKCE (code_verifier, S256 challenge)
  ▼
GET /auth/google-url ─▶ Google consent URL ─▶ [browser] you approve
  │
  ▼  Google redirects the code to 127.0.0.1:<port>/cb   ← lands on YOUR machine
POST /auth/exchange { code, code_verifier, redirect_uri, device_id }
  ▼
brain exchanges the code with Google (it holds the secret) to validate identity ONCE,
then issues a fresh opaque session token ─▶ { token, subdomain, account }
```

Google validates *identity* once at login; the brain then issues the session token (it does not mint a JWT). The auth code never leaves your machine and PKCE binds it to this CLI, so a relayed consent link can't capture your token. Loopback redirect URIs `127.0.0.1:8765-8767/cb` are registered on the Google client.

## Endpoints (the brain)

| Method · path | Purpose |
|---|---|
| `GET /auth/google-url` | Google consent URL for a loopback redirect (live mode). |
| `POST /auth/exchange` | Exchange the auth code (+ PKCE verifier) → `{ token, subdomain, account }` where `token` is a fresh opaque session secret (`gsk_…`). Stub mode takes a bare `account`. |
| `GET /devices` · `DELETE /devices/:subdomain` | List / revoke devices (Bearer session token). |
| `POST /_frp/handler` | Internal frps RPC (Login + NewProxy policy). Never public — Caddy blocks `/_frp/*`. |

## Deploy — push to main

```
git push main
  └─▶ .github/workflows/deploy.yml   (self-hosted runner, environment: production)
        └─▶ docker compose up -d --build     secrets injected as job env — no .env on disk
              └─▶ brain + frps + caddy (re)started   (brain = bun src/server/bin.ts)
```

One-time setup:

```
runner   register a self-hosted runner on the host that owns the domain
secrets  production env → FRP_AUTH_TOKEN · GINI_GOOGLE_CLIENT_ID · _SECRET
DNS      *.gini-relay.lilaclabs.ai  AND  the apex  →  the host
caddyTLS certbot wildcard (DNS-01) at /etc/letsencrypt; renewals run scripts/reload-caddy.sh
frpTLS   put the frps cert+key at /opt/gini-relay/tls (its CA cert is the committed frps-ca.crt)
google   register loopback redirects 127.0.0.1:8765-8767/cb on the OAuth client
```

## Security model

```
authn    opaque per-device session token (random gsk_…), no expiry; brain is sole verifier (stores only sha256) — every check is a registry hash-lookup; per-device instant revocation (no offline verify, no JWT)
authz    /_frp/handler: subdomain ownership · proxy_name pin · http-only · bandwidth tier
xport    :7000 control plane = TLS PINNED to our private CA (frps-ca.crt) → MITM-proof
         :443 visitor traffic terminates at Caddy (Let's Encrypt wildcard)
login    loopback redirect + PKCE → the auth code stays on the user's machine, can't be relayed
client   public by design: baked-in frp token + CA are non-secret; the per-user session token is the real auth
failclsd no Google creds ⇒ the brain refuses to start unless GINI_ALLOW_STUB=1 (never open by accident)
secrets  env-only / host-only, never committed (see Repo)
```

## Environment

| Var | Notes |
|---|---|
| `GINI_GOOGLE_CLIENT_ID` / `_SECRET` | Both set → live Google. Empty → stub, which needs `GINI_ALLOW_STUB=1` or the brain exits. |
| `GINI_ALLOW_STUB` | `1` permits stub (no-Google) auth in dev. Never set in prod. |
| `GINI_DB` | SQLite path (persistent volume in prod). |
| `GINI_PUBLIC_URL` | Brain's public base URL (logs / links). |
| `FRP_AUTH_TOKEN` (frps) | Shared coarse gate; the per-user session token is the real auth. |
| `GINI_RELAY_URL` · `GINI_FRPS_ADDR` · `GINI_FRPS_PORT` · `GINI_RELAY_DOMAIN` · `GINI_TLS_SERVER_NAME` · `GINI_FRP_TOKEN` · `GINI_CA_FILE` (client) | Override the public client defaults (`resolveDefaults`). |
| `GINI_HOME` (client) | Credential store dir (default `~/.gini-relay`). |
| `FRPC_BIN` · `FRPC_CACHE_DIR` · `FRPC_SKIP_DOWNLOAD` (client) | Use an existing frpc binary / cache dir / skip the postinstall download. |

## Local dev

```bash
bun run typecheck   # tsc --noEmit (strict)
bun test            # unit suite — 100% line+function coverage (enforced by bunfig)
bun run test:flow   # integration: stub-mode brain end-to-end on a temp port (no Google, no docker)
```
