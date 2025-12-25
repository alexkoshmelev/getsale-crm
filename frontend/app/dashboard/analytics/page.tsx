'use client';

import { useEffect, useState } from 'react';
import axios from 'axios';
import { BarChart3, TrendingUp, Users, DollarSign } from 'lucide-react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

export default function AnalyticsPage() {
  const [conversionRates, setConversionRates] = useState<any[]>([]);
  const [pipelineValue, setPipelineValue] = useState<any[]>([]);
  const [teamPerformance, setTeamPerformance] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchAnalytics();
  }, []);

  const fetchAnalytics = async () => {
    try {
      const [conversionRes, pipelineRes, teamRes] = await Promise.all([
        axios.get(`${API_URL}/api/analytics/conversion-rates`).catch(() => ({ data: [] })),
        axios.get(`${API_URL}/api/analytics/pipeline-value`).catch(() => ({ data: [] })),
        axios.get(`${API_URL}/api/analytics/team-performance`).catch(() => ({ data: [] })),
      ]);

      setConversionRates(conversionRes.data);
      setPipelineValue(pipelineRes.data);
      setTeamPerformance(teamRes.data);
    } catch (error) {
      console.error('Error fetching analytics:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  const totalValue = pipelineValue.reduce((sum, stage) => sum + (parseFloat(stage.total_value) || 0), 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">
          Аналитика
        </h1>
        <p className="text-gray-600 dark:text-gray-400">
          Метрики и отчеты по продажам
        </p>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 border border-gray-200 dark:border-gray-700">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-600 dark:text-gray-400">Общая стоимость</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-white mt-2">
                ${totalValue.toLocaleString()}
              </p>
            </div>
            <DollarSign className="w-8 h-8 text-green-500" />
          </div>
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 border border-gray-200 dark:border-gray-700">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-600 dark:text-gray-400">Конверсии</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-white mt-2">
                {conversionRates.length}
              </p>
            </div>
            <TrendingUp className="w-8 h-8 text-blue-500" />
          </div>
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 border border-gray-200 dark:border-gray-700">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-600 dark:text-gray-400">Стадий</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-white mt-2">
                {pipelineValue.length}
              </p>
            </div>
            <BarChart3 className="w-8 h-8 text-purple-500" />
          </div>
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 border border-gray-200 dark:border-gray-700">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-600 dark:text-gray-400">Участников</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-white mt-2">
                {teamPerformance.length}
              </p>
            </div>
            <Users className="w-8 h-8 text-orange-500" />
          </div>
        </div>
      </div>

      {/* Pipeline Value */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 border border-gray-200 dark:border-gray-700">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-4">
          Стоимость по стадиям
        </h2>
        <div className="space-y-4">
          {pipelineValue.map((stage) => (
            <div key={stage.stage_name}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  {stage.stage_name}
                </span>
                <span className="text-sm font-bold text-gray-900 dark:text-white">
                  ${(parseFloat(stage.total_value) || 0).toLocaleString()}
                </span>
              </div>
              <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                <div
                  className="bg-blue-600 h-2 rounded-full"
                  style={{
                    width: `${((parseFloat(stage.total_value) || 0) / totalValue) * 100}%`,
                  }}
                ></div>
              </div>
              <div className="flex items-center justify-between mt-1 text-xs text-gray-500 dark:text-gray-400">
                <span>{stage.deal_count} сделок</span>
                <span>Средняя: ${(parseFloat(stage.avg_value) || 0).toLocaleString()}</span>
              </div>
            </div>
          ))}
          {pipelineValue.length === 0 && (
            <p className="text-gray-500 dark:text-gray-400 text-center py-8">
              Нет данных для отображения
            </p>
          )}
        </div>
      </div>

      {/* Team Performance */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 border border-gray-200 dark:border-gray-700">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-4">
          Производительность команды
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 dark:bg-gray-700">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">
                  Участник
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">
                  Сделок закрыто
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">
                  Выручка
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">
                  Среднее время
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {teamPerformance.map((member) => (
                <tr key={member.user_id}>
                  <td className="px-4 py-3 text-sm text-gray-900 dark:text-white">
                    User {member.user_id.slice(0, 8)}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-300">
                    {member.deals_closed}
                  </td>
                  <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-white">
                    ${(parseFloat(member.revenue) || 0).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-300">
                    {member.avg_days_to_close
                      ? `${Math.round(parseFloat(member.avg_days_to_close))} дней`
                      : '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {teamPerformance.length === 0 && (
            <p className="text-gray-500 dark:text-gray-400 text-center py-8">
              Нет данных о производительности
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

