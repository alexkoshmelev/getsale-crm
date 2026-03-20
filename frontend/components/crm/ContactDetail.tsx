'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  User, Mail, Phone, AtSign, Briefcase, Filter, Crown,
  FileText, ExternalLink, Users,
} from 'lucide-react';
import {
  fetchCompanies, updateContact,
  type Company, type Contact,
} from '@/lib/api/crm';
import { resolveContact } from '@/lib/api/messaging';
import { listBdAccounts } from '@/lib/api/bd-accounts';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select, type SelectOption } from '@/components/ui/Select';
import { LeadContextAvatar } from '@/components/messaging/LeadContextAvatar';
import { getContactDisplayName } from '@/app/dashboard/crm/hooks/useCrmData';

interface ContactDetailProps {
  contact: Contact & { companyName?: string | null };
  onEdit: () => void;
  onDelete: () => void;
  onAddToFunnel?: () => void;
  onContactUpdated?: (updated: Contact & { companyName?: string | null }) => void;
}

export function ContactDetail({
  contact,
  onEdit,
  onDelete,
  onAddToFunnel,
  onContactUpdated,
}: ContactDetailProps) {
  const { t } = useTranslation();
  const name = getContactDisplayName(contact, t);
  const initials = (() => {
    const parts = name.replace(/@/g, '').trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase().slice(0, 2);
    if (name.length >= 2) return name.slice(0, 2).toUpperCase();
    return name.slice(0, 1).toUpperCase() || '?';
  })();

  const [avatarResolution, setAvatarResolution] = useState<{ bd_account_id: string; channel_id: string } | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editDisplayName, setEditDisplayName] = useState('');
  const [editFirstName, setEditFirstName] = useState('');
  const [editLastName, setEditLastName] = useState('');
  const [editUsername, setEditUsername] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editCompanyId, setEditCompanyId] = useState('');
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loadingCompanies, setLoadingCompanies] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState('');

  useEffect(() => {
    if (!contact.telegram_id) {
      setAvatarResolution(null);
      return;
    }
    resolveContact(contact.id)
      .then((r) => setAvatarResolution(r))
      .catch((err: unknown) => {
        const status = (err as { response?: { status?: number } })?.response?.status;
        if (status === 404 && contact.telegram_id) {
          listBdAccounts()
            .then((list) => {
              const account = list.find((a) => a.is_active !== false) ?? list[0];
              if (account?.id)
                setAvatarResolution({ bd_account_id: account.id, channel_id: contact.telegram_id! });
              else
                setAvatarResolution(null);
            })
            .catch(() => setAvatarResolution(null));
        } else {
          setAvatarResolution(null);
        }
      });
  }, [contact.id, contact.telegram_id]);

  useEffect(() => {
    if (isEditing) {
      setEditDisplayName(contact.display_name ?? '');
      setEditFirstName(contact.first_name ?? '');
      setEditLastName(contact.last_name ?? '');
      setEditUsername(contact.username ?? '');
      setEditEmail(contact.email ?? '');
      setEditPhone(contact.phone ?? '');
      setEditCompanyId(contact.company_id ?? '');
      setEditError('');
      setLoadingCompanies(true);
      fetchCompanies({ limit: 500 })
        .then((r) => setCompanies(r.items))
        .finally(() => setLoadingCompanies(false));
    }
  }, [isEditing, contact.display_name, contact.first_name, contact.last_name, contact.username, contact.email, contact.phone, contact.company_id]);

  const companyOptions: SelectOption[] = [
    { value: '', label: t('crm.noCompany') },
    ...companies.map((c) => ({ value: c.id, label: c.name })),
  ];

  const handleSaveEdit = useCallback(async () => {
    setEditError('');
    setSaving(true);
    try {
      const updated = await updateContact(contact.id, {
        firstName: editFirstName.trim() || undefined,
        lastName: editLastName.trim() || undefined,
        displayName: editDisplayName.trim() || undefined,
        username: editUsername.trim() || undefined,
        email: editEmail.trim() || undefined,
        phone: editPhone.trim() || undefined,
        companyId: editCompanyId || undefined,
      });
      onContactUpdated?.(updated);
      setIsEditing(false);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? t('common.error');
      setEditError(msg);
    } finally {
      setSaving(false);
    }
  }, [contact.id, editDisplayName, editFirstName, editLastName, editUsername, editEmail, editPhone, editCompanyId, onContactUpdated, t]);

  const avatarBdAccountId = avatarResolution?.bd_account_id ?? null;
  const avatarChannelId = avatarResolution?.channel_id ?? contact.telegram_id ?? null;
  const showAvatar = !!(avatarBdAccountId && avatarChannelId);

  if (isEditing) {
    return (
      <div className="space-y-4">
        {editError && (
          <div className="p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm">
            {editError}
          </div>
        )}
        <Input label={t('crm.displayName')} value={editDisplayName} onChange={(e) => setEditDisplayName(e.target.value)} placeholder={t('crm.displayNamePlaceholder')} />
        <Input label={t('crm.firstName')} value={editFirstName} onChange={(e) => setEditFirstName(e.target.value)} placeholder="Иван" />
        <Input label={t('crm.lastName')} value={editLastName} onChange={(e) => setEditLastName(e.target.value)} placeholder="Иванов" />
        <Input label="Username (Telegram)" value={editUsername} onChange={(e) => setEditUsername(e.target.value)} placeholder="username (без @)" />
        <Input label={t('crm.email')} type="email" value={editEmail} onChange={(e) => setEditEmail(e.target.value)} placeholder="ivan@example.com" />
        <Input label={t('crm.phone')} value={editPhone} onChange={(e) => setEditPhone(e.target.value)} placeholder="+7 999 123-45-67" />
        <Select label={t('crm.company')} options={companyOptions} value={editCompanyId} onChange={(e) => setEditCompanyId(e.target.value)} disabled={loadingCompanies} placeholder={t('crm.selectCompany')} />
        <div className="flex gap-3 pt-2">
          <Button type="button" variant="outline" className="flex-1" onClick={() => setIsEditing(false)}>{t('common.cancel')}</Button>
          <Button type="button" className="flex-1" disabled={saving} onClick={handleSaveEdit}>{saving ? t('common.saving') : t('common.save')}</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row gap-6">
        <div className="shrink-0">
          {showAvatar ? (
            <LeadContextAvatar
              contactName={name}
              telegramId={avatarChannelId}
              bdAccountId={avatarBdAccountId}
              className="w-20 h-20"
            />
          ) : (
            <div className="w-20 h-20 rounded-full bg-primary/15 flex items-center justify-center text-primary font-semibold text-2xl">
              {initials}
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <h3 className="font-heading text-xl font-semibold text-foreground truncate">{name}</h3>
            {contact.premium === true && (
              <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400 text-sm" title="Telegram Premium">
                <Crown className="w-4 h-4" />
              </span>
            )}
          </div>
          {contact.companyName && (
            <p className="text-sm text-muted-foreground flex items-center gap-1 mt-1">
              <Briefcase className="w-4 h-4" />
              {contact.companyName}
            </p>
          )}
        </div>
      </div>

      <dl className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
        {(contact.first_name ?? '').trim() && (
          <div>
            <dt className="text-muted-foreground flex items-center gap-2"><User className="w-4 h-4" /> {t('crm.firstName')}</dt>
            <dd className="font-medium text-foreground mt-0.5">{contact.first_name!.trim()}</dd>
          </div>
        )}
        {(contact.last_name ?? '').trim() && (
          <div>
            <dt className="text-muted-foreground flex items-center gap-2"><User className="w-4 h-4" /> {t('crm.lastName')}</dt>
            <dd className="font-medium text-foreground mt-0.5">{contact.last_name!.trim()}</dd>
          </div>
        )}
        {contact.email && (
          <div>
            <dt className="text-muted-foreground flex items-center gap-2"><Mail className="w-4 h-4" /> {t('crm.email')}</dt>
            <dd className="font-medium text-foreground mt-0.5">
              <a href={`mailto:${contact.email}`} className="text-primary hover:underline">{contact.email}</a>
            </dd>
          </div>
        )}
        {contact.phone && (
          <div>
            <dt className="text-muted-foreground flex items-center gap-2"><Phone className="w-4 h-4" /> {t('crm.phone')}</dt>
            <dd className="font-medium text-foreground mt-0.5">
              <a href={`tel:${contact.phone}`} className="text-primary hover:underline">{contact.phone}</a>
            </dd>
          </div>
        )}
        {contact.telegram_id && (
          <div>
            <dt className="text-muted-foreground flex items-center gap-2"><User className="w-4 h-4" /> Telegram ID</dt>
            <dd className="font-medium text-foreground mt-0.5">{contact.telegram_id}</dd>
          </div>
        )}
        {contact.username && (
          <div>
            <dt className="text-muted-foreground flex items-center gap-2"><AtSign className="w-4 h-4" /> Username</dt>
            <dd className="font-medium text-foreground mt-0.5 flex items-center gap-2">
              <span>{contact.username.startsWith('@') ? contact.username : `@${contact.username}`}</span>
              <a
                href={`https://t.me/${contact.username.replace(/^@/, '')}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline inline-flex items-center gap-1"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                t.me
              </a>
            </dd>
          </div>
        )}
      </dl>

      {contact.bio?.trim() && (
        <div className="pt-4 border-t border-border">
          <dt className="text-muted-foreground flex items-center gap-2 mb-1">
            <FileText className="w-4 h-4" /> {t('crm.bio')}
          </dt>
          <dd className="text-foreground whitespace-pre-wrap">{contact.bio.trim()}</dd>
        </div>
      )}

      {contact.telegramGroups?.length ? (
        <div className="pt-4 border-t border-border">
          <h4 className="text-sm font-medium text-foreground flex items-center gap-2 mb-2">
            <Users className="w-4 h-4" /> {t('crm.telegramGroups')}
          </h4>
          <ul className="flex flex-wrap gap-1.5">
            {contact.telegramGroups.map((g) => (
              <li key={g.telegram_chat_id} className="px-2 py-1 rounded-md bg-muted/50 text-sm text-foreground">
                {g.telegram_chat_title || g.telegram_chat_id}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2 pt-4 border-t border-border">
        {onAddToFunnel && (
          <Button variant="outline" size="sm" onClick={onAddToFunnel} className="gap-1.5">
            <Filter className="w-4 h-4" />
            {t('pipeline.addToFunnel')}
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={() => setIsEditing(true)}>{t('crm.editAction')}</Button>
        <Button variant="danger" size="sm" onClick={onDelete}>{t('crm.deleteAction')}</Button>
      </div>
    </div>
  );
}
