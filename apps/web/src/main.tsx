import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import './styles.css';
import { ToastProvider } from './components/ui/Toast';
import { createQueryClient } from './lib/query-client';
import { router } from './router';

const queryClient = createQueryClient();
const rootElement = document.getElementById('root');

if (rootElement === null) {
  throw new Error('عنصر ریشه برنامه یافت نشد.');
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
