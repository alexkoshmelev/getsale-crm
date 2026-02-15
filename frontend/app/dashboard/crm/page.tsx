'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import {
  Plus,
  Building2,
  User,
  TrendingUp,
  Pencil,
  Trash2,
  ChevronRight,
  Mail,
  Phone,
  Briefcase,
  Filter,
} from 'lucide-react';
import { apiClient } from '@/lib/api/client';
import {
  fetchCompanies,
  fetchContacts,
  fetchDeals,
  deleteCompany,
  deleteContact,
  deleteDeal,
  type Company,
  type Contact,
  type Deal,
  type PaginationMeta,
} from '@/lib/api/crm';
import { Modal } from '@/components/ui/Modal';
import { SearchInput } from '@/components/ui/SearchInput';
import { Pagination } from '@/components/ui/Pagination';
import { EmptyState } from '@/components/ui/EmptyState';
import { TableSkeleton } from '@/components/ui/Skeleton';
import Button from '@/components/ui/Button';
import { SlideOver } from '@/components/ui/SlideOver';
import { CompanyFormModal } from '@/components/crm/CompanyFormModal';
import { ContactFormModal } from '@/components/crm/ContactFormModal';
import { DealFormModal } from '@/components/crm/DealFormModal';
import { AddToFunnelModal } from '@/components/crm/AddToFunnelModal';
import { clsx } from 'clsx';

type TabId = 'companies' | 'contacts' | 'deals';

/** Имя контакта для отображения: display_name → имя+фамилия (не "Telegram %") → @username → telegram_id → заглушка */
function getContactDisplayName(c: Contact): string {
  const dn = (c.display_name ?? '').trim();
  if (dn) return dn;
  const fn = (c.first_name ?? '').trim();
  const ln = (c.last_name ?? '').trim();
  const full = [fn, ln].filter(Boolean).join(' ').trim();
  if (full && !/^Telegram\s+\d+$/i.test(full)) return full;
  const un = (c.username ?? '').trim();
  if (un) return un.startsWith('@') ? un : `@${un}`;
  if (c.telegram_id) return String(c.telegram_id);
  return 'Без имени';
}

const TABS: { id: TabId; i18nKey: string; icon: typeof Building2 }[] = [
  { id: 'companies', i18nKey: 'companies', icon: Building2 },
  { id: 'contacts', i18nKey: 'contacts', icon: User },
  { id: 'deals', i18nKey: 'deals', icon: TrendingUp },
];

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 10;

const VALID_TABS: TabId[] = ['companies', 'contacts', 'deals'];

export default function CRMPage() {
  const { t } = useTranslation();
  const searchParams = useSearchParams();
  const urlOpenApplied = useRef(false);
  const [activeTab, setActiveTab] = useState<TabId>('companies');
  const [search, setSearch] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');
  const [page, setPage] = useState(DEFAULT_PAGE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [companies, setCompanies] = useState<Company[]>([]);
  const [companiesPagination, setCompaniesPagination] = useState<PaginationMeta | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactsPagination, setContactsPagination] = useState<PaginationMeta | null>(null);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [dealsPagination, setDealsPagination] = useState<PaginationMeta | null>(null);

  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailType, setDetailType] = useState<TabId | null>(null);
  const [detailData, setDetailData] = useState<Company | Contact | Deal | null>(null);

  const [companyModalOpen, setCompanyModalOpen] = useState(false);
  const [companyEdit, setCompanyEdit] = useState<Company | null>(null);
  const [contactModalOpen, setContactModalOpen] = useState(false);
  const [contactEdit, setContactEdit] = useState<Contact | null>(null);
  const [addToFunnelContact, setAddToFunnelContact] = useState<Contact | null>(null);
  const [dealModalOpen, setDealModalOpen] = useState(false);
  const [dealEdit, setDealEdit] = useState<Deal | null>(null);

  const [deleteConfirm, setDeleteConfirm] = useState<{ type: TabId; id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Open entity from URL (e.g. from command palette: /dashboard/crm?tab=companies&open=uuid)
  useEffect(() => {
    if (urlOpenApplied.current) return;
    const tab = searchParams.get('tab');
    const open = searchParams.get('open');
    if (tab && open && VALID_TABS.includes(tab as TabId)) {
      urlOpenApplied.current = true;
      setActiveTab(tab as TabId);
      setDetailType(tab as TabId);
      setDetailId(open);
    }
  }, [searchParams]);

  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [activeTab, searchDebounced]);

  const loadCompanies = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchCompanies({
        page,
        limit: DEFAULT_LIMIT,
        search: searchDebounced || undefined,
      });
      setCompanies(res.items);
      setCompaniesPagination(res.pagination);
    } catch (e) {
      setError(t('crm.loadError'));
      setCompanies([]);
      setCompaniesPagination(null);
    } finally {
      setLoading(false);
    }
  }, [page, searchDebounced]);

  const loadContacts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchContacts({
        page,
        limit: DEFAULT_LIMIT,
        search: searchDebounced || undefined,
      });
      setContacts(res.items);
      setContactsPagination(res.pagination);
    } catch (e) {
      setError('Не удалось загрузить контакты');
      setContacts([]);
      setContactsPagination(null);
    } finally {
      setLoading(false);
    }
  }, [page, searchDebounced]);

  const loadDeals = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchDeals({
        page,
        limit: DEFAULT_LIMIT,
        search: searchDebounced || undefined,
      });
      setDeals(res.items);
      setDealsPagination(res.pagination);
    } catch (e) {
      setError(t('crm.loadError'));
      setDeals([]);
      setDealsPagination(null);
    } finally {
      setLoading(false);
    }
  }, [page, searchDebounced]);

  useEffect(() => {
    if (activeTab === 'companies') loadCompanies();
    else if (activeTab === 'contacts') loadContacts();
    else loadDeals();
  }, [activeTab, loadCompanies, loadContacts, loadDeals]);

  useEffect(() => {
    if (!detailId || !detailType) {
      setDetailData(null);
      return;
    }
    if (detailType === 'companies') {
      apiClient.get(`/api/crm/companies/${detailId}`).then((r) => setDetailData(r.data));
    } else if (detailType === 'contacts') {
      apiClient.get(`/api/crm/contacts/${detailId}`).then((r) => setDetailData(r.data));
    } else if (detailType === 'deals') {
      apiClient.get(`/api/crm/deals/${detailId}`).then((r) => {
        setDetailData(r.data);
        setDealEdit(r.data);
        setDealModalOpen(true);
        setDetailId(null);
        setDetailType(null);
        setDetailData(null);
      });
    }
  }, [detailId, detailType]);

  const refresh = useCallback(() => {
    if (activeTab === 'companies') loadCompanies();
    else if (activeTab === 'contacts') loadContacts();
    else loadDeals();
  }, [activeTab, loadCompanies, loadContacts, loadDeals]);

  const openDetail = (type: TabId, id: string, deal?: Deal) => {
    if (type === 'deals' && deal) {
      setDealEdit(deal);
      setDealModalOpen(true);
      return;
    }
    setDetailType(type);
    setDetailId(id);
  };

  const handleDelete = async () => {
    if (!deleteConfirm) return;
    setDeleting(true);
    try {
      if (deleteConfirm.type === 'companies') await deleteCompany(deleteConfirm.id);
      else if (deleteConfirm.type === 'contacts') await deleteContact(deleteConfirm.id);
      else await deleteDeal(deleteConfirm.id);
      setDeleteConfirm(null);
      if (detailId === deleteConfirm.id) {
        setDetailId(null);
        setDetailType(null);
        setDetailData(null);
      }
      refresh();
    } catch (e) {
      setError((e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? t('crm.deleteError'));
    } finally {
      setDeleting(false);
    }
  };

  const pagination = activeTab === 'companies' ? companiesPagination : activeTab === 'contacts' ? contactsPagination : dealsPagination;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-bold text-foreground tracking-tight">
            {t('crm.title')}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('crm.subtitle')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {activeTab === 'companies' && (
            <Button onClick={() => { setCompanyEdit(null); setCompanyModalOpen(true); }}>
              <Plus className="w-4 h-4 mr-2" />
              {t('common.company')}
            </Button>
          )}
          {activeTab === 'contacts' && (
            <Button onClick={() => { setContactEdit(null); setContactModalOpen(true); }}>
              <Plus className="w-4 h-4 mr-2" />
              {t('common.contact')}
            </Button>
          )}
          {activeTab === 'deals' && (
            <Button onClick={() => { setDealEdit(null); setDealModalOpen(true); }}>
              <Plus className="w-4 h-4 mr-2" />
              {t('common.deal')}
            </Button>
          )}
        </div>
      </div>

      <div className="border-b border-border">
        <nav className="flex gap-1" aria-label="Вкладки CRM">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={clsx(
                  'flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-t-lg -mb-px',
                  activeTab === tab.id
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'
                )}
              >
                <Icon className="w-4 h-4" />
                {t(`crm.${tab.i18nKey}`)}
              </button>
            );
          })}
        </nav>
      </div>

      <div className="flex flex-col sm:flex-row gap-4">
        <div className="flex-1">
          <SearchInput
            placeholder={activeTab === 'companies' ? t('crm.searchCompanies') : activeTab === 'contacts' ? t('crm.searchContacts') : t('crm.searchDeals')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-xs"
          />
        </div>
      </div>

      {error && (
        <div className="p-4 rounded-xl bg-destructive/10 border border-destructive/20 text-destructive text-sm">
          {error}
        </div>
      )}

      <div className="rounded-xl border border-border bg-card shadow-soft overflow-hidden">
        {activeTab === 'companies' && (
          <>
            {loading ? (
              <table className="w-full">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('crm.name')}</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('crm.industry')}</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('crm.size')}</th>
                    <th className="px-6 py-3 w-24" />
                  </tr>
                </thead>
                <TableSkeleton rows={5} cols={3} />
              </table>
            ) : (
              <table className="w-full">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('crm.name')}</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('crm.industry')}</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('crm.size')}</th>
                    <th className="px-6 py-3 w-24" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {companies.map((c) => (
                    <tr
                      key={c.id}
                      className="hover:bg-muted/30 transition-colors cursor-pointer group"
                      onClick={() => openDetail('companies', c.id)}
                    >
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <div className="p-2 rounded-lg bg-primary/10 text-primary">
                            <Building2 className="w-4 h-4" />
                          </div>
                          <span className="font-medium text-foreground">{c.name}</span>
                        </div>
                      </td>
                      <td className="px-6 py-4 text-sm text-muted-foreground">{c.industry ?? '—'}</td>
                      <td className="px-6 py-4 text-sm text-muted-foreground">{c.size ?? '—'}</td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); setCompanyEdit(c); setCompanyModalOpen(true); }}
                            className="p-2 rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
                            aria-label={t('crm.editAction')}
                          >
                            <Pencil className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); setDeleteConfirm({ type: 'companies', id: c.id, name: c.name }); }}
                            className="p-2 rounded-lg text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                            aria-label={t('crm.deleteAction')}
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                          <ChevronRight className="w-4 h-4 text-muted-foreground" />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {!loading && companies.length === 0 && (
              <EmptyState
                icon={Building2}
                title={t('crm.noCompanies')}
                description={t('crm.noCompaniesDesc')}
                action={<Button onClick={() => setCompanyModalOpen(true)}>{t('crm.addCompany')}</Button>}
              />
            )}
          </>
        )}

        {activeTab === 'contacts' && (
          <>
            {loading ? (
              <table className="w-full">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('crm.name')}</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('crm.email')}</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('common.company')}</th>
                    <th className="px-6 py-3 w-24" />
                  </tr>
                </thead>
                <TableSkeleton rows={5} cols={3} />
              </table>
            ) : (
              <table className="w-full">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('crm.name')}</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('crm.email')}</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('common.company')}</th>
                    <th className="px-6 py-3 w-24" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {contacts.map((c) => (
                    <tr
                      key={c.id}
                      className="hover:bg-muted/30 transition-colors cursor-pointer group"
                      onClick={() => openDetail('contacts', c.id)}
                    >
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <div className="p-2 rounded-full bg-primary/10 text-primary">
                            <User className="w-4 h-4" />
                          </div>
                          <span className="font-medium text-foreground">
                            {getContactDisplayName(c)}
                          </span>
                        </div>
                      </td>
                      <td className="px-6 py-4 text-sm text-muted-foreground">{c.email ?? '—'}</td>
                      <td className="px-6 py-4 text-sm text-muted-foreground">{(c as Contact & { companyName?: string }).companyName ?? (c as Contact & { company_name?: string }).company_name ?? '—'}</td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); setAddToFunnelContact(c); }}
                            className="p-2 rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
                            title={t('pipeline.addToFunnel')}
                            aria-label={t('pipeline.addToFunnel')}
                          >
                            <Filter className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); setContactEdit(c); setContactModalOpen(true); }}
                            className="p-2 rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
                            aria-label={t('crm.editAction')}
                          >
                            <Pencil className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); setDeleteConfirm({ type: 'contacts', id: c.id, name: getContactDisplayName(c) || c.email || c.id }); }}
                            className="p-2 rounded-lg text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                            aria-label={t('crm.deleteAction')}
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                          <ChevronRight className="w-4 h-4 text-muted-foreground" />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {!loading && contacts.length === 0 && (
              <EmptyState
                icon={User}
                title={t('crm.noContacts')}
                description={t('crm.noContactsDesc')}
                action={<Button onClick={() => setContactModalOpen(true)}>{t('crm.addContact')}</Button>}
              />
            )}
          </>
        )}

        {activeTab === 'deals' && (
          <>
            {loading ? (
              <table className="w-full">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('common.deal')}</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('common.company')}</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('crm.pipelineStage')}</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('crm.amount')}</th>
                    <th className="px-6 py-3 w-24" />
                  </tr>
                </thead>
                <TableSkeleton rows={5} cols={4} />
              </table>
            ) : (
              <table className="w-full">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('common.deal')}</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('common.company')}</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('crm.pipelineStage')}</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('crm.amount')}</th>
                    <th className="px-6 py-3 w-24" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {deals.map((d) => (
                    <tr
                      key={d.id}
                      className="hover:bg-muted/30 transition-colors cursor-pointer group"
                      onClick={() => openDetail('deals', d.id, d)}
                    >
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <div className="p-2 rounded-lg bg-primary/10 text-primary">
                            <TrendingUp className="w-4 h-4" />
                          </div>
                          <span className="font-medium text-foreground">{d.title}</span>
                        </div>
                      </td>
                      <td className="px-6 py-4 text-sm text-muted-foreground">{d.companyName ?? d.company_name ?? '—'}</td>
                      <td className="px-6 py-4 text-sm text-muted-foreground">
                        {(d.pipelineName ?? d.pipeline_name ?? '—')} / {(d.stageName ?? d.stage_name ?? '—')}
                      </td>
                      <td className="px-6 py-4 text-sm font-medium text-foreground">
                        {d.value != null ? `${Number(d.value).toLocaleString()} ${d.currency ?? 'RUB'}` : '—'}
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); setDealEdit(d); setDealModalOpen(true); }}
                            className="p-2 rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
                            aria-label={t('crm.editAction')}
                          >
                            <Pencil className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); setDeleteConfirm({ type: 'deals', id: d.id, name: d.title }); }}
                            className="p-2 rounded-lg text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                            aria-label={t('crm.deleteAction')}
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                          <ChevronRight className="w-4 h-4 text-muted-foreground" />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {!loading && deals.length === 0 && (
              <EmptyState
                icon={TrendingUp}
                title={t('crm.noDeals')}
                description={t('crm.noDealsDesc')}
                action={<Button onClick={() => setDealModalOpen(true)}>{t('crm.addDeal')}</Button>}
              />
            )}
          </>
        )}

        {pagination && pagination.totalPages > 1 && (
          <div className="px-6 py-4 border-t border-border">
            <Pagination
              page={page}
              totalPages={pagination.totalPages}
              onPageChange={setPage}
            />
            <p className="mt-2 text-center text-sm text-muted-foreground">
              {t('crm.shownCount', {
                from: ((page - 1) * pagination.limit) + 1,
                to: Math.min(page * pagination.limit, pagination.total),
                total: pagination.total,
              })}
            </p>
          </div>
        )}
      </div>

      {/* Detail SlideOver (companies & contacts only; deals open in modal) */}
      <SlideOver
        isOpen={Boolean(detailId && detailType && detailType !== 'deals')}
        onClose={() => { setDetailId(null); setDetailType(null); setDetailData(null); }}
        title={
          detailType === 'companies' ? t('common.company') :
          detailType === 'contacts' ? t('common.contact') : t('common.deal')
        }
      >
        {detailData && detailType === 'companies' && (
          <CompanyDetail
            company={detailData as Company}
            onEdit={() => { setCompanyEdit(detailData as Company); setCompanyModalOpen(true); setDetailId(null); }}
            onDelete={() => setDeleteConfirm({ type: 'companies', id: (detailData as Company).id, name: (detailData as Company).name })}
            t={t}
          />
        )}
        {detailData && detailType === 'contacts' && (
          <ContactDetail
            contact={detailData as Contact}
            onEdit={() => { setContactEdit(detailData as Contact); setContactModalOpen(true); setDetailId(null); }}
            onDelete={() => setDeleteConfirm({ type: 'contacts', id: (detailData as Contact).id, name: getContactDisplayName(detailData as Contact) || (detailData as Contact).email || '' })}
            onAddToFunnel={() => setAddToFunnelContact(detailData as Contact)}
            t={t}
          />
        )}
      </SlideOver>

      {/* Modals */}
      <CompanyFormModal
        isOpen={companyModalOpen}
        onClose={() => { setCompanyModalOpen(false); setCompanyEdit(null); }}
        onSuccess={() => { refresh(); setCompanyModalOpen(false); setCompanyEdit(null); }}
        edit={companyEdit}
      />
      <ContactFormModal
        isOpen={contactModalOpen}
        onClose={() => { setContactModalOpen(false); setContactEdit(null); }}
        onSuccess={() => { refresh(); setContactModalOpen(false); setContactEdit(null); }}
        edit={contactEdit}
      />
      <AddToFunnelModal
        isOpen={!!addToFunnelContact}
        onClose={() => setAddToFunnelContact(null)}
        contactId={addToFunnelContact?.id ?? ''}
        contactName={addToFunnelContact ? getContactDisplayName(addToFunnelContact) : undefined}
      />
      <DealFormModal
        isOpen={dealModalOpen}
        onClose={() => { setDealModalOpen(false); setDealEdit(null); }}
        onSuccess={() => { refresh(); setDealModalOpen(false); setDealEdit(null); }}
        edit={dealEdit}
      />

      {/* Delete confirmation */}
      <Modal
        isOpen={Boolean(deleteConfirm)}
        onClose={() => setDeleteConfirm(null)}
        title={t('crm.deleteConfirmTitle')}
        size="sm"
      >
        {deleteConfirm && (
          <div className="space-y-4">
            <p className="text-muted-foreground">
              {t('crm.deleteConfirmText', { name: deleteConfirm.name })}
            </p>
            <div className="flex gap-3">
              <Button variant="outline" className="flex-1" onClick={() => setDeleteConfirm(null)}>
                {t('common.cancel')}
              </Button>
              <Button variant="danger" className="flex-1" onClick={handleDelete} disabled={deleting}>
                {deleting ? t('common.deleting') : t('common.delete')}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function CompanyDetail({
  company,
  onEdit,
  onDelete,
  t,
}: {
  company: Company;
  onEdit: () => void;
  onDelete: () => void;
  t: (key: string) => string;
}) {
  return (
    <div className="space-y-6">
      <div className="flex items-start gap-4">
        <div className="p-3 rounded-xl bg-primary/10 text-primary">
          <Building2 className="w-8 h-8" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-heading text-lg font-semibold text-foreground truncate">{company.name}</h3>
          {company.industry && <p className="text-sm text-muted-foreground">{company.industry}</p>}
          {company.size && <p className="text-sm text-muted-foreground">{t('crm.size')}: {company.size}</p>}
        </div>
      </div>
      {company.description && (
        <div>
          <h4 className="text-sm font-medium text-foreground mb-1">{t('crm.description')}</h4>
          <p className="text-sm text-muted-foreground whitespace-pre-wrap">{company.description}</p>
        </div>
      )}
      <div className="flex gap-2 pt-4 border-t border-border">
        <Button variant="outline" size="sm" onClick={onEdit}>{t('crm.editAction')}</Button>
        <Button variant="danger" size="sm" onClick={onDelete}>{t('crm.deleteAction')}</Button>
      </div>
    </div>
  );
}

function ContactDetail({
  contact,
  onEdit,
  onDelete,
  onAddToFunnel,
  t,
}: {
  contact: Contact & { companyName?: string | null };
  onEdit: () => void;
  onDelete: () => void;
  onAddToFunnel?: () => void;
  t: (key: string) => string;
}) {
  const name = getContactDisplayName(contact);
  return (
    <div className="space-y-6">
      <div className="flex items-start gap-4">
        <div className="p-3 rounded-full bg-primary/10 text-primary">
          <User className="w-8 h-8" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-heading text-lg font-semibold text-foreground">{name}</h3>
          {(contact as Contact & { companyName?: string }).companyName && (
            <p className="text-sm text-muted-foreground flex items-center gap-1 mt-1">
              <Briefcase className="w-4 h-4" />
              {(contact as Contact & { companyName?: string }).companyName}
            </p>
          )}
        </div>
      </div>
      <div className="space-y-3">
        {contact.email && (
          <div className="flex items-center gap-2 text-sm">
            <Mail className="w-4 h-4 text-muted-foreground" />
            <a href={`mailto:${contact.email}`} className="text-primary hover:underline">{contact.email}</a>
          </div>
        )}
        {contact.phone && (
          <div className="flex items-center gap-2 text-sm">
            <Phone className="w-4 h-4 text-muted-foreground" />
            <a href={`tel:${contact.phone}`} className="text-primary hover:underline">{contact.phone}</a>
          </div>
        )}
        {contact.telegram_id && (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Telegram ID:</span>
            <span className="text-foreground">{contact.telegram_id}</span>
          </div>
        )}
        {contact.username && (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">@</span>
            <span className="text-foreground">{contact.username.startsWith('@') ? contact.username : `@${contact.username}`}</span>
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-2 pt-4 border-t border-border">
        {onAddToFunnel && (
          <Button variant="outline" size="sm" onClick={onAddToFunnel} className="gap-1.5">
            <Filter className="w-4 h-4" />
            {t('pipeline.addToFunnel')}
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={onEdit}>{t('crm.editAction')}</Button>
        <Button variant="danger" size="sm" onClick={onDelete}>{t('crm.deleteAction')}</Button>
      </div>
    </div>
  );
}

function DealDetail({
  deal,
  onEdit,
  onDelete,
  t,
}: {
  deal: Deal;
  onEdit: () => void;
  onDelete: () => void;
  t: (key: string) => string;
}) {
  const pipelineName = deal.pipelineName ?? deal.pipeline_name ?? '—';
  const stageName = deal.stageName ?? deal.stage_name ?? '—';
  const companyName = deal.companyName ?? deal.company_name ?? '—';
  return (
    <div className="space-y-6">
      <div className="flex items-start gap-4">
        <div className="p-3 rounded-xl bg-primary/10 text-primary">
          <TrendingUp className="w-8 h-8" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-heading text-lg font-semibold text-foreground">{deal.title}</h3>
          <p className="text-sm text-muted-foreground mt-1">{companyName}</p>
        </div>
      </div>
      <dl className="grid grid-cols-1 gap-3 text-sm">
        <div>
          <dt className="text-muted-foreground">{t('crm.pipelineStage')}</dt>
          <dd className="font-medium text-foreground">{pipelineName} → {stageName}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('crm.amount')}</dt>
          <dd className="font-medium text-foreground">
            {deal.value != null ? `${Number(deal.value).toLocaleString()} ${deal.currency ?? 'RUB'}` : '—'}
          </dd>
        </div>
      </dl>
      <div className="flex gap-2 pt-4 border-t border-border">
        <Button variant="outline" size="sm" onClick={onEdit}>{t('crm.editAction')}</Button>
        <Button variant="danger" size="sm" onClick={onDelete}>{t('crm.deleteAction')}</Button>
      </div>
    </div>
  );
}
