import api from '../api/client.js';

api.interceptors.request.use((config) => {
  if (config.url) {
    const normalizedUrl = config.url.startsWith('/') ? config.url : `/${config.url}`;
    if (!normalizedUrl.startsWith('/api/')) {
      config.url = `/api${normalizedUrl}`;
    }
  }
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export default api;
