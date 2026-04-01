import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { authApi } from '@/lib/api/auth';

interface User {
  id: string;
  email: string;
  organizationId: string;
  role: string;
}

interface Workspace {
  id: string;
  name: string;
}

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  workspaces: Workspace[] | null;
  login: (email: string, password: string) => Promise<void>;
  signup: (email: string, password: string, organizationName?: string, inviteToken?: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshAccessToken: () => Promise<void>;
  fetchWorkspaces: () => Promise<void>;
  switchWorkspace: (organizationId: string) => Promise<void>;
  createWorkspace: (name: string) => Promise<void>;
  leaveWorkspace: (organizationId: string) => Promise<void>;
  deleteWorkspace: (organizationId: string) => Promise<void>;
  refreshUser: () => Promise<void>;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      isAuthenticated: false,
      workspaces: null,

      login: async (email: string, password: string) => {
        const response = await authApi.post('/signin', { email, password });
        const { user } = response.data;
        set({ user, isAuthenticated: true });
      },

      signup: async (email: string, password: string, organizationName?: string, inviteToken?: string) => {
        const body: Record<string, unknown> = { email, password };
        if (inviteToken) body.inviteToken = inviteToken;
        else body.organizationName = organizationName ?? 'My Organization';
        const response = await authApi.post('/signup', body);
        const { user } = response.data;
        set({ user, isAuthenticated: true });
      },

      logout: async () => {
        try {
          await authApi.post('/logout', {});
        } catch (e) {
          (await import('../error-reporter')).reportWarning('Logout API call failed', { error: e, action: 'logout' });
        }
        set({ user: null, isAuthenticated: false, workspaces: null });
      },

      refreshAccessToken: async () => {
        const response = await authApi.post<{ user: User }>('/refresh', {});
        const { user } = response.data;
        if (user) set({ user });
      },

      fetchWorkspaces: async () => {
        const { user } = get();
        if (!user) return;
        try {
          const response = await authApi.get<Workspace[]>('/workspaces');
          set({ workspaces: response.data });
        } catch (e) {
          (await import('../error-reporter')).reportWarning('Fetch workspaces failed', { error: e, action: 'fetchWorkspaces' });
          set({ workspaces: [] });
        }
      },

      switchWorkspace: async (organizationId: string) => {
        const { user } = get();
        if (!user) throw new Error('Not authenticated');
        const response = await authApi.post<{ user: User }>('/switch-workspace', { organizationId });
        const { user: newUser } = response.data;
        set({ user: newUser });
        if (typeof window !== 'undefined') {
          const key = 'auth-storage';
          const payload = { state: { user: newUser, isAuthenticated: true }, version: 0 };
          try {
            localStorage.setItem(key, JSON.stringify(payload));
          } catch (e) {
            (await import('../error-reporter')).reportWarning('localStorage setItem failed', { error: e, action: 'switchWorkspace' });
          }
          window.location.href = '/dashboard';
        }
      },

      createWorkspace: async (name: string) => {
        const { user } = get();
        if (!user) throw new Error('Not authenticated');
        const response = await authApi.post<{ user: User }>('/workspaces', { name: name.trim() });
        const { user: newUser } = response.data;
        set({ user: newUser, workspaces: null });
        if (typeof window !== 'undefined') {
          const key = 'auth-storage';
          const payload = { state: { user: newUser, isAuthenticated: true }, version: 0 };
          try {
            localStorage.setItem(key, JSON.stringify(payload));
          } catch (e) {
            (await import('../error-reporter')).reportWarning('localStorage setItem failed', { error: e, action: 'createWorkspace' });
          }
          window.location.href = '/dashboard';
        }
      },

      leaveWorkspace: async (organizationId: string) => {
        const { user } = get();
        if (!user) throw new Error('Not authenticated');
        const response = await authApi.post<{ user: User }>(`/workspaces/${organizationId}/leave`);
        const { user: newUser } = response.data;
        set({ user: newUser, workspaces: null });
        if (typeof window !== 'undefined') {
          const key = 'auth-storage';
          const payload = { state: { user: newUser, isAuthenticated: true }, version: 0 };
          try {
            localStorage.setItem(key, JSON.stringify(payload));
          } catch (e) {
            (await import('../error-reporter')).reportWarning('localStorage setItem failed', { error: e, action: 'leaveWorkspace' });
          }
          window.location.href = '/dashboard';
        }
      },

      deleteWorkspace: async (organizationId: string) => {
        const { user } = get();
        if (!user) throw new Error('Not authenticated');
        const response = await authApi.delete<{ user: User }>(`/workspaces/${organizationId}`);
        const { user: newUser } = response.data;
        set({ user: newUser, workspaces: null });
        if (typeof window !== 'undefined') {
          const key = 'auth-storage';
          const payload = { state: { user: newUser, isAuthenticated: true }, version: 0 };
          try {
            localStorage.setItem(key, JSON.stringify(payload));
          } catch (e) {
            (await import('../error-reporter')).reportWarning('localStorage setItem failed', { error: e, action: 'deleteWorkspace' });
          }
          window.location.href = '/dashboard';
        }
      },

      refreshUser: async () => {
        try {
          const response = await authApi.get<{ id: string; email: string; organizationId: string; role: string }>(
            '/me',
            {
              params: { _: typeof window !== 'undefined' ? Date.now() : 0 },
              headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' },
            }
          );
          const u = response.data;
          set({
            user: u
              ? { id: u.id, email: u.email, organizationId: u.organizationId, role: u.role ?? '' }
              : null,
          });
        } catch {
          set({ user: null, isAuthenticated: false });
        }
      },
    }),
    {
      name: 'auth-storage',
      storage: createJSONStorage(() => (typeof window !== 'undefined' ? localStorage : undefined as any)),
      partialize: (state) => ({ user: state.user, isAuthenticated: !!state.user }),
      onRehydrateStorage: () => (state) => {
        if (state?.user) state.isAuthenticated = true;
      },
    }
  )
);


