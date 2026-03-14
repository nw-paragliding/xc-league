// Frontend test setup
import { expect, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';

// Cleanup after each test
afterEach(() => {
  cleanup();
});

// Mock fetch for API tests
global.fetch = vi.fn();

// Reset mocks after each test
afterEach(() => {
  vi.clearAllMocks();
});
