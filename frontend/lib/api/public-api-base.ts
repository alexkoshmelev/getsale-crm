/**
 * API base URL for axios/fetch.
 *
 * Browser: always '' (same-origin https://app.../api/...). Next.js rewrites proxy to gateway
 * (see next.config.js + Dockerfile API_URL=http://gateway:8000 at build). Avoids cross-subdomain
 * CORS and OPTIONS 404 on api-crm.getsale.ai.
 *
 * Server (SSR): API_URL || NEXT_PUBLIC_API_URL || localhost.
 */
export function getApiBaseUrl(): string {
  if (typeof window !== 'undefined') {
    return '';
  }
  return (
    process.env.API_URL ||
    process.env.NEXT_PUBLIC_API_URL ||
    'http://localhost:8000'
  ).replace(/\/$/, '');
}
