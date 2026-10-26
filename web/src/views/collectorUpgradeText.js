/**
 * views/collectorUpgradeText.js — 설정 › 수집 서버의 업그레이드 결과 문구(v2.775 — 사용자 보고 '수집서버 자동 업그레이드가 안되').
 * 예전 화면은 '업그레이드 실패' 만 빨갛게 보이고 이유·시각이 없었다(이유는 수동 버튼을 누른 직후 배너에만 나왔다). 서버가 준 값만 그린다.
 */
const fmt = (ms) => {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n); const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/**
 * 수집 서버 행의 업그레이드 결과(status.upgrade).
 * @returns {{ text:string, reason:string, tone:'ok'|'bad' }|null}
 */
export function upgradeCell(u) {
  if (!u || typeof u !== 'object') return null;
  const when = fmt(u.at);
  const tail = `${when ? ` · ${when}` : ''}${u.auto ? ' (자동)' : ''}`;
  if (u.ok === true) return { text: `업그레이드${u.version ? ` v${u.version}` : ''} 적용${tail}`, reason: '', tone: 'ok' };
  return { text: `업그레이드 실패${tail}`, reason: typeof u.reason === 'string' && u.reason ? u.reason : '사유를 받지 못했습니다', tone: 'bad' };
}

/**
 * 표 위 한 줄 — 마지막 자동 업그레이드에서 수집 서버로 보낸 결과(autoPush). 전부 성공이면 조용히(muted) 한 줄.
 * @returns {{ text:string, tone:'ok'|'warn'|'bad' }|null}
 */
export function autoPushLine(a) {
  if (!a || typeof a !== 'object') return null;
  const when = fmt(a.at);
  const head = `마지막 자동 업그레이드${when || a.version ? `(${[when, a.version ? `v${a.version}` : ''].filter(Boolean).join(' · ')})` : ''}`;
  if (a.skipped) return { text: `${head}: 수집 서버에 보내지 않았습니다 — ${a.skipped}`, tone: 'bad' };
  const total = Number(a.total) || 0; const ok = Number(a.ok) || 0;
  if (!total) return null;
  if (ok < total) return { text: `${head}: 수집 서버 ${ok}/${total} 성공 — 실패한 서버는 표의 버전 칸에 이유가 있습니다.`, tone: ok ? 'warn' : 'bad' };
  return { text: `${head}: 수집 서버 ${ok}/${total} 모두 받았습니다.`, tone: 'ok' };
}
