'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import {
  Plus,
  Building2,
  User,
  Users,
  Pencil,
  Trash2,
  ChevronRight,
  Mail,
  Phone,
  AtSign,
  Briefcase,
  Filter,
  FileUp,
  StickyNote,
  Bell,
  Check,
  Crown,
  FileText,
} from 'lucide-react';
import {
  fetchCompanies,
  fetchContacts,
  fetchCompany,
  fetchContact,
  deleteCompany,
  deleteContact,
  importContactsFromCsv,
  fetchContactNotes,
  createContactNote,
  deleteNote,
  fetchContactReminders,
  createContactReminder,
  updateReminder,
  deleteReminder,
  type Company,
  type Contact,
  type PaginationMeta,
  type Note,
  type Reminder,
} from '@/lib/api/crm';
import { Modal } from '@/components/ui/Modal';
import { SearchInput } from '@/components/ui/SearchInput';
import { Pagination } from '@/components/ui/Pagination';
import { EmptyState } from '@/components/ui/EmptyState';
import { TableSkeleton } from '@/components/ui/Skeleton';
import Button from '@/components/ui/Button';
import { CompanyFormModal } from '@/components/crm/CompanyFormModal';
import { ContactFormModal } from '@/components/crm/ContactFormModal';
import { AddToFunnelModal } from '@/components/crm/AddToFunnelModal';
import { clsx } from 'clsx';

type TabId = 'companies' | 'contacts';

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
];

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 10;

const VALID_TABS: TabId[] = ['companies', 'contacts'];

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

  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailType, setDetailType] = useState<TabId | null>(null);
  const [detailData, setDetailData] = useState<Company | Contact | null>(null);

  const [companyModalOpen, setCompanyModalOpen] = useState(false);
  const [companyEdit, setCompanyEdit] = useState<Company | null>(null);
  const [contactModalOpen, setContactModalOpen] = useState(false);
  const [contactEdit, setContactEdit] = useState<Contact | null>(null);
  const [addToFunnelContact, setAddToFunnelContact] = useState<Contact | null>(null);

  const [deleteConfirm, setDeleteConfirm] = useState<{ type: TabId; id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [importModalOpen, setImportModalOpen] = useState(false);
  const [importFileContent, setImportFileContent] = useState('');
  const [importHasHeader, setImportHasHeader] = useState(true);
  const [importColumnMapping, setImportColumnMapping] = useState<Record<number, string>>({});
  const [importResult, setImportResult] = useState<{ created: number; updated: number; errors: { row: number; message: string }[] } | null>(null);
  const [importLoading, setImportLoading] = useState(false);

  // Open entity from URL (e.g. from command palette: /dashboard/crm?tab=companies&open=uuid)
  useEffect(() => {
    if (urlOpenApplied.current) return;
    const tab = searchParams.get('tab');
    const open = searchParams.get('open');
    const resolvedTab = (tab === 'deals' ? 'contacts' : tab) as TabId;
    if (resolvedTab && open && VALID_TABS.includes(resolvedTab)) {
      urlOpenApplied.current = true;
      setActiveTab(resolvedTab);
      setDetailType(resolvedTab);
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

  useEffect(() => {
    if (activeTab === 'companies') loadCompanies();
    else loadContacts();
  }, [activeTab, loadCompanies, loadContacts]);

  useEffect(() => {
    if (!detailId || !detailType) {
      setDetailData(null);
      return;
    }
    if (detailType === 'companies') {
      fetchCompany(detailId).then(setDetailData).catch(() => setDetailData(null));
    } else {
      fetchContact(detailId).then(setDetailData).catch(() => setDetailData(null));
    }
  }, [detailId, detailType]);

  const refresh = useCallback(() => {
    if (activeTab === 'companies') loadCompanies();
    else loadContacts();
  }, [activeTab, loadCompanies, loadContacts]);

  const openDetail = (type: TabId, id: string) => {
    setDetailType(type);
    setDetailId(id);
  };

  const handleDelete = async () => {
    if (!deleteConfirm) return;
    setDeleting(true);
    try {
      if (deleteConfirm.type === 'companies') await deleteCompany(deleteConfirm.id);
      else await deleteContact(deleteConfirm.id);
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

  const pagination = activeTab === 'companies' ? companiesPagination : contactsPagination;

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
            <>
              <Button variant="outline" onClick={() => { setImportModalOpen(true); setImportResult(null); setImportFileContent(''); setImportColumnMapping({}); }}>
                <FileUp className="w-4 h-4 mr-2" />
                {t('crm.importContacts')}
              </Button>
              <Button onClick={() => { setContactEdit(null); setContactModalOpen(true); }}>
                <Plus className="w-4 h-4 mr-2" />
                {t('common.contact')}
              </Button>
            </>
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
            placeholder={activeTab === 'companies' ? t('crm.searchCompanies') : t('crm.searchContacts')}
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
                    <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('crm.phone')}</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Username</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Telegram ID</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('crm.premium')}</th>
                    <th className="px-6 py-3 w-24" />
                  </tr>
                </thead>
                <TableSkeleton rows={5} cols={7} />
              </table>
            ) : (
              <table className="w-full">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('crm.name')}</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('crm.email')}</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('common.company')}</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('crm.phone')}</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Username</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Telegram ID</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('crm.premium')}</th>
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
                      <td className="px-6 py-4 text-sm text-muted-foreground">{c.phone ?? '—'}</td>
                      <td className="px-6 py-4 text-sm text-muted-foreground">{c.username ? (c.username.startsWith('@') ? c.username : `@${c.username}`) : '—'}</td>
                      <td className="px-6 py-4 text-sm text-muted-foreground">{c.telegram_id ?? '—'}</td>
                      <td className="px-6 py-4 text-sm text-muted-foreground">
                        {c.premium === true ? (
                          <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400"><Crown className="w-4 h-4" />{t('crm.yes')}</span>
                        ) : c.premium === false ? (
                          <span className="text-muted-foreground">{t('crm.no')}</span>
                        ) : '—'}
                      </td>
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

      {/* Карточка компании/контакта как диалог (как карточка сделки) */}
      <Modal
        isOpen={Boolean(detailId && detailType)}
        onClose={() => { setDetailId(null); setDetailType(null); setDetailData(null); }}
        title={detailType === 'companies' ? t('common.company') : t('common.contact')}
        size="lg"
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
      </Modal>

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
        defaultPipelineId={typeof window !== 'undefined' ? window.localStorage.getItem('pipeline.selectedPipelineId') : null}
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

      {/* Contact import from CSV */}
      <Modal
        isOpen={importModalOpen}
        onClose={() => { setImportModalOpen(false); setImportResult(null); setImportFileContent(''); }}
        title={t('crm.importTitle')}
        size="md"
      >
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {t('crm.importContactsHint')}
          </p>
          <input
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            id="crm-import-csv"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              const reader = new FileReader();
              reader.onload = () => {
                const text = String(reader.result ?? '');
                setImportFileContent(text);
                setImportResult(null);
                const lines = text.split('\n').filter((l) => l.trim());
                const first = lines[0];
                if (first) {
                  const cols = first.split(',').length;
                  const defaultMap: Record<number, string> = {};
                  const defaults = ['firstName', 'lastName', 'email', 'phone', 'telegramId'];
                  for (let i = 0; i < cols; i++) defaultMap[i] = defaults[i] ?? '';
                  setImportColumnMapping(defaultMap);
                }
              };
              reader.readAsText(file, 'UTF-8');
              e.target.value = '';
            }}
          />
          <label
            htmlFor="crm-import-csv"
            className="inline-flex items-center justify-center font-medium rounded-lg border border-border hover:bg-accent text-foreground px-4 py-2 text-sm cursor-pointer transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <FileUp className="w-4 h-4 mr-2" />
            {importFileContent ? t('crm.importChangeFile') : t('crm.importSelectFile')}
          </label>
          {importFileContent && (
            <>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={importHasHeader} onChange={(e) => setImportHasHeader(e.target.checked)} className="rounded border-border" />
                <span className="text-sm text-foreground">{t('crm.importHasHeader')}</span>
              </label>
              {(() => {
                const lines = importFileContent.split('\n').filter((l) => l.trim());
                const firstRow = lines[importHasHeader ? 1 : 0];
                const colCount = firstRow ? firstRow.split(',').length : 0;
                const fieldOpts = [
                  { value: '', label: t('crm.importSkip') },
                  { value: 'firstName', label: t('crm.importFirstName') },
                  { value: 'lastName', label: t('crm.importLastName') },
                  { value: 'email', label: t('crm.importEmail') },
                  { value: 'phone', label: t('crm.importPhone') },
                  { value: 'telegramId', label: t('crm.importTelegramId') },
                ];
                return (
                  <div className="space-y-2">
                    <span className="text-sm font-medium text-foreground">{t('crm.importMapping')}</span>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                      {Array.from({ length: colCount }, (_, i) => (
                        <div key={i} className="flex flex-col gap-1">
                          <span className="text-xs text-muted-foreground">Кол. {i + 1}</span>
                          <select
                            value={importColumnMapping[i] ?? ''}
                            onChange={(e) => setImportColumnMapping((prev) => ({ ...prev, [i]: e.target.value }))}
                            className="w-full px-2 py-1.5 rounded-lg border border-border bg-background text-foreground text-sm"
                          >
                            {fieldOpts.map((o) => (
                              <option key={o.value || 'skip'} value={o.value}>{o.label}</option>
                            ))}
                          </select>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}
            </>
          )}
          {importResult && (
            <div className="p-3 rounded-lg bg-muted/50 text-sm">
              <p className="text-foreground">{t('crm.importCreated')}: {importResult.created}, {t('crm.importUpdated')}: {importResult.updated}</p>
              {importResult.errors.length > 0 && (
                <p className="text-destructive mt-1">{t('crm.importErrors')}: {importResult.errors.length} (строки: {importResult.errors.slice(0, 5).map((e) => e.row).join(', ')}{importResult.errors.length > 5 ? '…' : ''})</p>
              )}
            </div>
          )}
          <div className="flex gap-2 justify-end pt-2">
            <Button variant="outline" onClick={() => { setImportModalOpen(false); setImportResult(null); }}>
              {t('common.close')}
            </Button>
            <Button
              disabled={!importFileContent || importLoading}
              onClick={async () => {
                if (!importFileContent) return;
                setImportLoading(true);
                try {
                  const mapping: Record<string, number> = {};
                  Object.entries(importColumnMapping).forEach(([colIdx, field]) => {
                    if (field) mapping[field] = parseInt(colIdx, 10);
                  });
                  const result = await importContactsFromCsv({
                    content: importFileContent,
                    hasHeader: importHasHeader,
                    mapping: Object.keys(mapping).length ? mapping : undefined,
                  });
                  setImportResult(result);
                  if (result.created > 0 || result.updated > 0) loadContacts();
                } catch (err) {
                  setImportResult({ created: 0, updated: 0, errors: [{ row: 0, message: String(err) }] });
                } finally {
                  setImportLoading(false);
                }
              }}
            >
              {importLoading ? t('common.loading') : t('crm.importRun')}
            </Button>
          </div>
        </div>
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
  const initials = (() => {
    const parts = name.replace(/@/g, '').trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase().slice(0, 2);
    if (name.length >= 2) return name.slice(0, 2).toUpperCase();
    return name.slice(0, 1).toUpperCase() || '?';
  })();
  const [notes, setNotes] = useState<Note[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [noteText, setNoteText] = useState('');
  const [remindAt, setRemindAt] = useState('');
  const [remindTitle, setRemindTitle] = useState('');
  const [addingNote, setAddingNote] = useState(false);
  const [addingReminder, setAddingReminder] = useState(false);

  const loadNotes = useCallback(() => {
    fetchContactNotes(contact.id).then(setNotes).catch(() => setNotes([]));
  }, [contact.id]);
  const loadReminders = useCallback(() => {
    fetchContactReminders(contact.id).then(setReminders).catch(() => setReminders([]));
  }, [contact.id]);

  useEffect(() => { loadNotes(); loadReminders(); }, [loadNotes, loadReminders]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row gap-6">
        <div className="shrink-0">
          <div className="w-20 h-20 rounded-full bg-primary/15 flex items-center justify-center text-primary font-semibold text-2xl">
            {initials}
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <h3 className="font-heading text-xl font-semibold text-foreground truncate">
              {name}
            </h3>
            {contact.premium === true && (
              <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400 text-sm" title="Telegram Premium">
                <Crown className="w-4 h-4" />
              </span>
            )}
          </div>
          {(contact as Contact & { companyName?: string }).companyName && (
            <p className="text-sm text-muted-foreground flex items-center gap-1 mt-1">
              <Briefcase className="w-4 h-4" />
              {(contact as Contact & { companyName?: string }).companyName}
            </p>
          )}
        </div>
      </div>

      <dl className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
        {contact.email && (
          <div>
            <dt className="text-muted-foreground flex items-center gap-2">
              <Mail className="w-4 h-4" /> {t('crm.email')}
            </dt>
            <dd className="font-medium text-foreground mt-0.5">
              <a href={`mailto:${contact.email}`} className="text-primary hover:underline">{contact.email}</a>
            </dd>
          </div>
        )}
        {contact.phone && (
          <div>
            <dt className="text-muted-foreground flex items-center gap-2">
              <Phone className="w-4 h-4" /> {t('crm.phone')}
            </dt>
            <dd className="font-medium text-foreground mt-0.5">
              <a href={`tel:${contact.phone}`} className="text-primary hover:underline">{contact.phone}</a>
            </dd>
          </div>
        )}
        {contact.telegram_id && (
          <div>
            <dt className="text-muted-foreground flex items-center gap-2">
              <User className="w-4 h-4" /> Telegram ID
            </dt>
            <dd className="font-medium text-foreground mt-0.5">{contact.telegram_id}</dd>
          </div>
        )}
        {contact.username && (
          <div>
            <dt className="text-muted-foreground flex items-center gap-2">
              <AtSign className="w-4 h-4" /> Username
            </dt>
            <dd className="font-medium text-foreground mt-0.5">
              {contact.username.startsWith('@') ? contact.username : `@${contact.username}`}
            </dd>
          </div>
        )}
      </dl>

      {contact.bio?.trim() && (
        <div className="pt-4 border-t border-border">
          <dt className="text-muted-foreground flex items-center gap-2 mb-1">
            <FileText className="w-4 h-4" /> {t('crm.bio')}
          </dt>
          <dd className="text-foreground whitespace-pre-wrap">{contact.bio.trim()}</dd>
        </div>
      )}

      {(contact as Contact & { telegramGroups?: { telegram_chat_id: string; telegram_chat_title?: string }[] }).telegramGroups?.length ? (
        <div className="pt-4 border-t border-border">
          <h4 className="text-sm font-medium text-foreground flex items-center gap-2 mb-2">
            <Users className="w-4 h-4" /> {t('crm.telegramGroups')}
          </h4>
          <ul className="flex flex-wrap gap-1.5">
            {(contact as Contact & { telegramGroups: { telegram_chat_id: string; telegram_chat_title?: string }[] }).telegramGroups.map((g) => (
              <li key={g.telegram_chat_id} className="px-2 py-1 rounded-md bg-muted/50 text-sm text-foreground">
                {g.telegram_chat_title || g.telegram_chat_id}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="border-t border-border pt-4 space-y-4">
        <h4 className="text-sm font-medium text-foreground flex items-center gap-2">
          <StickyNote className="w-4 h-4" />
          {t('crm.notes')}
        </h4>
        <ul className="space-y-2 max-h-32 overflow-y-auto">
          {notes.map((n) => (
            <li key={n.id} className="flex items-start justify-between gap-2 text-sm bg-muted/40 rounded-lg p-2">
              <span className="text-foreground flex-1 break-words">{n.content}</span>
              <button type="button" onClick={() => deleteNote(n.id).then(loadNotes)} className="text-muted-foreground hover:text-destructive shrink-0" aria-label={t('common.delete')}>×</button>
            </li>
          ))}
        </ul>
        <div className="flex gap-2">
          <input type="text" value={noteText} onChange={(e) => setNoteText(e.target.value)} placeholder={t('crm.addNote')} className="flex-1 px-2 py-1.5 rounded-lg border border-border bg-background text-sm" />
          <Button size="sm" disabled={!noteText.trim() || addingNote} onClick={async () => { if (!noteText.trim()) return; setAddingNote(true); try { await createContactNote(contact.id, noteText.trim()); setNoteText(''); loadNotes(); } finally { setAddingNote(false); } }}>{addingNote ? '...' : t('common.add')}</Button>
        </div>
        <h4 className="text-sm font-medium text-foreground flex items-center gap-2 mt-4">
          <Bell className="w-4 h-4" />
          {t('crm.reminders')}
        </h4>
        <ul className="space-y-2 max-h-28 overflow-y-auto">
          {reminders.map((r) => (
            <li key={r.id} className={clsx('flex items-center justify-between gap-2 text-sm rounded-lg p-2', r.done ? 'bg-muted/30 text-muted-foreground' : 'bg-muted/40')}>
              <span className="flex-1 truncate">{r.title || new Date(r.remind_at).toLocaleString()}</span>
              <div className="flex items-center gap-1 shrink-0">
                {!r.done && <button type="button" onClick={() => updateReminder(r.id, { done: true }).then(loadReminders)} className="p-1 rounded text-green-600 hover:bg-green-500/20" title={t('crm.markDone')}><Check className="w-4 h-4" /></button>}
                <button type="button" onClick={() => deleteReminder(r.id).then(loadReminders)} className="p-1 rounded text-muted-foreground hover:text-destructive">×</button>
              </div>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2 items-end">
          <input type="datetime-local" value={remindAt} onChange={(e) => setRemindAt(e.target.value)} className="px-2 py-1.5 rounded-lg border border-border bg-background text-sm" />
          <input type="text" value={remindTitle} onChange={(e) => setRemindTitle(e.target.value)} placeholder={t('crm.reminderTitle')} className="w-40 px-2 py-1.5 rounded-lg border border-border bg-background text-sm" />
          <Button size="sm" disabled={!remindAt || addingReminder} onClick={async () => { if (!remindAt) return; setAddingReminder(true); try { await createContactReminder(contact.id, { remind_at: new Date(remindAt).toISOString(), title: remindTitle.trim() || undefined }); setRemindAt(''); setRemindTitle(''); loadReminders(); } finally { setAddingReminder(false); } }}>{addingReminder ? '...' : t('common.add')}</Button>
        </div>
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
