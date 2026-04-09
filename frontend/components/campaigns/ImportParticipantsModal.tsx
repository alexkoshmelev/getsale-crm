'use client';

import { useState, useCallback, useEffect, useRef, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Database, FileUp, Users, X, Loader2, AlertTriangle, Check } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import {
  checkCampaignAudienceConflicts,
  addCampaignParticipants,
  uploadAudienceFromCsv,
  uploadAudienceFromUsernameList,
  fetchContactsForPicker,
  fetchGroupSources,
  fetchGroupSourceContacts,
  fetchTelegramSourceKeywords,
  fetchTelegramSourceGroups,
  type AudienceConflictRow,
  type ContactForPicker,
  type GroupSource,
  type TelegramSourceGroup,
} from '@/lib/api/campaigns';
import { clsx } from 'clsx';
import { reportError } from '@/lib/error-reporter';

type ImportSource = 'crm' | 'csv' | 'group';
type WizardStep = 'source' | 'select' | 'conflicts' | 'confirm';

interface ImportParticipantsModalProps {
  campaignId: string;
  isOpen: boolean;
  onClose: () => void;
  onImported: () => void;
}

export const ImportParticipantsModal = memo(function ImportParticipantsModal({
  campaignId,
  isOpen,
  onClose,
  onImported,
}: ImportParticipantsModalProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState<WizardStep>('source');
  const [source, setSource] = useState<ImportSource>('crm');
  const [contactIds, setContactIds] = useState<string[]>([]);
  const [conflicts, setConflicts] = useState<AudienceConflictRow[]>([]);
  const [includeConflicts, setIncludeConflicts] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setStep('source');
    setSource('crm');
    setContactIds([]);
    setConflicts([]);
    setIncludeConflicts(false);
    setLoading(false);
    setError(null);
  }, []);

  useEffect(() => {
    if (isOpen) reset();
  }, [isOpen, reset]);

  const handleSourceSelected = (src: ImportSource) => {
    setSource(src);
    setStep('select');
    setError(null);
  };

  const handleContactsCollected = async (ids: string[]) => {
    if (ids.length === 0) return;
    setContactIds(ids);
    setLoading(true);
    setError(null);
    try {
      const { conflicts: c } = await checkCampaignAudienceConflicts(campaignId, ids);
      const risky = c.filter((row) => !row.is_current_campaign || row.last_sent_at != null);
      setConflicts(risky);
      setStep(risky.length > 0 ? 'conflicts' : 'confirm');
    } catch (e) {
      reportError(e, { component: 'ImportParticipantsModal', action: 'checkConflicts' });
      setError(t('campaigns.conflictCheckError', { defaultValue: 'Failed to check conflicts' }));
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmImport = async () => {
    setLoading(true);
    setError(null);
    try {
      const finalIds = includeConflicts
        ? contactIds
        : contactIds.filter((id) => !conflicts.some((c) => c.contact_id === id));
      if (finalIds.length === 0) {
        setError(t('campaigns.noContactsToImport', { defaultValue: 'No contacts to import after filtering conflicts' }));
        setLoading(false);
        return;
      }
      await addCampaignParticipants(campaignId, finalIds);
      onImported();
      onClose();
    } catch (e) {
      reportError(e, { component: 'ImportParticipantsModal', action: 'import' });
      setError(t('campaigns.importError', { defaultValue: 'Import failed' }));
    } finally {
      setLoading(false);
    }
  };

  const uniqueConflictContactIds = new Set(conflicts.map((c) => c.contact_id));
  const excludedCount = includeConflicts ? 0 : uniqueConflictContactIds.size;
  const finalCount = contactIds.length - excludedCount;

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => !loading && onClose()}
      title={t('campaigns.importParticipants', { defaultValue: 'Import participants' })}
      size="lg"
    >
      <div className="px-6 py-4 space-y-4">
        {/* Step 1: Source Selection */}
        {step === 'source' && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {t('campaigns.importSourceHint', { defaultValue: 'Choose where to import contacts from' })}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <button
                type="button"
                onClick={() => handleSourceSelected('crm')}
                className="p-5 rounded-xl border-2 border-border hover:border-primary hover:bg-primary/5 text-left transition-colors"
              >
                <Database className="w-7 h-7 text-primary mb-3" />
                <span className="font-medium text-foreground block">
                  {t('campaigns.importSourceCRM', { defaultValue: 'From CRM' })}
                </span>
                <span className="text-xs text-muted-foreground mt-1 block">
                  {t('campaigns.importSourceCRMHint', { defaultValue: 'Search and filter contacts' })}
                </span>
              </button>
              <button
                type="button"
                onClick={() => handleSourceSelected('csv')}
                className="p-5 rounded-xl border-2 border-border hover:border-primary hover:bg-primary/5 text-left transition-colors"
              >
                <FileUp className="w-7 h-7 text-primary mb-3" />
                <span className="font-medium text-foreground block">
                  {t('campaigns.importSourceCSV', { defaultValue: 'CSV / Usernames' })}
                </span>
                <span className="text-xs text-muted-foreground mt-1 block">
                  {t('campaigns.importSourceCSVHint', { defaultValue: 'Upload file or paste usernames' })}
                </span>
              </button>
              <button
                type="button"
                onClick={() => handleSourceSelected('group')}
                className="p-5 rounded-xl border-2 border-border hover:border-primary hover:bg-primary/5 text-left transition-colors"
              >
                <Users className="w-7 h-7 text-primary mb-3" />
                <span className="font-medium text-foreground block">
                  {t('campaigns.importSourceGroup', { defaultValue: 'Telegram group' })}
                </span>
                <span className="text-xs text-muted-foreground mt-1 block">
                  {t('campaigns.importSourceGroupHint', { defaultValue: 'Select from synced groups' })}
                </span>
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Contact Selection */}
        {step === 'select' && source === 'crm' && (
          <CRMPicker
            onSelect={handleContactsCollected}
            onBack={() => setStep('source')}
            loading={loading}
          />
        )}
        {step === 'select' && source === 'csv' && (
          <CSVImporter
            campaignId={campaignId}
            onSelect={handleContactsCollected}
            onBack={() => setStep('source')}
            loading={loading}
          />
        )}
        {step === 'select' && source === 'group' && (
          <GroupPicker
            onSelect={handleContactsCollected}
            onBack={() => setStep('source')}
            loading={loading}
          />
        )}

        {/* Step 3: Conflict Review */}
        {step === 'conflicts' && (
          <div className="space-y-4">
            <div className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3">
              <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
                  {t('campaigns.conflictsFound', { count: uniqueConflictContactIds.size, defaultValue: '{{count}} contacts already in other campaigns' })}
                </p>
                <p className="text-xs text-amber-700 dark:text-amber-300 mt-1">
                  {t('campaigns.conflictsDesc', { defaultValue: 'These contacts will be excluded by default. Check the box below to include them anyway.' })}
                </p>
              </div>
            </div>
            <div className="max-h-[200px] overflow-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-muted/80">
                  <tr>
                    <th className="text-left p-2 font-medium">{t('campaigns.contact', { defaultValue: 'Contact' })}</th>
                    <th className="text-left p-2 font-medium">{t('campaigns.campaignName', { defaultValue: 'Campaign' })}</th>
                    <th className="text-left p-2 font-medium">{t('campaigns.status', { defaultValue: 'Status' })}</th>
                    <th className="text-left p-2 font-medium">{t('campaigns.lastSent', { defaultValue: 'Last sent' })}</th>
                  </tr>
                </thead>
                <tbody>
                  {conflicts.slice(0, 50).map((c, i) => (
                    <tr key={`${c.contact_id}-${c.campaign_id}-${i}`} className="border-t border-border/50">
                      <td className="p-2 text-foreground text-xs">
                        {c.contact_username ? `@${c.contact_username.replace(/^@/, '')}` : (c.contact_name || c.contact_id.slice(0, 8))}
                      </td>
                      <td className="p-2 text-foreground">{c.campaign_name}</td>
                      <td className="p-2 text-muted-foreground">{c.participant_status}</td>
                      <td className="p-2 text-muted-foreground">{c.last_sent_at ? new Date(c.last_sent_at).toLocaleDateString() : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={includeConflicts}
                onChange={(e) => setIncludeConflicts(e.target.checked)}
                className="h-4 w-4 rounded border-border text-primary focus:ring-ring"
              />
              <span className="text-sm font-medium text-foreground">
                {t('campaigns.includeConflicts', { defaultValue: 'Include conflicting contacts anyway' })}
              </span>
            </label>
            <div className="flex justify-between items-center pt-2">
              <Button variant="outline" onClick={() => setStep('select')} disabled={loading}>
                {t('common.back', { defaultValue: 'Back' })}
              </Button>
              <Button onClick={() => setStep('confirm')} disabled={loading}>
                {t('common.continue', { defaultValue: 'Continue' })}
              </Button>
            </div>
          </div>
        )}

        {/* Step 4: Confirm */}
        {step === 'confirm' && (
          <div className="space-y-4">
            <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-2">
              <div className="flex items-center gap-2">
                <Check className="w-5 h-5 text-emerald-600" />
                <span className="text-sm font-medium text-foreground">
                  {t('campaigns.importSummary', {
                    total: finalCount,
                    excluded: excludedCount,
                    defaultValue: '{{total}} contacts will be added{{excluded, number}} excluded as conflicts)',
                  })}
                </span>
              </div>
              {excludedCount > 0 && (
                <p className="text-xs text-muted-foreground pl-7">
                  {t('campaigns.importExcludedNote', {
                    count: excludedCount,
                    defaultValue: '{{count}} conflicting contacts excluded',
                  })}
                </p>
              )}
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex justify-between items-center pt-2">
              <Button variant="outline" onClick={() => setStep(conflicts.length > 0 ? 'conflicts' : 'select')} disabled={loading}>
                {t('common.back', { defaultValue: 'Back' })}
              </Button>
              <Button onClick={handleConfirmImport} disabled={loading || finalCount === 0}>
                {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                {t('campaigns.importButton', { count: finalCount, defaultValue: 'Import {{count}} contacts' })}
              </Button>
            </div>
          </div>
        )}

        {error && step !== 'confirm' && <p className="text-sm text-destructive">{error}</p>}
      </div>
    </Modal>
  );
});

function CRMPicker({
  onSelect,
  onBack,
  loading: parentLoading,
}: {
  onSelect: (ids: string[]) => void;
  onBack: () => void;
  loading: boolean;
}) {
  const { t } = useTranslation();
  const [contacts, setContacts] = useState<ContactForPicker[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [keywords, setKeywords] = useState<string[]>([]);
  const [groups, setGroups] = useState<TelegramSourceGroup[]>([]);
  const [sourceKeyword, setSourceKeyword] = useState('');
  const [sourceGroup, setSourceGroup] = useState<TelegramSourceGroup | null>(null);

  useEffect(() => {
    fetchTelegramSourceKeywords().then(setKeywords).catch(() => setKeywords([]));
    fetchTelegramSourceGroups().then(setGroups).catch(() => setGroups([]));
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    fetchContactsForPicker({
      limit: 500,
      search: search.trim() || undefined,
      sourceKeyword: sourceKeyword || undefined,
      sourceTelegramChatId: sourceGroup?.telegramChatId,
      sourceBdAccountId: sourceGroup?.bdAccountId,
    })
      .then(setContacts)
      .catch(() => setContacts([]))
      .finally(() => setLoading(false));
  }, [search, sourceKeyword, sourceGroup]);

  useEffect(() => { load(); }, [load]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="space-y-3">
      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={t('campaigns.searchContacts')}
        className="w-full px-3 py-2 rounded-lg border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-hidden focus:ring-2 focus:ring-ring"
      />
      <div className="flex flex-wrap gap-2 items-center text-xs">
        {keywords.length > 0 && (
          <select
            value={sourceKeyword}
            onChange={(e) => setSourceKeyword(e.target.value)}
            className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
          >
            <option value="">{t('campaigns.filterByKeyword')}: —</option>
            {keywords.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        )}
        {groups.length > 0 && (
          <select
            value={sourceGroup ? `${sourceGroup.bdAccountId}:${sourceGroup.telegramChatId}` : ''}
            onChange={(e) => {
              const v = e.target.value;
              if (!v) setSourceGroup(null);
              else setSourceGroup(groups.find((g) => `${g.bdAccountId}:${g.telegramChatId}` === v) ?? null);
            }}
            className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm max-w-[200px]"
          >
            <option value="">{t('campaigns.filterByGroup')}: —</option>
            {groups.map((g) => (
              <option key={`${g.bdAccountId}:${g.telegramChatId}`} value={`${g.bdAccountId}:${g.telegramChatId}`}>
                {g.telegramChatTitle || g.telegramChatId}
              </option>
            ))}
          </select>
        )}
        <button type="button" onClick={() => setSelected(new Set(contacts.map((c) => c.id)))} className="text-primary hover:underline">
          {t('common.selectAll')}
        </button>
        <button type="button" onClick={() => setSelected(new Set())} className="text-muted-foreground hover:underline">
          {t('common.clear')}
        </button>
      </div>
      <div className="max-h-[280px] overflow-auto rounded-lg border border-border">
        {loading ? (
          <div className="p-8 text-center text-muted-foreground">{t('common.loading')}</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-muted/80 border-b border-border">
              <tr>
                <th className="w-10 p-2" />
                <th className="text-left p-2 font-medium">{t('common.name')}</th>
                <th className="text-left p-2 font-medium">Username</th>
                <th className="text-left p-2 font-medium">Email</th>
              </tr>
            </thead>
            <tbody>
              {contacts.map((c) => (
                <tr key={c.id} className="border-b border-border/50 hover:bg-muted/30">
                  <td className="p-2">
                    <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} className="rounded border-border" />
                  </td>
                  <td className="p-2 text-foreground">
                    {(c.display_name || [c.first_name, c.last_name].filter(Boolean).join(' ')).trim() || c.username || c.id.slice(0, 8)}
                  </td>
                  <td className="p-2 text-muted-foreground">{c.username ? `@${c.username.replace(/^@/, '')}` : '—'}</td>
                  <td className="p-2 text-muted-foreground truncate max-w-[140px]">{c.email ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="flex justify-between items-center pt-2">
        <Button variant="outline" onClick={onBack}>{t('common.back', { defaultValue: 'Back' })}</Button>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">{t('campaigns.contactsSelected', { count: selected.size })}</span>
          <Button onClick={() => onSelect(Array.from(selected))} disabled={selected.size === 0 || parentLoading}>
            {parentLoading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
            {t('common.continue', { defaultValue: 'Continue' })}
          </Button>
        </div>
      </div>
    </div>
  );
}

function CSVImporter({
  campaignId,
  onSelect,
  onBack,
  loading: parentLoading,
}: {
  campaignId: string;
  onSelect: (ids: string[]) => void;
  onBack: () => void;
  loading: boolean;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'file' | 'text'>('text');
  const [text, setText] = useState('');
  const [csvLoading, setCsvLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ created: number; matched: number } | null>(null);
  const csvRef = useRef<HTMLInputElement>(null);

  const handleUsernameSubmit = async () => {
    if (!text.trim()) return;
    setCsvLoading(true);
    setError(null);
    try {
      const data = await uploadAudienceFromUsernameList(campaignId, { text });
      setResult({ created: data.created, matched: data.matched });
      onSelect(data.contactIds);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setCsvLoading(false);
    }
  };

  const handleFileUpload = async (file: File) => {
    setCsvLoading(true);
    setError(null);
    try {
      const content = await file.text();
      if (!content.trim()) { setError(t('campaigns.uploadFileEmpty', { defaultValue: 'File is empty' })); setCsvLoading(false); return; }
      const data = await uploadAudienceFromCsv(campaignId, { content, hasHeader: true });
      setResult({ created: data.created, matched: data.matched });
      onSelect(data.contactIds);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setCsvLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setMode('text')}
          className={clsx('px-3 py-1.5 rounded-lg text-sm font-medium', mode === 'text' ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground')}
        >
          {t('campaigns.usernameListTitle', { defaultValue: 'Usernames' })}
        </button>
        <button
          type="button"
          onClick={() => setMode('file')}
          className={clsx('px-3 py-1.5 rounded-lg text-sm font-medium', mode === 'file' ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground')}
        >
          CSV
        </button>
      </div>
      {mode === 'text' ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">{t('campaigns.usernameListHint')}</p>
          <textarea
            className="w-full min-h-[140px] px-3 py-2 rounded-lg border border-border bg-background text-foreground text-sm font-mono"
            value={text}
            onChange={(e) => { setText(e.target.value); setError(null); }}
            placeholder="@username1&#10;@username2"
            disabled={csvLoading}
          />
          <Button onClick={handleUsernameSubmit} disabled={csvLoading || !text.trim() || parentLoading}>
            {csvLoading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
            {t('campaigns.usernameListSubmit', { defaultValue: 'Import' })}
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <input ref={csvRef} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFileUpload(file);
            e.target.value = '';
          }} />
          <Button variant="outline" onClick={() => csvRef.current?.click()} disabled={csvLoading || parentLoading}>
            <FileUp className="w-4 h-4 mr-2" />
            {csvLoading ? t('campaigns.uploading', { defaultValue: 'Uploading...' }) : t('campaigns.uploadCsv', { defaultValue: 'Upload CSV' })}
          </Button>
          <p className="text-xs text-muted-foreground">{t('campaigns.uploadCsvHint')}</p>
        </div>
      )}
      {result && <p className="text-sm text-foreground">{t('campaigns.uploadResult', { created: result.created, matched: result.matched, total: result.created + result.matched })}</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-start pt-2">
        <Button variant="outline" onClick={onBack}>{t('common.back', { defaultValue: 'Back' })}</Button>
      </div>
    </div>
  );
}

function GroupPicker({
  onSelect,
  onBack,
  loading: parentLoading,
}: {
  onSelect: (ids: string[]) => void;
  onBack: () => void;
  loading: boolean;
}) {
  const { t } = useTranslation();
  const [groups, setGroups] = useState<GroupSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchGroupSources().then(setGroups).catch(() => setGroups([])).finally(() => setLoading(false));
  }, []);

  const handleSelect = async (bdAccountId: string, telegramChatId: string) => {
    setLoading(true);
    setError(null);
    try {
      const { contactIds } = await fetchGroupSourceContacts({ bdAccountId, telegramChatId });
      onSelect(contactIds);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      {loading ? (
        <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
      ) : groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('campaigns.noGroupsSynced')}</p>
      ) : (
        <div className="max-h-[300px] overflow-auto rounded-lg border border-border">
          {groups.map((g) => (
            <button
              key={`${g.bd_account_id}-${g.telegram_chat_id}`}
              type="button"
              onClick={() => handleSelect(g.bd_account_id, g.telegram_chat_id)}
              disabled={loading || parentLoading}
              className="w-full p-3 border-b border-border last:border-0 text-left hover:bg-muted/30 transition-colors flex items-center gap-3"
            >
              <Users className="w-5 h-5 text-primary shrink-0" />
              <div className="min-w-0">
                <span className="font-medium text-foreground block truncate">{g.title || g.telegram_chat_id}</span>
                {g.account_name && <span className="text-xs text-muted-foreground">{g.account_name}</span>}
              </div>
            </button>
          ))}
        </div>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-start pt-2">
        <Button variant="outline" onClick={onBack}>{t('common.back', { defaultValue: 'Back' })}</Button>
      </div>
    </div>
  );
}
