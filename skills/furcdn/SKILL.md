---
name: furcdn
description: Use the furcdn CLI to manage FurCDN domains — list domains, purge (refresh) cache, and upload custom SSL certificates. Use when the user asks to list their FurCDN domains, refresh/purge CDN cache, or upload/renew an SSL certificate for a FurCDN domain.
---

# FurCDN CLI

`furcdn` is the official FurCDN command-line tool. It wraps FurCDN's public,
API-key-authenticated endpoints (`/api/v1/*`). It does **not** cover
session-cookie-only dashboard features (billing, admin panel, DNS/WAF rule
editing, tickets) — those have no API-key endpoint yet, so don't attempt to
simulate a dashboard login to reach them.

## Prerequisites

Check whether `furcdn` is installed and configured before using it:

```bash
furcdn --version
furcdn config show
```

If `API key` shows `(未設定)` / "not set", ask the user for a FurCDN API key
(created on the dashboard's "API" page, format `fck_...`) and run:

```bash
furcdn config set-key <key>
```

Only the current user's own key should ever be used — never ask for or store
another person's key.

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
- This CLI can also run as an MCP server (`furcdn mcp`) exposing the same
  four operations as MCP tools — see the repo README if MCP tool access is
  preferred over shelling out to the CLI directly.
