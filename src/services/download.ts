export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  try { link.click(); }
  finally {
    link.remove();
    // WebView2 may start consuming the blob after the click handler returns.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
