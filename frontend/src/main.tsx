import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Don't refetch on window focus for this app —
      // leaderboard has its own staleTime, track data is immutable
      refetchOnWindowFocus: false,
      retry: (failureCount, error: any) => {
        // Don't retry on 401, 403, 404 — these are expected states
        if ([401, 403, 404].includes(error?.status)) return false;
        return failureCount < 2;
      },
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </BrowserRouter>
  </StrictMode>,
);
