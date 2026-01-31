'use client';

import { useState, useEffect } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import Button from '@/components/ui/Button';
import { Company, createCompany, updateCompany } from '@/lib/api/crm';

const SIZE_OPTIONS = [
  { value: '', label: 'Не указан' },
  { value: '1-10', label: '1–10' },
  { value: '11-50', label: '11–50' },
  { value: '51-100', label: '51–100' },
  { value: '101-500', label: '101–500' },
  { value: '500+', label: '500+' },
];

interface CompanyFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  edit?: Company | null;
}

export function CompanyFormModal({ isOpen, onClose, onSuccess, edit }: CompanyFormModalProps) {
  const [name, setName] = useState('');
  const [industry, setIndustry] = useState('');
  const [size, setSize] = useState('');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const isEdit = Boolean(edit?.id);

  useEffect(() => {
    if (edit) {
      setName(edit.name ?? '');
      setIndustry(edit.industry ?? '');
      setSize(edit.size ?? '');
      setDescription(edit.description ?? '');
    } else {
      setName('');
      setIndustry('');
      setSize('');
      setDescription('');
    }
    setError('');
  }, [edit, isOpen]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!name.trim()) {
      setError('Укажите название компании');
      return;
    }
    setLoading(true);
    try {
      if (isEdit) {
        await updateCompany(edit!.id, { name: name.trim(), industry: industry || undefined, size: size || undefined, description: description || undefined });
      } else {
        await createCompany({
          name: name.trim(),
          industry: industry || undefined,
          size: size || undefined,
          description: description || undefined,
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
    <Modal isOpen={isOpen} onClose={onClose} title={isEdit ? 'Редактировать компанию' : 'Новая компания'} size="md">
      {error && (
        <div className="mb-4 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm">
          {error}
        </div>
      )}
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input
          label="Название *"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="ООО Компания"
          required
          autoFocus
        />
        <Input
          label="Отрасль"
          value={industry}
          onChange={(e) => setIndustry(e.target.value)}
          placeholder="IT, ритейл..."
        />
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Размер</label>
          <select
            value={size}
            onChange={(e) => setSize(e.target.value)}
            className="w-full px-4 py-2.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary outline-none"
          >
            {SIZE_OPTIONS.map((o) => (
              <option key={o.value || 'empty'} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Описание</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="w-full px-4 py-2.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary outline-none resize-none"
            placeholder="Краткое описание компании"
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
