import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { Shell } from '@/components/layout/shell';
import { HomePage } from '@/routes/home';
import { LoginPage } from '@/routes/login';
import { SetupPage } from '@/routes/setup';
import { NewSwitchPage } from '@/routes/switch-new';
import { SwitchDetailPage } from '@/routes/switch-detail';
import { AdminPage } from '@/routes/admin';
import { TotpChallengePage } from '@/routes/totp-challenge';
import { NotFoundPage } from '@/routes/not-found';

const router = createBrowserRouter([
  {
    element: <Shell />,
    children: [
      { path: '/', element: <HomePage /> },
      { path: '/login', element: <LoginPage /> },
      { path: '/setup', element: <SetupPage /> },
      { path: '/switches/new', element: <NewSwitchPage /> },
      { path: '/switches/:id', element: <SwitchDetailPage /> },
      { path: '/admin', element: <AdminPage /> },
      { path: '/2fa/totp', element: <TotpChallengePage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
