// Backend test setup
import 'dotenv/config';
import Database from 'better-sqlite3';
import { existsSync, unlinkSync } from 'fs';
import { afterAll, afterEach, beforeAll } from 'vitest';

// Use in-memory database for tests
export const TEST_DB_PATH = ':memory:';

let testDb: Database.Database | null = null;

beforeAll(() => {
  // Set test environment variables
  process.env.NODE_ENV = 'test';
  process.env.ENABLE_TEST_AUTH = 'true';
  process.env.DB_PATH = TEST_DB_PATH;
});

afterAll(() => {
  if (testDb) {
    testDb.close();
    testDb = null;
  }
});

export function getTestDb(): Database.Database {
  if (!testDb) {
    testDb = new Database(TEST_DB_PATH);
    testDb.pragma('journal_mode = WAL');
    testDb.pragma('foreign_keys = ON');
  }
  return testDb;
}

export function resetTestDb() {
  if (testDb) {
    testDb.close();
    testDb = null;
  }
}
