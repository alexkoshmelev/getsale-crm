'use client';

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import axios from 'axios';
import Link from 'next/link';
import { Plus, Circle } from 'lucide-react';
import Button from '@/components/ui/Button';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

interface Stage {
  id: string;
  name: string;
  order_index: number;
  color?: string;
}

interface Deal {
  id: string;
  title: string;
  value?: number;
  stage_id: string;
}

export default function PipelinePage() {
  const { t } = useTranslation();
  const [stages, setStages] = useState<Stage[]>([]);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      const [stagesRes, dealsRes] = await Promise.all([
        axios.get(`${API_URL}/api/pipeline/stages`),
        axios.get(`${API_URL}/api/crm/deals`),
      ]);

      setStages(stagesRes.data.sort((a: Stage, b: Stage) => a.order_index - b.order_index));
      setDeals(Array.isArray(dealsRes.data) ? dealsRes.data : dealsRes.data?.items ?? []);
    } catch (error) {
      console.error('Error fetching data:', error);
    } finally {
      setLoading(false);
    }
  };

  const getDealsForStage = (stageId: string) => {
    return deals.filter((deal) => deal.stage_id === stageId);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[320px]">
        <div className="animate-spin rounded-full h-10 w-10 border-2 border-primary border-t-transparent" aria-hidden />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-bold text-foreground tracking-tight mb-1">
            {t('pipeline.title')}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t('pipeline.subtitle')}
          </p>
        </div>
        <Link href="/dashboard/crm">
          <Button className="gap-2">
            <Plus className="w-4 h-4" />
            {t('pipeline.newDeal')}
          </Button>
        </Link>
      </div>

      {/* Kanban Board */}
      <div className="flex gap-4 overflow-x-auto pb-4 -mx-1">
        {stages.map((stage) => {
          const stageDeals = getDealsForStage(stage.id);
          const stageColor = stage.color || undefined;
          return (
            <div
              key={stage.id}
              className="flex-shrink-0 w-80 rounded-xl border border-border bg-muted/30 p-4 shadow-soft"
            >
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Circle
                    className="w-3 h-3 shrink-0 text-muted-foreground"
                    style={stageColor ? { color: stageColor, fill: stageColor } : undefined}
                    fill={stageColor ?? 'currentColor'}
                  />
                  <h3 className="font-heading font-semibold text-foreground tracking-tight">
                    {stage.name}
                  </h3>
                </div>
                <span className="text-xs font-medium text-muted-foreground bg-card border border-border px-2 py-1 rounded-lg">
                  {stageDeals.length}
                </span>
              </div>

              <div className="space-y-2">
                {stageDeals.map((deal) => (
                  <div
                    key={deal.id}
                    className="bg-card rounded-lg p-3 border border-border shadow-soft hover:shadow-soft-md hover:border-primary/30 transition-all duration-200 cursor-pointer"
                  >
                    <h4 className="font-medium text-foreground mb-1">
                      {deal.title}
                    </h4>
                    {deal.value != null && (
                      <p className="text-sm text-muted-foreground">
                        ${Number(deal.value).toLocaleString()}
                      </p>
                    )}
                  </div>
                ))}
                {stageDeals.length === 0 && (
                  <div className="text-center py-8 text-muted-foreground text-sm rounded-lg border border-dashed border-border">
                    Нет сделок
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {stages.length === 0 && (
          <div className="w-full flex items-center justify-center py-16 rounded-xl border border-dashed border-border bg-muted/20">
            <p className="text-muted-foreground text-sm">
              {t('pipeline.noStages')}. {t('pipeline.noStagesDesc')}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

