import React, { useEffect, useState } from 'react';

export function DownloadNotice() {
  const [notice, setNotice] = useState<{ success: boolean; path?: string | null; error?: string } | null>(null);
  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    void window.gitDigestDesktop?.onDownload?.(event => setNotice(event)).then(stop => {
      if (disposed) stop(); else unsubscribe = stop;
    }).catch(() => setNotice({ success: false, error: 'Download notifications are unavailable.' }));
    const links = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!(link instanceof HTMLAnchorElement) || !link.href.startsWith('https:') || !window.gitDigestDesktop?.openExternal) return;
      event.preventDefault();
      void window.gitDigestDesktop.openExternal(link.href).catch(() => setNotice({ success: false, error: 'Unable to open your browser. Please try again.' }));
    };
    document.addEventListener('click', links, true);
    return () => { disposed = true; unsubscribe?.(); document.removeEventListener('click', links, true); };
  }, []);
  if (!notice) return null;
  return <aside role="status" className="fixed bottom-4 right-4 left-4 sm:left-auto sm:max-w-xl z-50 rounded-xl border-2 border-amber-500 bg-[#161b22] p-4 text-sm text-white shadow-xl">
    <div className="flex items-start gap-4">
      <div className="min-w-0">
        <strong>{notice.error || (notice.success ? 'Download complete' : 'Download canceled or failed')}</strong>
        {notice.path && <p className="mt-1 break-all">Saved to: {notice.path}</p>}
        {notice.success && !notice.path && <p>Check the location selected in the download dialog.</p>}
        {notice.success && notice.path && window.gitDigestDesktop?.revealDownload && <button type="button" className="mt-2 text-amber-300 underline cursor-pointer" onClick={() => {
          void window.gitDigestDesktop!.revealDownload!(notice.path!).catch(() => setNotice({ ...notice, error: 'Unable to open the containing folder.' }));
        }}>Open containing folder</button>}
      </div>
      <button type="button" aria-label="Dismiss notification" className="ml-auto cursor-pointer" onClick={() => setNotice(null)}>✕</button>
    </div>
  </aside>;
}
