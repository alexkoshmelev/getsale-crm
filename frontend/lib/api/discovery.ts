import { apiClient } from './client';
import {
  searchBdAccountTelegramGroups,
  listBdAccountAdminedPublicChannels,
  resolveBdAccountChatInputs,
  type BdDiscoverySearchGroupItem,
  type BdDiscoverySearchType,
  type BdDiscoverySearchMode,
  type BdResolveChatsResultItem,
} from './bd-accounts';

export type SearchGroupItem = BdDiscoverySearchGroupItem;
export type SearchType = BdDiscoverySearchType;
export type SearchMode = BdDiscoverySearchMode;

export async function searchGroupsByKeyword(
  bdAccountId: string,
  query: string,
  limit?: number,
  type: SearchType = 'all',
  searchMode: SearchMode = 'query'
): Promise<SearchGroupItem[]> {
  return searchBdAccountTelegramGroups(bdAccountId, query, limit, type, searchMode);
}

export async function getAdminedPublicChannels(bdAccountId: string): Promise<SearchGroupItem[]> {
  return listBdAccountAdminedPublicChannels(bdAccountId);
}

export type ResolveChatsResultItem = BdResolveChatsResultItem;

export async function resolveChatsFromInputs(
  bdAccountId: string,
  inputs: string[]
): Promise<{ results: ResolveChatsResultItem[] }> {
  return resolveBdAccountChatInputs(bdAccountId, inputs);
}

export async function generateSearchQueries(topic: string): Promise<{ queries: string[] }> {
  const { data } = await apiClient.post<{ queries: string[] }>('/api/ai/generate-search-queries', { topic: topic.trim() });
  return data;
}

export interface DiscoveryTask {
  id: string;
  name: string;
  type: 'search' | 'parse';
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'stopped';
  progress: number;
  total: number;
  params: any;
  results: any;
  created_at: string;
  updated_at: string;
}

export async function fetchDiscoveryTasks(limit = 50, offset = 0): Promise<{ tasks: DiscoveryTask[], total: number }> {
  const { data } = await apiClient.get(`/api/crm/discovery-tasks?limit=${limit}&offset=${offset}`);
  return data;
}

export async function fetchDiscoveryTask(id: string): Promise<DiscoveryTask> {
  const { data } = await apiClient.get(`/api/crm/discovery-tasks/${id}`);
  return data;
}

export async function createDiscoveryTask(payload: { name: string, type: 'search' | 'parse', params: any }): Promise<DiscoveryTask> {
  const { data } = await apiClient.post('/api/crm/discovery-tasks', payload);
  return data;
}

export async function updateDiscoveryTaskAction(id: string, action: 'start' | 'pause' | 'stop'): Promise<DiscoveryTask> {
  const { data } = await apiClient.post(`/api/crm/discovery-tasks/${id}/action`, { action });
  return data;
}

// ─── Parse flow (smart resolve + strategy) ─────────────────────────────────

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
  error?: string;
}

export interface ParseSettings {
  depth?: 'fast' | 'standard' | 'deep';
  excludeAdmins?: boolean;
}

export async function parseResolve(
  bdAccountId: string,
  sources: string[]
): Promise<{ results: ResolvedSource[] }> {
  const { data } = await apiClient.post<{ results: ResolvedSource[] }>(
    '/api/crm/parse/resolve',
    { sources, bdAccountId }
  );
  return data;
}

export async function parseStart(payload: {
  sources: ResolvedSource[];
  settings?: ParseSettings;
  accountIds: string[];
  listName?: string;
  campaignId?: string;
  campaignName?: string;
  /** Каналы без группы обсуждения: `reactions` → сбор по реакциям (best-effort). */
  channelEngagement?: 'default' | 'reactions';
}): Promise<{ taskId: string; campaignId?: string | null }> {
  const { data } = await apiClient.post<{ taskId: string; campaignId?: string | null }>('/api/crm/parse/start', payload);
  return data;
}

export async function parsePause(taskId: string): Promise<{ taskId: string; status: string }> {
  const { data } = await apiClient.post<{ taskId: string; status: string }>(`/api/crm/parse/pause/${taskId}`);
  return data;
}

export async function parseStop(taskId: string): Promise<{ taskId: string; status: string }> {
  const { data } = await apiClient.post<{ taskId: string; status: string }>(`/api/crm/parse/stop/${taskId}`);
  return data;
}

export interface ParseResult {
  taskId: string;
  name: string;
  status: string;
  progress: number;
  total: number;
  parsed: number;
  results: Record<string, unknown>;
  params: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export async function fetchParseResult(taskId: string): Promise<ParseResult> {
  const { data } = await apiClient.get<ParseResult>(`/api/crm/parse/result/${taskId}`);
  return data;
}
