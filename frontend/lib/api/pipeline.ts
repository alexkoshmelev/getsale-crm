import { apiClient } from './client';

export interface Pipeline {
  id: string;
  organization_id: string;
  name: string;
  description?: string | null;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export interface Stage {
  id: string;
  pipeline_id: string;
  organization_id: string;
  name: string;
  order_index: number;
  color?: string | null;
  automation_rules?: unknown;
  entry_rules?: unknown;
  exit_rules?: unknown;
  allowed_actions?: unknown;
  created_at: string;
  updated_at: string;
}

export interface Lead {
  id: string;
  contact_id: string;
  pipeline_id: string;
  stage_id: string;
  order_index: number;
  created_at: string;
  updated_at: string;
  first_name?: string | null;
  last_name?: string | null;
  display_name?: string | null;
  username?: string | null;
  email?: string | null;
  telegram_id?: string | null;
}

export interface LeadsListResponse {
  items: Lead[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

export async function fetchPipelines(): Promise<Pipeline[]> {
  const { data } = await apiClient.get<Pipeline[]>('/api/pipeline');
  return data;
}

export async function fetchStages(pipelineId?: string): Promise<Stage[]> {
  const { data } = await apiClient.get<Stage[]>('/api/pipeline/stages', {
    params: pipelineId ? { pipelineId } : undefined,
  });
  return data;
}

export async function fetchLeads(params: {
  pipelineId: string;
  stageId?: string;
  page?: number;
  limit?: number;
}): Promise<LeadsListResponse> {
  const { data } = await apiClient.get<LeadsListResponse>('/api/pipeline/leads', { params });
  return data;
}

/** Воронки, в которых контакт уже есть (для проверки «уже в воронке»). */
export async function fetchContactPipelineIds(contactId: string): Promise<string[]> {
  const { data } = await apiClient.get<{ pipelineIds: string[] }>(`/api/pipeline/contacts/${contactId}/pipelines`);
  return data?.pipelineIds ?? [];
}

export async function addLeadToPipeline(body: {
  contactId: string;
  pipelineId: string;
  stageId?: string;
}): Promise<Lead> {
  const { data } = await apiClient.post<Lead>('/api/pipeline/leads', body);
  return data;
}

export async function updateLead(leadId: string, body: { stageId?: string; orderIndex?: number }): Promise<Lead> {
  const { data } = await apiClient.patch<Lead>(`/api/pipeline/leads/${leadId}`, body);
  return data;
}

export async function removeLead(leadId: string): Promise<void> {
  await apiClient.delete(`/api/pipeline/leads/${leadId}`);
}

export async function updatePipeline(
  pipelineId: string,
  body: { name?: string; description?: string | null; isDefault?: boolean }
): Promise<Pipeline> {
  const { data } = await apiClient.put<Pipeline>(`/api/pipeline/${pipelineId}`, body);
  return data;
}

export async function deletePipeline(pipelineId: string): Promise<void> {
  await apiClient.delete(`/api/pipeline/${pipelineId}`);
}

export async function updateStage(
  stageId: string,
  body: {
    name?: string;
    orderIndex?: number;
    color?: string | null;
    automationRules?: unknown;
    entryRules?: unknown;
    exitRules?: unknown;
    allowedActions?: unknown;
  }
): Promise<Stage> {
  const { data } = await apiClient.put<Stage>(`/api/pipeline/stages/${stageId}`, body);
  return data;
}

export async function deleteStage(stageId: string): Promise<void> {
  await apiClient.delete(`/api/pipeline/stages/${stageId}`);
}

export async function createPipeline(body: {
  name: string;
  description?: string | null;
  isDefault?: boolean;
}): Promise<Pipeline> {
  const { data } = await apiClient.post<Pipeline>('/api/pipeline', body);
  return data;
}

export async function createStage(body: {
  pipelineId: string;
  name: string;
  orderIndex?: number;
  color?: string | null;
}): Promise<Stage> {
  const { data } = await apiClient.post<Stage>('/api/pipeline/stages', body);
  return data;
}
