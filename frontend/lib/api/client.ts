import axios from 'axios';
import { useAuthStore } from '@/lib/stores/auth-store';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

export const apiClient = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Add auth token interceptor
apiClient.interceptors.request.use((config) => {
  if (typeof window !== 'undefined') {
    const authStorage = localStorage.getItem('auth-storage');
    if (authStorage) {
      try {
        const auth = JSON.parse(authStorage);
        if (auth.state?.accessToken) {
          config.headers.Authorization = `Bearer ${auth.state.accessToken}`;
        }
      } catch (error) {
        console.error('Error parsing auth storage:', error);
      }
    }
  }
  return config;
});

// 401: refresh token and retry once (apiClient is separate — auth-store interceptor only applies to default axios)
let apiClientRefreshing = false;
const apiClientQueue: Array<{ request: any; resolve: (v: any) => void; reject: (e: any) => void }> = [];

apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;
    if (
      !originalRequest ||
      error.response?.status !== 401 ||
      originalRequest._retry === true ||
      originalRequest?.url?.includes('/api/auth/signin') ||
      originalRequest?.url?.includes('/api/auth/signup') ||
      originalRequest?.url?.includes('/api/auth/refresh')
    ) {
      return Promise.reject(error);
    }

    if (apiClientRefreshing) {
      return new Promise((resolve, reject) => {
        apiClientQueue.push({ request: originalRequest, resolve, reject });
      });
    }

    originalRequest._retry = true;
    apiClientRefreshing = true;

    try {
      await useAuthStore.getState().refreshAccessToken();
      const newToken = useAuthStore.getState().accessToken;
      if (newToken) {
        originalRequest.headers = { ...originalRequest.headers, Authorization: `Bearer ${newToken}` };
        const res = await apiClient.request(originalRequest);
        apiClientQueue.forEach(({ request, resolve, reject }) => {
          request.headers = { ...request.headers, Authorization: `Bearer ${newToken}` };
          apiClient.request(request).then(resolve, reject);
        });
        apiClientQueue.length = 0;
        return res;
      }
    } catch (refreshError) {
      apiClientQueue.forEach(({ reject: r }) => r(refreshError));
      apiClientQueue.length = 0;
    } finally {
      apiClientRefreshing = false;
    }
    return Promise.reject(error);
  }
);

