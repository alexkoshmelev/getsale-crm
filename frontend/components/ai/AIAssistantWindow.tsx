'use client';

import { useState, useRef, useEffect } from 'react';
import { X, Send, Loader2, Sparkles, Minimize2 } from 'lucide-react';
import Button from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';

interface AIMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

interface AIAssistantWindowProps {
  isOpen: boolean;
  onClose: () => void;
  selectedChat?: {
    name: string | null;
    channel_id: string;
    first_name: string | null;
    last_name: string | null;
  } | null;
}

export default function AIAssistantWindow({ 
  isOpen, 
  onClose,
  selectedChat 
}: AIAssistantWindowProps) {
  const [messages, setMessages] = useState<AIMessage[]>([
    {
      id: '1',
      role: 'assistant',
      content: 'Привет! Я ваш AI-помощник для работы с клиентами. Чем могу помочь?',
      timestamp: new Date(),
    },
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [isMinimized, setIsMinimized] = useState(false);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const handleSend = async () => {
    if (!input.trim() || isLoading) return;

    const userMessage: AIMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: input.trim(),
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);

    // Заглушка для AI-ответа
    setTimeout(() => {
      const assistantMessage: AIMessage = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: generateAIResponse(userMessage.content),
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, assistantMessage]);
      setIsLoading(false);
    }, 1000);
  };

  const generateAIResponse = (userInput: string): string => {
    // Заглушка для генерации ответа
    const lowerInput = userInput.toLowerCase();
    
    if (lowerInput.includes('привет') || lowerInput.includes('здравствуй')) {
      return 'Здравствуйте! Как дела? Чем могу помочь с работой с клиентами?';
    }
    
    if (lowerInput.includes('скрипт') || lowerInput.includes('ответ')) {
      return `Вот пример ответа для клиента:\n\n"Здравствуйте! Спасибо за интерес к нашему продукту. Мы готовы ответить на все ваши вопросы и помочь с выбором оптимального решения. Когда вам будет удобно обсудить детали?"\n\nЭтот ответ показывает профессионализм и готовность помочь.`;
    }
    
    if (lowerInput.includes('анализ') || lowerInput.includes('статистика')) {
      const chatInfo = selectedChat 
        ? `\n\nИнформация о текущем чате:\n- Имя: ${selectedChat.name || 'Не указано'}\n- ID: ${selectedChat.channel_id}`
        : '';
      return `Анализ переписки показывает:\n- Среднее время ответа: 5 минут\n- Процент положительных ответов: 85%\n- Рекомендация: продолжать активную коммуникацию${chatInfo}`;
    }
    
    return `Понял ваш запрос: "${userInput}". Это заглушка для демонстрации. В реальной версии здесь будет интеграция с AI-сервисом для генерации умных ответов на основе контекста переписки и истории взаимодействий с клиентом.`;
  };

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString('ru-RU', { 
      hour: '2-digit', 
      minute: '2-digit' 
    });
  };

  if (!isOpen) return null;

  return (
    <div className="fixed bottom-24 right-4 w-96 h-[600px] bg-white rounded-lg shadow-2xl border border-gray-200 flex flex-col z-[60]">
      {/* Заголовок */}
      <div className="flex items-center justify-between p-4 border-b border-gray-200 bg-gradient-to-r from-blue-600 to-purple-600 text-white rounded-t-lg">
        <div className="flex items-center gap-2">
          <Sparkles className="w-5 h-5" />
          <h3 className="font-semibold">AI Помощник</h3>
          {selectedChat && (
            <span className="text-xs bg-white/20 px-2 py-1 rounded">
              {selectedChat.name || 'Чат'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setIsMinimized(!isMinimized)}
            className="p-1 hover:bg-white/20 rounded transition-colors"
            title={isMinimized ? 'Развернуть' : 'Свернуть'}
          >
            <Minimize2 className="w-4 h-4" />
          </button>
          <button
            onClick={onClose}
            className="p-1 hover:bg-white/20 rounded transition-colors"
            title="Закрыть"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {!isMinimized && (
        <>
          {/* Сообщения */}
          <div className="flex-1 overflow-y-auto p-4 bg-gray-50 space-y-4">
            {messages.map((message) => (
              <div
                key={message.id}
                className={`flex ${
                  message.role === 'user' ? 'justify-end' : 'justify-start'
                }`}
              >
                <div
                  className={`max-w-[80%] rounded-2xl px-4 py-2 ${
                    message.role === 'user'
                      ? 'bg-blue-600 text-white rounded-br-md'
                      : 'bg-white text-gray-900 rounded-bl-md shadow-sm border border-gray-200'
                  }`}
                >
                  <div className="text-sm whitespace-pre-wrap break-words">
                    {message.content}
                  </div>
                  <div
                    className={`text-xs mt-1 ${
                      message.role === 'user'
                        ? 'text-blue-100'
                        : 'text-gray-500'
                    }`}
                  >
                    {formatTime(message.timestamp)}
                  </div>
                </div>
              </div>
            ))}
            
            {isLoading && (
              <div className="flex justify-start">
                <div className="bg-white rounded-2xl rounded-bl-md px-4 py-2 shadow-sm border border-gray-200">
                  <Loader2 className="w-5 h-5 animate-spin text-blue-600" />
                </div>
              </div>
            )}
            
            <div ref={messagesEndRef} />
          </div>

          {/* Поле ввода */}
          <div className="p-4 border-t border-gray-200 bg-white rounded-b-lg">
            <div className="flex items-center gap-2">
              <Input
                type="text"
                placeholder="Задайте вопрос AI-помощнику..."
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyPress={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                className="flex-1"
              />
              <Button
                onClick={handleSend}
                disabled={!input.trim() || isLoading}
                className="px-4"
              >
                {isLoading ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <Send className="w-5 h-5" />
                )}
              </Button>
            </div>
            <p className="text-xs text-gray-500 mt-2">
              AI поможет с ответами, скриптами и анализом переписки
            </p>
          </div>
        </>
      )}
    </div>
  );
}
