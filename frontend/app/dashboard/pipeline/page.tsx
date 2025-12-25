'use client';

import { useEffect, useState } from 'react';
import axios from 'axios';
import { Plus, Circle } from 'lucide-react';

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
      setDeals(dealsRes.data);
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
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">
            Воронка продаж
          </h1>
          <p className="text-gray-600 dark:text-gray-400">
            Управление сделками и стадиями
          </p>
        </div>
        <button className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors">
          <Plus className="w-5 h-5" />
          <span>Новая сделка</span>
        </button>
      </div>

      {/* Kanban Board */}
      <div className="flex gap-4 overflow-x-auto pb-4">
        {stages.map((stage) => {
          const stageDeals = getDealsForStage(stage.id);
          return (
            <div
              key={stage.id}
              className="flex-shrink-0 w-80 bg-gray-50 dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700"
            >
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Circle
                    className="w-3 h-3"
                    style={{ color: stage.color || '#6B7280' }}
                    fill={stage.color || '#6B7280'}
                  />
                  <h3 className="font-semibold text-gray-900 dark:text-white">
                    {stage.name}
                  </h3>
                </div>
                <span className="text-sm text-gray-500 dark:text-gray-400 bg-white dark:bg-gray-700 px-2 py-1 rounded">
                  {stageDeals.length}
                </span>
              </div>

              <div className="space-y-2">
                {stageDeals.map((deal) => (
                  <div
                    key={deal.id}
                    className="bg-white dark:bg-gray-700 rounded-lg p-3 shadow-sm border border-gray-200 dark:border-gray-600 hover:shadow-md transition-shadow cursor-pointer"
                  >
                    <h4 className="font-medium text-gray-900 dark:text-white mb-1">
                      {deal.title}
                    </h4>
                    {deal.value && (
                      <p className="text-sm text-gray-600 dark:text-gray-300">
                        ${deal.value.toLocaleString()}
                      </p>
                    )}
                  </div>
                ))}
                {stageDeals.length === 0 && (
                  <div className="text-center py-8 text-gray-400 dark:text-gray-500 text-sm">
                    Нет сделок
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {stages.length === 0 && (
          <div className="w-full text-center py-12">
            <p className="text-gray-500 dark:text-gray-400">
              Нет стадий. Создайте первую воронку.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

