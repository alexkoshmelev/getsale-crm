'use client';

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import { fetchPipelines, fetchContactPipelineIds, addLeadToPipeline, type Pipeline } from '@/lib/api/pipeline';

interface AddToFunnelModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
  contactId: string;
  contactName?: string;
}

export function AddToFunnelModal({
  isOpen,
  onClose,
  onSuccess,
  contactId,
  contactName,
}: AddToFunnelModalProps) {
  const { t } = useTranslation();
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [contactPipelineIds, setContactPipelineIds] = useState<string[]>([]);
  const [selectedPipelineId, setSelectedPipelineId] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen && contactId) {
      setError(null);
      setSelectedPipelineId('');
      setContactPipelineIds([]);
      setLoading(true);
      Promise.all([fetchPipelines(), fetchContactPipelineIds(contactId)])
        .then(([pls, ids]) => {
          setPipelines(pls);
          setContactPipelineIds(ids);
        })
        .catch(() => setPipelines([]))
        .finally(() => setLoading(false));
    }
  }, [isOpen, contactId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedPipelineId) {
      setError('Select a pipeline');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await addLeadToPipeline({ contactId, pipelineId: selectedPipelineId });
      onSuccess?.();
      onClose();
    } catch (err: any) {
      const msg = err?.response?.data?.error ?? err?.message ?? 'Failed to add to funnel';
      const code = err?.response?.data?.code;
      setError(code === 'ALREADY_IN_PIPELINE' ? t('pipeline.alreadyInFunnel') : msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t('pipeline.addToFunnel')}>
      <form onSubmit={handleSubmit} className="space-y-4">
        {contactName && (
          <p className="text-sm text-muted-foreground">
            {t('pipeline.leadContact')}: <span className="font-medium text-foreground">{contactName}</span>
          </p>
        )}
        {loading ? (
          <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
        ) : pipelines.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('pipeline.noPipelines')}</p>
        ) : (() => {
          const availablePipelines = pipelines.filter((p) => !contactPipelineIds.includes(p.id));
          return (
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">
              {t('pipeline.selectPipeline')}
            </label>
            {availablePipelines.length === 0 && pipelines.length > 0 && (
              <p className="text-sm text-muted-foreground mb-2">{t('pipeline.alreadyInAllFunnels')}</p>
            )}
            <select
              value={selectedPipelineId}
              onChange={(e) => setSelectedPipelineId(e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
              required
            >
              <option value="">—</option>
              {pipelines.map((p) => {
                const alreadyIn = contactPipelineIds.includes(p.id);
                return (
                  <option key={p.id} value={p.id} disabled={alreadyIn}>
                    {p.name}{alreadyIn ? ` (${t('pipeline.alreadyInFunnel')})` : ''}
                  </option>
                );
              })}
            </select>
          </div>
          );
        })()}
        {error && (
          <p className="text-sm text-destructive">{error}</p>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            disabled={
              loading ||
              pipelines.length === 0 ||
              submitting ||
              pipelines.every((p) => contactPipelineIds.includes(p.id))
            }
          >
            {submitting ? t('common.saving') : t('pipeline.addToFunnel')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
