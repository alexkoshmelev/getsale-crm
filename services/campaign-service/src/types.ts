/** DB row interfaces and type aliases for campaign-service. */

export type QueryParam = string | number | boolean | null | Date | string[];

export interface CampaignRow {
  id: string;
  organization_id: string;
  company_id: string | null;
  pipeline_id: string | null;
  name: string;
  status: string;
  target_audience: Record<string, unknown> | null;
  schedule: Record<string, unknown> | null;
  lead_creation_settings: Record<string, unknown> | null;
  created_by_user_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  owner_email?: string;
  owner_name?: string;
  total_participants?: number;
}

export interface CampaignWithKpi extends CampaignRow {
  total_sent: number;
  total_read: number;
  total_replied: number;
  total_converted_to_shared_chat: number;
  total_won: number;
  total_revenue: number;
  bd_account_name: string | null;
}

export interface CampaignStep {
  id: string;
  order_index: number;
  template_id: string;
  delay_hours: number | null;
  delay_minutes: number | null;
  trigger_type: string | null;
  conditions: Record<string, unknown> | null;
  content: string;
  /** When true, step is skipped at send time but kept in editor. */
  is_hidden?: boolean | null;
}

export interface DueParticipantRow {
  participant_id: string;
  campaign_id: string;
  contact_id: string;
  bd_account_id: string;
  channel_id: string;
  current_step: number;
  status: string;
  organization_id: string;
  /** Order in campaign queue; used to stagger next_send_at between participants. */
  enqueue_order: number;
  /** Per-account daily send limit from bd_accounts.max_dm_per_day; null = use env default. */
  max_dm_per_day?: number | null;
}

export interface CampaignCountRow {
  campaign_id: string;
  cnt: number;
}

export interface CampaignRevenueRow {
  campaign_id: string;
  total: string;
}

export interface BdAccountRow {
  id: string;
  display_name: string | null;
  first_name: string | null;
  last_name: string | null;
  username: string | null;
  phone_number: string | null;
  telegram_id: string | null;
}
