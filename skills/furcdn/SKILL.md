---
name: furcdn
description: Use the furcdn CLI to manage FurCDN domains and accounts — list/create/update domains, purge cache, manage SSL/WAF/cache rules/origins, and self-service account tasks (billing, tickets, plan). Never use it for admin/management-panel operations — the CLI does not support those by design. Use when the user asks to manage their FurCDN domain, cache, SSL, WAF, or account.
---

# FurCDN CLI

`furcdn` is the official FurCDN command-line tool. It has two auth modes:
API Key (`furcdn config set-key`, covers `/api/v1/*` — `furcdn domains`/`furcdn ssl`)
and session login via OAuth device flow (`furcdn login`, covers `furcdn domain`
and `furcdn account` — full domain management, billing, tickets, etc.).

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
furcdn domains purge example.com
furcdn domains purge 42 --json
```

This is rate-limited (10 times per 5 minutes per account). If the command
fails with a `429` error, tell the user to wait a few minutes before
retrying — don't loop retrying it yourself.

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

## Error handling

- `401` → API key missing or invalid. Tell the user to run
  `furcdn config set-key <key>`.
- `403` → the domain doesn't belong to this account's API key.
- `429` → rate limited; wait, don't retry immediately in a loop.
- Network errors → report the failure; don't silently retry indefinitely.

## Notes

- Prefer `--json` output when you need to parse results programmatically;
  use the plain table output when just showing something to the user.
- This CLI can also run as an MCP server (`furcdn mcp`) exposing a handful of
  the most common operations as MCP tools — see the repo README for the
  current list if MCP tool access is preferred over shelling out to the CLI.
- Full domain management (`furcdn domain`, session login) covers CRUD,
  `origin` (origin/SNI settings), `tls` (force-https/http2/ech), `cache-rules`,
  `waf`, `ssl`, `dns-check`, and `logs` — see `furcdn domain --help` and
  `furcdn domain <subcommand> --help` for exact flags before using them.
- Destructive operations (domain delete, passkey delete, password change)
  require `--verify-code` (an email code from `furcdn account send-code`)
  and/or interactive confirmation — don't try to bypass these.
