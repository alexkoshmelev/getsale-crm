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

// Handle 401 errors
apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (error.response?.status === 401) {
      // Try to refresh token
      if (typeof window !== 'undefined') {
        const authStorage = localStorage.getItem('auth-storage');
        if (authStorage) {
          try {
            const auth = JSON.parse(authStorage);
            if (auth.state?.refreshToken) {
              const response = await axios.post(`${API_URL}/api/auth/refresh`, {
                refreshToken: auth.state.refreshToken,
              });
              const newToken = response.data.accessToken;
              // Update storage
              const updatedAuth = {
                ...auth,
                state: { ...auth.state, accessToken: newToken },
              };
              localStorage.setItem('auth-storage', JSON.stringify(updatedAuth));
              // Retry original request
              error.config.headers.Authorization = `Bearer ${newToken}`;
              return axios.request(error.config);
            }
          } catch (refreshError) {
            // Refresh failed, redirect to login
            localStorage.removeItem('auth-storage');
            window.location.href = '/auth/login';
          }
        }
      }
    }
    return Promise.reject(error);
  }
);

