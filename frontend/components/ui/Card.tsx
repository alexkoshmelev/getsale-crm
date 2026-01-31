import { ReactNode } from 'react';
import { clsx } from 'clsx';

interface CardProps {
  children: ReactNode;
  className?: string;
  title?: string;
}

export function Card({ children, className, title }: CardProps) {
  return (
    <div
      className={clsx(
        'bg-card text-card-foreground rounded-xl border border-border shadow-soft p-6',
        'transition-shadow duration-200 hover:shadow-soft-md',
        className
      )}
    >
      {title && (
        <h3 className="font-heading text-lg font-semibold text-foreground tracking-tight mb-4">
          {title}
        </h3>
      )}
      {children}
    </div>
  );
}

