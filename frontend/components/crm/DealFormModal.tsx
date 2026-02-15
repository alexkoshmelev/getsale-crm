'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { MessageSquare } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Select, SelectOption } from '@/components/ui/Select';
import Button from '@/components/ui/Button';
import { Deal, Company, Contact, createDeal, updateDeal, fetchCompanies, fetchContacts } from '@/lib/api/crm';
import { Pipeline, Stage, fetchPipelines, fetchStages } from '@/lib/api/pipeline';
import { DealChatAvatar } from '@/components/crm/DealChatAvatar';

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
  const [currency, setCurrency] = useState('RUB');
  const [probability, setProbability] = useState('');
  const [expectedCloseDate, setExpectedCloseDate] = useState('');
  const [comments, setComments] = useState('');

  const [companies, setCompanies] = useState<Company[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [stages, setStages] = useState<Stage[]>([]);

  const [loadingMeta, setLoadingMeta] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const isEdit = Boolean(edit?.id);

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
      setCurrency(edit.currency ?? 'RUB');
      setProbability(edit.probability != null ? String(edit.probability) : '');
      setExpectedCloseDate(edit.expected_close_date ?? '');
      setComments(edit.comments ?? '');
    } else {
      setCompanyId(preselectedCompanyId ?? '');
      setContactId(preselectedContactId ?? '');
      setPipelineId('');
      setStageId('');
      setTitle('');
      setValue('');
      setCurrency('RUB');
      setProbability('');
      setExpectedCloseDate('');
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
      setError('Укажите название сделки');
      return;
    }
    if (!isEdit && (!companyId || !pipelineId)) {
      setError('Выберите компанию и воронку');
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
          expectedCloseDate: expectedCloseDate.trim() || null,
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
          expectedCloseDate: expectedCloseDate.trim() || undefined,
          comments: comments.trim() || undefined,
        });
      }
      onSuccess();
      onClose();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Ошибка сохранения';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={isEdit ? 'Редактировать сделку' : 'Новая сделка'} size="lg">
      {error && (
        <div className="mb-4 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm">
          {error}
        </div>
      )}
      <form onSubmit={handleSubmit} className="space-y-4">
        {isEdit && edit?.bd_account_id && edit?.channel_id && (
          <div className="flex items-center gap-3 pb-2 border-b border-border">
            <DealChatAvatar
              bdAccountId={edit.bd_account_id}
              channelId={edit.channel_id}
              title={edit.title}
              className="w-12 h-12"
            />
            <div className="flex-1 min-w-0 flex items-center justify-between gap-2">
              <span className="font-medium text-foreground truncate">{edit.title}</span>
              <Link
                href={`/dashboard/messaging?bdAccountId=${encodeURIComponent(edit.bd_account_id)}&open=${encodeURIComponent(edit.channel_id)}`}
                className="shrink-0 inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
              >
                <MessageSquare className="w-4 h-4" />
                Открыть чат
              </Link>
            </div>
          </div>
        )}
        {!isEdit && (
          <>
            <Select
              label="Компания *"
              options={companyOptions}
              value={companyId}
              onChange={(e) => setCompanyId(e.target.value)}
              disabled={loadingMeta}
              placeholder="Выберите компанию"
              required
            />
            <Select
              label="Контакт"
              options={contactOptions}
              value={contactId}
              onChange={(e) => setContactId(e.target.value)}
              disabled={loadingMeta}
              placeholder="Выберите контакт"
            />
            <Select
              label="Воронка *"
              options={pipelineOptions}
              value={pipelineId}
              onChange={(e) => setPipelineId(e.target.value)}
              disabled={loadingMeta}
              placeholder="Выберите воронку"
              required
            />
            <Select
              label="Стадия"
              options={stageOptions}
              value={stageId}
              onChange={(e) => setStageId(e.target.value)}
              disabled={!pipelineId || loadingMeta}
              placeholder={pipelineId ? 'Первая стадия по умолчанию' : 'Сначала выберите воронку'}
            />
          </>
        )}
        <Input
          label="Название сделки *"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Продажа пакета услуг"
          required
          autoFocus={isEdit}
        />
        <div className="grid grid-cols-2 gap-4">
          <Input
            label="Сумма"
            type="number"
            min={0}
            step={0.01}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="0"
          />
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Валюта</label>
            <select
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              className="w-full px-4 py-2.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary outline-none"
            >
              <option value="RUB">RUB</option>
              <option value="USD">USD</option>
              <option value="EUR">EUR</option>
            </select>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Input
            label="Вероятность, %"
            type="number"
            min={0}
            max={100}
            value={probability}
            onChange={(e) => setProbability(e.target.value)}
            placeholder="0–100"
          />
          <Input
            label="Ожидаемая дата закрытия"
            type="date"
            value={expectedCloseDate}
            onChange={(e) => setExpectedCloseDate(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Комментарий</label>
          <textarea
            value={comments}
            onChange={(e) => setComments(e.target.value)}
            placeholder="Заметки по сделке"
            rows={3}
            className="w-full px-4 py-2.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary outline-none resize-y"
          />
        </div>
        <div className="flex gap-3 pt-2">
          <Button type="button" variant="outline" className="flex-1" onClick={onClose}>
            Отмена
          </Button>
          <Button type="submit" className="flex-1" disabled={loading}>
            {loading ? 'Сохранение...' : isEdit ? 'Сохранить' : 'Создать'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
