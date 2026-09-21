import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { z } from 'zod';
import { ApiError, apiClient } from './api-client';

const currentUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  role: z.string(),
});

export type CurrentUser = z.infer<typeof currentUserSchema>;

export type AuthState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'authenticated'; readonly user: CurrentUser }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'unavailable' };

type AuthProviderProps = {
  readonly children: ReactNode;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: AuthProviderProps) {
  const [state, setState] = useState<AuthState>({ kind: 'loading' });

  useEffect(() => {
    const controller = new AbortController();

    async function loadCurrentUser(): Promise<void> {
      try {
        const user = await apiClient.request({
          path: '/me',
          schema: currentUserSchema,
          signal: controller.signal,
        });
        if (!controller.signal.aborted) setState({ kind: 'authenticated', user });
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError) {
          setState(error.status === 401 ? { kind: 'unauthenticated' } : { kind: 'unavailable' });
          return;
        }
        throw error;
      }
    }

    void loadCurrentUser();
    return () => controller.abort();
  }, []);

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const state = useContext(AuthContext);
  if (state === null) throw new Error('useAuth must be used within AuthProvider');
  return state;
}
