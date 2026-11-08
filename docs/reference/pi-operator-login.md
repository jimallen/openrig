# A Pi seat's login: the operator's, by a declared link (OF-279)

A new Pi seat starts with an empty login. Pi itself writes a 2-byte `{}` `auth.json` into the seat's agent
directory (`<state>/pi/<seat>/agent`) the first time it runs, and the seat then fails on its first message with
"No API key found for <provider>". OpenRig does not copy the operator's login. It can **link** it.

## Turning it on

- **Per host: `pi.operator_login_dir`.** The operator's Pi agent folder (the one holding `auth.json`), an absolute
  path with no `..`. Set it with `rig config set pi.operator_login_dir <folder>` (environment name
  `OPENRIG_PI_OPERATOR_LOGIN_DIR`). Unset (the default) links nothing. It is read at every launch, resume, restore
  and fork, so a change reaches a seat's next start.
- **Per member, for `models.json`: `pi: { link_operator_models: true }`.** Only some seats need the operator's
  custom providers (for example an ollama provider). With it, `<agent dir>/models.json` is linked to
  `<folder>/models.json` as well. Without it `models.json` is never touched.
  A member that declares both `pi.link_operator_models` and `model_overrides` is refused when the spec is checked:
  a linked `models.json` is the operator's file, and the overrides are written into the seat's own. Use one or the
  other.

## What the runner does at each launch

| The seat's `auth.json` is | The runner |
|---|---|
| absent | links it to `<folder>/auth.json` |
| exactly 2 bytes and parses as `{}` (Pi's own stub) | replaces it with the link (a temp link renamed over it) |
| any other regular file | leaves it alone and uses it: it holds that seat's own login |
| a link to the operator's file | leaves it; logs the line below |
| a link somewhere else | leaves it alone; the launch log names where it points |

The link step itself reads one file: the parse of a seat's own 2-byte `auth.json`. It only checks (stat, realpath) that the operator's
files exist and are regular files, and that they resolve outside the Pi state root (a folder or link that leads into a seat's own
directory, or to the seat's own file, is refused: it would be a seat's file, not the operator's login). A regular seat `models.json` is left alone
and named in the log.

**The runner does parse the operator's `auth.json` (and `models.json`, when linked) afterwards, through the link.** Its credential check
(the same one that produced the launch notice before this change) reads the seat's `auth.json` and `models.json` to classify the credential
source for the provider the spec names. That is a parse only: nothing from the file is printed, copied or written, a parse error is reported
as "unknown" without its message, and the operator's files are never opened for writing by the runner. (Pi itself, once started, reads and
rewrites the file; that is the shared-login section below.)

**It never creates a dangling link.** If `<folder>/auth.json` (or `models.json`, when declared) is missing or is not a
regular file, the launch is refused before Pi starts: Pi's `ensureFileExists` writes `{}` when `existsSync` is false, and
`existsSync` follows the link, so a dangling link would make Pi create `{}` inside the operator's own folder. The seat
and agent directories are checked like the `model_overrides` writer checks them: a symlinked seat or agent directory
refuses the launch.

## A launch with no credential is refused

The runner refuses a launch before Pi starts (exit 78, one line on the pane naming the provider and the fixes) only when all of these hold:

- the provider the spec names (the part of `model` before the first `/`) is in a table of providers whose every credential source in Pi
  1.4.0 is an environment variable this check can see by name, besides the stored sign-in and `models.json` key it also reads. The
  table is **re-derived by behaviour**, not read off one file: `scripts/measure-pi-credential-env.mjs <pi-ai dist dir>` loads Pi's builtin
  providers and finds, for each, the sets of environment names that make its api-key resolver return a credential. That found two things
  `env-api-keys.js` alone does not show: anthropic's workload identity federation (`ANTHROPIC_FEDERATION_RULE_ID`,
  `ANTHROPIC_ORGANIZATION_ID` and `ANTHROPIC_IDENTITY_TOKEN_FILE` together, `providers/anthropic.js`) and cloudflare's credentials
  (`CLOUDFLARE_API_KEY` with `CLOUDFLARE_ACCOUNT_ID`, and `CLOUDFLARE_GATEWAY_ID` for the gateway). Where several names are needed
  together, any one of them present counts as "present" (fewer refusals is the safe side). `openai-codex` is oauth only (a stored sign-in or
  a `models.json` key) and reads no environment;
- the seat has no stored sign-in or key for it in `auth.json` or `models.json`;
- none of that provider's names is present in the seat's environment. A name passed through `env_passthrough` counts;
- no Pi extension is configured (or the extension configuration could not be read);
- **the seat's Pi is the version the table was measured on (1.4.0).** Only when a refusal is the verdict, the runner runs one bounded
  `pi --version` (3 s, the environment and PATH the real Pi gets). Any other version, or none readable, withholds the refusal and the log
  says the table needs re-measuring for that Pi (run the script above and update the table). After a Pi upgrade, re-measure and bump
  `PI_CREDENTIAL_TABLE_PI_VERSION`.

Everything else keeps the advisory notice and the launch continues: a provider the table does not name (custom providers such as ollama,
extension providers, anything newer than the measured Pi), `google-vertex` (an api key variable, but also Application Default Credentials
found through a file check) and `amazon-bedrock` (AWS profile, roles and container credentials: ambient), and "unknown" (no provider named,
an unreadable or odd file, a key written as `$VAR` or `!command`).

## The shared login: what is and is not known

Every launch that uses the link logs one line saying the login is shared with the operator's own Pi and every other
seat linked to it. **Concurrent token refresh across those processes is not proven safe.** Measured on the installed Pi
1.4.0 (`~/.pi/agent/install/releases/1.4.0/node_modules`), with the server side unmeasured:

- Refresh tokens are replaced on every refresh: `@earendil-works/pi-ai/dist/auth/oauth/openai-codex.js:99-107` requires
  a `refresh_token` in the response and stores it. Pi's own comment says "the provider may already have rotated the
  refresh token" (`pi-ai/dist/auth/resolve.js:53-56`).
- Pi serialises refreshes with `proper-lockfile` on `<auth path>.lock`, with `realpath: false`
  (`pi-coding-agent/dist/core/auth-storage.js:91`; `proper-lockfile/lib/lockfile.js:12`). The lock directory is therefore
  next to each process's **own** path, not the operator's file. Measured with dummy files: with seat1 holding its lock only
  `seat1/auth.json.lock` existed, and a second seat sharing the target acquired its lock after 0 ms. The re-check "needs
  refresh?" under the lock (`resolve.js:75-76`) cannot see another process's refresh in that window.
- All sharers hold the same `expires`, and refresh when under 5 minutes remain (`resolve.js:102`), so two active sharers
  tend to refresh in the same window, both presenting the same refresh token.
- Pi writes the file in place (`writeFileSync`, `auth-storage.js:71,147`): the link survives a refresh and the
  operator's file is what is rewritten; the write is not atomic.
- A failed refresh writes nothing (`resolve.js:78-82`).

What this does not establish is what the provider's server does with a refresh token presented twice (accept both, reject the
second, or revoke the token family). If it revokes, one of the sharers, the operator's own Pi included, would need to
log in again. This was measured nowhere with a real login, by decision. A 2026-11-02 incident with Codex (not Pi) on
Sparky, where a linked `auth.json` went from 3871 to 28 bytes, is the nearest evidence; its cause was not established.
A seat that must never share can keep its own sign-in: a regular `auth.json` with a login is left alone.
