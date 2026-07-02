// 구형 브라우저 폴리필(업데이트가 막힌 관리 단말의 Chrome<98/<103 대응) — 반드시 앱보다 먼저.
// structuredClone(Chrome 98+): 관리 화면 폼 초기화에 사용(플레인 JSON 객체만 복제 → JSON 폴백 안전).
if (typeof globalThis.structuredClone !== 'function') {
  globalThis.structuredClone = (o) => (o === undefined ? o : JSON.parse(JSON.stringify(o)));
}
// AbortSignal.timeout(Chrome 103+)은 api.js에서 기능 감지로 폴백 처리됨.

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
