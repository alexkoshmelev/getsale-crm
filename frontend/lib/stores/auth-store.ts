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
  accessToken: string | null;
  refreshToken: string | null;
  user: User | null;
  isAuthenticated: boolean;
  workspaces: Workspace[] | null;
  login: (email: string, password: string) => Promise<void>;
  signup: (email: string, password: string, organizationName?: string, inviteToken?: string) => Promise<void>;
  logout: () => void;
  refreshAccessToken: () => Promise<void>;
  fetchWorkspaces: () => Promise<void>;
  switchWorkspace: (organizationId: string) => Promise<void>;
}

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      accessToken: null,
      refreshToken: null,
      user: null,
      isAuthenticated: false,
      workspaces: null,

      login: async (email: string, password: string) => {
        try {
          const response = await axios.post(`${API_URL}/api/auth/signin`, {
            email,
            password,
          });

          const { accessToken, refreshToken, user } = response.data;

          set({
            accessToken,
            refreshToken,
            user,
            isAuthenticated: true,
          });

          // Set default axios header
          axios.defaults.headers.common['Authorization'] = `Bearer ${accessToken}`;
        } catch (error: any) {
          throw new Error(error.response?.data?.error || 'Login failed');
        }
      },

      signup: async (email: string, password: string, organizationName?: string, inviteToken?: string) => {
        try {
          const body: Record<string, unknown> = { email, password };
          if (inviteToken) {
            body.inviteToken = inviteToken;
          } else {
            body.organizationName = organizationName ?? 'My Organization';
          }
          const response = await axios.post(`${API_URL}/api/auth/signup`, body);

          const { accessToken, refreshToken, user } = response.data;

          set({
            accessToken,
            refreshToken,
            user,
            isAuthenticated: true,
          });

          // Set default axios header
          axios.defaults.headers.common['Authorization'] = `Bearer ${accessToken}`;
        } catch (error: any) {
          throw new Error(error.response?.data?.error || 'Signup failed');
        }
      },

      logout: () => {
        set({
          accessToken: null,
          refreshToken: null,
          user: null,
          isAuthenticated: false,
          workspaces: null,
        });
        delete axios.defaults.headers.common['Authorization'];
      },

      refreshAccessToken: async () => {
        const { refreshToken } = get();
        if (!refreshToken) {
          get().logout();
          throw new Error('No refresh token available');
        }

        try {
          const response = await axios.post(`${API_URL}/api/auth/refresh`, {
            refreshToken,
          });

          const { accessToken, refreshToken: newRefreshToken } = response.data;

          // Update both tokens if new refresh token is provided
          set({ 
            accessToken,
            ...(newRefreshToken && { refreshToken: newRefreshToken })
          });
          axios.defaults.headers.common['Authorization'] = `Bearer ${accessToken}`;
        } catch (error: any) {
          // If refresh token expired or invalid, logout immediately
          get().logout();
          
          // Throw error so interceptor knows refresh failed
          throw error;
        }
      },

      fetchWorkspaces: async () => {
        const { accessToken } = get();
        if (!accessToken) return;
        try {
          const response = await axios.get<Workspace[]>(`${API_URL}/api/auth/workspaces`, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          set({ workspaces: response.data });
        } catch {
          set({ workspaces: [] });
        }
      },

      switchWorkspace: async (organizationId: string) => {
        const { accessToken } = get();
        if (!accessToken) throw new Error('Not authenticated');
        const response = await axios.post<{ accessToken: string; user: User }>(
          `${API_URL}/api/auth/switch-workspace`,
          { organizationId },
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        const { accessToken: newAccessToken, user } = response.data;
        set({ accessToken: newAccessToken, user });
        axios.defaults.headers.common['Authorization'] = `Bearer ${newAccessToken}`;
        if (typeof window !== 'undefined') {
          window.location.href = '/dashboard';
        }
      },
    }),
    {
      name: 'auth-storage',
      storage: createJSONStorage(() => (typeof window !== 'undefined' ? localStorage : undefined as any)),
      // Restore isAuthenticated when state is rehydrated from storage
      onRehydrateStorage: () => (state) => {
        if (state && state.accessToken && state.user) {
          state.isAuthenticated = true;
          if (typeof window !== 'undefined') {
            axios.defaults.headers.common['Authorization'] = `Bearer ${state.accessToken}`;
          }
        }
      },
    }
  )
);

// Flag to prevent multiple simultaneous refresh requests
let isRefreshing = false;
let failedQueue: Array<{
  resolve: (value?: any) => void;
  reject: (reason?: any) => void;
}> = [];

const processQueue = (error: any, token: string | null = null) => {
  failedQueue.forEach((prom) => {
    if (error) {
      prom.reject(error);
    } else {
      prom.resolve(token);
    }
  });
  failedQueue = [];
};

// Initialize axios interceptor (only on client side)
if (typeof window !== 'undefined') {
  // Set initial token if exists and restore authentication state
  const authStorage = localStorage.getItem('auth-storage');
  if (authStorage) {
    try {
      const auth = JSON.parse(authStorage);
      if (auth.state?.accessToken && auth.state?.user) {
        axios.defaults.headers.common['Authorization'] = `Bearer ${auth.state.accessToken}`;
        // Restore authentication state
        useAuthStore.setState({
          isAuthenticated: true,
          accessToken: auth.state.accessToken,
          refreshToken: auth.state.refreshToken,
          user: auth.state.user,
        });
      }
    } catch (error) {
      console.error('Error parsing auth storage:', error);
    }
  }

  // Add response interceptor for token refresh
  axios.interceptors.response.use(
    (response) => response,
    async (error) => {
      const originalRequest = error.config;

      // Skip refresh for login/signup/refresh endpoints to avoid infinite loops
      if (
        originalRequest?.url?.includes('/api/auth/signin') ||
        originalRequest?.url?.includes('/api/auth/signup') ||
        originalRequest?.url?.includes('/api/auth/refresh') ||
        originalRequest?.url?.includes('/api/auth/switch-workspace') ||
        originalRequest?._retry
      ) {
        return Promise.reject(error);
      }

      if (error.response?.status === 401) {
        // If already refreshing, queue this request
        if (isRefreshing) {
          return new Promise((resolve, reject) => {
            failedQueue.push({ resolve, reject });
          })
            .then((token) => {
              originalRequest.headers.Authorization = `Bearer ${token}`;
              return axios(originalRequest);
            })
            .catch((err) => {
              return Promise.reject(err);
            });
        }

        originalRequest._retry = true;
        isRefreshing = true;

        try {
          await useAuthStore.getState().refreshAccessToken();
          const newToken = useAuthStore.getState().accessToken;
          
          if (newToken) {
            originalRequest.headers.Authorization = `Bearer ${newToken}`;
            processQueue(null, newToken);
            return axios(originalRequest);
          } else {
            throw new Error('No token received');
          }
        } catch (refreshError) {
          // Refresh failed - logout and redirect immediately
          processQueue(refreshError, null);
          useAuthStore.getState().logout();
          
          // Clear any pending requests
          failedQueue = [];
          
          // Redirect to login if not already there
          if (window.location.pathname !== '/auth/login') {
            window.location.href = '/auth/login';
          }
          
          return Promise.reject(refreshError);
        } finally {
          isRefreshing = false;
        }
      }
      return Promise.reject(error);
    }
  );
}

