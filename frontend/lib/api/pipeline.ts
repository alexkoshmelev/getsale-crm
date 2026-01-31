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
