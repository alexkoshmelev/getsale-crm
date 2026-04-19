/**
 * BD / Telegram-linked account as returned by GET /api/bd-accounts and related endpoints.
 * Single source of truth for the shape used across messaging, bd-accounts UI, discovery, pipeline.
 */
export interface BDAccountProxyConfig {
  type: 'socks5';
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
  /** Active Telegram FLOOD_WAIT window (ISO). */
  flood_wait_until?: string | null;
  flood_wait_seconds?: number | null;
  /** Last flood reason (op + error), for support / UI. */
  flood_reason?: string | null;
  /** When flood was last recorded. */
  flood_last_at?: string | null;
  /** Telegram SpamBot / escalation marked account as restricted. */
  spam_restricted_at?: string | null;
  spam_restriction_source?: string | null;
  peer_flood_count_1h?: number | null;
  last_spambot_check_at?: string | null;
  last_spambot_result?: string | null;
  send_blocked_until?: string | null;
  /** When false, optional runtime activation (future gateway feature). */
  gramjs_runtime_enabled?: boolean;
  timezone?: string | null;
  working_hours_start?: string | null;
  working_hours_end?: string | null;
  working_days?: number[] | null;
  auto_responder_enabled?: boolean;
  auto_responder_system_prompt?: string | null;
  auto_responder_history_count?: number;
  /** Unread across synced chats (messaging aggregate). */
  unread_count?: number;
  /** Demo: DB-only, send disabled. */
  is_demo?: boolean;
}
