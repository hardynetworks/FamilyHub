import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { ApiError } from './lib/api';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: true,
      refetchInterval: 60_000, // keeps a wall-mounted tablet fresh
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
    },
  },
});

// If the session expires, bounce back to the login screen.
queryClient.getQueryCache().subscribe((e) => {
  const err = (e.query.state.error ?? null) as unknown;
  if (err instanceof ApiError && err.status === 401 && e.query.queryKey[0] !== 'auth') {
    queryClient.invalidateQueries({ queryKey: ['auth'] });
  }
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
