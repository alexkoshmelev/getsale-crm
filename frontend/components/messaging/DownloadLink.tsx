'use client';

import React, { useState } from 'react';

interface DownloadLinkProps {
  url: string;
  className?: string;
  downloadLabel?: string;
}

function DownloadLinkInner({ url, className, downloadLabel = 'Download' }: DownloadLinkProps) {
  const [loading, setLoading] = useState(false);

  const handleClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    if (loading) return;
    setLoading(true);
    try {
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to download');
      const blob = await res.blob();
      const u = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = u;
      a.download = 'document';
      a.click();
      URL.revokeObjectURL(u);
    } catch (_) {
      window.open(url, '_blank');
    } finally {
      setLoading(false);
    }
  };

  return (
    <button type="button" onClick={handleClick} className={className} disabled={loading}>
      {loading ? '…' : downloadLabel}
    </button>
  );
}

export const DownloadLink = React.memo(DownloadLinkInner);
