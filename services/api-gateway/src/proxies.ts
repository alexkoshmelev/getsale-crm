import type { Request, Response } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import type { Logger } from '@getsale/logger';
import { serviceUrls } from './config';
import {
  addCorrelationToProxyReq,
  addInternalAuthToProxyReq,
  addAuthHeadersToProxyReq,
  addCorrelationToResponse,
  addCorsToProxyRes,
} from './proxy-helpers';

function proxyOnError(log: Logger) {
  return (err: Error, req: Request, res: Response): void => {
    log.error({ message: 'Proxy error', url: req.url, error: String(err) });
    if (!res.headersSent) {
      res.status(500).json({ error: 'Service unavailable' });
    } else {
      log.warn({ message: 'Response already sent, cannot send error response', url: req.url });
    }
  };
}

export function createProxies(log: Logger) {
  const onError = proxyOnError(log);

  const authProxy = createProxyMiddleware({
    target: serviceUrls.auth,
    changeOrigin: true,
    pathRewrite: { '^/api/auth': '/api/auth' },
    logLevel: 'debug',
    timeout: 30000,
    proxyTimeout: 30000,
    onProxyReq: (proxyReq, req) => {
      addCorrelationToProxyReq(proxyReq, req as Request);
      addInternalAuthToProxyReq(proxyReq);
      proxyReq.setTimeout(30000, () => {});
    },
    onProxyRes: (proxyRes, req, res) => {
      addCorrelationToResponse(res, req as Request);
      addCorsToProxyRes(proxyRes, req as Request);
    },
    onError,
  });

  const inviteProxy = createProxyMiddleware({
    target: serviceUrls.auth,
    changeOrigin: true,
    pathRewrite: { '^/api/invite': '/api/invite' },
    onProxyReq: (proxyReq, req) => {
      addCorrelationToProxyReq(proxyReq, req as Request);
      addInternalAuthToProxyReq(proxyReq);
    },
    onProxyRes: (proxyRes, req, res) => {
      addCorrelationToResponse(res, req as Request);
      addCorsToProxyRes(proxyRes, req as Request);
    },
  });

  const createAuthProxy = (target: string, pathRewrite: Record<string, string>, extra?: { timeout?: number; proxyTimeout?: number }) =>
    createProxyMiddleware({
      target,
      changeOrigin: true,
      pathRewrite,
      ...extra,
      onProxyReq: (proxyReq, req) => {
        addCorrelationToProxyReq(proxyReq, req as Request);
        addInternalAuthToProxyReq(proxyReq);
        addAuthHeadersToProxyReq(proxyReq, req as Request);
      },
      onProxyRes: (proxyRes, req, res) => {
        addCorrelationToResponse(res, req as Request);
        addCorsToProxyRes(proxyRes, req as Request);
      },
      onError,
    });

  const crmProxy = createAuthProxy(serviceUrls.crm, { '^/api/crm': '/api/crm' });
  const messagingProxy = createAuthProxy(serviceUrls.messaging, { '^/api/messaging': '/api/messaging' });
  const aiProxy = createAuthProxy(serviceUrls.ai, { '^/api/ai': '/api/ai' });
  const userProxy = createAuthProxy(serviceUrls.user, { '^/api/users': '/api/users' });
  const pipelineProxy = createAuthProxy(serviceUrls.pipeline, { '^/api/pipeline': '/api/pipeline' });
  const automationProxy = createAuthProxy(serviceUrls.automation, { '^/api/automation': '/api/automation' });
  const analyticsProxy = createAuthProxy(serviceUrls.analytics, { '^/api/analytics': '/api/analytics' });
  const activityProxy = createAuthProxy(serviceUrls.activity, { '^/api/activity': '/api/activity' });
  const teamProxy = createAuthProxy(serviceUrls.team, { '^/api/team': '/api/team' });
  const campaignProxy = createAuthProxy(serviceUrls.campaign, { '^/api/campaigns': '/api/campaigns' }, { timeout: 30000, proxyTimeout: 30000 });

  const stripeWebhookProxy = createProxyMiddleware({
    target: serviceUrls.user,
    changeOrigin: true,
    pathRewrite: { '^/api/users/stripe-webhook': '/api/users/stripe-webhook' },
    onProxyReq: (proxyReq, req) => {
      addCorrelationToProxyReq(proxyReq, req as Request);
      addInternalAuthToProxyReq(proxyReq);
    },
    onProxyRes: (proxyRes, req, res) => {
      addCorrelationToResponse(res, req as Request);
    },
    onError,
  });

  // Long-running: dialogs-by-folders?refresh=1 can take 3–5+ min (flood wait, many chats)
  const BD_ACCOUNTS_PROXY_TIMEOUT_MS = 300000; // 5 min
  const bdAccountsProxy = createProxyMiddleware({
    target: serviceUrls.bdAccounts,
    changeOrigin: true,
    pathRewrite: { '^/api/bd-accounts': '/api/bd-accounts' },
    timeout: BD_ACCOUNTS_PROXY_TIMEOUT_MS,
    proxyTimeout: BD_ACCOUNTS_PROXY_TIMEOUT_MS,
    logLevel: 'debug',
    onProxyReq: (proxyReq, req) => {
      addCorrelationToProxyReq(proxyReq, req as Request);
      addInternalAuthToProxyReq(proxyReq);
      addAuthHeadersToProxyReq(proxyReq, req as Request);
    },
    onProxyRes: (proxyRes, req, res) => {
      addCorrelationToResponse(res, req as Request);
      addCorsToProxyRes(proxyRes, req as Request);
    },
    onError: (err, req, res) => {
      log.error({ message: 'Proxy error', url: req.url, error: String(err) });
      if (!res.headersSent) res.status(504).json({ error: 'Service unavailable' });
    },
  });

  return {
    authProxy,
    inviteProxy,
    crmProxy,
    messagingProxy,
    aiProxy,
    userProxy,
    stripeWebhookProxy,
    bdAccountsProxy,
    pipelineProxy,
    automationProxy,
    analyticsProxy,
    activityProxy,
    teamProxy,
    campaignProxy,
  };
}
