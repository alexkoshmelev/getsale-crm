'use client';

import { useState, useRef, useEffect } from 'react';
import { Sparkles } from 'lucide-react';

interface AIAssistantWidgetProps {
  onOpen: () => void;
}

export default function AIAssistantWidget({ onOpen }: AIAssistantWidgetProps) {
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [hasDragged, setHasDragged] = useState(false);
  const widgetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Устанавливаем начальную позицию в правом нижнем углу
    if (widgetRef.current) {
      const container = widgetRef.current.parentElement;
      if (container) {
        const rect = container.getBoundingClientRect();
        setPosition({
          x: rect.width - 80,
          y: rect.height - 80,
        });
      }
    }
  }, []);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (widgetRef.current) {
      const rect = widgetRef.current.getBoundingClientRect();
      setDragOffset({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      });
      setIsDragging(true);
      setHasDragged(false);
    }
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isDragging && widgetRef.current) {
        setHasDragged(true);
        const container = widgetRef.current.parentElement;
        if (container) {
          const containerRect = container.getBoundingClientRect();
          const newX = e.clientX - containerRect.left - dragOffset.x;
          const newY = e.clientY - containerRect.top - dragOffset.y;
          
          // Ограничиваем перемещение в пределах контейнера
          const widgetSize = 64;
          const maxX = containerRect.width - widgetSize;
          const maxY = containerRect.height - widgetSize;
          
          setPosition({
            x: Math.max(0, Math.min(newX, maxX)),
            y: Math.max(0, Math.min(newY, maxY)),
          });
        }
      }
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, dragOffset]);

  const handleClick = (e: React.MouseEvent) => {
    // Открываем окно только если не было перетаскивания
    if (!hasDragged) {
      onOpen();
    }
    setHasDragged(false);
  };

  return (
    <div
      ref={widgetRef}
      className="absolute z-50 cursor-move"
      style={{
        left: `${position.x}px`,
        top: `${position.y}px`,
        transform: isDragging ? 'scale(1.1)' : 'scale(1)',
        transition: isDragging ? 'none' : 'transform 0.2s ease',
      }}
      onMouseDown={handleMouseDown}
      onClick={handleClick}
    >
      <div className="relative">
        <div className="w-16 h-16 bg-gradient-to-br from-blue-600 to-purple-600 rounded-full shadow-lg hover:shadow-xl flex items-center justify-center transition-all duration-200 hover:scale-110">
          <Sparkles className="w-8 h-8 text-white" />
        </div>
        {/* Пульсирующий эффект */}
        <div className="absolute inset-0 bg-blue-500 rounded-full animate-ping opacity-20"></div>
      </div>
    </div>
  );
}
