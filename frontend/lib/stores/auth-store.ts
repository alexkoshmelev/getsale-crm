import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import axios from 'axios';

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
  refreshUser: () => Promise<void>;
}

// Cookie-setting operations (login, signup, refresh, switch-workspace, logout) MUST go
// directly to the gateway so Set-Cookie headers reach the browser without Next.js rewrite interference.
// Read-only operations (me, workspaces) go to same origin via Next.js rewrite (cookie is sent automatically).
const GATEWAY_URL = typeof window !== 'undefined'
  ? (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000')
  : (process.env.NEXT_PUBLIC_API_URL || process.env.API_URL || 'http://localhost:8000');
const SAME_ORIGIN_URL = typeof window !== 'undefined'
  ? ''
  : (process.env.NEXT_PUBLIC_API_URL || process.env.API_URL || 'http://localhost:8000');
const axiosConfig = { withCredentials: true };

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      isAuthenticated: false,
      workspaces: null,

      login: async (email: string, password: string) => {
        const response = await axios.post(
          `${GATEWAY_URL}/api/auth/signin`,
          { email, password },
          axiosConfig
        );
        const { user } = response.data;
        set({ user, isAuthenticated: true });
      },

      signup: async (email: string, password: string, organizationName?: string, inviteToken?: string) => {
        const body: Record<string, unknown> = { email, password };
        if (inviteToken) body.inviteToken = inviteToken;
        else body.organizationName = organizationName ?? 'My Organization';
        const response = await axios.post(`${GATEWAY_URL}/api/auth/signup`, body, axiosConfig);
        const { user } = response.data;
        set({ user, isAuthenticated: true });
      },

      logout: async () => {
        try {
          await axios.post(`${GATEWAY_URL}/api/auth/logout`, {}, axiosConfig);
        } catch (_) {}
        set({ user: null, isAuthenticated: false, workspaces: null });
      },

      refreshAccessToken: async () => {
        const response = await axios.post<{ user: User }>(
          `${GATEWAY_URL}/api/auth/refresh`,
          {},
          axiosConfig
        );
        const { user } = response.data;
        if (user) set({ user });
      },

      fetchWorkspaces: async () => {
        const { user } = get();
        if (!user) return;
        try {
          const response = await axios.get<Workspace[]>(
            `${SAME_ORIGIN_URL}/api/auth/workspaces`,
            axiosConfig
          );
          set({ workspaces: response.data });
        } catch {
          set({ workspaces: [] });
        }
      },

      switchWorkspace: async (organizationId: string) => {
        const { user } = get();
        if (!user) throw new Error('Not authenticated');
        const response = await axios.post<{ user: User }>(
          `${GATEWAY_URL}/api/auth/switch-workspace`,
          { organizationId },
          axiosConfig
        );
        const { user: newUser } = response.data;
        set({ user: newUser });
        // Persist new user to localStorage before redirect so rehydration after reload uses correct workspace.
        if (typeof window !== 'undefined') {
          const key = 'auth-storage';
          const payload = { state: { user: newUser, isAuthenticated: true }, version: 0 };
          try {
            localStorage.setItem(key, JSON.stringify(payload));
          } catch (_) {}
          window.location.href = '/dashboard';
        }
      },

      refreshUser: async () => {
        try {
          const response = await axios.get<{ id: string; email: string; organizationId: string; role: string }>(
            `${SAME_ORIGIN_URL}/api/auth/me`,
            {
              ...axiosConfig,
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


