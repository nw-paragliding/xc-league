// =============================================================================
// XC / Hike & Fly League Platform — Auth Middleware
//
// Provider:  Google OAuth 2.0 only at launch
// Token:     JWT (7-day expiry, no refresh)
//            Delivered as HttpOnly cookie (web) AND response body (API clients)
//            Middleware accepts either; cookie takes precedence
// Revocation: token_version on users table — increment to invalidate all tokens
// Tenant:    League resolved from :leagueSlug in path; membership checked per route
// =============================================================================

// =============================================================================
// DEPENDENCIES (types only — actual imports resolved by your module bundler)
// =============================================================================

// jose  — JWT sign/verify (Web Crypto API compatible, no Node crypto dependency)
// zod   — payload validation
// All route types below reference Fastify but are framework-agnostic in logic

import fp = require('fastify-plugin');

// ---------------------------------------------------------------------------
// Minimal Fastify stubs — replaced by real imports in your project
// (kept inline here so this file type-checks without installed packages)
// ---------------------------------------------------------------------------
declare const process: { env: Record<string, string | undefined>; }
declare class Buffer { static from(b: ArrayBuffer): { toString(enc: string): string }; }

interface FastifyRequest {
  params:  unknown;
  query:   unknown;
  body:    unknown;
  headers: { authorization?: string };
  cookies: unknown;
  log:     { error(obj: unknown, msg?: string): void };
  user:    AuthenticatedUser | null;
  league:  LeagueRecord | null;
  membership: MembershipRecord | null;
  server?: { config: AuthConfig };
}
interface FastifyReply {
  status(code: number): FastifyReply;
  send(payload?: unknown): FastifyReply;
  redirect(code: number, url: string): void;
  setCookie(name: string, value: string, opts: CookieOptions): FastifyReply;
}
interface CookieOptions {
  httpOnly?: boolean; secure?: boolean; sameSite?: string;
  path?: string; maxAge?: number; domain?: string;
}
type FastifyPluginAsync<O = unknown> = (app: {
  decorateRequest(key: string, val: unknown): void;
  addHook(name: string, fn: (req: FastifyRequest, reply: any) => Promise<void>): void;
}, opts: O) => Promise<void>;

// =============================================================================
// ENVIRONMENT CONFIGURATION
// All values must be present at startup — crash fast if any are missing.
// =============================================================================

export interface AuthConfig {
  /** RS256 private key (PEM) for signing JWTs — never leaves the server */
  jwtPrivateKeyPem: string;
  /** RS256 public key (PEM) for verifying JWTs */
  jwtPublicKeyPem: string;
  /** JWT issuer claim — e.g. "https://yourapp.com" */
  jwtIssuer: string;
  /** Google OAuth client ID */
  googleClientId: string;
  /** Google OAuth client secret */
  googleClientSecret: string;
  /** Absolute URL Google redirects to after consent — e.g. "https://yourapp.com/api/v1/auth/oauth/google/callback" */
  googleRedirectUri: string;
  /** Secure random string used to sign the OAuth state parameter */
  oauthStateSecret: string;
  /** Cookie name for the JWT */
  cookieName: string;
  /** true in production — sets Secure flag on cookies */
  secureCookies: boolean;
  /** Frontend URL for redirects (e.g. http://localhost:5173 in dev) */
  frontendUrl: string;
}

export function loadAuthConfig(): AuthConfig {
  if (process.env.NODE_ENV === 'test') {
    return {
      jwtPrivateKeyPem:    'test',
      jwtPublicKeyPem:     'test',
      jwtIssuer:           'test',
      googleClientId:      'test',
      googleClientSecret:  'test',
      googleRedirectUri:   'test',
      oauthStateSecret:    'test',
      cookieName:          'xcleague_jwt',
      secureCookies:       false,
      frontendUrl:         'http://localhost:5173',
    };
  }
  const required = [
    'JWT_PRIVATE_KEY_PEM',
    'JWT_PUBLIC_KEY_PEM',
    'JWT_ISSUER',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GOOGLE_REDIRECT_URI',
    'OAUTH_STATE_SECRET',
  ];
  for (const key of required) {
    if (!process.env[key]) throw new Error(`Missing required environment variable: ${key}`);
  }
  return {
    jwtPrivateKeyPem:    process.env.JWT_PRIVATE_KEY_PEM!,
    jwtPublicKeyPem:     process.env.JWT_PUBLIC_KEY_PEM!,
    jwtIssuer:           process.env.JWT_ISSUER!,
    googleClientId:      process.env.GOOGLE_CLIENT_ID!,
    googleClientSecret:  process.env.GOOGLE_CLIENT_SECRET!,
    googleRedirectUri:   process.env.GOOGLE_REDIRECT_URI!,
    oauthStateSecret:    process.env.OAUTH_STATE_SECRET!,
    cookieName:          process.env.COOKIE_NAME ?? 'xcleague_jwt',
    secureCookies:       process.env.NODE_ENV === 'production',
    frontendUrl:         process.env.FRONTEND_URL ?? (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:5173'),
  };
}

// =============================================================================
// JWT CLAIMS
// =============================================================================

/** Claims stored inside the JWT */
export interface JwtClaims {
  sub: string;           // user.id (UUID)
  email: string;
  displayName: string;
  isAdmin: boolean;      // global super-admin
  tokenVersion: number;  // must match users.token_version — increment to revoke
}

/** Parsed and validated JWT — attached to request as request.user */
export type AuthenticatedUser = JwtClaims & {
  userId: string;        // alias for sub — more readable in handlers
};

// =============================================================================
// JWT UTILITIES
// Uses RS256 (asymmetric) — private key signs, public key verifies.
// RS256 allows the public key to be shared with other services safely.
// =============================================================================

const JWT_ALGORITHM = 'RS256' as const;
const JWT_EXPIRY    = '7d';

/** Sign a JWT for a user. Call after login or account creation. */
export async function signJwt(claims: JwtClaims, config: AuthConfig): Promise<string> {
  // Dynamic import keeps jose tree-shakeable
  // In your project: import { SignJWT, importPKCS8 } from 'jose';
  const { SignJWT, importPKCS8 } = await import('jose' as any);
  const privateKey = await importPKCS8(config.jwtPrivateKeyPem, JWT_ALGORITHM);
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: JWT_ALGORITHM })
    .setIssuedAt()
    .setIssuer(config.jwtIssuer)
    .setExpirationTime(JWT_EXPIRY)
    .sign(privateKey);
}

/** Verify and decode a JWT. Returns null on any verification failure. */
export async function verifyJwt(
  token: string,
  config: AuthConfig,
): Promise<JwtClaims | null> {
  try {
    // In your project: import { jwtVerify, importSPKI } from 'jose';
    const { jwtVerify, importSPKI } = await import('jose' as any);
    const publicKey = await importSPKI(config.jwtPublicKeyPem, JWT_ALGORITHM);
    const { payload } = await jwtVerify(token, publicKey, {
      issuer: config.jwtIssuer,
      algorithms: [JWT_ALGORITHM],
    });
    // Validate required claims are present
    if (
      typeof payload.sub !== 'string' ||
      typeof payload['email'] !== 'string'
    ) {
      return null;
    }
    if (typeof payload['tokenVersion'] !== 'number') {
      return null;
    }
    return payload as unknown as JwtClaims;
  } catch (err) {
    return null;
  }
}

// =============================================================================
// OAUTH STATE PARAMETER
// Signed with HMAC-SHA256 to prevent CSRF. Contains a nonce + timestamp.
// State is set as a short-lived HttpOnly cookie before the redirect;
// verified on callback by comparing the cookie value with the query param.
// =============================================================================

/** Generate a signed state token. Returns { state, nonce }. */
export async function generateOAuthState(secret: string): Promise<{ state: string; nonce: string }> {
  const nonce = crypto.randomUUID();
  const timestamp = Date.now().toString();
  const payload = `${nonce}.${timestamp}`;
  const sig = await hmacSign(payload, secret);
  return { state: `${payload}.${sig}`, nonce };
}

/**
 * Verify an OAuth state token.
 * Returns the nonce if valid; throws if tampered or expired (> 10 minutes).
 */
export async function verifyOAuthState(state: string, secret: string): Promise<string> {
  const parts = state.split('.');
  if (parts.length !== 3) throw new Error('Invalid state format');
  const [nonce, timestamp, sig] = parts;
  const payload = `${nonce}.${timestamp}`;
  const expectedSig = await hmacSign(payload, secret);
  if (sig !== expectedSig) throw new Error('State signature mismatch');
  const age = Date.now() - parseInt(timestamp, 10);
  if (age > 10 * 60 * 1000) throw new Error('State token expired');
  return nonce;
}

async function hmacSign(payload: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return Buffer.from(sig).toString('hex');
}

// =============================================================================
// GOOGLE OAUTH FLOW
// =============================================================================

const GOOGLE_AUTH_URL     = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL    = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

/** Build the Google consent screen URL to redirect the user to. */
export function buildGoogleAuthUrl(state: string, config: AuthConfig): string {
  const params = new URLSearchParams({
    client_id:     config.googleClientId,
    redirect_uri:  config.googleRedirectUri,
    response_type: 'code',
    scope:         'openid email profile',
    state,
    access_type:   'online',   // no refresh token needed — we use our own long-lived JWT
    prompt:        'select_account',
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export interface GoogleUserInfo {
  sub: string;       // Google's stable user ID
  email: string;
  email_verified: boolean;
  name: string;
  picture: string | null;
}

/** Exchange an auth code for user info. Throws on any failure. */
export async function exchangeGoogleCode(
  code: string,
  config: AuthConfig,
): Promise<GoogleUserInfo> {
  // Step 1: exchange code for tokens
  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id:     config.googleClientId,
      client_secret: config.googleClientSecret,
      redirect_uri:  config.googleRedirectUri,
      grant_type:    'authorization_code',
    }),
  });
  if (!tokenRes.ok) {
    const body = await tokenRes.text();
    throw new Error(`Google token exchange failed: ${body}`);
  }
  const tokens = await tokenRes.json() as { access_token: string };

  // Step 2: fetch user info with access token
  const userRes = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!userRes.ok) throw new Error('Failed to fetch Google user info');
  const userInfo = await userRes.json() as GoogleUserInfo;

  if (!userInfo.email_verified) {
    throw new Error('Google account email is not verified');
  }
  return userInfo;
}

// =============================================================================
// USER PROVISIONING
// Find-or-create user from Google identity.
// =============================================================================

export interface UserRecord {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  isAdmin: boolean;
  tokenVersion: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Find-or-create user from a Google identity.
 *
 * Flow:
 *   1. Look up oauth_identities by (provider='google', provider_user_id=googleSub)
 *   2. If found → return user; optionally sync name/avatar if changed
 *   3. If not found → check if email already exists in users table
 *      a. If email exists → link this Google identity to the existing user
 *      b. If not → create new user + identity in a single transaction
 *
 * Email linking (step 3a) handles the case where a user previously signed up
 * via a different provider with the same email. At launch with Google-only
 * this is a no-op, but it future-proofs multi-provider support.
 */
export function findOrCreateGoogleUser(
  googleUser: GoogleUserInfo,
  db: any,
): UserRecord {
  // Step 1: look up by stable Google ID
  const existingIdentity = db.prepare(
    `SELECT user_id FROM oauth_identities
     WHERE provider = 'google' AND provider_user_id = ?`
  ).get(googleUser.sub) as { user_id: string } | undefined;

  if (existingIdentity) {
    // Sync profile fields in case they changed in Google
    db.prepare(
      `UPDATE users SET display_name = ?, avatar_url = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(googleUser.name, googleUser.picture ?? null, existingIdentity.user_id);
    
    const user = db.prepare(
      `SELECT * FROM users WHERE id = ?`
    ).get(existingIdentity.user_id) as UserRecord | undefined;
    
    if (!user) throw new Error('User record missing after identity lookup');
    return user;
  }

  // Step 3: no identity found
  return db.transaction((): UserRecord => {
    // Check if email exists (e.g. future second provider with same email)
    const existingUser = db.prepare(
      `SELECT * FROM users WHERE email = ?`
    ).get(googleUser.email) as UserRecord | undefined;

    const userId = existingUser?.id ?? crypto.randomUUID();

    if (!existingUser) {
      // New user
      db.prepare(
        `INSERT INTO users (id, email, display_name, avatar_url, is_super_admin, token_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, 1, datetime('now'), datetime('now'))`
      ).run(userId, googleUser.email, googleUser.name, googleUser.picture ?? null);
    }

    // Link Google identity
    db.prepare(
      `INSERT INTO oauth_identities (id, user_id, provider, provider_user_id, created_at)
       VALUES (?, ?, 'google', ?, datetime('now'))`
    ).run(crypto.randomUUID(), userId, googleUser.sub);

    const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId) as UserRecord | undefined;
    if (!user) throw new Error('User record missing after creation');
    return user;
  })();
}

// =============================================================================
// COOKIE HELPERS
// =============================================================================

const COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60; // 7 days, matches JWT expiry

export function setAuthCookie(reply: any, jwt: string, config: AuthConfig): void {
  reply.setCookie(config.cookieName, jwt, {
    httpOnly: true,
    secure:   config.secureCookies,
    sameSite: 'lax',    // 'lax' allows cookie on top-level navigations (OAuth redirect)
    path:     '/',
    domain:   config.secureCookies ? undefined : 'localhost', // Share cookie across ports in dev
    maxAge:   COOKIE_MAX_AGE_SECONDS,
  });
}

export function clearAuthCookie(reply: any, config: AuthConfig): void {
  reply.setCookie(config.cookieName, '', {
    httpOnly: true,
    secure:   config.secureCookies,
    sameSite: 'lax',
    path:     '/',
    domain:   config.secureCookies ? undefined : 'localhost', // Match cookie domain from setAuthCookie
    maxAge:   0,
  });
}

/** Extract JWT string from request — cookie takes precedence over Bearer header. */
export function extractToken(request: any, config: AuthConfig): string | null {
  // Cookie (web browser)
  const cookieToken = (request.cookies as Record<string, string>)[config.cookieName];
  if (cookieToken) return cookieToken;

  // Authorization: Bearer <token> (API clients)
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7).trim() || null;
  }

  return null;
}

// =============================================================================
// FASTIFY AUTH MIDDLEWARE
// Decorates request with `request.user` (AuthenticatedUser | null).
// Use requireAuth() guard on protected routes.
// =============================================================================

// request.user / .league / .membership are declared in the stubs above

/**
 * Fastify plugin: decodes JWT on every request and attaches user to request.
 * Does NOT reject unauthenticated requests — use requireAuth() for that.
 *
 * Also verifies token_version against the DB. This adds one DB read per
 * authenticated request but is the only way to support immediate revocation
 * with stateless JWTs.
 */
const authPluginImpl: any = async (
  fastify: any,
  { config, db }: { config: AuthConfig; db: Database },
) => {
  fastify.decorateRequest('user', null);
  fastify.decorateRequest('league', null);
  fastify.decorateRequest('membership', null);

  fastify.addHook('preHandler', async (request: any, _reply: any) => {
    // ── Test-mode bypass ────────────────────────────────────────────────────
    // When NODE_ENV=test, accept an x-test-user-id header to authenticate as
    // any user in the DB without needing a real JWT. Never active in production.
    if (process.env['NODE_ENV'] === 'test') {
      const testUserId = (request.headers as Record<string, string>)['x-test-user-id'];
      if (testUserId) {
        const userRow = db.prepare(
          `SELECT id, is_super_admin, token_version FROM users WHERE id = ? AND deleted_at IS NULL`
        ).get(testUserId) as { id: string; is_super_admin: number; token_version: number } | undefined;
        if (userRow) {
          request.user = {
            sub:          userRow.id,
            userId:       userRow.id,
            isAdmin:      Boolean(userRow.is_super_admin),
            tokenVersion: userRow.token_version,
            iat:          0,
            exp:          Number.MAX_SAFE_INTEGER,
          } as any;
        }
        return;
      }
    }

    // ── Normal JWT path ─────────────────────────────────────────────────────
    const token = extractToken(request, config);
    if (!token) return; // unauthenticated — request.user stays null

    const claims = await verifyJwt(token, config);
    if (!claims) return; // invalid/expired token — treat as unauthenticated

    // Verify token_version — protects against revoked tokens
    const userRow = db.prepare(
      `SELECT token_version, is_super_admin FROM users WHERE id = ? AND deleted_at IS NULL`
    ).get(claims.sub) as { token_version: number; is_super_admin: number } | undefined;
    
    if (!userRow || userRow.token_version !== claims.tokenVersion) return;

    request.user = {
      ...claims,
      userId: claims.sub,
      isAdmin: Boolean(userRow.is_super_admin),
    };
  });
};

// Wrap with fastify-plugin to avoid encapsulation
export const authPlugin = fp(authPluginImpl, {
  name: 'auth-plugin',
  fastify: '4.x'
});

// =============================================================================
// AUTHORIZATION GUARDS
// Call these at the start of route handlers or as preHandler hooks.
// =============================================================================

/** Reject request if not authenticated. Returns 401. */
export function requireAuth(request: any, reply: any): void {
  if (!request.user) {
    reply.status(401).send({ error: 'Authentication required' });
    throw new Error('Unauthorized'); // stops handler execution in Fastify
  }
}

/** Reject request if not a super-admin. Returns 403. */
export function requireSuperAdmin(request: any, reply: any): void {
  requireAuth(request, reply);
  if (!request.user!.isAdmin) {
    reply.status(403).send({ error: 'Super-admin access required' });
    throw new Error('Forbidden');
  }
}

/** Reject request if not a member of the resolved league. Returns 403. */
export function requireLeagueMember(request: any, reply: any): void {
  requireAuth(request, reply);
  if (!request.membership) {
    reply.status(403).send({ error: 'League membership required' });
    throw new Error('Forbidden');
  }
}

/** Reject request if not a league admin or super-admin. Returns 403. */
export function requireLeagueAdmin(request: any, reply: any): void {
  requireAuth(request, reply);
  if (request.user!.isAdmin) return; // super admins have access to all leagues
  if (!request.membership || request.membership.role !== 'admin') {
    reply.status(403).send({ error: 'League admin access required' });
    throw new Error('Forbidden');
  }
}

// =============================================================================
// LEAGUE + MEMBERSHIP RESOLUTION HOOKS
// Applied to routes with :leagueSlug in the path.
// Sets request.league and request.membership.
// =============================================================================

export interface LeagueRecord {
  id: string;
  slug: string;
  name: string;
  isPublic: boolean;
}

export interface MembershipRecord {
  userId: string;
  leagueId: string;
  role: 'admin' | 'pilot' | 'spectator';
  joinedAt: string;
}

/**
 * Hook: resolve league from :leagueSlug path parameter.
 * Returns 404 if league doesn't exist.
 * Attach to any route scope that contains :leagueSlug.
 */
export function makeResolveLeagueHook(db: any) {
  return async function resolveLeague(request: any, reply: any): Promise<void> {
    const { leagueSlug } = request.params as { leagueSlug?: string };
    if (!leagueSlug) return;

    const league = db.prepare(
      `SELECT id, slug, name FROM leagues
       WHERE slug = ? AND deleted_at IS NULL`
    ).get(leagueSlug) as LeagueRecord | undefined;
    
    if (!league) {
      void reply.status(404).send({ error: `League '${leagueSlug}' not found` });
      return;
    }
    request.league = league;

    // Resolve membership if the user is authenticated
    if (request.user) {
      const membership = db.prepare(
        `SELECT user_id as userId, league_id as leagueId, role, joined_at as joinedAt
         FROM league_memberships
         WHERE league_id = ? AND user_id = ? AND left_at IS NULL`
      ).get(league.id, request.user.userId) as MembershipRecord | undefined;
      
      request.membership = membership ?? null;
    }
  };
}

// =============================================================================
// AUTH ROUTES
// Mount these at /api/v1/auth
// =============================================================================

/**
 * GET /auth/oauth/google
 *
 * Initiates the Google OAuth flow.
 * Generates a signed state token, sets it as a short-lived HttpOnly cookie,
 * then redirects to Google's consent screen.
 */
export async function handleGoogleAuthInitiate(
  request: any,
  reply: any,
  config: AuthConfig,
): Promise<void> {
  const { state } = await generateOAuthState(config.oauthStateSecret);

  // Store state in a short-lived cookie so we can verify it on callback
  reply.setCookie('oauth_state', state, {
    httpOnly: true,
    secure:   config.secureCookies,
    sameSite: 'lax',
    path:     '/api/v1/auth',
    domain:   config.secureCookies ? undefined : 'localhost', // Share cookie across ports in dev
    maxAge:   600, // 10 minutes
  });

  const authUrl = buildGoogleAuthUrl(state, config);
  reply.redirect(302, authUrl);
}

/**
 * GET /auth/oauth/google/callback
 *
 * Google redirects here after consent.
 * Verifies state, exchanges code for user info, provisions user, issues JWT.
 *
 * On success: sets HttpOnly JWT cookie and returns JWT in body.
 * On failure: redirects to /login?error=auth_failed (frontend handles display).
 */
export async function handleGoogleAuthCallback(
  request: any,
  reply: any,
  config: AuthConfig,
  db: Database,
): Promise<void> {
  const query = request.query as { code?: string; state?: string; error?: string };

  // User denied consent
  if (query.error) {
    const errorUrl = config.frontendUrl ? `${config.frontendUrl}/?error=access_denied` : '/?error=access_denied';
    return reply.redirect(302, errorUrl);
  }

  const cookieState = (request.cookies as Record<string, string>)['oauth_state'];

  try {
    if (!query.state || !cookieState) throw new Error('Missing state');
    // Verify query param state matches cookie state — CSRF protection
    if (query.state !== cookieState) throw new Error('State mismatch');
    await verifyOAuthState(query.state, config.oauthStateSecret);
  } catch {
    const errorUrl = config.frontendUrl ? `${config.frontendUrl}/?error=auth_failed` : '/?error=auth_failed';
    return reply.redirect(302, errorUrl);
  }

  if (!query.code) {
    const errorUrl = config.frontendUrl ? `${config.frontendUrl}/?error=auth_failed` : '/?error=auth_failed';
    return reply.redirect(302, errorUrl);
  }

  try {
    const googleUser = await exchangeGoogleCode(query.code, config);
    const user = findOrCreateGoogleUser(googleUser, db);

    const claims: JwtClaims = {
      sub:          user.id,
      email:        user.email,
      displayName:  (user as any).display_name ?? user.displayName,
      isAdmin:      Boolean((user as any).is_super_admin ?? user.isAdmin),
      tokenVersion: (user as any).token_version ?? user.tokenVersion,
    };

    const jwt = await signJwt(claims, config);

    // Clear the state cookie
    reply.setCookie('oauth_state', '', { 
      path: '/api/v1/auth', 
      domain: config.secureCookies ? undefined : 'localhost',
      maxAge: 0 
    });

    // Set long-lived auth cookie — this is how web clients stay authenticated
    setAuthCookie(reply, jwt, config);

    // Detect whether this is a browser-initiated flow or a direct API call.
    // Browser requests come via a top-level redirect from Google so they have
    // no Accept: application/json header. API clients calling the callback
    // directly do — they get the JWT in the body instead of a redirect.
    const wantJson = (request.headers as any)['accept']?.includes('application/json');

    if (wantJson) {
      // API client — return JWT in body (cookie is also set for convenience)
      reply.status(200).send({
        token: jwt,
        user: {
          id:          user.id,
          email:       user.email,
          displayName: user.displayName,
          avatarUrl:   user.avatarUrl,
          isAdmin:     user.isAdmin,
        },
      });
    } else {
      // Browser flow — redirect to frontend; cookie is already set.
      // Frontend detects ?auth=success, calls /auth/me to hydrate user state.
      const redirectUrl = config.frontendUrl ? `${config.frontendUrl}/?auth=success` : '/?auth=success';
      reply.redirect(302, redirectUrl);
    }
  } catch (err) {
    request.log.error(err, 'OAuth callback error');
    const errorUrl = config.frontendUrl ? `${config.frontendUrl}/?error=auth_failed` : '/?error=auth_failed';
    reply.redirect(302, errorUrl);
  }
}

/**
 * GET /auth/me
 *
 * Returns the current user's profile.
 * Requires authentication.
 */
export async function handleGetMe(
  request: any,
  reply: any,
  db: any,
): Promise<void> {
  requireAuth(request, reply);
  const user = db.prepare(
    `SELECT id, email, display_name as displayName, avatar_url as avatarUrl, is_super_admin as isAdmin,
            wind_rating as windRating, glider_manufacturer as gliderManufacturer, glider_model as gliderModel,
            glider_weight_rating as gliderWeightRating
     FROM users WHERE id = ?`
  ).get(request.user!.userId) as UserRecord | undefined;

  if (!user) { reply.status(404).send({ error: 'User not found' }); return; }
  reply.send({ user: { ...user, isAdmin: Boolean((user as any).isAdmin) } });
}

/**
 * PATCH /auth/me
 *
 * Update display name or avatar URL.
 * Does NOT allow changing email (that goes through Google).
 */
export async function handleUpdateMe(
  request: any,
  reply: any,
  db: any,
): Promise<void> {
  requireAuth(request, reply);
  const body = request.body as {
    displayName?: string;
    avatarUrl?: string | null;
    windRating?: string | null;
    gliderManufacturer?: string | null;
    gliderModel?: string | null;
    gliderWeightRating?: number | null;
  };

  const VALID_WIND_RATINGS = new Set(['A', 'B', 'C', 'D', 'CCC']);

  // Only update provided fields
  if (body.displayName !== undefined) {
    db.prepare(
      `UPDATE users SET display_name = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(body.displayName.trim(), request.user!.userId);
  }
  if (body.avatarUrl !== undefined) {
    db.prepare(
      `UPDATE users SET avatar_url = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(body.avatarUrl, request.user!.userId);
  }
  if (body.windRating !== undefined) {
    if (body.windRating !== null && !VALID_WIND_RATINGS.has(body.windRating)) {
      reply.status(400).send({ error: 'Invalid wind rating. Must be A, B, C, D, or CCC.' });
      return;
    }
    db.prepare(
      `UPDATE users SET wind_rating = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(body.windRating, request.user!.userId);
  }
  if (body.gliderManufacturer !== undefined) {
    db.prepare(
      `UPDATE users SET glider_manufacturer = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(body.gliderManufacturer, request.user!.userId);
  }
  if (body.gliderModel !== undefined) {
    db.prepare(
      `UPDATE users SET glider_model = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(body.gliderModel, request.user!.userId);
  }
  if (body.gliderWeightRating !== undefined) {
    if (body.gliderWeightRating !== null && (typeof body.gliderWeightRating !== 'number' || body.gliderWeightRating <= 0)) {
      reply.status(400).send({ error: 'Invalid weight rating. Must be a positive number (kg).' });
      return;
    }
    db.prepare(
      `UPDATE users SET glider_weight_rating = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(body.gliderWeightRating, request.user!.userId);
  }

  const user = db.prepare(
    `SELECT id, email, display_name as displayName, avatar_url as avatarUrl, is_super_admin as isAdmin,
            wind_rating as windRating, glider_manufacturer as gliderManufacturer, glider_model as gliderModel,
            glider_weight_rating as gliderWeightRating
     FROM users WHERE id = ?`
  ).get(request.user!.userId) as UserRecord | undefined;

  reply.send({ user });
}

/**
 * POST /auth/logout
 *
 * Clears the auth cookie.
 * Does NOT increment token_version — existing tokens remain valid until expiry.
 * For immediate revocation, use POST /auth/revoke instead.
 */
export async function handleLogout(
  request: any,
  reply: any,
  config: AuthConfig,
): Promise<void> {
  clearAuthCookie(reply, config);
  reply.status(204).send();
}

/**
 * POST /auth/revoke
 *
 * Increments token_version, immediately invalidating all existing tokens.
 * Use when: account compromise suspected, league admin removed, pilot banned.
 *
 * Admins can revoke other users by passing userId in the body (super-admin only).
 * Regular users can only revoke their own tokens.
 */
export async function handleRevokeTokens(
  request: any,
  reply: any,
  db: any,
): Promise<void> {
  requireAuth(request, reply);

  const body = request.body as { userId?: string };
  let targetUserId = request.user!.userId;

  if (body.userId && body.userId !== targetUserId) {
    // Only super-admins can revoke other users
    if (!request.user!.isAdmin) {
      reply.status(403).send({ error: "Cannot revoke another user's tokens" }); return;
    }
    targetUserId = body.userId;
  }

  db.prepare(
    `UPDATE users SET token_version = token_version + 1, updated_at = datetime('now')
     WHERE id = ?`
  ).run(targetUserId);

  // If revoking own tokens, also clear the cookie
  if (targetUserId === request.user!.userId) {
    clearAuthCookie(reply, request.server?.config ?? ({} as AuthConfig));
  }

  reply.status(204).send();
}

// =============================================================================
// ROUTE REGISTRATION EXAMPLE
// Shows how to wire everything into Fastify.
// =============================================================================

/**
 * Example route registration (in your main routes file):
 *
 * // Register auth plugin globally
 * await fastify.register(authPlugin, { config, db });
 *
 * // Auth routes — no league context needed
 * fastify.get('/api/v1/auth/oauth/google',
 *   (req, reply) => handleGoogleAuthInitiate(req, reply, config));
 *
 * fastify.get('/api/v1/auth/oauth/google/callback',
 *   (req, reply) => handleGoogleAuthCallback(req, reply, config, db));
 *
 * fastify.get('/api/v1/auth/me',
 *   (req, reply) => handleGetMe(req, reply, db));
 *
 * fastify.patch('/api/v1/auth/me',
 *   (req, reply) => handleUpdateMe(req, reply, db));
 *
 * fastify.post('/api/v1/auth/logout',
 *   (req, reply) => handleLogout(req, reply, config));
 *
 * fastify.post('/api/v1/auth/revoke',
 *   (req, reply) => handleRevokeTokens(req, reply, db));
 *
 * // League-scoped routes — add league resolution hook
 * const leagueRoutes = async (fastify: FastifyInstance) => {
 *   fastify.addHook('preHandler', makeResolveLeagueHook(db));
 *
 *   fastify.get('/api/v1/leagues/:leagueSlug', (req, reply) => {
 *     // request.league and request.membership are populated here
 *     // Public leagues visible to all; private leagues require membership
 *     if (!req.league!.isPublic) requireLeagueMember(req, reply);
 *     reply.send({ league: req.league });
 *   });
 *
 *   fastify.patch('/api/v1/leagues/:leagueSlug', (req, reply) => {
 *     requireLeagueAdmin(req, reply);
 *     // ... update handler
 *   });
 * };
 * await fastify.register(leagueRoutes);
 */

// =============================================================================
// PLACEHOLDER TYPES (implemented elsewhere in the codebase)
// =============================================================================

declare class Database {
  run(sql: string, params?: any[]): { changes: number };
  get<T>(sql: string, params?: any[]): T | null;
  transaction<T>(fn: () => T): () => T;
  prepare(sql: string): { run(...args: any[]): any; get(...args: any[]): any; all(...args: any[]): any[] };
}
