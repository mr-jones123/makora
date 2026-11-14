# Auth internals

`apps/makora/src/auth/`. What the user sees: [features/accounts.md](../features/accounts.md).

## Contract

`types.ts` defines `AuthStore`, which extends pi-ai's `CredentialStore`:

- `read`, `list`, `modify`, `delete` act on each provider's **active** account, so pi-ai's `Models` reads and
  refreshes it like a single credential, unchanged.
- `accounts(providerId?)`, `activate`, `remove` manage accounts.
- `saveLogin(providerId, { credential, identity, subscription })` stores a login: it replaces the account with the same
  identity or adds a new one, and makes it active.

`AccountSummary` (no secrets) carries id, label, type, active, subscription, identity, `loginAt`, and `grantExpiresAt`
(login time + 30 days for Anthropic OAuth).

## The file

`~/.makora/auth.json`, validated with pi-schema on every read (it is a trust boundary):

```json
{
  "version": 1,
  "providers": {
    "anthropic": {
      "active": "<account id>",
      "accounts": [
        {
          "id": "<uuid>",
          "label": "you@example.com (Team)",
          "credential": { "type": "oauth", "access": "…", "refresh": "…", "expires": 0, "account": {}, "organization": {} },
          "identity": { "email": "…", "accountUuid": "…", "organizationUuid": "…", "organizationName": "Team" },
          "subscription": true,
          "loginAt": 0
        }
      ]
    }
  }
}
```

- Created with mode 0600 in a 0700 directory; written to a temp file and renamed, so readers never see half a file.
- A corrupt file, or one whose `active` names no account, is an error naming the path; it is never rewritten.
- Writes hold a cross-process `proper-lockfile` lock on `<file>.lock` plus one in-process promise chain.
  Known gap: `proper-lockfile`'s stale-lock takeover can grant a lock twice after a crash; the plan is to switch to the
  SQLite lock sessions use ([roadmap.md](../roadmap.md)).

## Identity

Two logins are the same account when their organization uuids are equal and their account uuids (else emails) are
equal. A token is scoped to one organization, so one person's Team seat and personal plan stay separate. Labels are
`email (organization)`, else `<provider> <n>`. When a removed account was active, the most recent remaining login
becomes active (ties go to the later one in the file).

## Login

`login.ts` `loginAccount(models, store, providerId, type, interaction)` runs the provider's own login
(`provider.auth.oauth.login` or the API-key login) the same way `Models.login` does, then calls `saveLogin`. It does
not call `Models.login`, which would overwrite the single credential. Identity comes from the credential's extra
`account` and `organization` fields.

The pi-ai change that makes this possible: `packages/ai/src/auth/oauth/anthropic.ts` keeps `account` and
`organization` from Anthropic's token response in the credential, and refresh spreads the stored credential so they
survive. The flow itself is pi's: client id `9d1c250a-…`, PKCE, `claude.ai/oauth/authorize`,
`platform.claude.com/v1/oauth/token`, loopback callback on port 53692 or paste-the-code.

## Plan usage

`usage.ts` `fetchPlanUsage` (Anthropic OAuth only): gets a fresh token through `models.getAuth`, calls
`GET https://api.anthropic.com/api/oauth/usage` with `anthropic-beta: oauth-2025-04-20`, and parses `five_hour` →
`5h`, `seven_day` → `7d`, `seven_day_<x>` and scoped weekly limits → `7d <x>`. Any failure (network, non-2xx, 15 s
timeout, unexpected body) returns undefined and the label shows no usage. The response shape follows oh-my-pi's parser
and has not been checked against a live response.

## What makora does not do

No Claude Code impersonation: no `x-anthropic-billing-header` or body checksum, no device-id `metadata.user_id`, no
client-mimicking headers, no adopting a Claude Code version from server rejections, no automatic account rotation on
limits, no tool-name prefixing. `PI_AI_CLAUDE_CODE_VERSION` only overrides the version string pi already sends. See
[decisions.md](../decisions.md).
