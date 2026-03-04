'use client';

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Link from 'next/link';
import { User, MessageSquare, ExternalLink, Loader2 } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import { fetchLeadContextByLeadId, type LeadContextByLead } from '@/lib/api/messaging';
import { formatDealAmount } from '@/lib/format/currency';

function formatLeadPanelDate(iso: string): string {
  if (!iso || Number.isNaN(new Date(iso).getTime())) return '—';
  const d = new Date(iso);
  const day = d.getDate();
  const month = d.toLocaleString('en-GB', { month: 'short' });
  const year = d.getFullYear();
  return `${day} ${month} ${year}`;
}

interface LeadCardModalProps {
  leadId: string | null;
  open: boolean;
  onClose: () => void;
}

export function LeadCardModal({ leadId, open, onClose }: LeadCardModalProps) {
  const { t } = useTranslation();
  const [context, setContext] = useState<LeadContextByLead | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !leadId) {
      setContext(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    fetchLeadContextByLeadId(leadId)
      .then(setContext)
      .catch(() => setError(t('common.error', 'Ошибка загрузки')))
      .finally(() => setLoading(false));
  }, [open, leadId, t]);

  const chatHref =
    context?.bd_account_id && context?.channel_id
      ? `/dashboard/messaging?bdAccountId=${encodeURIComponent(context.bd_account_id)}&open=${encodeURIComponent(context.channel_id)}`
      : null;

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title={t('messaging.leadCardTitle', 'Карточка лида')}
      size="lg"
    >
      <div className="space-y-5">
        {loading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        )}
        {error && (
          <p className="text-sm text-destructive py-4">{error}</p>
        )}
        {!loading && !error && context && (
          <>
            <div className="flex flex-col items-center text-center pb-4 border-b border-border">
              <div className="p-3 rounded-xl bg-primary/10 text-primary">
                <User className="w-10 h-10" />
              </div>
              <h2 className="mt-3 font-heading text-xl font-semibold text-foreground truncate w-full px-2">
                {context.contact_name || '—'}
              </h2>
              <p className="text-sm text-muted-foreground mt-1">
                {context.company_name || (context.contact_username ? `@${String(context.contact_username).replace(/^@/, '')}` : null) || '—'}
              </p>
              <span className="inline-block mt-2 text-[10px] font-medium px-2 py-0.5 rounded-md bg-primary/15 text-primary">
                {t('pipeline.leadCard', 'Лид')}
              </span>
            </div>

            <div className="grid grid-cols-1 gap-4">
              <div>
                <label className="block text-sm font-medium text-foreground mb-1.5">{t('crm.pipelineStage', 'Воронка / Стадия')}</label>
                <p className="text-sm text-foreground">{context.pipeline.name} — {context.stage.name}</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-foreground mb-1.5">{t('crm.amount', 'Сумма')}</label>
                <p className="text-sm font-medium text-foreground">
                  {context.won_at && context.revenue_amount != null && context.revenue_amount > 0
                    ? formatDealAmount(context.revenue_amount, 'EUR')
                    : '—'}
                </p>
              </div>
              {(context.campaign != null || context.became_lead_at) && (
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1.5">{t('messaging.leadPanelCampaign', 'Кампания')}</label>
                  <p className="text-sm text-foreground">{context.campaign != null ? context.campaign.name : '—'}</p>
                  {context.became_lead_at && (
                    <p className="text-xs text-muted-foreground mt-0.5">{formatLeadPanelDate(context.became_lead_at)}</p>
                  )}
                </div>
              )}
            </div>

            {context.shared_chat_created_at && (context.shared_chat_invite_link?.trim() || context.shared_chat_channel_id != null) && (
              <a
                href={
                  context.shared_chat_invite_link?.trim() ||
                  (() => {
                    const raw = Number(context.shared_chat_channel_id);
                    const id = Number.isNaN(raw) ? String(context.shared_chat_channel_id).replace(/^-100/, '') : String(Math.abs(raw));
                    return `https://t.me/c/${id}`;
                  })()
                }
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 text-sm text-primary hover:underline"
              >
                <ExternalLink className="w-4 h-4" />
                {t('messaging.openInTelegram', 'Открыть в Telegram')}
              </a>
            )}

            {context.won_at && (
              <div className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
                ✓ {t('messaging.dealWon', 'Сделка закрыта')}
                {context.revenue_amount != null && context.revenue_amount > 0 && ` — ${formatDealAmount(context.revenue_amount, 'EUR')}`}
              </div>
            )}
            {context.lost_at && (
              <div className="text-sm text-muted-foreground">
                ✕ {t('messaging.dealLost', 'Сделка потеряна')}
                {context.loss_reason && <div className="mt-1 text-xs opacity-90">{context.loss_reason}</div>}
              </div>
            )}

            <div className="border-t border-border pt-4 space-y-2">
              <h4 className="text-sm font-medium text-foreground">{t('messaging.timelineTitle', 'История')}</h4>
              {context.timeline.length === 0 ? (
                <div className="text-xs text-muted-foreground">—</div>
              ) : (
                context.timeline.map((ev, i) => (
                  <div key={i} className="text-xs text-muted-foreground">
                    <span className="tabular-nums">{formatLeadPanelDate(ev.created_at)}</span>
                    {' — '}
                    {ev.type === 'lead_created' && t('messaging.timelineLeadCreated')}
                    {ev.type === 'stage_changed' && t('messaging.timelineStageChanged', { name: ev.stage_name ?? '' })}
                    {ev.type === 'deal_created' && t('messaging.timelineDealCreated')}
                  </div>
                ))
              )}
            </div>

            <div className="flex gap-3 pt-2 border-t border-border">
              {chatHref && (
                <Link href={chatHref} className="flex-1" onClick={onClose}>
                  <Button type="button" className="w-full gap-2">
                    <MessageSquare className="w-4 h-4" />
                    {t('pipeline.goToChat', 'Перейти в чат')}
                  </Button>
                </Link>
              )}
              <Button type="button" variant="outline" className={chatHref ? '' : 'flex-1'} onClick={onClose}>
                {t('pipeline.dealFormCancel', 'Закрыть')}
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
