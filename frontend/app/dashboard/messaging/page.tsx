'use client';

import { useEffect, useState } from 'react';
import axios from 'axios';
import { Send, Inbox, MessageSquare } from 'lucide-react';
import { useWebSocket } from '@/lib/hooks/use-websocket';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

interface Message {
  id: string;
  content: string;
  direction: 'inbound' | 'outbound';
  channel: string;
  unread: boolean;
  created_at: string;
  first_name?: string;
  last_name?: string;
}

export default function MessagingPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [selectedChat, setSelectedChat] = useState<string | null>(null);
  const [chatMessages, setChatMessages] = useState<Message[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const { isConnected, on, off } = useWebSocket();

  useEffect(() => {
    fetchInbox();
    
    // Subscribe to WebSocket events
    if (isConnected) {
      on('event', (data: any) => {
        if (data.type === 'message.received' || data.type === 'message.sent') {
          fetchInbox();
          if (selectedChat) {
            fetchChatMessages(selectedChat);
          }
        }
      });
    }

    return () => {
      off('event');
    };
  }, [isConnected, selectedChat]);

  useEffect(() => {
    if (selectedChat) {
      fetchChatMessages(selectedChat);
    }
  }, [selectedChat]);

  const fetchInbox = async () => {
    try {
      const response = await axios.get(`${API_URL}/api/messaging/inbox`);
      setMessages(response.data);
    } catch (error) {
      console.error('Error fetching inbox:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchChatMessages = async (contactId: string) => {
    try {
      const response = await axios.get(`${API_URL}/api/messaging/messages`, {
        params: { contactId },
      });
      setChatMessages(response.data);
    } catch (error) {
      console.error('Error fetching chat messages:', error);
    }
  };

  const handleSendMessage = async () => {
    if (!newMessage.trim() || !selectedChat) return;

    try {
      await axios.post(`${API_URL}/api/messaging/send`, {
        contactId: selectedChat,
        channel: 'telegram',
        channelId: selectedChat,
        content: newMessage,
      });

      setNewMessage('');
      fetchChatMessages(selectedChat);
    } catch (error) {
      console.error('Error sending message:', error);
    }
  };

  const handleMarkAsRead = async (messageId: string) => {
    try {
      await axios.patch(`${API_URL}/api/messaging/messages/${messageId}/read`);
      fetchInbox();
    } catch (error) {
      console.error('Error marking as read:', error);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  const unreadCount = messages.filter((m) => m.unread).length;
  const selectedMessage = messages.find((m) => m.id === selectedChat);

  return (
    <div className="flex h-[calc(100vh-8rem)] bg-white dark:bg-gray-800 rounded-lg shadow border border-gray-200 dark:border-gray-700">
      {/* Chat List */}
      <div className="w-80 border-r border-gray-200 dark:border-gray-700 flex flex-col">
        <div className="p-4 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2 mb-2">
            <Inbox className="w-5 h-5 text-gray-600 dark:text-gray-400" />
            <h2 className="font-semibold text-gray-900 dark:text-white">
              Входящие
            </h2>
            {unreadCount > 0 && (
              <span className="bg-blue-600 text-white text-xs px-2 py-1 rounded-full">
                {unreadCount}
              </span>
            )}
            {isConnected && (
              <span className="w-2 h-2 bg-green-500 rounded-full" title="Connected"></span>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {messages.map((message) => (
            <button
              key={message.id}
              onClick={() => {
                setSelectedChat(message.id);
                if (message.unread) {
                  handleMarkAsRead(message.id);
                }
              }}
              className={`w-full text-left p-4 border-b border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors ${
                selectedChat === message.id ? 'bg-blue-50 dark:bg-blue-900/20' : ''
              }`}
            >
              <div className="flex items-start justify-between mb-1">
                <div className="flex items-center gap-2">
                  <MessageSquare className="w-4 h-4 text-gray-400" />
                  <span className="font-medium text-gray-900 dark:text-white">
                    {message.first_name} {message.last_name || ''}
                  </span>
                </div>
                {message.unread && (
                  <span className="w-2 h-2 bg-blue-600 rounded-full"></span>
                )}
              </div>
              <p className="text-sm text-gray-600 dark:text-gray-400 truncate">
                {message.content}
              </p>
              <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                {new Date(message.created_at).toLocaleString('ru-RU')}
              </p>
            </button>
          ))}
          {messages.length === 0 && (
            <div className="text-center py-12 text-gray-400 dark:text-gray-500">
              Нет сообщений
            </div>
          )}
        </div>
      </div>

      {/* Chat Window */}
      <div className="flex-1 flex flex-col">
        {selectedChat && selectedMessage ? (
          <>
            <div className="p-4 border-b border-gray-200 dark:border-gray-700">
              <h3 className="font-semibold text-gray-900 dark:text-white">
                {selectedMessage.first_name} {selectedMessage.last_name || ''}
              </h3>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {selectedMessage.channel}
              </p>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {chatMessages.map((msg) => (
                <div
                  key={msg.id}
                  className={`flex ${
                    msg.direction === 'outbound' ? 'justify-end' : 'justify-start'
                  }`}
                >
                  <div
                    className={`max-w-xs lg:max-w-md px-4 py-2 rounded-lg ${
                      msg.direction === 'outbound'
                        ? 'bg-blue-600 text-white'
                        : 'bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-white'
                    }`}
                  >
                    <p className="text-sm">{msg.content}</p>
                    <p
                      className={`text-xs mt-1 ${
                        msg.direction === 'outbound'
                          ? 'text-blue-100'
                          : 'text-gray-500 dark:text-gray-400'
                      }`}
                    >
                      {new Date(msg.created_at).toLocaleTimeString('ru-RU')}
                    </p>
                  </div>
                </div>
              ))}
              {chatMessages.length === 0 && (
                <p className="text-gray-500 dark:text-gray-400 text-center py-8">
                  Нет сообщений в этом чате
                </p>
              )}
            </div>

            <div className="p-4 border-t border-gray-200 dark:border-gray-700">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newMessage}
                  onChange={(e) => setNewMessage(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && handleSendMessage()}
                  placeholder="Введите сообщение..."
                  className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent dark:bg-gray-700 dark:text-white"
                />
                <button
                  onClick={handleSendMessage}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors"
                >
                  <Send className="w-5 h-5" />
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <MessageSquare className="w-16 h-16 text-gray-400 mx-auto mb-4" />
              <p className="text-gray-500 dark:text-gray-400">
                Выберите чат для начала переписки
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
