import { apiClient } from './client';

export interface SearchGroupItem {
  chatId: string;
  title: string;
  peerType: string;
  membersCount?: number;
  username?: string;
}

export type SearchType = 'groups' | 'channels' | 'all';

export type SearchMode = 'query' | 'hashtag';

export async function searchGroupsByKeyword(
  bdAccountId: string,
  query: string,
  limit?: number,
  type: SearchType = 'all',
  searchMode: SearchMode = 'query'
): Promise<SearchGroupItem[]> {
  const params = new URLSearchParams({ q: query.trim() });
  if (limit != null) params.set('limit', String(limit));
  params.set('type', type);
  if (searchMode === 'hashtag') params.set('searchMode', 'hashtag');
  const { data } = await apiClient.get<SearchGroupItem[]>(
    `/api/bd-accounts/${bdAccountId}/search-groups?${params.toString()}`
  );
  return Array.isArray(data) ? data : [];
}

export async function getAdminedPublicChannels(bdAccountId: string): Promise<SearchGroupItem[]> {
  const { data } = await apiClient.get<SearchGroupItem[]>(
    `/api/bd-accounts/${bdAccountId}/admined-public-channels`
  );
  return Array.isArray(data) ? data : [];
}

export interface ResolveChatsResultItem {
  chatId?: string;
  title?: string;
  peerType?: string;
  error?: string;
}

export async function resolveChatsFromInputs(
  bdAccountId: string,
  inputs: string[]
): Promise<{ results: ResolveChatsResultItem[] }> {
  const { data } = await apiClient.post<{ results: ResolveChatsResultItem[] }>(
    `/api/bd-accounts/${bdAccountId}/resolve-chats`,
    { inputs }
  );
  return data;
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
}): Promise<{ taskId: string }> {
  const { data } = await apiClient.post<{ taskId: string }>('/api/crm/parse/start', payload);
  return data;
}

/** Unified SSE stream URL (progress + notifications). Use useEventsStream() and subscribe('parse_progress' | 'sync_progress' | 'notification'). */
export function getEventsStreamUrl(): string {
  const base = typeof window !== 'undefined' ? window.location.origin : (process.env.NEXT_PUBLIC_API_URL || '');
  return `${base}/api/events/stream`;
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
