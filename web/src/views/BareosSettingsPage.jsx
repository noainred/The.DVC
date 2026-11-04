/**
 * 설정 › 🖥️ vCenter 관리 › Bareos 백업 서버(v2.878 — 사용자 요청 'Bareos 의 설정을 전체 메뉴 설정으로 위치 변경 · B안').
 *   예전 자리는 Backup › Bareos 탭 줄의 '설정'(#/tools/bareos-backup/settings)이었다. 화면 본문(Director · 완전 설치 · 법인별 설정 ·
 *   계정 통합 · 공통 기본값)은 BareosSettings.jsx 그대로이고, 구획 주소만 #/settings/bareos/<구획> 으로 바뀌었다.
 *   API 와 권한은 그대로다 — /api/tools/bareos-backup/settings… 는 adminOnly · fullScopeOnly(서버가 집행), 도구 키 bareos-backup 권한도 그대로 본다.
 *   Bareos 도구 화면이 10초마다 읽던 상태(GET /tools/bareos-backup)는 여기서는 들어올 때 1번 + 저장 뒤에만 읽는다(설정 화면은 실행 현황판이 아니다).
 */
import React, { useEffect, useRef, useState } from 'react';
import { fetchJson, getCurrentUser, toolAllowed } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';
import BoldText from '../components/boldText.jsx';
import SettingsTab from './tools/BareosSettings.jsx';
import { Note, Dot } from './tools/BareosBits.jsx';
import { directorLine } from './tools/bareosText.js';

export default function BareosSettingsPage() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const gen = useRef(0);
  const me = getCurrentUser();
  const fullScope = !me?.scope || (!(me.scope.vcenters || []).length && !(me.scope.regions || []).length);
  const allowed = toolAllowed('bareos-backup') && fullScope;
  const load = () => {
    const g = ++gen.current;
    fetchJson('/tools/bareos-backup').then((d) => { if (g === gen.current) { setData(d); setErr(null); } })
      .catch((e) => { if (g === gen.current) setErr(e); });   // 늦게 온 이전 응답은 버린다
  };
  useEffect(() => { if (allowed) load(); }, [allowed]);

  if (!toolAllowed('bareos-backup')) return <div className="muted" style={{ padding: 16 }}>Bareos 백업 기능 권한이 없는 계정입니다.</div>;
  if (!fullScope) return <div className="muted" style={{ padding: 16 }}>Bareos Director 설정은 전체 범위 관리자만 볼 수 있습니다 — Backup › Bareos › 운영을 쓰세요.</div>;
  if (err && !data) return <ErrorBox error={err} />;
  if (!data) return <Loading />;
  const dirTone = data.demo ? 'warn' : data.configured && data.poller?.ok !== false && !(data.directors || []).some((x) => x.authStopped) ? 'ok' : 'bad';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
      <div className="muted" style={{ fontSize: 13, overflowWrap: 'anywhere' }}>
        법인마다 Director 를 등록하고 vCenter 를 묶습니다. 설치 · 법인별 설정 · 계정은 왼쪽 목록에서 고릅니다(전체 범위 관리자). 백업 실행 · 복원은 Backup › Bareos › 운영에서 합니다.
      </div>
      {err && <Note>최근 다시 읽기에 실패했습니다 — 아래는 마지막으로 받은 내용입니다({String(err.message || err).slice(0, 160)}).</Note>}
      {!data.demo && (
        <div data-bareos-dirline="" style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12.5, lineHeight: 1.6, color: dirTone === 'bad' ? '#fca5a5' : 'var(--text-dim)' }}>
          <span style={{ marginTop: 5 }}><Dot color={dirTone === 'ok' ? '#4ade80' : '#f87171'} /></span>
          <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}><BoldText text={directorLine(data)} /></span>
        </div>
      )}
      {data.settingsLoadError && <Note tone="bad">설정 파일을 읽지 못했습니다(손상본 보존) — {data.settingsLoadError.reason}</Note>}
      {data.registryLoadError && <Note tone="bad">백업 대상 원장을 읽지 못했습니다(손상본 보존 — 새 대상 추가를 막았습니다) — {data.registryLoadError.reason}</Note>}
      <SettingsTab onSaved={load} writable={data.settingsWritable !== false} />
    </div>
  );
}
