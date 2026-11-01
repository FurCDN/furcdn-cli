---
name: furcdn
description: Use the furcdn CLI to manage FurCDN domains and accounts — list/create/update domains, purge cache, manage SSL/WAF/cache rules/origins, deploy static sites with Pages, and self-service account tasks (billing, tickets, plan). Never use it for admin/management-panel operations — the CLI does not support those by design. Use when the user asks to manage their FurCDN domain, cache, SSL, WAF, or account.
---

# FurCDN CLI

`furcdn` is the official FurCDN command-line tool. It has two auth modes:
API Key (`furcdn config set-key`, covers `/api/v1/*` — `furcdn domains`/`furcdn ssl`)
and session login via OAuth device flow (`furcdn login`, covers `furcdn domain`,
`furcdn account` and `furcdn pages` — full domain management, billing, tickets,
static hosting, etc.). `furcdn pages` picks the right mode automatically:
API key when configured, otherwise the session.

**It does not, and will never, expose any admin/management-panel operation**,
even for an admin-role account — that's a deliberate design decision (the
server also hard-rejects admin API calls from CLI-issued tokens). Never try to
work around this by calling `furcdn api /api/admin/...` or by any other means;
if the user needs admin functionality, tell them to use the browser dashboard.

## Prerequisites

Check whether `furcdn` is installed and configured before using it:

```bash
furcdn --version
furcdn config show      # API key
furcdn whoami            # session login status (for domain/account commands)
```

- For `furcdn domains`/`furcdn ssl` (API Key auth): if not configured, ask the
  user for a FurCDN API key (created on the dashboard's "API" page, format
  `fck_...`) and run `furcdn config set-key <key>`.
- For `furcdn domain`/`furcdn account` (session auth): if `furcdn whoami` fails,
  tell the user to run `furcdn login` themselves in their own terminal — it
  opens a browser for them to approve, and never enter a password/OAuth
  approval on the user's behalf.

Only the current user's own credentials should ever be used — never ask for or
store another person's API key or session.

## Common tasks

### List domains

```bash
furcdn domains list           # human-readable table
furcdn domains list --json    # machine-readable, prefer this when parsing output
```

### Purge / refresh cache for a domain

Accepts either the numeric id or the full domain name — prefer the domain
name since it's what the user will typically say.

```bash
# whole-domain purge (no options = the original behaviour)
furcdn domains purge example.com
furcdn domains purge 42 --json

# selective purge: only the matching cache entries are dropped
furcdn domains purge example.com --url 'https://example.com/a.css?v=1'
furcdn domains purge example.com --url /b.js --url /c.js
furcdn domains purge example.com --prefix /static/
furcdn domains purge example.com --pattern '/assets/*.js'
furcdn domains purge example.com --prefix /static/ --pattern '/img/*' --url /index.html
furcdn domains purge example.com --all      # explicit whole-domain purge
```

Selector semantics (use whichever matches what the user actually wants to
drop — don't fall back to a whole-domain purge if a selector works):

- `--url`: exact URL match. Either a full URL (host must equal the domain) or a
  path starting with `/`. The query string is part of the match, unless the
  domain has `ignoreQueryString` enabled. Every cached variant (Vary copies,
  GET and HEAD) of that URL is dropped.
- `--prefix`: plain string prefix on the URL path, query string ignored
  (`/static/` drops `/static/a.js` and `/static/x/y.css`).
- `--pattern`: glob on the URL path, must start with `/`, `*` matches anything
  including `/` (e.g. `/assets/*.js`, `/img/*`). Quote it in the shell.
- `--all`: explicit whole-domain purge; cannot be combined with the selectors
  above (the CLI rejects it locally).
- `--url`/`--prefix`/`--pattern` can be repeated or take several values, and
  can be combined in one call (union). At most 100 entries in total, 2048
  characters each.

Rate limits: whole-domain purge 10 times per 5 minutes per account; selective
purge 60 times per 5 minutes. If the command fails with a `429` error, tell
the user to wait a few minutes before retrying — don't loop retrying it
yourself.

The output/`--json` response reports `mode` (`all` or `selective`), `total`
(online nodes serving the domain), `success` (nodes that acknowledged and
confirmed success — failed nodes are not counted) and, for selective purges,
`removed` (cache entries deleted, summed across the successful nodes only —
the same URL cached on 3 nodes counts 3; it is not a unique-URL count). When
`removed` is missing or invalid, or when no node confirmed success, the CLI
prints "刪除筆數不明" rather than assuming 0. With `total` 0 it says no nodes
are online instead of claiming success.

Cache rules (TTL / "do not cache") are only applied when a node fetches from
origin, so changing a rule never touches content that is already cached. If
the user expects a rule change to take effect immediately, purge the affected
content. `furcdn domain purge` (session auth) takes the same options and also
returns a `message` string; the CLI ignores that string and builds its summary
from `ok`/`mode`/`total`/`success`/`removed` only, so counts never repeat
regardless of the server locale. `ok:false` is reported as a failure even when
`success` equals `total`.

Over MCP the same operation is the `furcdn_domains_purge` tool: `domain` plus
the optional `all`, `urls`, `prefixes` and `patterns` fields (string arrays,
same semantics as the CLI flags).

### Upload a custom SSL certificate

Requires the certificate and private key as local PEM files. Ask the user
for the file paths if they weren't given.

```bash
furcdn ssl upload example.com --cert ./fullchain.pem --key ./privkey.pem
```

This disables auto-renew for that domain — mention that side effect to the
user when you run it.

### Health check

```bash
furcdn health
```

Pure liveness check of the configured API base URL; a 200 here does not
guarantee the rest of the API is fully healthy.

### Origin selection (multi-origin, per-node latency)

Only relevant when a domain has more than one origin. `originPolicy` decides how
each edge node picks an origin; setting `strategy` to `latency` turns on
per-node ICMP/TCP/HTTP probing and picks the lowest-latency origin *for that
node* (not a single global choice).

```bash
furcdn domain origin policy get example.com       # current effective policy
furcdn domain origin policy set example.com --set strategy=latency
furcdn domain origin probes example.com           # per-node RTT/loss + selected origin
furcdn domain origin list example.com             # per-origin weight/backup/probe-host
furcdn domain origin set example.com --url http://origin2.example --backup --weight 2
```

- `furcdn domain update example.com --origin-strategy latency ...` is shorthand
  for setting the policy; only the fields you pass are changed (the server
  shallow-merges), and `--reset` on `origin policy set` restores the defaults.
- Nodes need ICMP egress to the origin; if ICMP is blocked or unavailable the
  policy falls back to TCP connect by default (`probeFallback`).
- Don't switch to `latency` unless the user asks — `failover` (the default) is
  the safest for a single primary + backups setup.

### Switch a domain's cluster

```bash
furcdn domain update example.com --cluster 2
furcdn domain update 12 --cluster 2 --set enabled=true   # combine with other fields
```

Prints the new cluster name and `dnsTarget` (the stable alias to CNAME to). If
the user's CNAME already points at that alias, no DNS change is needed. When
Aliyun is not configured the response carries
`dnsNote: "aliyun_not_configured"`: the cluster did switch, but the alias was not
updated — tell the user to point the CNAME at `dnsTarget` manually. Same-cluster
requests are a no-op (`dnsUpdated:false`). A `502` means the Aliyun alias update
failed and the server rolled the cluster back; it is safe to retry later.

### Deploy a static site (FurCDN Pages, beta)

FurCDN Pages hosts a static folder, but a Pages site has **no public hostname
of its own**: you bind the user's own domain to it (and pick a cluster), or
point an existing domain's origin at the Pages site. It is in beta and gated:
every Pages API returns `403 pages_beta_required` until the account redeems a
beta code. The user must supply the code — never guess one or reuse someone
else's.

```bash
furcdn pages beta status
furcdn pages beta redeem PGB-XXXX-XXXX-XXXX
furcdn pages create my-blog --production-branch main
furcdn pages deploy ./dist --site my-blog --branch main --message "deploy"
furcdn pages deployments my-blog
furcdn pages activate my-blog <id>        # rollback / promote
furcdn pages usage

# Bind a domain to the site (creates the domain with origin type=pages)
furcdn pages bind my-blog blog.example.com --cluster <id>
furcdn pages bind my-blog blog.example.com   # TTY: interactive cluster picker
furcdn pages domains my-blog                 # bound domains + CNAME targets

# Point an existing domain's origin at the Pages site (no --url)
furcdn domain origin set example.com --pages my-blog
furcdn domain origin set example.com --pages my-blog --backup
```

- The folder root must contain `index.html`. The CLI packs a tar.gz and
  enforces 20MB total / 2000 files / 255-char paths locally before uploading.
  `.git`, `node_modules` and `.DS_Store` are ignored; symlinks pointing outside
  the folder are rejected.
- Only the site's production branch goes live automatically; other branches are
  stored but not served — use `furcdn pages activate <site> <id>` to promote.
- `pages bind` requires a cluster id (`furcdn info clusters` lists them). If
  `--cluster` is omitted the CLI prompts interactively; in a non-interactive
  environment it errors instead of hanging. After success, tell the user the
  exact CNAME to create (the command prints it) and that the domain can be
  managed with `furcdn domain` (SSL, WAF, cache) — switching clusters later is
  `furcdn domain update <domain> --cluster <id>`.
- `furcdn domain origin set <domain> --pages <site>` makes the domain serve the
  Pages site; `--pages` and `--url` are mutually exclusive, and `--backup`
  appends it as a backup origin.
- Destructive commands (`delete`, `rm-deployment`) ask for confirmation; only
  pass `-y/--yes` when the user explicitly asked to delete something.

## Error handling

- `401` → API key missing or invalid. Tell the user to run
  `furcdn config set-key <key>`.
- `403` → the domain doesn't belong to this account's API key.
- `429` → rate limited; wait, don't retry immediately in a loop.
- `403 pages_beta_required` → Pages is beta-gated; tell the user to redeem a
  code with `furcdn pages beta redeem <code>`.
- `403 pages_banned` / `pages_site_suspended` → the account or site was
  suspended; don't try to work around it, point the user to support/dashboard.
- `413 pages_quota_exceeded` / `pages_site_too_large` → show `furcdn pages
  usage` so the user can see the 100MB account quota / 20MB per-site limit.
- `pages_domain_*` / existing domain error codes from `pages bind` → surface
  the server message as-is (domain already exists, plan domain limit, cluster
  not allowed, …); don't retry blindly.
- Cluster switch: `403 您的套餐未包含此叢集` / `403 …需要實名認證` → tell the
  user to upgrade or complete real-name verification; `409` → concurrent change,
  re-read the domain and retry; `502` → server rolled back, retry later.
- Network errors → report the failure; don't silently retry indefinitely.

## Notes

- Prefer `--json` output when you need to parse results programmatically;
  use the plain table output when just showing something to the user.
- This CLI can also run as an MCP server (`furcdn mcp`) exposing a handful of
  the most common operations as MCP tools (including
  `furcdn_domains_origin_policy_get/set`, `furcdn_domains_origin_probes`,
  `furcdn_domains_origin_set`, and the `furcdn_pages_*` tools) — see the repo
  README for the current list if
  MCP tool access is preferred over shelling out to the CLI.
- Full domain management (`furcdn domain`, session login) covers CRUD,
  `origin` (origin/SNI settings, per-origin weight/backup/probe fields, and the
  `policy`/`probes` subcommands for origin selection), `tls`
  (force-https/http2/ech), `cache-rules`, `waf`, `ssl`, `dns-check`, and `logs`
  — see `furcdn domain --help` and `furcdn domain <subcommand> --help` for
  exact flags before using them.
- Destructive operations (domain delete, passkey delete, password change)
  require `--verify-code` (an email code from `furcdn account send-code`)
  and/or interactive confirmation — don't try to bypass these.
