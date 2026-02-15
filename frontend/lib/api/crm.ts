import { apiClient } from './client';

export interface PaginationParams {
  page?: number;
  limit?: number;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

// Companies
export interface Company {
  id: string;
  organization_id: string;
  name: string;
  industry?: string | null;
  size?: string | null;
  description?: string | null;
  goals?: unknown;
  policies?: unknown;
  created_at: string;
  updated_at: string;
}

export interface CompaniesListParams extends PaginationParams {
  search?: string;
  industry?: string;
}

export interface CompaniesListResponse {
  items: Company[];
  pagination: PaginationMeta;
}

export async function fetchCompanies(params?: CompaniesListParams): Promise<CompaniesListResponse> {
  const { data } = await apiClient.get<CompaniesListResponse>('/api/crm/companies', { params });
  return data;
}

export async function fetchCompany(id: string): Promise<Company> {
  const { data } = await apiClient.get<Company>(`/api/crm/companies/${id}`);
  return data;
}

export async function createCompany(body: {
  name: string;
  industry?: string;
  size?: string;
  description?: string;
  goals?: unknown;
  policies?: unknown;
}): Promise<Company> {
  const { data } = await apiClient.post<Company>('/api/crm/companies', body);
  return data;
}

export async function updateCompany(
  id: string,
  body: Partial<{ name: string; industry: string; size: string; description: string; goals: unknown; policies: unknown }>
): Promise<Company> {
  const { data } = await apiClient.put<Company>(`/api/crm/companies/${id}`, body);
  return data;
}

export async function deleteCompany(id: string): Promise<void> {
  await apiClient.delete(`/api/crm/companies/${id}`);
}

// Contacts
export interface Contact {
  id: string;
  organization_id: string;
  company_id?: string | null;
  first_name: string;
  last_name?: string | null;
  email?: string | null;
  phone?: string | null;
  telegram_id?: string | null;
  display_name?: string | null;
  username?: string | null;
  consent_flags?: Record<string, boolean>;
  created_at: string;
  updated_at: string;
  company_name?: string | null;
  companyName?: string | null;
}

export interface ContactsListParams extends PaginationParams {
  search?: string;
  companyId?: string;
}

export interface ContactsListResponse {
  items: Contact[];
  pagination: PaginationMeta;
}

export async function fetchContacts(params?: ContactsListParams): Promise<ContactsListResponse> {
  const { data } = await apiClient.get<ContactsListResponse>('/api/crm/contacts', { params });
  return data;
}

export async function fetchContact(id: string): Promise<Contact & { companyName?: string | null }> {
  const { data } = await apiClient.get<Contact & { companyName?: string | null }>(`/api/crm/contacts/${id}`);
  return data;
}

export async function createContact(body: {
  firstName?: string;
  lastName?: string;
  displayName?: string;
  username?: string;
  email?: string;
  phone?: string;
  telegramId?: string;
  companyId?: string | null;
  consentFlags?: Record<string, boolean>;
}): Promise<Contact> {
  const { data } = await apiClient.post<Contact>('/api/crm/contacts', body);
  return data;
}

export async function updateContact(
  id: string,
  body: Partial<{
    firstName: string;
    lastName: string | null;
    email: string | null;
    phone: string | null;
    telegramId: string | null;
    companyId: string | null;
    displayName: string | null;
    username: string | null;
    consentFlags: Record<string, boolean>;
  }>
): Promise<Contact> {
  const { data } = await apiClient.put<Contact>(`/api/crm/contacts/${id}`, body);
  return data;
}

export async function deleteContact(id: string): Promise<void> {
  await apiClient.delete(`/api/crm/contacts/${id}`);
}

// Deals
export interface Deal {
  id: string;
  organization_id: string;
  company_id: string;
  contact_id?: string | null;
  pipeline_id: string;
  stage_id: string;
  owner_id: string;
  title: string;
  value?: number | null;
  currency?: string | null;
  probability?: number | null;
  expected_close_date?: string | null;
  comments?: string | null;
  history?: unknown[];
  created_at: string;
  updated_at: string;
  company_name?: string;
  companyName?: string;
  pipeline_name?: string;
  pipelineName?: string;
  stage_name?: string;
  stageName?: string;
  stage_order?: number;
  stageOrder?: number;
  contactName?: string | null;
  ownerEmail?: string | null;
  bd_account_id?: string | null;
  channel?: string | null;
  channel_id?: string | null;
}

export interface DealsListParams extends PaginationParams {
  search?: string;
  companyId?: string;
  contactId?: string;
  pipelineId?: string;
  stageId?: string;
  ownerId?: string;
}

export interface DealsListResponse {
  items: Deal[];
  pagination: PaginationMeta;
}

export async function fetchDeals(params?: DealsListParams): Promise<DealsListResponse> {
  const { data } = await apiClient.get<DealsListResponse>('/api/crm/deals', { params });
  return data;
}

export async function fetchDeal(id: string): Promise<Deal> {
  const { data } = await apiClient.get<Deal>(`/api/crm/deals/${id}`);
  return data;
}

export async function createDeal(body: {
  companyId?: string | null;
  contactId?: string | null;
  pipelineId: string;
  stageId?: string | null;
  title: string;
  value?: number | null;
  currency?: string;
  probability?: number | null;
  expectedCloseDate?: string | null;
  comments?: string | null;
  bdAccountId?: string | null;
  channel?: string | null;
  channelId?: string | null;
}): Promise<Deal> {
  const { data } = await apiClient.post<Deal>('/api/crm/deals', body);
  return data;
}

export async function updateDeal(
  id: string,
  body: Partial<{
    title: string;
    value: number | null;
    currency: string | null;
    contactId: string | null;
    ownerId: string;
    probability: number | null;
    expectedCloseDate: string | null;
    comments: string | null;
  }>
): Promise<Deal> {
  const { data } = await apiClient.put<Deal>(`/api/crm/deals/${id}`, body);
  return data;
}

export async function updateDealStage(id: string, body: { stageId: string; reason?: string }): Promise<{ success: boolean }> {
  const { data } = await apiClient.patch<{ success: boolean }>(`/api/crm/deals/${id}/stage`, body);
  return data;
}

export async function deleteDeal(id: string): Promise<void> {
  await apiClient.delete(`/api/crm/deals/${id}`);
}
