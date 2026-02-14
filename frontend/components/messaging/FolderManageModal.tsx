'use client';

import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { GripVertical, Plus, X, Trash2 } from 'lucide-react';
import Button from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';

const FOLDER_ICON_OPTIONS = ['📁', '📂', '💬', '⭐', '🔴', '📥', '📤', '✏️', '❤️', '🔥', '👍', '📌'];

export interface SyncFolderItem {
  id: string;
  folder_id: number;
  folder_title: string;
  order_index: number;
  is_user_created?: boolean;
  icon?: string | null;
}

interface FolderManageModalProps {
  open: boolean;
  onClose: () => void;
  folders: SyncFolderItem[];
  onFoldersChange: (newFolders: SyncFolderItem[]) => void;
  selectedAccountId: string | null;
  isAccountOwner: boolean;
  hideEmptyFolders: boolean;
  onHideEmptyFoldersChange: (value: boolean) => void;
  onCreateFolder: (folder_title: string, icon: string | null) => Promise<SyncFolderItem | null>;
  onReorder: (order: string[]) => Promise<SyncFolderItem[] | null>;
  onUpdateFolder: (folderRowId: string, data: { folder_title?: string; icon?: string | null }) => Promise<SyncFolderItem | null>;
  onDeleteFolder?: (folderRowId: string) => Promise<void>;
  onFolderDeleted?: (folderId: number) => void;
}

export function FolderManageModal({
  open,
  onClose,
  folders,
  onFoldersChange,
  selectedAccountId,
  isAccountOwner,
  hideEmptyFolders,
  onHideEmptyFoldersChange,
  onCreateFolder,
  onReorder,
  onUpdateFolder,
  onDeleteFolder,
  onFolderDeleted,
}: FolderManageModalProps) {
  const { t } = useTranslation();
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [addMode, setAddMode] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newIcon, setNewIcon] = useState<string | null>('📁');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleDragStart = useCallback((e: React.DragEvent, id: string) => {
    setDraggedId(id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent, targetId: string) => {
      e.preventDefault();
      setDraggedId(null);
      const sourceId = e.dataTransfer.getData('text/plain');
      if (!sourceId || sourceId === targetId) return;
      const idx = folders.findIndex((f) => f.id === sourceId);
      const targetIdx = folders.findIndex((f) => f.id === targetId);
      if (idx === -1 || targetIdx === -1) return;
      const reordered = [...folders];
      const [removed] = reordered.splice(idx, 1);
      reordered.splice(targetIdx, 0, removed);
      const newOrder = reordered.map((f) => f.id);
      setSaving(true);
      setError('');
      try {
        const updated = await onReorder(newOrder);
        if (updated) onFoldersChange(updated);
      } catch (err: any) {
        setError(err?.response?.data?.error || t('common.error'));
      } finally {
        setSaving(false);
      }
    },
    [folders, onReorder, onFoldersChange, t]
  );

  const handleAddFolder = useCallback(async () => {
    const title = newTitle.trim().slice(0, 12) || t('messaging.folderNewDefault');
    setSaving(true);
    setError('');
    try {
      const created = await onCreateFolder(title, newIcon);
      if (created) {
        onFoldersChange([...folders, created]);
        setNewTitle('');
        setNewIcon('📁');
        setAddMode(false);
      }
    } catch (err: any) {
      setError(err?.response?.data?.error || t('common.error'));
    } finally {
      setSaving(false);
    }
  }, [newTitle, newIcon, onCreateFolder, onFoldersChange, folders, t]);

  const handleTitleBlur = useCallback(
    async (folder: SyncFolderItem, value: string) => {
      const v = value.trim().slice(0, 12);
      if (v === folder.folder_title) return;
      setSaving(true);
      try {
        const updated = await onUpdateFolder(folder.id, { folder_title: v || folder.folder_title });
        if (updated) onFoldersChange(folders.map((f) => (f.id === folder.id ? updated : f)));
      } finally {
        setSaving(false);
      }
    },
    [onUpdateFolder, onFoldersChange, folders]
  );

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-50" aria-hidden onClick={onClose} />
      <div className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-md bg-card border border-border rounded-xl shadow-xl p-6 max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between mb-1 shrink-0">
          <h2 className="font-heading text-lg font-semibold text-foreground">{t('messaging.folderManageTitle')}</h2>
          <button type="button" onClick={onClose} className="p-2 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
            <X className="w-5 h-5" />
          </button>
        </div>
        <p className="text-xs text-muted-foreground mb-4 shrink-0">{t('messaging.folderManageSafetyHint')}</p>
        <div className="mb-4 p-3 rounded-lg bg-muted/50 border border-border shrink-0">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={hideEmptyFolders}
              onChange={(e) => onHideEmptyFoldersChange(e.target.checked)}
              className="rounded border-border"
            />
            <span className="text-sm text-foreground">{t('messaging.hideEmptyFolders')}</span>
          </label>
          <p className="text-xs text-muted-foreground mt-1 ml-6">{t('messaging.hideEmptyFoldersHint')}</p>
        </div>
        {error && (
          <p className="text-sm text-destructive mb-3 rounded-lg bg-destructive/10 px-3 py-2">{error}</p>
        )}
        <div className="flex-1 min-h-0 overflow-y-auto space-y-2 mb-4 scroll-thin">
          {folders.map((f) => (
            <div
              key={f.id}
              draggable={isAccountOwner}
              onDragStart={(e) => handleDragStart(e, f.id)}
              onDragOver={handleDragOver}
              onDrop={(e) => handleDrop(e, f.id)}
              onDragEnd={() => setDraggedId(null)}
              className={`flex items-center gap-2 p-2 rounded-lg border border-border bg-background ${
                draggedId === f.id ? 'opacity-50' : ''
              } ${isAccountOwner ? 'cursor-grab active:cursor-grabbing' : ''}`}
            >
              {isAccountOwner && <GripVertical className="w-4 h-4 text-muted-foreground shrink-0" />}
              <span className="text-lg shrink-0">{f.icon || '📁'}</span>
              {isAccountOwner ? (
                <Input
                  className="flex-1 h-8 text-sm"
                  defaultValue={f.folder_title}
                  maxLength={12}
                  onBlur={(e) => handleTitleBlur(f, e.target.value)}
                />
              ) : (
                <span className="text-sm truncate flex-1">{f.folder_title}</span>
              )}
              <span className="text-[10px] text-muted-foreground shrink-0">{f.is_user_created ? 'CRM' : 'TG'}</span>
              {isAccountOwner && f.is_user_created && onDeleteFolder && (
                <button
                  type="button"
                  onClick={async () => {
                    if (!window.confirm(t('messaging.folderDeleteConfirm', { name: f.folder_title }))) return;
                    setSaving(true);
                    setError('');
                    try {
                      await onDeleteFolder(f.id);
                      onFoldersChange(folders.filter((x) => x.id !== f.id));
                      onFolderDeleted?.(f.folder_id);
                    } catch (err: any) {
                      setError(err?.response?.data?.error || t('common.error'));
                    } finally {
                      setSaving(false);
                    }
                  }}
                  className="p-1.5 rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors shrink-0"
                  title={t('messaging.folderDelete')}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>
          ))}
        </div>
        {isAccountOwner && selectedAccountId && (
          <div className="shrink-0 border-t border-border pt-4 space-y-3">
            {!addMode ? (
              <Button type="button" variant="outline" className="w-full" onClick={() => setAddMode(true)}>
                <Plus className="w-4 h-4 mr-2" />
                {t('messaging.folderAddNew')}
              </Button>
            ) : (
              <div className="rounded-lg border border-border p-3 space-y-2 bg-muted/30">
                <Input
                  placeholder={t('messaging.folderNamePlaceholder')}
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value.slice(0, 12))}
                  maxLength={12}
                  className="text-sm"
                />
                <p className="text-xs text-muted-foreground">{t('messaging.folderNameMax')}</p>
                <div className="flex flex-wrap gap-1">
                  {FOLDER_ICON_OPTIONS.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      onClick={() => setNewIcon(emoji)}
                      className={`w-8 h-8 flex items-center justify-center rounded text-lg ${
                        newIcon === emoji ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'
                      }`}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={handleAddFolder} disabled={saving}>
                    {saving ? t('common.loading') : t('common.save')}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => { setAddMode(false); setNewTitle(''); setNewIcon('📁'); }}>
                    {t('common.cancel')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
        {saving && (
          <p className="text-xs text-muted-foreground mt-2">{t('common.loading')}</p>
        )}
      </div>
    </>
  );
}
