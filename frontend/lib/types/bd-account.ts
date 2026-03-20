/**
 * BD / Telegram-linked account as returned by GET /api/bd-accounts and related endpoints.
 * Single source of truth for the shape used across messaging, bd-accounts UI, discovery, pipeline.
 */
export interface BDAccountProxyConfig {
  type: 'socks5' | 'http';
  host: string;
  port: number;
  username?: string;
  password?: string;
}

/** Sync folder row from GET /api/bd-accounts/:id/sync-folders */
export interface BdSyncFolder {
  id: string;
  folder_id: number;
  folder_title: string;
  order_index: number;
  is_user_created?: boolean;
  icon?: string | null;
}

export interface BDAccount {
  id: string;
  organization_id?: string;
  phone_number?: string | null;
  telegram_id: string;
  is_active: boolean;
  connected_at?: string;
  last_activity?: string;
  created_at: string;
  sync_status?: string;
  sync_progress_done?: number;
  sync_progress_total?: number;
  sync_error?: string;
  is_owner?: boolean;
  owner_id?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  username?: string | null;
  bio?: string | null;
  photo_file_id?: string | null;
  display_name?: string | null;
  proxy_config?: BDAccountProxyConfig | null;
  proxy_status?: 'none' | 'configured' | 'ok' | 'error';
  last_proxy_check_at?: string | null;
  last_proxy_error?: string | null;
  connection_state?: 'connected' | 'reconnecting' | 'disconnected' | 'reauth_required';
  disconnect_reason?: string | null;
  last_error_code?: string | null;
  last_error_at?: string | null;
  /** Unread across synced chats (messaging aggregate). */
  unread_count?: number;
  /** Demo: DB-only, send disabled. */
  is_demo?: boolean;
}
