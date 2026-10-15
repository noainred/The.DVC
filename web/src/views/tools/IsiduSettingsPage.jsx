/**
 * 설정 › 수집 서버 › 아이실론 디렉터리 사용량(v2.740) — 수집 대상 설정을 특수 기능 화면에서 설정 메뉴로 옮긴 자리.
 *
 * 사용자 요청(2026-10-15): "수집 대상 설정은 설정 메뉴로 이동해서 일반 사용자, 관리자는 못 보게" · "전체 설정 메뉴로 이동".
 *  · 슈퍼 관리자 전용이다. 메뉴는 Settings.jsx `superOnly` 가 숨기고, 서버 설정 API 는 `requireSuperAdmin`(403 super-admin-only)이 막는다.
 *    주소로 직접 들어온 관리자는 권한 안내를 본다(서버 403 을 ErrorBox 가 권한 안내로 바꾼다 — 오류처럼 보이지 않게).
 *  · 편집 화면은 IsiduSettings(개별 편집·일괄 변경) 한 벌이다 — 창으로 그리던 것을 `page` 로 그린다(사본을 만들지 않는다).
 *  · 대상 목록·엣지 키·이 노드 키는 메인 목록 응답(`/tools/isilon-dirusage`)에서 받는다 — 일괄 변경 표가 상태 칸을 그리는 데 쓴다.
 *    저장·일괄 적용 뒤에는 다시 읽는다. 폴링하지 않는다(설정 화면이다).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { fetchJson, isSuperAdminUser } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { hashSegments } from '../../hooks/hashTab.js';
import IsiduSettings from './IsiduSettings.jsx';
import { isiduSettingsTabOf } from './isiduSettingsLink.js';
import './isidu.css';

export default function IsiduSettingsPage() {
  // 첫 렌더에서 한 번만 읽는다 — 설정 화면의 하위 탭 동기화가 주소를 `#/settings/isilon-dirusage` 로 다시 쓸 수 있다.
  const [initialTab] = useState(() => isiduSettingsTabOf(hashSegments(typeof window === 'undefined' ? '' : window.location.hash)));
  const [main, setMain] = useState(null);
  const [err, setErr] = useState(null);
  const superAdmin = isSuperAdminUser();
  const load = useCallback(() => {
    let alive = true;
    fetchJson('/tools/isilon-dirusage').then((d) => { if (alive) { setMain(d); setErr(null); } }).catch((e) => { if (alive) setErr(e); });
    return () => { alive = false; };
  }, []);
  useEffect(() => (superAdmin ? load() : undefined), [superAdmin, load]);

  if (!superAdmin) {
    return <ErrorBox error={{ status: 403, requiredRole: ['super_admin'], message: '아이실론 수집 대상 설정은 슈퍼 관리자만 볼 수 있습니다.' }} />;
  }
  if (!main && err) return <ErrorBox error={err} />;
  if (!main) return <Loading />;
  return (
    <div>
      <div className="section-title" style={{ marginTop: 0 }}>아이실론 디렉터리 사용량 — 수집 대상 설정</div>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 12 }}>
        조사할 아이실론·디렉터리·주기·시한·결과 메일을 정합니다. 결과는 특수 기능 › 아이실론 디렉터리 사용량에서 봅니다. 이 설정은 슈퍼 관리자만 볼 수 있습니다.
      </div>
      {err ? <div className="isd-banner amber">대상 목록을 다시 읽지 못했습니다 — 직전 목록으로 보입니다. ({String(err?.message || err)})</div> : null}
      <IsiduSettings page onSaved={load} edges={main.edges} mainKey={main.key} rows={main.targets || []} initialTab={initialTab} />
    </div>
  );
}
