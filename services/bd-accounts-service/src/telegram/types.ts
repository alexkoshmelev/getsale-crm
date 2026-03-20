import { TelegramClient } from 'telegram';
import { Pool } from 'pg';
import { RabbitMQClient, RedisClient } from '@getsale/utils';

export interface ProxyConfig {
  type: 'socks5' | 'http';
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface StructuredLog {
  info(...args: unknown[]): void;
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

export interface TelegramClientInfo {
  client: TelegramClient;
  accountId: string;
  organizationId: string;
  userId: string;
  phoneNumber: string;
  isConnected: boolean;
  lastActivity: Date;
  reconnectAttempts: number;
  /** Value used for Redis lock (instanceId); used for refresh and release. */
  lockValue?: string;
}

export interface QrLoginState {
  status: 'pending' | 'qr' | 'need_password' | 'success' | 'expired' | 'error';
  loginTokenUrl?: string;
  expiresAt?: number;
  accountId?: string;
  error?: string;
  passwordHint?: string;
}

export interface QrSessionInternal extends QrLoginState {
  organizationId: string;
  userId: string;
  apiId: number;
  apiHash: string;
  proxyConfigRaw?: ProxyConfig | null;
  passwordResolve?: (password: string) => void;
}

export type TelegramSourceType = 'channel' | 'public_group' | 'private_group' | 'comment_group' | 'unknown';

export interface ResolvedSource {
  input: string;
  type: TelegramSourceType;
  title: string;
  username?: string;
  chatId: string;
  membersCount?: number;
  linkedChatId?: number;
  canGetMembers: boolean;
  canGetMessages: boolean;
}

export interface TelegramManagerDeps {
  pool: Pool;
  rabbitmq: RabbitMQClient;
  redis: RedisClient | null;
  log: StructuredLog;
  instanceId: string;
  clients: Map<string, TelegramClientInfo>;
  qrSessions: Map<string, QrSessionInternal>;
  reconnectIntervals: Map<string, NodeJS.Timeout>;
  updateKeepaliveIntervals: Map<string, NodeJS.Timeout>;
  lockHeartbeatIntervals: Map<string, NodeJS.Timeout>;
  dialogFiltersCache: Map<string, { ts: number; filters: unknown[] }>;
}

export interface SearchResultChat {
  chatId: string;
  title: string;
  peerType: string;
  membersCount?: number;
  username?: string;
}
