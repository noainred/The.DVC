import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';
import { registerPwa, startAlertNotifications } from './pwa.js';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// PWA: 서비스워커 등록(설치 가능) + 위험 인시던트 브라우저 알림 폴링.
registerPwa();
startAlertNotifications();
