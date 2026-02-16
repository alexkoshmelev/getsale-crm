'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { useTranslation } from 'react-i18next';
import { MessageSquare, StickyNote, Bell } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Select, SelectOption } from '@/components/ui/Select';
import Button from '@/components/ui/Button';
import { Deal, Company, Contact, createDeal, updateDeal, fetchCompanies, fetchContacts } from '@/lib/api/crm';
import { Pipeline, Stage, fetchPipelines, fetchStages } from '@/lib/api/pipeline';
import { DealChatAvatar } from '@/components/crm/DealChatAvatar';
import { getCurrencySymbol } from '@/lib/format/currency';

interface DealFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  edit?: Deal | null;
  preselectedCompanyId?: string | null;
  preselectedContactId?: string | null;
}

export function DealFormModal({
  isOpen,
  onClose,
  onSuccess,
  edit,
  preselectedCompanyId,
  preselectedContactId,
}: DealFormModalProps) {
  const [companyId, setCompanyId] = useState('');
  const [contactId, setContactId] = useState('');
  const [pipelineId, setPipelineId] = useState('');
  const [stageId, setStageId] = useState('');
  const [title, setTitle] = useState('');
  const [value, setValue] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [probability, setProbability] = useState('');
  const [comments, setComments] = useState('');
  const descriptionRef = useRef<HTMLTextAreaElement>(null);

  const [companies, setCompanies] = useState<Company[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [stages, setStages] = useState<Stage[]>([]);

  const [loadingMeta, setLoadingMeta] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const isEdit = Boolean(edit?.id);
  const { t, i18n } = useTranslation();
  const locale = i18n.language?.startsWith('ru') ? 'ru-RU' : 'en-US';

  useEffect(() => {
    if (isOpen) {
      setLoadingMeta(true);
      Promise.all([
        fetchCompanies({ limit: 500 }),
        fetchContacts({ limit: 500 }),
        fetchPipelines(),
      ])
        .then(([companiesRes, contactsRes, pipelinesList]) => {
          setCompanies(companiesRes.items);
          setContacts(contactsRes.items);
          setPipelines(pipelinesList);
        })
        .finally(() => setLoadingMeta(false));
    }
  }, [isOpen]);

  useEffect(() => {
    if (pipelineId) {
      fetchStages(pipelineId).then((s) => {
        const sorted = s.sort((a, b) => a.order_index - b.order_index);
        setStages(sorted);
        if (!edit?.id && sorted.length > 0) {
          setStageId((prev) => (sorted.some((st) => st.id === prev) ? prev : sorted[0].id));
        }
      });
    } else {
      setStages([]);
      if (!edit?.id) setStageId('');
    }
  }, [pipelineId, edit?.id]);

  useEffect(() => {
    if (edit) {
      setCompanyId(edit.company_id);
      setContactId(edit.contact_id ?? '');
      setPipelineId(edit.pipeline_id);
      setStageId(edit.stage_id);
      setTitle(edit.title ?? '');
      setValue(edit.value != null ? String(edit.value) : '');
      setCurrency(edit.currency ?? 'USD');
      setProbability(edit.probability != null ? String(edit.probability) : '');
      setComments(edit.comments ?? '');
    } else {
      setCompanyId(preselectedCompanyId ?? '');
      setContactId(preselectedContactId ?? '');
      setPipelineId('');
      setStageId('');
      setTitle('');
      setValue('');
      setCurrency('USD');
      setProbability('');
      setComments('');
    }
    setError('');
  }, [edit, preselectedCompanyId, preselectedContactId, isOpen]);

  const companyOptions: SelectOption[] = companies.map((c) => ({ value: c.id, label: c.name }));
  const pipelineOptions: SelectOption[] = pipelines.map((p) => ({ value: p.id, label: p.name }));
  const stageOptions: SelectOption[] = stages.map((s) => ({ value: s.id, label: s.name }));
  const contactOptions: SelectOption[] = [
    { value: '', label: 'Не выбран' },
    ...contacts
      .filter((c) => !companyId || c.company_id === companyId)
      .map((c) => ({
        value: c.id,
        label: [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || c.id,
      })),
  ];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!title.trim()) {
      setError(t('pipeline.dealFormErrorTitleRequired'));
      return;
    }
    if (!isEdit && (!companyId || !pipelineId)) {
      setError(t('pipeline.dealFormErrorCompanyPipeline'));
      return;
    }
    const probNum = probability.trim() === '' ? null : parseInt(probability, 10);
    const probValue = probNum !== null && !Number.isNaN(probNum) ? probNum : null;
    setLoading(true);
    try {
      if (isEdit) {
        await updateDeal(edit!.id, {
          title: title.trim(),
          value: value ? parseFloat(value) : null,
          currency: currency || null,
          contactId: contactId || null,
          probability: probValue,
          comments: comments.trim() || null,
        });
      } else {
        await createDeal({
          companyId,
          contactId: contactId || null,
          pipelineId,
          stageId: stageId || undefined,
          title: title.trim(),
          value: value ? parseFloat(value) : undefined,
          currency: currency || undefined,
          probability: probValue ?? undefined,
          comments: comments.trim() || undefined,
        });
      }
      onSuccess();
      onClose();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? t('pipeline.dealFormErrorSave');
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const chatHref =
    isEdit && edit?.bd_account_id && edit?.channel_id
      ? `/dashboard/messaging?bdAccountId=${encodeURIComponent(edit.bd_account_id)}&open=${encodeURIComponent(edit.channel_id)}`
      : null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={isEdit ? t('pipeline.dealFormTitle') : t('pipeline.dealFormNew')} size="lg">
      {error && (
        <div className="mb-4 p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm">
          {error}
        </div>
      )}
      <form onSubmit={handleSubmit} className="space-y-5">
        {/* Шапка: аватар + название (при редактировании с чатом) */}
        {isEdit && (edit?.bd_account_id && edit?.channel_id || edit?.creatorEmail) && (
          <div className="flex flex-col items-center text-center pb-4 border-b border-border">
            {edit?.bd_account_id && edit?.channel_id && (
              <DealChatAvatar
                bdAccountId={edit.bd_account_id}
                channelId={edit.channel_id}
                title={edit.title}
                className="w-16 h-16"
              />
            )}
            <h2 className="mt-3 font-heading text-xl font-semibold text-foreground truncate w-full px-2">
              {edit.title}
            </h2>
            {edit.creatorEmail && (
              <p className="text-xs text-muted-foreground mt-1">{t('pipeline.dealFormCreatedBy')}: {edit.creatorEmail}</p>
            )}
          </div>
        )}

        {!isEdit && (
          <>
            <Select
              label={t('pipeline.dealFormCompany')}
              options={companyOptions}
              value={companyId}
              onChange={(e) => setCompanyId(e.target.value)}
              disabled={loadingMeta}
              placeholder={t('pipeline.dealFormSelectCompany')}
              required
            />
            <Select
              label={t('pipeline.dealFormContact')}
              options={contactOptions}
              value={contactId}
              onChange={(e) => setContactId(e.target.value)}
              disabled={loadingMeta}
              placeholder={t('pipeline.dealFormSelectContact')}
            />
            <Select
              label={t('pipeline.dealFormPipeline')}
              options={pipelineOptions}
              value={pipelineId}
              onChange={(e) => setPipelineId(e.target.value)}
              disabled={loadingMeta}
              placeholder={t('pipeline.dealFormSelectPipeline')}
              required
            />
            <Select
              label={t('pipeline.dealFormStage')}
              options={stageOptions}
              value={stageId}
              onChange={(e) => setStageId(e.target.value)}
              disabled={!pipelineId || loadingMeta}
              placeholder={pipelineId ? t('pipeline.dealFormStageDefault') : t('pipeline.dealFormSelectStageFirst')}
            />
          </>
        )}

        <Input
          label={t('pipeline.dealFormTitleLabel')}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t('pipeline.dealFormTitlePlaceholder')}
          required
          autoFocus={isEdit && !edit?.bd_account_id}
        />

        <div>
          <label className="block text-sm font-medium text-foreground mb-1.5">{t('pipeline.dealFormDescription')}</label>
          <textarea
            ref={descriptionRef}
            value={comments}
            onChange={(e) => setComments(e.target.value)}
            placeholder={t('pipeline.dealFormDescriptionPlaceholder')}
            rows={2}
            className="w-full px-4 py-2.5 rounded-xl border border-border bg-background text-foreground placeholder:text-muted-foreground focus:ring-2 focus:ring-ring focus:border-primary outline-none resize-y text-sm"
          />
        </div>

        {/* Сумма и стадия в одну линию */}
        <div className="grid grid-cols-2 gap-6">
          <div className="min-w-0">
            <label className="block text-sm font-medium text-foreground mb-1.5">{t('pipeline.dealFormAmount')}</label>
            <div className="flex gap-2 min-w-0">
              <input
                type="number"
                min={0}
                step={0.01}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="0"
                className="min-w-0 flex-1 px-4 py-2.5 rounded-xl border border-border bg-background text-foreground placeholder:text-muted-foreground focus:ring-2 focus:ring-ring outline-none text-sm w-0"
              />
              <select
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                className="shrink-0 w-[5.5rem] px-2 py-2.5 rounded-xl border border-border bg-background text-foreground focus:ring-2 focus:ring-ring outline-none text-sm"
              >
                <option value="USD">USD ({getCurrencySymbol('USD')})</option>
                <option value="RUB">RUB ({getCurrencySymbol('RUB')})</option>
                <option value="EUR">EUR ({getCurrencySymbol('EUR')})</option>
              </select>
            </div>
          </div>
          {isEdit && stages.length > 0 && (
            <div className="min-w-0">
              <label className="block text-sm font-medium text-foreground mb-1.5">{t('pipeline.dealFormStage')}</label>
              <Select
                options={stageOptions}
                value={stageId}
                onChange={(e) => setStageId(e.target.value)}
                placeholder={t('pipeline.dealFormStagePlaceholder')}
                className="[&_select]:rounded-xl [&_select]:py-2.5 [&_select]:min-w-0"
              />
            </div>
          )}
        </div>

        {!isEdit && (
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">{t('pipeline.dealFormStage')}</label>
            <Select
              options={stageOptions}
              value={stageId}
              onChange={(e) => setStageId(e.target.value)}
              disabled={!pipelineId || loadingMeta}
              placeholder={pipelineId ? t('pipeline.dealFormStageDefault') : t('pipeline.dealFormSelectStageFirst')}
              className="[&_select]:rounded-xl [&_select]:py-2.5"
            />
          </div>
        )}

        {isEdit && (
          <>
            <Input
              label={t('pipeline.dealFormProbability')}
              type="number"
              min={0}
              max={100}
              value={probability}
              onChange={(e) => setProbability(e.target.value)}
              placeholder={t('pipeline.dealFormProbabilityPlaceholder')}
              className="[&_input]:rounded-xl"
            />
          </>
        )}

        {/* Три кнопки как на скрине: заметка, напоминание, открыть чат */}
        <div className="grid grid-cols-3 gap-3">
          <button
            type="button"
            onClick={() => descriptionRef.current?.focus()}
            className="flex flex-col items-center justify-center gap-2 py-4 px-3 rounded-xl border border-border bg-muted/30 hover:bg-muted/50 text-foreground transition-colors"
          >
            <StickyNote className="w-5 h-5 text-primary" />
            <span className="text-xs font-medium">{t('pipeline.dealFormAddNote')}</span>
          </button>
          <button
            type="button"
            onClick={() => window.alert(t('pipeline.dealFormReminderComing'))}
            className="flex flex-col items-center justify-center gap-2 py-4 px-3 rounded-xl border border-border bg-muted/30 hover:bg-muted/50 text-foreground transition-colors"
          >
            <Bell className="w-5 h-5 text-primary" />
            <span className="text-xs font-medium">{t('pipeline.dealFormAddReminder')}</span>
          </button>
          {chatHref ? (
            <Link
              href={chatHref}
              className="flex flex-col items-center justify-center gap-2 py-4 px-3 rounded-xl border border-border bg-muted/30 hover:bg-muted/50 text-foreground transition-colors no-underline"
            >
              <MessageSquare className="w-5 h-5 text-primary" />
              <span className="text-xs font-medium">{t('pipeline.dealFormOpenChat')}</span>
            </Link>
          ) : (
            <div className="flex flex-col items-center justify-center gap-2 py-4 px-3 rounded-xl border border-dashed border-border bg-muted/10 text-muted-foreground">
              <MessageSquare className="w-5 h-5 opacity-50" />
              <span className="text-xs">{t('pipeline.dealFormNoChat')}</span>
            </div>
          )}
        </div>

        {/* Блок описания внизу с датой (если есть текст) — как на скрине */}
        {isEdit && edit && comments.trim() && (
          <div className="pt-3 border-t border-border">
            <p className="text-sm text-foreground whitespace-pre-wrap">{comments.trim()}</p>
            <p className="text-xs text-muted-foreground mt-1.5">
              {edit.updated_at
                ? new Date(edit.updated_at).toLocaleString(locale, {
                    day: 'numeric',
                    month: 'long',
                    year: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })
                : ''}
            </p>
          </div>
        )}

        <div className="flex gap-3 pt-2">
          <Button type="button" variant="outline" className="flex-1" onClick={onClose}>
            {t('pipeline.dealFormCancel')}
          </Button>
          <Button type="submit" className="flex-1" disabled={loading}>
            {loading ? t('pipeline.dealFormSaving') : isEdit ? t('pipeline.dealFormSave') : t('pipeline.dealFormCreate')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
