import type { TelegramClient } from 'telegram';

export interface ProxyConfig {
  type: 'socks5' | 'http';
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface StructuredLog {
  info(entry: { message: string; [key: string]: unknown }): void;
  error(entry: { message: string; [key: string]: unknown }): void;
  warn(entry: { message: string; [key: string]: unknown }): void;
}

export interface TelegramClientInfo {
  client: TelegramClient;
  accountId: string;
  organizationId: string;
  isConnected: boolean;
  lastActivity: Date;
  phoneNumber: string;
}

export interface QrLoginState {
  status: 'pending' | 'qr' | 'need_password' | 'success' | 'expired' | 'error';
  loginTokenUrl?: string;
  expiresAt?: number;
  accountId?: string;
  error?: string;
  passwordHint?: string;
}

export type AccountState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'flood_wait'
  | 'error'
  | 'reauth_required';
