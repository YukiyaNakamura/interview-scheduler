/**
 * React の起動。QueryClientProvider で API の結果を全画面で共有し、RouterProvider で URL ごとにページを切り替える。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { router } from './router';
import './styles/base.css';
import './styles/guest.css';

const queryClient = new QueryClient({
  defaultOptions: {
    // 4xx は何度やっても同じなので再試行しない
    queries: { retry: (count, err) => count < 2 && !(err instanceof Error && 'status' in err && Number(err.status) < 500), refetchOnWindowFocus: false },
  },
});

const root = document.getElementById('root');
if (root !== null) {
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}
