# XC League - Full Code Review

**Date:** 2026-03-27
**Scope:** Complete repository audit (backend, frontend, config, dependencies, security)

---

## Critical Issues

### 1. Exposed Secrets in Repository

**Severity: CRITICAL**

- `.env` contains Google OAuth Client ID/Secret, full RSA-2048 private key, bootstrap admin email, and OAuth state secret
- `README.md` documents the Google OAuth Client ID and Secret (lines 55-57)
- PEM key files exist in the repo root (`private.pem`, `private-pkcs8.pem`, `public.pem`) -- these may have been committed before `*.pem` was added to `.gitignore`

**Remediation:**
1. Rotate all Google OAuth credentials immediately
2. Regenerate RSA keypair
3. Remove PEM files from git history (`git filter-branch` or BFG)
4. Strip secrets from README
5. Use a secrets manager for production

### 2. NODE_ENV=test Authentication Bypass

**Severity: HIGH** | `src/auth.ts:454-475`

When `NODE_ENV=test`, any request with an `x-test-user-id` header authenticates as that user -- including super-admin functions. If a production environment accidentally sets `NODE_ENV=test`, full auth bypass is possible.

```typescript
if (process.env['NODE_ENV'] === 'test') {
  const testUserId = (request.headers as Record<string, string>)['x-test-user-id'];
  if (testUserId) { /* bypasses all auth */ }
}
```

**Remediation:**
- Add a secondary guard (e.g., check for a test-only secret or a compile-time flag)
- Log a loud warning if this code path is ever hit
- Consider stripping the bypass entirely in production builds

### 3. Super Admin Bootstrap Runs on Every Startup

**Severity: HIGH** | `src/migrate.ts:80-122`

The `BOOTSTRAP_SUPER_ADMIN_EMAIL` user is promoted to super-admin on every migration run, not just the first time. If someone signs up with that email, they're silently promoted.

**Remediation:**
- Only bootstrap once (track in a `settings` table)
- Require manual confirmation for first-time admin setup

---

## Moderate Issues

### 4. No League Visibility / Privacy Model

**Severity: MODERATE** | `src/routes/leagues.ts:101-113`, `src/auth.ts:571`

The `leagues` table has no `is_public` column. The `makeResolveLeagueHook` resolves any league by slug without checking membership, so `GET /leagues/:slug` returns full league details (name, descriptions, logo) to any authenticated user.

**Remediation:**
- Add `is_public BOOLEAN DEFAULT 1` to leagues
- Enforce: if `!league.is_public && !request.membership` return 403

### 5. Soft-Delete Orphaning (Missing Cascade)

**Severity: MODERATE** | `src/routes/leagues.ts` (task deletion), `src/schema.sql`

When a task is soft-deleted, its `flight_submissions`, `flight_attempts`, and `task_results` are not cascaded. Queries that JOIN on `tasks WHERE deleted_at IS NULL` silently drop orphaned data, which can cause invisible gaps in standings.

**Remediation:**
- Soft-delete related submissions/results when a task is deleted, OR
- Add `ON DELETE CASCADE` to the FK constraints

### 6. No Rate Limiting

**Severity: MODERATE** | `src/server.ts`

No rate limiting is configured on any endpoint. OAuth callback, file upload, and login endpoints are vulnerable to brute-force and abuse.

**Remediation:**
- Add `@fastify/rate-limit` with sensible defaults (e.g., 100 req/min per IP, stricter on auth endpoints)

### 7. Markdown XSS Risk

**Severity: MODERATE** | `frontend/src/pages/HomePage.tsx:383`, `LeagueSettingsPage.tsx:130`

League descriptions (`fullDescription`) are rendered via `<ReactMarkdown>` without explicit allowed-element restrictions. While react-markdown strips raw HTML by default, it still renders links which could use `javascript:` or `data:` protocols.

**Remediation:**
- Sanitize markdown server-side on save
- Configure react-markdown with `allowedElements` or add `rehype-sanitize`
- Deploy a Content Security Policy that blocks `javascript:` URIs

---

## Low-Severity Issues

### 8. Content-Disposition Header Injection

**Severity: LOW** | `src/upload.ts:434`

IGC filenames from user uploads are placed directly into the `Content-Disposition` header without escaping:

```typescript
.header('Content-Disposition', `attachment; filename="${row.igc_filename}"`)
```

A crafted filename (e.g., `"x".igc`) could break the header syntax.

**Remediation:**
```typescript
const safeName = row.igc_filename.replace(/[^\w.-]/g, '_');
reply.header('Content-Disposition', `attachment; filename="${safeName}"`);
```

### 9. Unvalidated Image URLs

**Severity: LOW** | `frontend/src/pages/LeaguesListPage.tsx:119`

`league.logoUrl` is rendered directly in an `<img src>` tag without origin validation. An admin could set a tracking pixel or malicious URL.

**Remediation:**
- Validate URLs server-side (allowlist of domains or proxy through backend)
- Add CSP `img-src` directive

### 10. No HTTPS Enforcement at App Level

**Severity: LOW** | `src/server.ts`

The app relies entirely on a reverse proxy for TLS. The `secure` cookie flag is only set when `secureCookies` config is true (production). If the reverse proxy is misconfigured, cookies could be sent in cleartext.

**Remediation:**
- Add HSTS header in production
- Consider `Strict-Transport-Security: max-age=63072000; includeSubDomains`

---

## Positive Findings

| Area | Status | Notes |
|------|--------|-------|
| SQL Injection | Safe | All queries use parameterized statements (`?` placeholders) throughout |
| JWT Implementation | Good | RS256, 7-day expiry, token version revocation, issuer validation |
| OAuth CSRF Protection | Good | HMAC-SHA256 state param with 10-min expiry, cookie comparison |
| Cookie Security | Good | HttpOnly, Secure (prod), SameSite=lax, no token in localStorage |
| Route Authorization | Good | Consistent use of `requireAuth`, `requireLeagueAdmin`, `requireLeagueMember`, `requireSuperAdmin` |
| League Data Isolation | Good | All league-scoped queries filter by `league_id` via resolved league hook |
| Transaction Usage | Good | Multi-step operations (uploads, season creation, task reordering) wrapped in transactions |
| File Upload Validation | Good | Extension check, size limit (5MB), magic byte verification for IGC files |
| Input Validation | Good | Slug regex, date parsing, wind/weight rating whitelists |
| Error Messages | Good | Generic user-facing errors, no stack traces leaked |
| Soft Deletes | Good | Consistent `deleted_at` pattern across all user-facing tables |
| Audit Logging | Good | Admin actions logged to `admin_audit_log` with actor, target, details |
| TypeScript Strict Mode | Good | Enabled for both server and frontend |
| Docker Build | Good | Multi-stage, non-root user, production-only deps |
| No Console Logging | Good | No `console.log` of sensitive data in frontend production code |
| No localStorage Tokens | Good | Auth tokens stored exclusively in HttpOnly cookies |
| Test Isolation | Good | In-memory SQLite per test, proper fixtures, no shared state |

---

## Recommendations by Priority

### Before Production / Public Release
1. Rotate all exposed credentials (OAuth, RSA keys)
2. Remove secrets from README and git history
3. Harden the test-mode auth bypass
4. Add rate limiting to auth and upload endpoints
5. Add CSP headers

### Next Sprint
6. Implement league visibility (public/private)
7. Cascade soft-deletes for tasks -> submissions/results
8. Sanitize markdown on save + add rehype-sanitize on render
9. Sanitize Content-Disposition filenames
10. Add HSTS header in production

### Ongoing
11. Run `npm audit` regularly
12. Consider adding GDPR data export / hard-delete capability
13. Add monitoring/alerting for auth bypass code path
