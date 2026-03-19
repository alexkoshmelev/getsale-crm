import type { Request, Response } from 'express';
import type { ClientRequest } from 'http';
import { CORRELATION_HEADER, INTERNAL_AUTH_HEADER, INTERNAL_AUTH_SECRET } from './config';
import { getAccessTokenFromRequest } from './auth';
import { resolveOrigin } from './cors';

export function addCorrelationToProxyReq(proxyReq: ClientRequest, req: Request): void {
  const id = req.correlationId;
  if (id) proxyReq.setHeader(CORRELATION_HEADER, id);
}

export function addInternalAuthToProxyReq(proxyReq: ClientRequest): void {
  if (INTERNAL_AUTH_SECRET) proxyReq.setHeader(INTERNAL_AUTH_HEADER, INTERNAL_AUTH_SECRET);
}

export function addAuthHeadersToProxyReq(proxyReq: ClientRequest, req: Request): void {
  const user = req.user;
  const userId = user?.id != null ? String(user.id).trim() : '';
  const organizationId = user?.organizationId != null ? String(user.organizationId).trim() : '';
  if (userId && organizationId) {
    proxyReq.setHeader('X-User-Id', userId);
    proxyReq.setHeader('X-Organization-Id', organizationId);
    if (user!.role) proxyReq.setHeader('X-User-Role', user!.role);
  }
  const token = getAccessTokenFromRequest(req) ?? (typeof req.headers.authorization === 'string' ? req.headers.authorization.replace(/^Bearer\s+/i, '').trim() : undefined);
  if (token) proxyReq.setHeader('Authorization', `Bearer ${token}`);
}

export function addCorrelationToResponse(res: Response, req: Request): void {
  const id = req.correlationId;
  if (id) res.setHeader(CORRELATION_HEADER, id);
}

export function addCorsToProxyRes(
  proxyRes: { headers: Record<string, string | string[] | undefined> },
  req: Request
): void {
  const origin = resolveOrigin(req.headers.origin);
  proxyRes.headers['access-control-allow-origin'] = origin;
  proxyRes.headers['access-control-allow-credentials'] = 'true';
}
