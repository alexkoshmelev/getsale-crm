'use client';

import React, { useEffect } from 'react';
import { X } from 'lucide-react';

interface MediaViewerProps {
  url: string;
  type: 'image' | 'video';
  onClose: () => void;
}

/**
 * Fullscreen overlay for viewing photo/video (Telegram-style, not new tab).
 */
export function MediaViewer({ url, type, onClose }: MediaViewerProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/95 flex items-center justify-center"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Media viewer"
    >
      <button
        type="button"
        onClick={onClose}
        className="absolute top-4 right-4 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors z-10"
        aria-label="Close"
      >
        <X className="w-6 h-6" />
      </button>
      <div
        className="max-w-[90vw] max-h-[90vh] flex items-center justify-center"
        onClick={(e) => e.stopPropagation()}
      >
        {type === 'image' && (
          <img src={url} alt="" className="max-w-full max-h-[90vh] object-contain rounded-lg" />
        )}
        {type === 'video' && (
          <video
            src={url}
            controls
            autoPlay
            className="max-w-full max-h-[90vh] rounded-lg"
            onClick={(e) => e.stopPropagation()}
          />
        )}
      </div>
    </div>
  );
}
