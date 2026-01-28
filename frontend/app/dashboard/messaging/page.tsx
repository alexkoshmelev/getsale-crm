'use client';

import { useEffect, useState, useRef } from 'react';
import { apiClient } from '@/lib/api/client';
import { 
  Plus, Search, Send, MoreVertical, MessageSquare, 
  CheckCircle2, XCircle, Loader2, Settings, Trash2,
  Mic, Paperclip, FileText, Image, Video, File,
  Sparkles, Zap, History, FileCode, Bot, Workflow,
  ChevronDown, X, Clock, UserCircle, Tag, BarChart3
} from 'lucide-react';
import Button from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import AIAssistantWidget from '@/components/ai/AIAssistantWidget';
import AIAssistantWindow from '@/components/ai/AIAssistantWindow';

interface BDAccount {
  id: string;
  phone_number: string;
  telegram_id: string;
  is_active: boolean;
  connected_at?: string;
  last_activity?: string;
  created_at: string;
}

interface Chat {
  channel: string;
  channel_id: string;
  contact_id: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  telegram_id: string | null;
  name: string | null;
  unread_count: number;
  last_message_at: string;
  last_message: string | null;
}

interface Message {
  id: string;
  content: string;
  direction: string;
  created_at: string;
  status: string;
  contact_id: string | null;
  channel: string;
  channel_id: string;
}

export default function MessagingPage() {
  const [accounts, setAccounts] = useState<BDAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [chats, setChats] = useState<Chat[]>([]);
  const [selectedChat, setSelectedChat] = useState<Chat | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingChats, setLoadingChats] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sendingMessage, setSendingMessage] = useState(false);
  const [accountSearch, setAccountSearch] = useState('');
  const [chatSearch, setChatSearch] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [showCommandsMenu, setShowCommandsMenu] = useState(false);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showAIAssistant, setShowAIAssistant] = useState(false);

  useEffect(() => {
    fetchAccounts();
  }, []);

  useEffect(() => {
    if (selectedAccountId) {
      fetchChats();
    }
  }, [selectedAccountId]);

  useEffect(() => {
    if (selectedChat) {
      fetchMessages();
      markAsRead();
    }
  }, [selectedChat]);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Закрытие меню при клике вне его области
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest('.commands-menu') && !target.closest('.attach-menu')) {
        setShowCommandsMenu(false);
        setShowAttachMenu(false);
      }
    };

    if (showCommandsMenu || showAttachMenu) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
      };
    }
  }, [showCommandsMenu, showAttachMenu]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const fetchAccounts = async () => {
    try {
      const response = await apiClient.get('/api/bd-accounts');
      setAccounts(response.data);
      if (response.data.length > 0 && !selectedAccountId) {
        setSelectedAccountId(response.data[0].id);
      }
    } catch (error: any) {
      console.error('Error fetching accounts:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchChats = async () => {
    if (!selectedAccountId) return;
    
    setLoadingChats(true);
    try {
      // Get chats from messaging service (these are chats with messages in DB)
      let chatsFromDB: any[] = [];
      try {
        const chatsResponse = await apiClient.get('/api/messaging/chats?channel=telegram');
        chatsFromDB = chatsResponse.data || [];
      } catch (chatsError: any) {
        console.warn('Could not fetch chats from messaging service:', chatsError);
        // Continue with dialogs only
      }
      
      // Get dialogs from BD account (all available Telegram dialogs)
      let dialogs: any[] = [];
      try {
        const dialogsResponse = await apiClient.get(`/api/bd-accounts/${selectedAccountId}/dialogs`);
        dialogs = Array.isArray(dialogsResponse.data) ? dialogsResponse.data : [];
        console.log(`[Messaging] Loaded ${dialogs.length} dialogs from BD account`);
      } catch (dialogError: any) {
        console.error('Error fetching dialogs from BD account:', dialogError);
        console.error('Error details:', {
          status: dialogError.response?.status,
          message: dialogError.response?.data?.error || dialogError.message,
        });
        // If dialogs fail, try to use only chats from DB
        if (chatsFromDB.length > 0) {
          console.log(`[Messaging] Using ${chatsFromDB.length} chats from DB only`);
          const formattedChats: Chat[] = chatsFromDB.map((chat: any) => ({
            channel: chat.channel || 'telegram',
            channel_id: String(chat.channel_id),
            contact_id: chat.contact_id,
            first_name: chat.first_name,
            last_name: chat.last_name,
            email: chat.email,
            telegram_id: chat.telegram_id,
            name: chat.name || null,
            unread_count: parseInt(chat.unread_count) || 0,
            last_message_at: chat.last_message_at || new Date().toISOString(),
            last_message: chat.last_message,
          }));
          setChats(formattedChats);
          return;
        }
        // If both fail, show empty list
        console.warn('[Messaging] No chats available from either source');
        setChats([]);
        return;
      }
      
      // Create a map of chats from messaging service by channel_id
      const chatsMap = new Map<string, Chat>();
      console.log(`[Messaging] Processing ${chatsFromDB.length} chats from DB`);
      chatsFromDB.forEach((chat: any) => {
        const channelId = String(chat.channel_id);
        chatsMap.set(channelId, {
          channel: chat.channel || 'telegram',
          channel_id: channelId,
          contact_id: chat.contact_id,
          first_name: chat.first_name,
          last_name: chat.last_name,
          email: chat.email,
          telegram_id: chat.telegram_id,
          name: chat.name || null,
          unread_count: parseInt(chat.unread_count) || 0,
          last_message_at: chat.last_message_at || new Date().toISOString(),
          last_message: chat.last_message,
        });
      });
      
      // Merge dialogs with chats - add dialogs that don't have messages yet
      dialogs.forEach((dialog: any) => {
        const channelId = String(dialog.id);
        if (!chatsMap.has(channelId)) {
          // This is a dialog without messages in DB yet
          chatsMap.set(channelId, {
            channel: 'telegram',
            channel_id: channelId,
            contact_id: null,
            first_name: null,
            last_name: null,
            email: null,
            telegram_id: channelId,
            name: dialog.name || null,
            unread_count: dialog.unreadCount || 0,
            last_message_at: dialog.lastMessageDate 
              ? new Date(dialog.lastMessageDate * 1000).toISOString() 
              : new Date().toISOString(),
            last_message: dialog.lastMessage || null,
          });
        } else {
          // Update existing chat with dialog info if available
          const existingChat = chatsMap.get(channelId)!;
          // Update name from dialog if not already set
          if (dialog.name && !existingChat.name) {
            existingChat.name = dialog.name;
          }
          // Try to extract first_name/last_name from dialog name if not already set
          if (dialog.name && !existingChat.first_name && !existingChat.last_name) {
            const nameParts = dialog.name.split(' ');
            existingChat.first_name = nameParts[0] || null;
            existingChat.last_name = nameParts.slice(1).join(' ') || null;
          }
          if (dialog.unreadCount !== undefined) {
            existingChat.unread_count = Math.max(existingChat.unread_count, dialog.unreadCount || 0);
          }
        }
      });
      
      // Convert map to array and sort by last_message_at
      const formattedChats = Array.from(chatsMap.values()).sort((a, b) => {
        return new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime();
      });

      console.log(`[Messaging] Total chats after merge: ${formattedChats.length}`);
      setChats(formattedChats);
    } catch (error: any) {
      console.error('Error fetching chats:', error);
      // Set empty array on error to show "No chats" message
      setChats([]);
    } finally {
      setLoadingChats(false);
    }
  };

  const fetchMessages = async () => {
    if (!selectedChat || !selectedAccountId) return;

    setLoadingMessages(true);
    try {
      // Try to get messages from database first
      const response = await apiClient.get('/api/messaging/messages', {
        params: {
          channel: selectedChat.channel,
          channelId: selectedChat.channel_id,
          limit: 100,
        },
      });
      
      let messages = response.data.messages || [];
      
      // If no messages in DB, try to get from Telegram dialogs
      if (messages.length === 0) {
        console.log('[Messaging] No messages in DB, trying to fetch from Telegram...');
        try {
          // Get dialogs to find this chat
          const dialogsResponse = await apiClient.get(`/api/bd-accounts/${selectedAccountId}/dialogs`);
          const dialog = dialogsResponse.data.find((d: any) => String(d.id) === selectedChat.channel_id);
          
          if (dialog && dialog.lastMessage) {
            // Create a placeholder message from dialog info
            messages = [{
              id: `temp-${Date.now()}`,
              content: dialog.lastMessage,
              direction: 'inbound',
              created_at: dialog.lastMessageDate 
                ? new Date(dialog.lastMessageDate * 1000).toISOString() 
                : new Date().toISOString(),
              status: 'delivered',
              contact_id: selectedChat.contact_id,
              channel: selectedChat.channel,
              channel_id: selectedChat.channel_id,
            }];
          }
        } catch (dialogError) {
          console.warn('Could not fetch dialog info:', dialogError);
        }
      }
      
      // Reverse to show oldest first (like Telegram)
      setMessages(messages.reverse());
      console.log(`[Messaging] Loaded ${messages.length} messages for chat ${selectedChat.channel_id}`);
    } catch (error: any) {
      console.error('Error fetching messages:', error);
      setMessages([]);
    } finally {
      setLoadingMessages(false);
    }
  };

  const markAsRead = async () => {
    if (!selectedChat) return;

    try {
      // Use correct endpoint: /api/messaging/chats/:chatId/mark-all-read?channel=telegram
      await apiClient.post(
        `/api/messaging/chats/${selectedChat.channel_id}/mark-all-read?channel=${selectedChat.channel}`
      );
      // Update chat unread count
      setChats((prev) =>
        prev.map((chat) =>
          chat.channel_id === selectedChat.channel_id
            ? { ...chat, unread_count: 0 }
            : chat
        )
      );
    } catch (error) {
      // Silently fail - not critical
      console.warn('Error marking as read:', error);
    }
  };

  // Заглушки для новых функций
  const handleVoiceMessage = () => {
    console.log('[CRM] Voice message recording started');
    setIsRecording(true);
    // Заглушка - через 2 секунды остановим
    setTimeout(() => {
      setIsRecording(false);
      alert('Голосовое сообщение записано (заглушка)');
    }, 2000);
  };

  const handleAttachFile = (type: 'photo' | 'video' | 'file') => {
    console.log(`[CRM] Attach ${type}`);
    setShowAttachMenu(false);
    fileInputRef.current?.click();
    alert(`Прикрепление ${type === 'photo' ? 'фото' : type === 'video' ? 'видео' : 'файла'} (заглушка)`);
  };

  const handleInsertFromScript = () => {
    console.log('[CRM] Insert from script');
    setShowCommandsMenu(false);
    const scriptMessage = 'Здравствуйте! Спасибо за интерес к нашему продукту. Как мы можем вам помочь?';
    setNewMessage(scriptMessage);
    alert('Сообщение из скрипта вставлено (заглушка)');
  };

  const handleInsertPrevious = () => {
    console.log('[CRM] Insert previous message');
    setShowCommandsMenu(false);
    if (messages.length > 0) {
      const lastOutbound = [...messages].reverse().find(m => m.direction === 'outbound');
      if (lastOutbound) {
        setNewMessage(lastOutbound.content);
        alert('Предыдущее сообщение вставлено (заглушка)');
      } else {
        alert('Нет предыдущих исходящих сообщений');
      }
    }
  };

  const handleInsertAIGenerated = () => {
    console.log('[CRM] Insert AI-generated message');
    setShowCommandsMenu(false);
    const aiMessage = 'На основе контекста беседы, предлагаю следующий ответ...';
    setNewMessage(aiMessage);
    alert('AI-сгенерированное сообщение вставлено (заглушка)');
  };

  const handleAutomation = () => {
    console.log('[CRM] Open automation');
    setShowCommandsMenu(false);
    alert('Открытие настроек автоматизации (заглушка)');
  };

  const handleCreateContact = () => {
    console.log('[CRM] Create contact');
    setShowCommandsMenu(false);
    alert('Создание контакта (заглушка)');
  };

  const handleAddTag = () => {
    console.log('[CRM] Add tag');
    setShowCommandsMenu(false);
    alert('Добавление тега к контакту (заглушка)');
  };

  const handleViewAnalytics = () => {
    console.log('[CRM] View analytics');
    setShowCommandsMenu(false);
    alert('Просмотр аналитики по контакту (заглушка)');
  };

  const handleScheduleMessage = () => {
    console.log('[CRM] Schedule message');
    setShowCommandsMenu(false);
    alert('Отложенная отправка сообщения (заглушка)');
  };

  const handleSendMessage = async () => {
    if (!newMessage.trim() || !selectedChat || !selectedAccountId) return;

    const messageText = newMessage.trim();
    setNewMessage('');
    setSendingMessage(true);

    // Optimistically add message to UI
    const tempMessage: Message = {
      id: `temp-${Date.now()}`,
      content: messageText,
      direction: 'outbound',
      created_at: new Date().toISOString(),
      status: 'pending',
      contact_id: selectedChat.contact_id,
      channel: selectedChat.channel,
      channel_id: selectedChat.channel_id,
    };
    setMessages((prev) => [...prev, tempMessage]);
    scrollToBottom();

    try {
      const response = await apiClient.post('/api/messaging/send', {
        contactId: selectedChat.contact_id,
        channel: selectedChat.channel,
        channelId: selectedChat.channel_id,
        content: messageText,
        bdAccountId: selectedAccountId,
      });

      // Replace temp message with real one
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === tempMessage.id
            ? {
                ...msg,
                id: response.data.id,
                status: response.data.status,
                created_at: response.data.created_at,
              }
            : msg
        )
      );

      // Refresh chats to update last message
      await fetchChats();
    } catch (error: any) {
      console.error('Error sending message:', error);
      // Remove temp message on error
      setMessages((prev) => prev.filter((msg) => msg.id !== tempMessage.id));
      alert(error.response?.data?.error || 'Ошибка отправки сообщения');
    } finally {
      setSendingMessage(false);
    }
  };

  const getChatName = (chat: Chat) => {
    // First priority: use name from dialog
    if (chat.name) {
      return chat.name;
    }
    // Second priority: use first_name + last_name
    if (chat.first_name || chat.last_name) {
      return `${chat.first_name || ''} ${chat.last_name || ''}`.trim();
    }
    // Third priority: use email
    if (chat.email) {
      return chat.email;
    }
    // Last resort: use telegram_id
    if (chat.telegram_id) {
      return chat.telegram_id;
    }
    return 'Unknown';
  };

  const formatTime = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / (1000 * 60));
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const days = Math.floor(hours / 24);

    // Show time for today
    if (days === 0) {
      // If less than 1 minute ago, show "только что"
      if (minutes < 1) {
        return 'только что';
      }
      // If less than 1 hour ago, show minutes
      if (hours === 0) {
        return `${minutes} мин. назад`;
      }
      return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    } else if (days === 1) {
      return 'Вчера ' + date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    } else if (days < 7) {
      return date.toLocaleDateString('ru-RU', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
    } else {
      return date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
    }
  };

  const filteredAccounts = accounts.filter((account) =>
    account.phone_number?.toLowerCase().includes(accountSearch.toLowerCase()) ||
    account.telegram_id?.toLowerCase().includes(accountSearch.toLowerCase())
  );

  const filteredChats = chats.filter((chat) => {
    const name = getChatName(chat).toLowerCase();
    return name.includes(chatSearch.toLowerCase());
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="relative flex h-[calc(100vh-12rem)] bg-white -m-6 rounded-lg border border-gray-200 overflow-hidden">
      {/* BD Accounts Sidebar */}
      <div className="w-64 bg-gray-50 border-r border-gray-200 flex flex-col">
        <div className="p-4 border-b border-gray-200">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-gray-900">BD Аккаунты</h3>
            <Button
              size="sm"
              onClick={() => window.location.href = '/dashboard/bd-accounts'}
              className="p-1"
            >
              <Plus className="w-4 h-4" />
            </Button>
          </div>
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-2.5 text-gray-400" />
            <Input
              type="text"
              placeholder="Поиск..."
              value={accountSearch}
              onChange={(e) => setAccountSearch(e.target.value)}
              className="pl-9 text-sm"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {filteredAccounts.length === 0 ? (
            <div className="p-4 text-center text-sm text-gray-500">
              Нет аккаунтов
            </div>
          ) : (
            filteredAccounts.map((account) => (
              <div
                key={account.id}
                onClick={() => setSelectedAccountId(account.id)}
                className={`p-3 cursor-pointer border-b border-gray-200 hover:bg-gray-100 ${
                  selectedAccountId === account.id
                    ? 'bg-blue-50 border-l-4 border-l-blue-500'
                    : ''
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm truncate">
                      {account.phone_number || account.telegram_id || 'Unknown'}
                    </div>
                    <div className="text-xs text-gray-500">Telegram</div>
                  </div>
                  {account.is_active ? (
                    <CheckCircle2 className="w-4 h-4 text-green-500 flex-shrink-0 ml-2" />
                  ) : (
                    <XCircle className="w-4 h-4 text-gray-400 flex-shrink-0 ml-2" />
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Chats List */}
      <div className="w-80 bg-white border-r border-gray-200 flex flex-col">
        <div className="p-4 border-b border-gray-200">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-2.5 text-gray-400" />
            <Input
              type="text"
              placeholder="Поиск чатов..."
              value={chatSearch}
              onChange={(e) => setChatSearch(e.target.value)}
              className="pl-9 text-sm"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loadingChats ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
            </div>
          ) : filteredChats.length === 0 ? (
            <div className="p-4 text-center text-sm text-gray-500">
              Нет чатов
            </div>
          ) : (
            filteredChats.map((chat) => (
              <div
                key={`${chat.channel}-${chat.channel_id}`}
                onClick={() => setSelectedChat(chat)}
                className={`p-4 cursor-pointer border-b border-gray-100 hover:bg-gray-50 ${
                  selectedChat?.channel_id === chat.channel_id ? 'bg-blue-50' : ''
                }`}
              >
                <div className="flex items-start justify-between mb-1">
                  <div className="font-medium text-sm truncate flex-1">
                    {getChatName(chat)}
                  </div>
                  <span className="text-xs text-gray-500 ml-2 flex-shrink-0">
                    {formatTime(chat.last_message_at)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <div className="text-sm text-gray-600 truncate flex-1">
                    {chat.last_message || 'Нет сообщений'}
                  </div>
                  {chat.unread_count > 0 && (
                    <span className="ml-2 bg-blue-500 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center flex-shrink-0">
                      {chat.unread_count}
                    </span>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Chat Messages */}
      <div className="flex-1 flex flex-col">
        {selectedChat ? (
          <>
            <div className="p-4 border-b border-gray-200 bg-white">
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-semibold">{getChatName(selectedChat)}</div>
                  <div className="text-sm text-gray-500">
                    {selectedChat.telegram_id && `Telegram ID: ${selectedChat.telegram_id}`}
                  </div>
                </div>
                <button className="p-2 hover:bg-gray-100 rounded">
                  <MoreVertical className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 bg-gray-50">
              {loadingMessages ? (
                <div className="flex items-center justify-center h-full">
                  <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
                </div>
              ) : messages.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-gray-500">
                  <MessageSquare className="w-12 h-12 mb-3 text-gray-400" />
                  <p className="text-sm">Нет сообщений</p>
                  <p className="text-xs mt-1 text-gray-400">Начните переписку</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {messages.map((msg, index) => {
                    const isOutbound = msg.direction === 'outbound';
                    const showDateSeparator = index === 0 || 
                      new Date(msg.created_at).toDateString() !== 
                      new Date(messages[index - 1].created_at).toDateString();
                    
                    return (
                      <div key={msg.id}>
                        {showDateSeparator && (
                          <div className="flex justify-center my-4">
                            <span className="text-xs text-gray-500 bg-gray-200 px-3 py-1 rounded-full">
                              {new Date(msg.created_at).toLocaleDateString('ru-RU', {
                                day: 'numeric',
                                month: 'long',
                                year: 'numeric'
                              })}
                            </span>
                          </div>
                        )}
                        <div
                          className={`flex items-end gap-2 ${
                            isOutbound ? 'flex-row-reverse' : 'flex-row'
                          }`}
                        >
                          <div
                            className={`max-w-[70%] rounded-2xl px-4 py-2 ${
                              isOutbound
                                ? 'bg-blue-500 text-white rounded-br-md'
                                : 'bg-white text-gray-900 rounded-bl-md shadow-sm'
                            }`}
                          >
                            <div className="text-sm leading-relaxed whitespace-pre-wrap break-words">
                              {msg.content}
                            </div>
                            <div
                              className={`text-xs mt-1 flex items-center gap-1 ${
                                isOutbound
                                  ? 'text-blue-100 justify-end'
                                  : 'text-gray-500 justify-start'
                              }`}
                            >
                              <span>{formatTime(msg.created_at)}</span>
                              {isOutbound && (
                                <span className="ml-1">
                                  {msg.status === 'delivered' ? '✓✓' : 
                                   msg.status === 'sent' ? '✓' : ''}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  <div ref={messagesEndRef} />
                </div>
              )}
            </div>

            {/* Команды CRM - верхняя панель */}
            {showCommandsMenu && (
              <div className="commands-menu px-4 pt-3 pb-2 bg-gray-50 border-t border-gray-200">
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    onClick={handleInsertFromScript}
                    className="flex items-center gap-2 px-3 py-1.5 text-sm bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                  >
                    <FileCode className="w-4 h-4 text-blue-600" />
                    <span>Из скрипта</span>
                  </button>
                  <button
                    onClick={handleInsertPrevious}
                    className="flex items-center gap-2 px-3 py-1.5 text-sm bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                  >
                    <History className="w-4 h-4 text-purple-600" />
                    <span>Предыдущее</span>
                  </button>
                  <button
                    onClick={handleInsertAIGenerated}
                    className="flex items-center gap-2 px-3 py-1.5 text-sm bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                  >
                    <Sparkles className="w-4 h-4 text-yellow-600" />
                    <span>AI-ответ</span>
                  </button>
                  <button
                    onClick={handleAutomation}
                    className="flex items-center gap-2 px-3 py-1.5 text-sm bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                  >
                    <Zap className="w-4 h-4 text-orange-600" />
                    <span>Автоматизация</span>
                  </button>
                  <button
                    onClick={handleCreateContact}
                    className="flex items-center gap-2 px-3 py-1.5 text-sm bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                  >
                    <UserCircle className="w-4 h-4 text-green-600" />
                    <span>Создать контакт</span>
                  </button>
                  <button
                    onClick={handleAddTag}
                    className="flex items-center gap-2 px-3 py-1.5 text-sm bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                  >
                    <Tag className="w-4 h-4 text-indigo-600" />
                    <span>Добавить тег</span>
                  </button>
                  <button
                    onClick={handleViewAnalytics}
                    className="flex items-center gap-2 px-3 py-1.5 text-sm bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                  >
                    <BarChart3 className="w-4 h-4 text-cyan-600" />
                    <span>Аналитика</span>
                  </button>
                  <button
                    onClick={handleScheduleMessage}
                    className="flex items-center gap-2 px-3 py-1.5 text-sm bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                  >
                    <Clock className="w-4 h-4 text-pink-600" />
                    <span>Отложить</span>
                  </button>
                  <button
                    onClick={() => setShowCommandsMenu(false)}
                    className="ml-auto p-1.5 text-gray-400 hover:text-gray-600 transition-colors"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}

            <div className="p-4 bg-white border-t border-gray-200">
              {/* Панель ввода сообщения */}
              <div className="flex items-end gap-2">
                {/* Кнопка прикрепления файлов */}
                <div className="relative attach-menu">
                  <button
                    onClick={() => setShowAttachMenu(!showAttachMenu)}
                    className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
                    title="Прикрепить файл"
                  >
                    <Paperclip className="w-5 h-5" />
                  </button>
                  
                  {/* Выпадающее меню прикрепления */}
                  {showAttachMenu && (
                    <div className="absolute bottom-full left-0 mb-2 bg-white border border-gray-200 rounded-lg shadow-lg p-2 z-10 min-w-[180px]">
                      <button
                        onClick={() => handleAttachFile('photo')}
                        className="w-full flex items-center gap-3 px-3 py-2 text-sm hover:bg-gray-50 rounded-lg transition-colors"
                      >
                        <Image className="w-4 h-4 text-blue-600" />
                        <span>Фото</span>
                      </button>
                      <button
                        onClick={() => handleAttachFile('video')}
                        className="w-full flex items-center gap-3 px-3 py-2 text-sm hover:bg-gray-50 rounded-lg transition-colors"
                      >
                        <Video className="w-4 h-4 text-red-600" />
                        <span>Видео</span>
                      </button>
                      <button
                        onClick={() => handleAttachFile('file')}
                        className="w-full flex items-center gap-3 px-3 py-2 text-sm hover:bg-gray-50 rounded-lg transition-colors"
                      >
                        <File className="w-4 h-4 text-gray-600" />
                        <span>Файл</span>
                      </button>
                    </div>
                  )}
                  
                  {/* Скрытый input для файлов */}
                  <input
                    ref={fileInputRef}
                    type="file"
                    className="hidden"
                    accept="image/*,video/*,.pdf,.doc,.docx,.txt"
                    multiple
                  />
                </div>

                {/* Кнопка голосового сообщения */}
                <button
                  onClick={handleVoiceMessage}
                  className={`p-2 rounded-lg transition-colors ${
                    isRecording
                      ? 'bg-red-100 text-red-600 animate-pulse'
                      : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'
                  }`}
                  title="Голосовое сообщение"
                >
                  <Mic className="w-5 h-5" />
                </button>

                {/* Поле ввода */}
                <div className="flex-1 relative">
                  <div className="w-full">
                    <Input
                      type="text"
                      placeholder="Написать сообщение..."
                      value={newMessage}
                      onChange={(e) => setNewMessage(e.target.value)}
                      onKeyPress={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          handleSendMessage();
                        }
                      }}
                      className="pr-10"
                    />
                  </div>
                  
                  {/* Кнопка команд CRM */}
                  <button
                    onClick={() => setShowCommandsMenu(!showCommandsMenu)}
                    className={`absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-lg transition-colors ${
                      showCommandsMenu
                        ? 'bg-blue-100 text-blue-600'
                        : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'
                    }`}
                    title="Команды CRM"
                  >
                    <Bot className="w-4 h-4" />
                  </button>
                </div>

                {/* Кнопка отправки */}
                <Button
                  onClick={handleSendMessage}
                  disabled={!newMessage.trim() || sendingMessage}
                  className="px-4"
                >
                  {sendingMessage ? (
                    <Loader2 className="w-5 h-5 animate-spin" />
                  ) : (
                    <Send className="w-5 h-5" />
                  )}
                </Button>
              </div>

              {/* Индикатор записи голосового сообщения */}
              {isRecording && (
                <div className="mt-2 flex items-center gap-2 text-sm text-red-600">
                  <div className="w-2 h-2 bg-red-600 rounded-full animate-pulse"></div>
                  <span>Идет запись голосового сообщения...</span>
                  <button
                    onClick={() => setIsRecording(false)}
                    className="ml-auto text-xs text-gray-500 hover:text-gray-700"
                  >
                    Отменить
                  </button>
                </div>
              )}

              {/* Подсказка о командах */}
              {!showCommandsMenu && (
                <div className="mt-2 flex items-center gap-2 text-xs text-gray-400">
                  <Bot className="w-3 h-3" />
                  <span>Нажмите на иконку бота для доступа к командам CRM</span>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center bg-gray-50">
            <div className="text-center">
              <MessageSquare className="w-16 h-16 text-gray-400 mx-auto mb-4" />
              <h3 className="text-lg font-semibold text-gray-900 mb-2">
                Выберите чат
              </h3>
              <p className="text-gray-500">
                Выберите чат из списка, чтобы начать переписку
              </p>
            </div>
          </div>
        )}
      </div>

      {/* AI Assistant Widget */}
      <AIAssistantWidget onOpen={() => setShowAIAssistant(true)} />

      {/* AI Assistant Window */}
      <AIAssistantWindow
        isOpen={showAIAssistant}
        onClose={() => setShowAIAssistant(false)}
        selectedChat={selectedChat ? {
          name: selectedChat.name,
          channel_id: selectedChat.channel_id,
          first_name: selectedChat.first_name,
          last_name: selectedChat.last_name,
        } : null}
      />
    </div>
  );
}
