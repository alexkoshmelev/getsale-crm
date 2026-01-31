'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { clsx } from 'clsx';

interface PaginationProps {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  className?: string;
}

export function Pagination({ page, totalPages, onPageChange, className }: PaginationProps) {
  if (totalPages <= 1) return null;

  const showPages = 5;
  let start = Math.max(1, page - Math.floor(showPages / 2));
  let end = Math.min(totalPages, start + showPages - 1);
  if (end - start + 1 < showPages) start = Math.max(1, end - showPages + 1);
  const pages = Array.from({ length: end - start + 1 }, (_, i) => start + i);

  return (
    <nav
      className={clsx('flex items-center justify-center gap-1', className)}
      aria-label="Пагинация"
    >
      <button
        type="button"
        onClick={() => onPageChange(page - 1)}
        disabled={page <= 1}
        className="p-2 rounded-lg border border-border text-foreground hover:bg-accent disabled:opacity-50 disabled:pointer-events-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        aria-label="Предыдущая страница"
      >
        <ChevronLeft className="w-5 h-5" />
      </button>
      <div className="flex items-center gap-1">
        {start > 1 && (
          <>
            <PageButton page={1} current={page} onPageChange={onPageChange} />
            {start > 2 && <span className="px-2 text-muted-foreground">…</span>}
          </>
        )}
        {pages.map((p) => (
          <PageButton key={p} page={p} current={page} onPageChange={onPageChange} />
        ))}
        {end < totalPages && (
          <>
            {end < totalPages - 1 && <span className="px-2 text-muted-foreground">…</span>}
            <PageButton page={totalPages} current={page} onPageChange={onPageChange} />
          </>
        )}
      </div>
      <button
        type="button"
        onClick={() => onPageChange(page + 1)}
        disabled={page >= totalPages}
        className="p-2 rounded-lg border border-border text-foreground hover:bg-accent disabled:opacity-50 disabled:pointer-events-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        aria-label="Следующая страница"
      >
        <ChevronRight className="w-5 h-5" />
      </button>
    </nav>
  );
}

function PageButton({
  page,
  current,
  onPageChange,
}: {
  page: number;
  current: number;
  onPageChange: (p: number) => void;
}) {
  const isCurrent = page === current;
  return (
    <button
      type="button"
      onClick={() => onPageChange(page)}
      className={clsx(
        'min-w-[2.25rem] h-9 px-3 rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        isCurrent
          ? 'bg-primary text-primary-foreground'
          : 'border border-border text-foreground hover:bg-accent'
      )}
      aria-current={isCurrent ? 'page' : undefined}
    >
      {page}
    </button>
  );
}
