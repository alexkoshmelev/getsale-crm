import axios from 'axios';

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

// Note: Token refresh is handled by the main axios interceptor in auth-store.ts
// This interceptor just passes through - the main interceptor will handle 401 errors
apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    // Let the main axios interceptor handle 401 errors to avoid duplicate refresh attempts
    return Promise.reject(error);
  }
);

