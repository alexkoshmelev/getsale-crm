'use client';

import { useEffect, useState } from 'react';
import axios from 'axios';
import { Building2, Users, MessageSquare, TrendingUp } from 'lucide-react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

export default function DashboardPage() {
  const [stats, setStats] = useState({
    companies: 0,
    contacts: 0,
    messages: 0,
    deals: 0,
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const [companiesRes, contactsRes, messagesRes, dealsRes] = await Promise.all([
          axios.get(`${API_URL}/api/crm/companies`).catch(() => ({ data: [] })),
          axios.get(`${API_URL}/api/crm/contacts`).catch(() => ({ data: [] })),
          axios.get(`${API_URL}/api/messaging/inbox`).catch(() => ({ data: [] })),
          axios.get(`${API_URL}/api/crm/deals`).catch(() => ({ data: [] })),
        ]);

        setStats({
          companies: companiesRes.data.length || 0,
          contacts: contactsRes.data.length || 0,
          messages: messagesRes.data.length || 0,
          deals: dealsRes.data.length || 0,
        });
      } catch (error) {
        console.error('Error fetching stats:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchStats();
  }, []);

  const statCards = [
    {
      title: 'Компании',
      value: stats.companies,
      icon: Building2,
      color: 'bg-blue-500',
    },
    {
      title: 'Контакты',
      value: stats.contacts,
      icon: Users,
      color: 'bg-green-500',
    },
    {
      title: 'Сообщения',
      value: stats.messages,
      icon: MessageSquare,
      color: 'bg-purple-500',
    },
    {
      title: 'Сделки',
      value: stats.deals,
      icon: TrendingUp,
      color: 'bg-orange-500',
    },
  ];

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">
          Dashboard
        </h1>
        <p className="text-gray-600 dark:text-gray-400">
          Обзор вашей CRM системы
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {statCards.map((stat) => {
          const Icon = stat.icon;
          return (
            <div
              key={stat.title}
              className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 border border-gray-200 dark:border-gray-700"
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600 dark:text-gray-400">
                    {stat.title}
                  </p>
                  <p className="text-3xl font-bold text-gray-900 dark:text-white mt-2">
                    {stat.value}
                  </p>
                </div>
                <div className={`${stat.color} p-3 rounded-lg`}>
                  <Icon className="w-6 h-6 text-white" />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 border border-gray-200 dark:border-gray-700">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-4">
            Последние активности
          </h2>
          <p className="text-gray-500 dark:text-gray-400">
            Активности появятся здесь
          </p>
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 border border-gray-200 dark:border-gray-700">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-4">
            Быстрые действия
          </h2>
          <div className="space-y-2">
            <button className="w-full text-left px-4 py-2 bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 rounded-lg hover:bg-blue-100 dark:hover:bg-blue-900/30 transition-colors">
              Создать компанию
            </button>
            <button className="w-full text-left px-4 py-2 bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400 rounded-lg hover:bg-green-100 dark:hover:bg-green-900/30 transition-colors">
              Добавить контакт
            </button>
            <button className="w-full text-left px-4 py-2 bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400 rounded-lg hover:bg-purple-100 dark:hover:bg-purple-900/30 transition-colors">
              Новая сделка
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

