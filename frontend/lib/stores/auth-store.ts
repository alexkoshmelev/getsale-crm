import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import axios from 'axios';

interface User {
  id: string;
  email: string;
  organizationId: string;
  role: string;
}

interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  user: User | null;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<void>;
  signup: (email: string, password: string, organizationName: string) => Promise<void>;
  logout: () => void;
  refreshAccessToken: () => Promise<void>;
}

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      accessToken: null,
      refreshToken: null,
      user: null,
      isAuthenticated: false,

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

      signup: async (email: string, password: string, organizationName: string) => {
        try {
          const response = await axios.post(`${API_URL}/api/auth/signup`, {
            email,
            password,
            organizationName,
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
          throw new Error(error.response?.data?.error || 'Signup failed');
        }
      },

      logout: () => {
        set({
          accessToken: null,
          refreshToken: null,
          user: null,
          isAuthenticated: false,
        });
        delete axios.defaults.headers.common['Authorization'];
      },

      refreshAccessToken: async () => {
        const { refreshToken } = get();
        if (!refreshToken) {
          get().logout();
          return;
        }

        try {
          const response = await axios.post(`${API_URL}/api/auth/refresh`, {
            refreshToken,
          });

          const { accessToken } = response.data;

          set({ accessToken });
          axios.defaults.headers.common['Authorization'] = `Bearer ${accessToken}`;
        } catch (error) {
          get().logout();
        }
      },
    }),
    {
      name: 'auth-storage',
      storage: createJSONStorage(() => (typeof window !== 'undefined' ? localStorage : undefined as any)),
    }
  )
);

// Initialize axios interceptor (only on client side)
if (typeof window !== 'undefined') {
  // Set initial token if exists
  const authStorage = localStorage.getItem('auth-storage');
  if (authStorage) {
    try {
      const auth = JSON.parse(authStorage);
      if (auth.state?.accessToken) {
        axios.defaults.headers.common['Authorization'] = `Bearer ${auth.state.accessToken}`;
      }
    } catch (error) {
      console.error('Error parsing auth storage:', error);
    }
  }

  // Add response interceptor for token refresh
  axios.interceptors.response.use(
    (response) => response,
    async (error) => {
      if (error.response?.status === 401) {
        try {
          await useAuthStore.getState().refreshAccessToken();
          // Retry original request
          const newToken = useAuthStore.getState().accessToken;
          if (newToken) {
            error.config.headers.Authorization = `Bearer ${newToken}`;
            return axios.request(error.config);
          }
        } catch (refreshError) {
          // Refresh failed, logout
          useAuthStore.getState().logout();
          if (window.location.pathname !== '/auth/login') {
            window.location.href = '/auth/login';
          }
        }
      }
      return Promise.reject(error);
    }
  );
}

