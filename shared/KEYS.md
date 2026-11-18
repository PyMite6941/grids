# AI keys & subscriptions

Both apps read the same local `.env`, with the same rules, from `web/lib/keyring.js` and
`desktop/src/grids/ai/KeyRing.java`. Add or remove connections from the app's AI → Keys
screen, or edit the file by hand. Edits apply on the next request, with no restart.

## Where the file is

1. `GRIDS_ENV_FILE`, if set.
2. Otherwise `grids/.env` at the repo root. The web server uses this path, and the desktop
   app finds it by walking up to the folder that contains `shared/FORMAT.md`.
3. Otherwise `~/.grids/.env`, used by an installed desktop copy.

`.env` and `.grids-usage.json` are git-ignored. Never commit them.

## Format

| Line | Meaning |
|---|---|
| `AI_KEY_<NAME>="..."` | An API key. `NAME` uses A–Z, 0–9 and `_` (up to 32 characters) |
| `AI_KEY_<NAME>_LIMIT=1000` | Requests per day before Auto stops picking it. A key you pick by name also stops at its limit |
| `AI_KEY_<NAME>_BASE_URL=...` | That key's provider (any OpenAI-compatible URL). Defaults to `AI_BASE_URL`, then Groq |
| `AI_KEY_<NAME>_MODEL=...` | That key's model. Defaults to `AI_MODEL`, then `openai/gpt-oss-120b` |
| `AI_SUB_<NAME>=claude\|codex\|gemini` | A subscription (see below). Also takes `_LIMIT` and `_MODEL` |
| `AI_SUB_<NAME>_BIN=...` | Path to the CLI, if it isn't on PATH. Set this by hand only |
| `AI_KEY_SELECT=auto\|<NAME>` | The default connection |
| `AI_API_KEY=...` | A legacy single key. It shows up as `DEFAULT` |

With no connections at all and a `localhost` base URL (Ollama, LM Studio), you get a
keyless `LOCAL` connection.

## Usage and switching

- Usage is counted per UTC day in `.grids-usage.json`, next to the `.env`: requests, tokens
  and rate-limit hits. That file holds names and counts only, never keys.
- **Auto** picks the connection with the lowest used/limit fraction. A connection with no
  limit counts as having a limit of 10,000. It skips any connection that has hit its limit
  or is cooling down.
- If a request fails with 401, 402, 403 or 429, Auto tries the next connection:
  - a 429 cools that connection down for `retry-after` seconds, or 60 s if none is given;
  - a 401, 402 or 403 (bad key or out of credit) cools it down for 1 hour.
- A 400 never fails over, since the same request would fail on every key.
- A connection you pick by name is the only one tried; Grids never switches away from it
  silently. Its daily limit still applies. A cooldown doesn't, because picking it by name
  counts as a deliberate retry.

## Subscriptions

These use a plan you already pay for, through the vendor's official CLI, signed in with your
account. Grids runs the CLI as a subprocess with no tools enabled, in an empty temp folder,
and sends the prompt on stdin. It never reads or reuses the CLI's login tokens.

| Type | CLI | Sign in |
|---|---|---|
| `claude` | Claude Code (`claude`) | Run `claude` once and sign in |
| `codex` | Codex CLI (`codex`) | Run `codex login` and choose "Sign in with ChatGPT" |
| `gemini` | Gemini CLI (`gemini`) | Run `gemini` and choose "Login with Google" |

The CLIs can't call functions, so the model answers in the JSON format described in
`ai/text-protocol.md`. Its actions are then checked against the same tool schemas as
API replies.

Subscriptions are personal. The web server only offers them when it is bound to loopback
(set `ALLOW_SUBSCRIPTIONS=1` to override). A hosted Grids must never let visitors spend one
person's plan.

## Web server switches

| Variable | Default | Effect |
|---|---|---|
| `ALLOW_KEY_EDIT` | on only when bound to loopback | Allows the Keys screen to write the `.env`. It also requires a same-origin JSON request with a loopback `Host` |
| `ALLOW_SUBSCRIPTIONS` | on only when bound to loopback | Allows subscription connections |
| `ALLOW_CUSTOM_PROVIDER` | off | Lets a browser send its own base URL, model and key with each request |
