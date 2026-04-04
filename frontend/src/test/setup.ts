// Frontend test setup

import { cleanup } from '@testing-library/react';
import { afterEach, expect } from 'vitest';
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
