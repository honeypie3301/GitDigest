import { initializeCredentials } from './services/credentials';
import { createRoot } from 'react-dom/client';
import App from './App';
import { DownloadNotice } from './components/DownloadNotice';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';

async function start() {
  let credentialError = '';
  try { await initializeCredentials(); }
  catch { credentialError = 'Saved credentials could not be loaded. Configure your GitHub token again to access private repositories.'; }
  createRoot(document.getElementById('root')!).render(
    <ErrorBoundary>
      {credentialError && <p role="alert" className="bg-red-950 p-3 text-sm text-red-200">{credentialError}</p>}
      <DownloadNotice />
      <App />
    </ErrorBoundary>
  );
}
void start();
