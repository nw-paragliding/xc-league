// =============================================================================
// XC / Hike & Fly League Platform — Auth Routes
//
// Registers all authentication endpoints under /api/v1/auth
// Uses handlers from ../auth.ts
// =============================================================================

import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import type { AuthConfig } from '../auth';
import {
  handleGetMe,
  handleGoogleAuthCallback,
  handleGoogleAuthInitiate,
  handleLogout,
  handleRevokeTokens,
  handleUpdateMe,
} from '../auth';

interface AuthRouteOptions {
  config: AuthConfig;
  db: Database.Database;
}

export async function registerAuthRoutes(fastify: FastifyInstance, opts: AuthRouteOptions): Promise<void> {
  const { config, db } = opts;

  // OAuth initiate — redirects to Google
  fastify.get(
    '/auth/oauth/google',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      return handleGoogleAuthInitiate(request, reply, config);
    },
  );

  // OAuth callback — Google redirects here after consent
  fastify.get(
    '/auth/oauth/google/callback',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      return handleGoogleAuthCallback(request, reply, config, db as any);
    },
  );

  // Get current user profile
  fastify.get('/auth/me', async (request, reply) => {
    return handleGetMe(request, reply, db);
  });

  // Update current user profile
  fastify.patch('/auth/me', async (request, reply) => {
    return handleUpdateMe(request, reply, db);
  });

  // Logout — clears auth cookie
  fastify.post('/auth/logout', async (request, reply) => {
    return handleLogout(request, reply, config);
  });

  // Revoke all tokens for a user
  fastify.post('/auth/revoke', async (request, reply) => {
    return handleRevokeTokens(request, reply, db);
  });
}
