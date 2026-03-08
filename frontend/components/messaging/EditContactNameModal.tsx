'use client';

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import Button from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';

export interface EditContactNameModalProps {
  open: boolean;
  onClose: () => void;
  value: string;
  onChange: (value: string) => void;
  onSave: () => void | Promise<void>;
  saving: boolean;
}

export function EditContactNameModal({
  open,
  onClose,
  value,
  onChange,
  onSave,
  saving,
}: EditContactNameModalProps) {
  const { t } = useTranslation();
  return (
    <Modal isOpen={open} onClose={onClose} title={t('messaging.contactName')} size="sm">
      <div className="px-6 py-4 space-y-4">
        <p className="text-sm text-muted-foreground">{t('messaging.contactNameHint')}</p>
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={t('messaging.enterName')}
        />
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {t('global.cancel', 'Отмена')}
          </Button>
          <Button onClick={onSave} disabled={saving}>
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : t('common.save')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
