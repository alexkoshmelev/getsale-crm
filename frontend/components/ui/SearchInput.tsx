'use client';

import { Search } from 'lucide-react';
import { InputHTMLAttributes, useId } from 'react';
import { clsx } from 'clsx';

interface SearchInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: string;
  onClear?: () => void;
}

export function SearchInput({ label, className, id: idProp, onClear, ...props }: SearchInputProps) {
  const id = useId();
  const inputId = idProp ?? id;
  return (
    <div className="relative w-full">
      {label && (
        <label htmlFor={inputId} className="sr-only">
          {label}
        </label>
      )}
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground pointer-events-none" />
      <input
        type="search"
        id={inputId}
        className={clsx(
          'w-full pl-10 pr-4 py-2.5 rounded-lg border border-input bg-background text-foreground placeholder:text-muted-foreground',
          'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-0 focus:border-transparent',
          'hover:border-input/80 transition-colors duration-150',
          className
        )}
        aria-label={label ?? 'Поиск'}
        {...props}
      />
    </div>
  );
}
