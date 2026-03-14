# Testing Guide

This project uses Vitest for both backend and frontend testing.

## Quick Start

```bash
# Run all tests (backend + frontend)
npm run test:all

# Run backend tests only
npm run test

# Run frontend tests only
cd frontend && npm run test

# Run tests in watch mode (auto-rerun on file changes)
npm run test:watch

# Run tests with UI
npm run test:ui

# Run tests with coverage report
npm run test:coverage
```

## Project Structure

```
/
├── tests/                      # Backend tests
│   ├── setup.ts               # Test environment setup
│   ├── helpers.ts             # Database & fixture helpers
│   └── routes/                # API endpoint tests
│       └── seasons.test.ts
├── frontend/
│   └── src/
│       ├── test/
│       │   └── setup.ts       # Frontend test setup
│       └── pages/
│           └── *.test.tsx     # Component tests
├── vitest.config.ts           # Backend Vitest config
└── frontend/vitest.config.ts  # Frontend Vitest config
```

## Backend Testing

### Test Database

- Tests use an **in-memory SQLite database** (`:memory:`)
- Database schema is automatically loaded before tests
- Each test suite gets a fresh database

### Writing Backend Tests

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { getTestDb, resetTestDb } from '../setup';
import { setupTestDatabase, createTestUser, createTestLeague } from '../helpers';

describe('My API Endpoint', () => {
  let db: any;
  let testUser: any;

  beforeEach(() => {
    resetTestDb();
    db = getTestDb();
    setupTestDatabase(db);
    testUser = createTestUser(db, { email: 'test@example.com' });
  });

  it('should do something', () => {
    // Your test code here
    expect(testUser.email).toBe('test@example.com');
  });
});
```

### Test Helpers

Available in `tests/helpers.ts`:

- `setupTestDatabase(db)` - Load schema and migrations
- `createTestUser(db, overrides)` - Create a user
- `createTestLeague(db, overrides)` - Create a league
- `addLeagueMember(db, leagueId, userId, role)` - Add member to league
- `createTestSeason(db, leagueId, overrides)` - Create a season
- `createTestTask(db, seasonId, leagueId, overrides)` - Create a task

## Frontend Testing

### Test Environment

- Uses **jsdom** to simulate browser environment
- Tests run in Node.js with DOM APIs mocked
- React components rendered with `@testing-library/react`

### Writing Frontend Tests

```typescript
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import MyComponent from './MyComponent';

// Mock API or hooks
vi.mock('../api/leagues', () => ({
  leagueApi: {
    listSeasons: vi.fn(),
  },
}));

describe('MyComponent', () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  const renderComponent = () => {
    return render(
      <QueryClientProvider client={queryClient}>
        <MyComponent />
      </QueryClientProvider>
    );
  };

  it('should render the component', () => {
    renderComponent();
    expect(screen.getByText('Hello')).toBeInTheDocument();
  });
});
```

### Common Testing Patterns

#### Testing User Interactions

```typescript
import { userEvent } from '@testing-library/user-event';

it('should handle button click', async () => {
  renderComponent();
  const button = screen.getByText('Click me');
  await userEvent.click(button);
  expect(screen.getByText('Clicked!')).toBeInTheDocument();
});
```

#### Testing Async Data Loading

```typescript
it('should load and display data', async () => {
  vi.mocked(leagueApi.listSeasons).mockResolvedValue({
    seasons: [{ id: '1', name: 'Summer 2025' }],
  });

  renderComponent();

  await waitFor(() => {
    expect(screen.getByText('Summer 2025')).toBeInTheDocument();
  });
});
```

#### Testing Error States

```typescript
it('should display error message', async () => {
  vi.mocked(leagueApi.listSeasons).mockRejectedValue(
    new Error('Failed to load')
  );

  renderComponent();

  await waitFor(() => {
    expect(screen.getByText(/Error loading/)).toBeInTheDocument();
  });
});
```

## Test Coverage

View coverage reports after running:

```bash
npm run test:coverage
```

Coverage reports are generated in:
- `coverage/` (backend)
- `frontend/coverage/` (frontend)

Open `coverage/index.html` in a browser to view detailed coverage.

## CI/CD Integration

Add to your GitHub Actions workflow:

```yaml
- name: Run tests
  run: npm run test:all

- name: Run tests with coverage
  run: npm run test:coverage
```

## Best Practices

1. **Test behavior, not implementation** - Focus on what users see and do
2. **Use descriptive test names** - "should display error when API fails" not "test error"
3. **Arrange-Act-Assert** - Set up data, perform action, verify result
4. **Mock external dependencies** - Don't call real APIs in tests
5. **Keep tests fast** - Use in-memory database, avoid setTimeout
6. **One assertion per test** - Makes failures easier to diagnose
7. **Clean up after tests** - Reset mocks, clear database state

## Troubleshooting

### Tests fail with "Cannot find module"

Make sure you're using the right import paths:
- Backend: Use relative imports from test file location
- Frontend: Use path aliases configured in `vite.config.ts`

### "Database is locked" errors

Make sure you call `resetTestDb()` in `beforeEach` to get a fresh database.

### Mock not working

Clear mocks between tests:

```typescript
import { afterEach } from 'vitest';

afterEach(() => {
  vi.clearAllMocks();
});
```

### Tests pass locally but fail in CI

Check Node.js version compatibility and ensure all dependencies are installed.
