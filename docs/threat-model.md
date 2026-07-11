# Threat model: cross-user access, token theft, prompt injection, artifact filenames

Written as part of the Phase 7 security-hardening pass (see `plan.md`). Most
of the concrete mitigations already existed in the code from earlier rounds;
this note collects them in one place, names what's still an accepted risk,
and points at the file that owns each mitigation so future changes don't
regress it silently.

## Cross-user access

**Risk**: user A reads/writes user B's chat sessions, messages, artifacts, or
provider credentials.

**Mitigated**:

- Every REST route that touches a session-scoped resource calls
  `ChatSessionsService.getOwned(userId, sessionId)` before doing anything
  else (`backend/src/chat/chat-sessions.controller.ts`,
  `backend/src/artifacts/artifacts.controller.ts`) — a 404/403 there stops
  the request before any data lookup.
- `ProviderSettingsService` scopes every query by `userId` from the JWT, not
  from any client-supplied id (`backend/src/provider-settings/provider-settings.service.ts`).
- `RefreshToken` rows are looked up by `id` (`tokenId` from the JWT payload)
  and then compared against `row.userId !== userId` before being trusted
  (`backend/src/auth/auth.service.ts` `refresh()`), so a stolen/forged
  refresh JWT for one user can't be replayed against another user's token
  row even if the `jti` happened to collide.
- The WebSocket gateway checks session ownership on `session:join` before
  adding the socket to that session's room (`backend/src/realtime/chat.gateway.ts`
  — outside this pass's remit, not modified here, but confirmed present).

**Open gap (documented, not fixed here)**: per the app's own
`ข้อจำกัดที่ทราบ` section in `README.md`, `chat:stop` does not verify the
stopping user owns the message being stopped, and artifact socket handlers
don't filter events by the client's current session. Both are pre-existing
gaps in `realtime/chat.gateway.ts`, which is another agent's active
territory during this pass — flagged here rather than fixed to avoid a merge
conflict.

## Token theft

**Risk**: an attacker obtains a user's access or refresh token and uses it
to impersonate them.

**Mitigated**:

- Access tokens are short-lived (`JWT_ACCESS_EXPIRES_IN`, default 15m) and
  kept in browser memory only (per `README.md`'s auth flow), not
  `localStorage` — limits the window and surface for XSS-based theft.
- Refresh tokens are `httpOnly` + `SameSite=Strict` cookies scoped to
  `/api/auth` (`backend/src/auth/auth.controller.ts`), so they're
  unreadable from JS and not sent cross-site.
- Refresh tokens are hashed (SHA-256) at rest, not stored plaintext
  (`hashToken()` in `auth.service.ts`) — a database read doesn't hand over
  usable tokens.
- Rotation + reuse detection: every refresh mints a new token and revokes
  the old one; if a revoked token is presented again (the signal that
  someone has a copy of an already-rotated token — i.e. theft), the entire
  token family is revoked, forcing re-authentication everywhere
  (`auth.service.ts` `refresh()` / `revokeFamilyAndAudit()`). This pass adds
  an audit-log entry (`auth.refresh.reuse_detected`) at that path so a theft
  event is now visible in logs, not just felt as "I got logged out".
- `secure` cookie flag is tied to `NODE_ENV === 'production'`
  (`auth.controller.ts`) — verified during this pass, not changed, since a
  real deploy needs a TLS-terminating layer for `Secure` to have teeth (see
  the HTTPS-enforcement note in `frontend/nginx.conf` and this pass's
  report).
- Login brute-forcing is throttled per-IP (5/min on `/api/auth/login`,
  `auth.controller.ts`), and every login attempt (success or failure) is now
  audit-logged with the user id (when known) and IP, not the password/email
  (`AuditLogService`, `backend/src/common/audit-log.service.ts`).

**Accepted risk / not addressed this pass**: no per-account lockout beyond
the IP-based throttle — deliberately, since a hard per-account lockout lets
an attacker lock a *victim* out by deliberately failing their login
repeatedly (a DoS on the legitimate user), which `plan.md` explicitly warns
against. The IP throttle plus reuse-detection-triggered mass revocation is
judged sufficient for this pass; a smarter exponential-backoff-per-(email,
IP) scheme is a reasonable future improvement but adds meaningful complexity
(in-memory state + TTL cleanup, or a new store) for a modest hardening gain
over what's already in place.

## Prompt injection

**Risk**: a malicious or compromised chat message tries to make the AI
ignore its system prompt, exfiltrate another user's data, or trick a user
into running/trusting malicious generated code.

**Not mitigated — accepted open risk.** Nothing in this codebase currently
detects or filters prompt-injection attempts in message content sent to
Ollama/Claude/OpenAI. This is a hard, actively-researched problem
(input/output filtering, structured tool-call boundaries, provider-side
guardrails) and doing it properly is out of scope for a hardening pass on an
otherwise-unrelated feature set. What *does* limit the blast radius even
without direct mitigation:

- Each user's data is already isolated by the cross-user-access controls
  above — a successful prompt injection in user A's own session can at
  worst make the AI misbehave *within A's own session*, since the AI has no
  tool/API access to other users' sessions, artifacts, or credentials (no
  function-calling/tool-use wired up in this app at all today).
- Artifact filenames extracted from AI output are strictly normalized
  (see below) before ever being used as a lookup key, so a prompt-injected
  response can't use a crafted filename to escape its own session's
  artifact namespace.
- Generated code is never executed server-side; it's only stored and shown
  in Monaco for the same user who requested it, so "AI writes malicious
  code" is a user-trust problem (the user is choosing to view/copy their own
  AI's output), not a server compromise.

If/when tool-use or cross-session AI capabilities are added, this section
needs to be revisited before shipping them.

## Artifact filename attacks

**Risk**: a filename from AI output or a user's manual edit is used for
path traversal, collides with another artifact, or otherwise escapes its
intended scope.

**Mitigated**: `normalizeArtifactFilename()` in
`backend/src/artifacts/artifacts.service.ts` runs on every artifact
filename before it's used anywhere:

- Rejects control characters, absolute paths (`/foo`, `C:\foo`), and any
  path segment equal to `..` (both directly and after
  `path.posix.normalize()`, so this also cannot be bypassed with e.g.
  `a/../../etc/passwd`-style tricks that only look safe pre-normalization).
- Caps filename length at 255 UTF-8 bytes (`MAX_ARTIFACT_FILENAME_BYTES`).
- Normalizes backslashes to forward slashes so Windows-style traversal
  attempts (`..\\..\\`) are caught by the same checks as POSIX ones.
- Every artifact row is additionally scoped by `sessionId` in its unique
  constraint (`@@unique([sessionId, filename, revision])` in
  `schema.prisma`), so even a validated filename can't collide across
  sessions/users.

Artifacts are not written to the filesystem today (per this function's own
doc comment) — this normalization is forward-looking protection for if/when
artifact export-to-disk is added, and costs nothing to keep enforced now.

## Summary table

| Threat                | Status                                             |
| ---------------------- | --------------------------------------------------- |
| Cross-user data access | Mitigated (ownership checks on every resource path) |
| Refresh token theft    | Mitigated (rotation, reuse detection, hashing, now audit-logged) |
| Access token theft     | Mitigated (short-lived, memory-only, httpOnly refresh cookie) |
| Account-lockout DoS    | Deliberately not implemented — IP throttle judged sufficient |
| Prompt injection       | **Open / accepted risk** — no mitigation, blast radius limited by existing isolation |
| Artifact filename traversal | Mitigated (`normalizeArtifactFilename`) |
| `chat:stop` cross-user | **Open gap** — pre-existing, owned by `realtime/chat.gateway.ts` |
