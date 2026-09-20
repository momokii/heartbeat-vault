import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { Shell } from '@/components/layout/shell';
import { HomePage } from '@/routes/home';
import { LoginPage } from '@/routes/login';
import { SetupPage } from '@/routes/setup';
import { NotFoundPage } from '@/routes/not-found';

const router = createBrowserRouter([
  {
    element: <Shell />,
    children: [
      { path: '/', element: <HomePage /> },
      { path: '/login', element: <LoginPage /> },
      { path: '/setup', element: <SetupPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
