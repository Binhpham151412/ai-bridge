import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './components/App.tsx';
import { BridgeProvider } from './state/BridgeProvider.tsx';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <BridgeProvider api={window.aiBridge}>
        <App />
      </BridgeProvider>
    </StrictMode>,
  );
}
