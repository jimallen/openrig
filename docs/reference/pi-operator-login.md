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

The one file read is the parse of a seat's 2-byte `auth.json`. The operator's files are only checked to exist and to
be regular files; they are never opened by the link. A regular seat `models.json` is left alone and named in the log.

**It never creates a dangling link.** If `<folder>/auth.json` (or `models.json`, when declared) is missing or is not a
regular file, the launch is refused before Pi starts: Pi's `ensureFileExists` writes `{}` when `existsSync` is false, and
`existsSync` follows the link, so a dangling link would make Pi create `{}` inside the operator's own folder. The seat
and agent directories are checked like the `model_overrides` writer checks them: a symlinked seat or agent directory
refuses the launch.

## A launch with no credential is refused

When the provider the spec names (the part of `model` before the first `/`) has no stored sign-in, no `models.json`
key and no managed environment key in the seat, the runner refuses the launch before Pi starts (exit 78, one line on
the pane naming the provider and the fix: set `pi.operator_login_dir`, or sign in for this seat). Two things keep a
launch going:

- **"unknown"** (no provider named, an unreadable or odd file, a key written as `$VAR` or `!command`): the advisory
  notice stays, because the seat may hold a login the metadata cannot show.
- **A configured Pi extension** (or an extension configuration that cannot be read): an extension can supply a provider and
  its credential. The launch continues and the log line says so.

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
