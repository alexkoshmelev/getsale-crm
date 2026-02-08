'use client';

import React from 'react';

const URL_REGEX = /(https?:\/\/[^\s<>\]\)]+)/gi;

interface LinkifyTextProps {
  text: string;
  className?: string;
}

/**
 * Renders text with URLs as clickable links (Telegram-style).
 */
export function LinkifyText({ text, className = '' }: LinkifyTextProps) {
  const parts = text.split(URL_REGEX);
  return (
    <span className={className}>
      {parts.map((part, i) =>
        /^https?:\/\//i.test(part) ? (
          <a
            key={i}
            href={part}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline hover:opacity-90 break-all"
          >
            {part}
          </a>
        ) : (
          <React.Fragment key={i}>{part}</React.Fragment>
        )
      )}
    </span>
  );
}
