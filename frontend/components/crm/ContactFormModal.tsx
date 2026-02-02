'use client';

import { useState, useEffect } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Select, SelectOption } from '@/components/ui/Select';
import Button from '@/components/ui/Button';
import { Contact, Company, createContact, updateContact, fetchCompanies } from '@/lib/api/crm';

interface ContactFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  edit?: Contact | null;
  preselectedCompanyId?: string | null;
}

export function ContactFormModal({ isOpen, onClose, onSuccess, edit, preselectedCompanyId }: ContactFormModalProps) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loadingCompanies, setLoadingCompanies] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const isEdit = Boolean(edit?.id);

  useEffect(() => {
    if (isOpen) {
      setLoadingCompanies(true);
      fetchCompanies({ limit: 500 })
        .then((r) => setCompanies(r.items))
        .finally(() => setLoadingCompanies(false));
    }
  }, [isOpen]);

  useEffect(() => {
    if (edit) {
      setFirstName(edit.first_name ?? '');
      setLastName(edit.last_name ?? '');
      setDisplayName(edit.display_name ?? '');
      setUsername(edit.username ?? '');
      setEmail(edit.email ?? '');
      setPhone(edit.phone ?? '');
      setCompanyId(edit.company_id ?? '');
    } else {
      setFirstName('');
      setLastName('');
      setDisplayName('');
      setUsername('');
      setEmail('');
      setPhone('');
      setCompanyId(preselectedCompanyId ?? '');
    }
    setError('');
  }, [edit, preselectedCompanyId, isOpen]);

  const companyOptions: SelectOption[] = [
    { value: '', label: 'Без компании' },
    ...companies.map((c) => ({ value: c.id, label: c.name })),
  ];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!firstName.trim() && !displayName.trim() && !edit?.telegram_id) {
      setError('Укажите имя, отображаемое имя или откройте контакт из Messaging (Telegram)');
      return;
    }
    setLoading(true);
    try {
      if (isEdit) {
        await updateContact(edit!.id, {
          firstName: firstName.trim() || undefined,
          lastName: lastName.trim() || undefined,
          displayName: displayName.trim() || undefined,
          username: username.trim() || undefined,
          email: email.trim() || undefined,
          phone: phone.trim() || undefined,
          companyId: companyId || undefined,
        });
      } else {
        await createContact({
          firstName: firstName.trim() || undefined,
          lastName: lastName.trim() || undefined,
          displayName: displayName.trim() || undefined,
          username: username.trim() || undefined,
          email: email.trim() || undefined,
          phone: phone.trim() || undefined,
          companyId: companyId || null,
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
    <Modal isOpen={isOpen} onClose={onClose} title={isEdit ? 'Редактировать контакт' : 'Новый контакт'} size="md">
      {error && (
        <div className="mb-4 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm">
          {error}
        </div>
      )}
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input
          label="Отображаемое имя"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="Как показывать в CRM и Messaging"
        />
        <Input
          label="Имя"
          value={firstName}
          onChange={(e) => setFirstName(e.target.value)}
          placeholder="Иван"
          autoFocus
        />
        <Input
          label="Фамилия"
          value={lastName}
          onChange={(e) => setLastName(e.target.value)}
          placeholder="Иванов"
        />
        <Input
          label="Username (Telegram)"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="username (без @)"
        />
        <Input
          label="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="ivan@example.com"
        />
        <Input
          label="Телефон"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="+7 999 123-45-67"
        />
        <Select
          label="Компания"
          options={companyOptions}
          value={companyId}
          onChange={(e) => setCompanyId(e.target.value)}
          disabled={loadingCompanies}
          placeholder="Выберите компанию"
        />
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
