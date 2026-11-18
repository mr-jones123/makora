# Login and accounts

Makora logs in to model providers with pi-ai's login flows and keeps several accounts per provider. Internals:
[architecture/auth.md](../architecture/auth.md).

## Logging in

`/login` lists every provider that has an OAuth or API-key login, then runs its flow:

- OAuth: makora shows the URL and opens your browser when it can; some flows ask you to paste a code back.
- API key: a masked input.

Subscription logins pi-ai supports include Anthropic (Claude Pro/Max), OpenAI (ChatGPT/Codex), GitHub Copilot, Kimi,
xAI and Meta.

## Accounts

- Each provider can hold several accounts; one is active and pays for requests.
- Logging in with a new identity adds an account and makes it active. Logging in again as an existing account
  replaces its token and starts a new grant.
- An account is a person in one organization: a Team seat and a personal plan of the same person are two accounts,
  labeled `email (organization)`.
- `/accounts` lists them; pick one to make it active or remove it. `/logout` removes the active account.
- API-key logins have no identity, so each one adds a new account.

## The status row label

The right side of the status row says how much of the current login's plan is used, and warns when something needs
you. It does not name the account, which crowded out the context gauge; `/accounts` shows which one is active.

| Label | Means |
| --- | --- |
| `5h 42%` | A subscription login; its fullest plan usage window |
| (empty) | A login without plan usage, such as an API-key account, or before the usage request answered |
| `5h 42% · login expires soon · /login` (warning color) | An Anthropic grant ends within 5 days |
| `fake model` | `--fake` |
| `not logged in · /login` (warning color) | No account for this provider |
| `api key · <source>` | No stored account, but the provider has a key from its environment variable |
| `auth file unreadable` (warning color) | `~/.makora/auth.json` is corrupt or not readable |

A narrow status row shortens the folder from its start, then drops it, before the context gauge loses anything. Anthropic ends an OAuth grant about
30 days after login regardless of refreshes (observed by oh-my-pi, not documented by Anthropic); log in again to start
a new one. Plan usage refreshes every 5 minutes and is shown only when Anthropic's usage endpoint answers.

## How Anthropic bills this

Anthropic bills Claude Pro/Max usage from third-party harnesses, makora included, as **extra usage**, per token, not
against plan limits. Makora does not impersonate Claude Code to change that (no billing header, request checksum,
device fingerprint or automatic account rotation); doing so is against Anthropic's terms and risks the account. See
[decisions.md](../decisions.md).

## Not verified yet

Behavior against a real Claude Pro/Max login has not been tested: whether the token response includes the account
and organization (if not, accounts get labels like `anthropic 1` and every login adds one), and whether the usage
endpoint answers. See [roadmap.md](../roadmap.md).
