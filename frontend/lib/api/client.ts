import axios from 'axios';
import { useAuthStore } from '@/lib/stores/auth-store';

// Data requests go through same origin (Next.js rewrite) so cookies are sent automatically.
const API_URL =
  typeof window !== 'undefined' ? '' : (process.env.NEXT_PUBLIC_API_URL || process.env.API_URL || 'http://localhost:8000');

// Cookie-setting requests (refresh) must hit the gateway directly so Set-Cookie reaches the browser.
const GATEWAY_URL = typeof window !== 'undefined'
  ? (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000')
  : (process.env.NEXT_PUBLIC_API_URL || process.env.API_URL || 'http://localhost:8000');

export const apiClient = axios.create({
  baseURL: API_URL,
  headers: { 'Content-Type': 'application/json' },
  withCredentials: true,
});

// Prevent caching of /api/auth/me so workspace switch always gets fresh user (avoids 304 with stale organizationId).
apiClient.interceptors.request.use((config) => {
  if (config.url?.includes('/api/auth/me')) {
    config.params = { ...config.params, _: Date.now() };
    config.headers['Cache-Control'] = 'no-cache';
    config.headers['Pragma'] = 'no-cache';
  }
  return config;
});

let apiClientRefreshing = false;
const apiClientQueue: Array<{ request: AxiosConfigWithRetry; resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];

type AxiosConfigWithRetry = import('axios').InternalAxiosRequestConfig & { _retry?: boolean };

/** Build a fresh config for retry so the browser sends the latest cookies (avoids stale config). */
function retryConfig(original: AxiosConfigWithRetry): import('axios').InternalAxiosRequestConfig {
  return { ...original, withCredentials: true, _retry: true } as import('axios').InternalAxiosRequestConfig;
}

apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;
    if (
      !originalRequest ||
      error.response?.status !== 401 ||
      (originalRequest as AxiosConfigWithRetry)._retry === true ||
      originalRequest?.url?.includes('/api/auth/signin') ||
      originalRequest?.url?.includes('/api/auth/signup') ||
      originalRequest?.url?.includes('/api/auth/refresh') ||
      originalRequest?.url?.includes('/api/auth/logout')
    ) {
      return Promise.reject(error);
    }

    if (apiClientRefreshing) {
      return new Promise((resolve, reject) => {
        apiClientQueue.push({ request: originalRequest as AxiosConfigWithRetry, resolve, reject });
      });
    }

    (originalRequest as AxiosConfigWithRetry)._retry = true;
    apiClientRefreshing = true;

    try {
      // Refresh must go directly to gateway so Set-Cookie reaches the browser (not through Next.js rewrite).
      const refreshRes = await axios.post<{ user: { id: string; email: string; organizationId: string; role: string } }>(
        `${GATEWAY_URL}/api/auth/refresh`,
        {},
        { withCredentials: true }
      );
      const user = refreshRes.data?.user;
      if (user) useAuthStore.setState({ user });

      // Give the browser time to apply the new access_token cookie before the retry (critical for credentials to be sent).
      await new Promise((r) => setTimeout(r, 150));

      const retry = retryConfig(originalRequest);
      const res = await apiClient.request(retry);
      apiClientQueue.forEach(({ request, resolve, reject }) => {
        apiClient.request(retryConfig(request)).then(resolve, reject);
      });
      apiClientQueue.length = 0;
      return res;
    } catch (err: unknown) {
      const axiosErr = err as { config?: { url?: string } };
      const wasRefreshCall = typeof axiosErr?.config?.url === 'string' && axiosErr.config.url.includes('/api/auth/refresh');
      apiClientQueue.forEach(({ reject: r }) => r(err));
      apiClientQueue.length = 0;
      // Only logout when the refresh request itself failed (e.g. invalid/expired refresh token). If retry got 401 again, do not kick the user out.
      if (wasRefreshCall) {
        await useAuthStore.getState().logout();
        if (typeof window !== 'undefined' && window.location.pathname !== '/auth/login') {
          window.location.href = '/auth/login';
        }
      }
      return Promise.reject(err);
    } finally {
      apiClientRefreshing = false;
    }
  }
);

