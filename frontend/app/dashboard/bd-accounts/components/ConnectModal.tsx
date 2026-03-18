'use client';

import { CheckCircle2, XCircle, Loader2, MessageSquare, FolderOpen, ChevronRight, ChevronDown, RefreshCw, HelpCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import type { ConnectModalProps } from '../hooks/useBdAccountsConnect';
import type { SyncChatRow } from '../types';

export function ConnectModal(c: ConnectModalProps) {
  const { t } = useTranslation();

  const title =
    c.connectStep === 'credentials' && 'Подключить Telegram аккаунт' ||
    c.connectStep === 'qr' && 'Вход по QR-коду' ||
    c.connectStep === 'code' && 'Введите код из SMS' ||
    c.connectStep === 'password' && 'Введите пароль 2FA' ||
    c.connectStep === 'select-chats' && 'Чаты для синхронизации' ||
    '';

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <Card className={`w-full p-6 m-4 flex flex-col ${c.connectStep === 'select-chats' ? 'max-w-2xl max-h-[88vh]' : 'max-w-md'}`}>
        <div className="flex items-center justify-between mb-4 shrink-0">
          <h2 className="text-xl font-bold text-gray-900 dark:text-white">{title}</h2>
          <Button variant="outline" size="sm" onClick={c.handleCloseModal}>✕</Button>
        </div>

        {c.error && (
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3 mb-4 shrink-0">
            <p className="text-sm text-red-800 dark:text-red-200">{c.error}</p>
            {c.connectStep === 'select-chats' && c.handleRetryLoadDialogs && (
              <Button type="button" variant="outline" size="sm" className="mt-2 border-red-300 dark:border-red-700 text-red-800 dark:text-red-200 hover:bg-red-100 dark:hover:bg-red-900/30" onClick={c.handleRetryLoadDialogs} disabled={c.loadingDialogs}>
                Повторить
              </Button>
            )}
          </div>
        )}

        <div className={`flex flex-col ${c.connectStep === 'select-chats' ? 'flex-1 min-h-0 overflow-hidden' : ''} space-y-4`}>
          {c.connectStep === 'credentials' && (
            <>
              <div className="flex rounded-lg border border-gray-200 dark:border-gray-700 p-1 bg-gray-50 dark:bg-gray-800">
                <button
                  type="button"
                  onClick={() => c.setLoginMethod('phone')}
                  className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors ${
                    c.loginMethod === 'phone' ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow' : 'text-gray-600 dark:text-gray-400 hover:text-gray-900'
                  }`}
                >
                  По номеру телефона
                </button>
                <button
                  type="button"
                  onClick={() => c.setLoginMethod('qr')}
                  className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors ${
                    c.loginMethod === 'qr' ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow' : 'text-gray-600 dark:text-gray-400 hover:text-gray-900'
                  }`}
                >
                  По QR-коду
                </button>
              </div>
              {c.loginMethod === 'phone' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Номер телефона</label>
                  <Input
                    type="tel"
                    value={c.connectForm.phoneNumber}
                    onChange={(e) => c.setConnectForm({ ...c.connectForm, phoneNumber: e.target.value })}
                    placeholder="+1234567890"
                  />
                </div>
              )}
            </>
          )}

          {c.connectStep === 'qr' && c.qrState && (
            <>
              {(c.qrState.status === 'pending' || (c.qrState.status === 'need_password' && (c.submittingQrPassword || c.qrPendingReason === 'password'))) && !c.qrJustConnected && (
                <div className="flex flex-col items-center justify-center py-8">
                  <Loader2 className="w-12 h-12 animate-spin text-blue-600 mb-4" />
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                    {c.qrPendingReason === 'password' || c.submittingQrPassword ? 'Проверка пароля и подключение аккаунта…' : 'Генерация QR-кода…'}
                  </p>
                </div>
              )}
              {c.qrJustConnected && (
                <div className="flex flex-col items-center justify-center py-10">
                  <div className="w-16 h-16 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center mb-4">
                    <CheckCircle2 className="w-10 h-10 text-green-600 dark:text-green-400" />
                  </div>
                  <p className="text-lg font-semibold text-green-800 dark:text-green-200">Аккаунт подключён</p>
                  <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">Переход к выбору чатов…</p>
                </div>
              )}
              {c.qrState.status === 'qr' && c.qrState.loginTokenUrl && (
                <div className="flex flex-col items-center py-4">
                  <div className="bg-white p-4 rounded-xl shadow-inner">
                    <img
                      src={`https://api.qrserver.com/v1/create-qr-code/?size=256x256&data=${encodeURIComponent(c.qrState.loginTokenUrl)}`}
                      alt="QR для входа в Telegram"
                      className="w-64 h-64"
                    />
                  </div>
                  <p className="text-sm text-gray-600 dark:text-gray-400 mt-4 text-center max-w-xs">
                    Откройте Telegram на телефоне → Настройки → Устройства → Подключить устройство и отсканируйте QR-код
                  </p>
                  <p className="text-xs text-gray-500 mt-2">Код обновляется автоматически каждые ~30 сек.</p>
                </div>
              )}
              {c.qrState.status === 'need_password' && !c.submittingQrPassword && c.qrPendingReason !== 'password' && (
                <div className="py-4 space-y-3">
                  <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-3">
                    <p className="text-sm text-amber-800 dark:text-amber-200 font-medium">Требуется пароль 2FA</p>
                    <p className="text-xs text-amber-700 dark:text-amber-300 mt-0.5">
                      У этого аккаунта включена двухфакторная аутентификация. Введите пароль облачного пароля Telegram.
                    </p>
                    {c.qrState.passwordHint && <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">Подсказка: {c.qrState.passwordHint}</p>}
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Пароль 2FA</label>
                    <Input
                      type="password"
                      value={c.qr2faPassword}
                      onChange={(e) => c.setQr2faPassword(e.target.value)}
                      placeholder="••••••••"
                      autoFocus
                      onKeyDown={(e) => e.key === 'Enter' && c.handleSubmitQr2faPassword()}
                    />
                  </div>
                </div>
              )}
              {c.qrState.status === 'expired' && (
                <div className="flex flex-col items-center justify-center py-8">
                  <Loader2 className="w-12 h-12 animate-spin text-blue-600 mb-4" />
                  <p className="text-sm text-gray-600 dark:text-gray-400">Обновление QR-кода…</p>
                  <p className="text-xs text-gray-500 mt-1">Новый код появится через пару секунд.</p>
                </div>
              )}
              {c.qrState.status === 'error' && c.qrState.error && (
                <div className="py-4 space-y-3">
                  <p className="text-sm text-red-600 dark:text-red-400">{c.qrState.error}</p>
                  <p className="text-xs text-gray-500">Нажмите «Попробовать снова», чтобы показать новый QR-код.</p>
                </div>
              )}
            </>
          )}

          {c.connectStep === 'code' && (
            <>
              <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4 mb-4">
                <p className="text-sm text-blue-800 dark:text-blue-200">
                  Код подтверждения отправлен на номер <strong>{c.connectForm.phoneNumber}</strong>
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Код из SMS</label>
                <Input
                  type="text"
                  value={c.connectForm.phoneCode}
                  onChange={(e) => c.setConnectForm({ ...c.connectForm, phoneCode: e.target.value })}
                  placeholder="12345"
                  autoFocus
                />
              </div>
            </>
          )}

          {c.connectStep === 'password' && (
            <>
              <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4 mb-4">
                <p className="text-sm text-yellow-800 dark:text-yellow-200">Для этого аккаунта требуется двухфакторная аутентификация</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Пароль 2FA</label>
                <Input
                  type="password"
                  value={c.connectForm.password}
                  onChange={(e) => c.setConnectForm({ ...c.connectForm, password: e.target.value })}
                  placeholder="••••••••"
                  autoFocus
                />
              </div>
            </>
          )}

          {c.connectStep === 'select-chats' && (
            <div className="flex flex-col min-h-0 flex-1">
              {c.connectingAccountId && (
                <div className="flex items-center gap-2 mb-3 shrink-0">
                  <span className="flex items-center justify-center w-8 h-8 rounded-full bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400 shrink-0" title={`${t('bdAccounts.accountConnected')}. ${t('bdAccounts.accountConnectedHint')}`}>
                    <CheckCircle2 className="w-5 h-5" />
                  </span>
                  <span className="flex items-center justify-center w-8 h-8 rounded-full bg-muted text-muted-foreground hover:bg-muted/80 shrink-0 cursor-help" title={`${t('bdAccounts.syncSafetyTitle')}. ${t('bdAccounts.syncSafetyIntro')}`}>
                    <HelpCircle className="w-5 h-5" />
                  </span>
                </div>
              )}
              {c.syncProgress !== null ? (
                <div className="space-y-3 py-4 shrink-0">
                  <p className="text-sm text-gray-700 dark:text-gray-300">
                    Синхронизация… {c.syncProgress.currentTitle && <span className="text-muted-foreground">({c.syncProgress.currentTitle})</span>}
                  </p>
                  <div className="flex items-center gap-3">
                    <div className="flex-1 h-2.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                      <div className="h-full bg-primary transition-all duration-300 rounded-full" style={{ width: c.syncProgress.total ? `${(100 * c.syncProgress.done) / c.syncProgress.total}%` : '0%' }} />
                    </div>
                    <span className="text-sm font-medium tabular-nums">{c.syncProgress.done} / {c.syncProgress.total}</span>
                  </div>
                </div>
              ) : c.loadingDialogs ? (
                <div className="flex flex-col items-center justify-center py-12 flex-1">
                  <Loader2 className="w-10 h-10 animate-spin text-primary mb-3" />
                  <p className="text-sm text-muted-foreground">Загружаем папки и чаты…</p>
                  <p className="text-xs text-muted-foreground mt-1">При большом числе чатов загрузка может занять 3–5 минут</p>
                </div>
              ) : (
                <>
                  <div className="mb-3 shrink-0">
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Поиск по чатам и папкам</label>
                    <div className="relative">
                      <Input
                        type="text"
                        placeholder="Введите название чата или папки…"
                        value={c.selectChatsSearch}
                        onChange={(e) => c.setSelectChatsSearch(e.target.value)}
                        className="pl-9 rounded-lg border-gray-300 dark:border-gray-600"
                      />
                    </div>
                  </div>
                  <div className="flex items-center gap-2 mb-2 shrink-0 flex-wrap">
                    <span className="text-xs text-muted-foreground">Тип чатов:</span>
                    <div className="flex rounded-lg border border-gray-200 dark:border-gray-700 p-0.5 bg-gray-100 dark:bg-gray-800">
                      {(['all', 'personal', 'groups'] as const).map((key) => (
                        <button
                          key={key}
                          type="button"
                          onClick={() => c.setChatTypeFilter(key)}
                          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${c.chatTypeFilter === key ? 'bg-card text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'}`}
                        >
                          {key === 'all' ? 'Все' : key === 'personal' ? 'Личные' : 'Группы'}
                        </button>
                      ))}
                    </div>
                    <button type="button" onClick={c.handleRefetchFolders} disabled={c.refetchFoldersLoading} className="ml-auto flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50">
                      {c.refetchFoldersLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                      Обновить папки и чаты
                    </button>
                  </div>
                  <p className="text-xs text-muted-foreground mb-2 shrink-0">Отметьте папку — выберутся все чаты в ней. Или отметьте только нужные чаты.</p>
                  <div className="flex-1 min-h-0 overflow-y-auto rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/30 p-3 space-y-4">
                    {c.filterFoldersBySearch(c.dialogsByFolders, c.selectChatsSearch).map((folder) => {
                      const folderState = c.getFolderCheckState(folder);
                      const folderIdNum = Number(folder.id);
                      const isExpanded = c.expandedFolderId === folderIdNum;
                      const displayedDialogs = c.chatTypeFilter === 'all' ? folder.dialogs : c.chatTypeFilter === 'personal' ? folder.dialogs.filter((d) => d.isUser) : folder.dialogs.filter((d) => d.isGroup);
                      return (
                        <div key={folder.id} className="rounded-lg border border-gray-200 dark:border-gray-700 bg-card overflow-hidden">
                          <div className="flex items-center gap-2 p-3 hover:bg-gray-50 dark:hover:bg-gray-800/50 border-b border-gray-100 dark:border-gray-800">
                            <label className="flex items-center shrink-0 cursor-pointer" onClick={(e) => e.stopPropagation()}>
                              <input type="checkbox" ref={(el) => { if (el) el.indeterminate = folderState.indeterminate; }} checked={folderState.checked} onChange={() => c.toggleFolderSelection(folder)} className="rounded border-gray-300 w-4 h-4" />
                            </label>
                            <button type="button" onClick={() => c.toggleFolderExpanded(folderIdNum)} className="flex items-center gap-2 flex-1 min-w-0 text-left cursor-pointer">
                              {folder.emoticon ? <span className="text-lg shrink-0 w-6 text-center leading-none" aria-hidden>{folder.emoticon}</span> : <FolderOpen className="w-4 h-4 text-muted-foreground shrink-0" />}
                              <span className="font-semibold text-sm text-foreground truncate">{folder.title}</span>
                              <span className="text-xs text-muted-foreground shrink-0">{displayedDialogs.length}</span>
                              {isExpanded ? <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0 ml-auto" /> : <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0 ml-auto" />}
                            </button>
                          </div>
                          {isExpanded && (
                            <div className="max-h-48 overflow-y-auto">
                              {displayedDialogs.map((dialog) => (
                                <label key={`${folder.id}-${dialog.id}`} className="flex items-center gap-3 px-3 py-2 pl-10 hover:bg-gray-50 dark:hover:bg-gray-800/30 cursor-pointer border-t border-gray-100 dark:border-gray-800/50 first:border-t-0">
                                  <input type="checkbox" checked={c.selectedChatIds.has(String(dialog.id))} onChange={() => c.toggleChatSelection(String(dialog.id))} className="rounded border-gray-300 w-4 h-4" />
                                  <span className="font-medium text-sm truncate flex-1">{dialog.name}</span>
                                  {dialog.isUser && <span className="text-xs text-blue-600 dark:text-blue-400 shrink-0">Личный</span>}
                                  {dialog.isGroup && <span className="text-xs text-green-600 dark:text-green-400 shrink-0">Группа</span>}
                                  {dialog.isChannel && <span className="text-xs text-purple-600 dark:text-purple-400 shrink-0">Канал</span>}
                                </label>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {c.filterFoldersBySearch(c.dialogsByFolders, c.selectChatsSearch).length === 0 && c.selectChatsSearch.trim() && (
                      <p className="text-sm text-muted-foreground py-4 text-center">Ничего не найдено по запросу «{c.selectChatsSearch.trim()}»</p>
                    )}
                    {c.filterFoldersBySearch(c.dialogsByFolders, c.selectChatsSearch).length === 0 && !c.selectChatsSearch.trim() && c.dialogsByFolders.length === 0 && (
                      <p className="text-sm text-muted-foreground py-6 text-center">Нет папок и чатов. Подождите загрузки или проверьте подключение.</p>
                    )}
                    {(() => {
                      const idsInFolders = new Set(c.dialogsByFolders.flatMap((f) => f.dialogs.map((d) => String(d.id))));
                      const otherSyncChats = c.syncChatsList.filter((row: SyncChatRow) => !idsInFolders.has(String(row.telegram_chat_id)));
                      if (otherSyncChats.length === 0) return null;
                      const q = c.selectChatsSearch.trim().toLowerCase();
                      const filteredOther = q ? otherSyncChats.filter((r) => (r.title ?? r.telegram_chat_id).toLowerCase().includes(q)) : otherSyncChats;
                      if (filteredOther.length === 0 && q) return null;
                      const byFolder = new Map<number | null, SyncChatRow[]>();
                      for (const row of filteredOther) {
                        const fid = row.folder_id ?? null;
                        if (!byFolder.has(fid)) byFolder.set(fid, []);
                        byFolder.get(fid)!.push(row);
                      }
                      const folderTitles = new Map<number | null, string>();
                      folderTitles.set(null, 'Без папки');
                      for (const f of c.dialogsByFolders) folderTitles.set(f.id, f.title);
                      return (
                        <div className="rounded-lg border border-dashed border-gray-300 dark:border-gray-600 bg-card/50 p-3 mt-2">
                          <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2 flex items-center gap-1.5">
                            <MessageSquare className="w-3.5 h-3.5" /> Другие выбранные чаты
                          </div>
                          {Array.from(byFolder.entries()).map(([folderId, rows]) => (
                            <div key={folderId ?? 'null'} className="space-y-0.5">
                              {folderId !== null && <div className="text-xs text-muted-foreground pl-6 mt-1.5">{folderTitles.get(folderId) ?? `Папка ${folderId}`}</div>}
                              {rows.map((row) => (
                                <label key={row.telegram_chat_id} className="flex items-center gap-3 pl-6 py-1.5 hover:bg-gray-50 dark:hover:bg-gray-800/30 rounded cursor-pointer">
                                  <input type="checkbox" checked={c.selectedChatIds.has(String(row.telegram_chat_id))} onChange={() => c.toggleChatSelection(String(row.telegram_chat_id))} className="rounded border-gray-300 w-4 h-4" />
                                  <span className="font-medium text-sm truncate">{row.title || row.telegram_chat_id}</span>
                                </label>
                              ))}
                            </div>
                          ))}
                        </div>
                      );
                    })()}
                  </div>
                  <p className="text-sm text-muted-foreground mt-3 shrink-0">Выбрано чатов: <strong className="text-foreground">{c.selectedChatIds.size}</strong></p>
                </>
              )}
            </div>
          )}
        </div>

        <div className="flex gap-2 mt-6 shrink-0">
          {c.connectStep === 'credentials' && (
            <>
              <Button variant="outline" onClick={c.handleCloseModal} className="flex-1">Отмена</Button>
              {c.loginMethod === 'phone' ? (
                <Button onClick={c.handleSendCode} disabled={c.sendingCode} className="flex-1">
                  {c.sendingCode ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Отправка...</> : 'Отправить код'}
                </Button>
              ) : (
                <Button onClick={c.handleStartQrLogin} disabled={c.startingQr} className="flex-1">
                  {c.startingQr ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Загрузка...</> : 'Показать QR-код'}
                </Button>
              )}
            </>
          )}
          {c.connectStep === 'qr' && (
            <>
              <Button variant="outline" onClick={c.handleBackFromQr} className="flex-1">Назад</Button>
              {c.qrPendingReason === 'password' ? (
                <Button disabled className="flex-1"><Loader2 className="w-4 h-4 animate-spin mr-2" />Проверка пароля…</Button>
              ) : c.qrState?.status === 'need_password' ? (
                <Button onClick={c.handleSubmitQr2faPassword} disabled={c.submittingQrPassword || !c.qr2faPassword.trim()} className="flex-1">
                  {c.submittingQrPassword ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Подтвердить'}
                </Button>
              ) : c.qrState?.status === 'error' ? (
                <Button onClick={c.handleRetryQr} disabled={c.startingQr} className="flex-1">
                  {c.startingQr ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Попробовать снова'}
                </Button>
              ) : (
                <Button variant="outline" onClick={c.handleCloseModal} className="flex-1">Отмена</Button>
              )}
            </>
          )}
          {c.connectStep === 'code' && (
            <>
              <Button variant="outline" onClick={() => c.setConnectStep('credentials')} className="flex-1">Назад</Button>
              <Button onClick={c.handleVerifyCode} disabled={c.verifyingCode} className="flex-1">
                {c.verifyingCode ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Проверка...</> : 'Подтвердить'}
              </Button>
            </>
          )}
          {c.connectStep === 'password' && (
            <>
              <Button variant="outline" onClick={() => c.setConnectStep('code')} className="flex-1">Назад</Button>
              <Button onClick={c.handleVerifyCode} disabled={c.verifyingCode} className="flex-1">
                {c.verifyingCode ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Подключение...</> : 'Подключить'}
              </Button>
            </>
          )}
          {c.connectStep === 'select-chats' && !c.syncProgress && (
            <>
              <Button variant="outline" onClick={c.handleCloseModal} className="flex-1">Пропустить</Button>
              <Button onClick={c.handleSaveAndSync} disabled={c.startingSync || c.selectedChatIds.size === 0 || c.loadingDialogs} className="flex-1">
                {c.startingSync ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Запуск…</> : 'Сохранить и синхронизировать'}
              </Button>
            </>
          )}
        </div>
      </Card>
    </div>
  );
}
