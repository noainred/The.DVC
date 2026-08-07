import React, { useState } from 'react';
import { getCurrentUser } from '../api.js';
import CsvTab from './svcmon/CsvTab.jsx';
import TemplateTab from './svcmon/TemplateTab.jsx';
import BulkTab from './svcmon/BulkTab.jsx';

/**
 * 성능점검 설정 — 특수 기능 > '성능점검 설정' 카드로 들어온다.
 *
 * 서브탭을 처음부터 **별 파일**로 쪼갠 이유: 한 파일에 세 화면의 상태를 모으면 조기 return
 * 뒤에 useState 를 추가하기 쉬워지고, 그러면 렌더 간 훅 개수가 달라져 React #310 으로
 * 화면 전체가 크래시한다(v2.202 사용자 관리에서 실제 발생 → v2.203 긴급 수정).
 *
 * 도구 키는 `svcmon-config` 로 고정한다 — 권한 매트릭스(`permissions.json toolsDenied`)에
 * 문자열로 영구 저장되므로 릴리스 후 이름을 바꾸면 옛 키는 어떤 도구와도 매칭되지 않고
 * 새 키는 거부목록에 없어 **자동 허용**된다(권한이 조용히 넓어지는 회귀).
 */

const TABS = [
  { k: 'tpl', label: '점검 템플릿', desc: '서버 유형별 점검 묶음을 정의하고 대상에 한꺼번에 적용합니다.' },
  { k: 'bulk', label: '대량 자동등록', desc: '이름 규칙({n})과 IP 범위로 대상을 만들고 템플릿을 자동 할당합니다.' },
  { k: 'csv', label: '가져오기 · 내보내기', desc: 'CSV 로 대상·점검을 한꺼번에 등록하거나 현재 목록을 내려받습니다.' },
];

/** 트리 우클릭에서 넘어온 1회용 프리필(경로·구분). 읽고 바로 지운다. */
function takePrefill() {
  try {
    const raw = sessionStorage.getItem('svcmon.prefill');
    if (!raw) return null;
    sessionStorage.removeItem('svcmon.prefill');
    return JSON.parse(raw);
  } catch { return null; }
}

export default function SvcMonConfig() {
  const me = getCurrentUser();
  const canEdit = me?.role === 'admin' || me?.role === 'operator';
  // 프리필은 최초 렌더에서 1회만 읽는다(리렌더마다 읽으면 sessionStorage 를 이미 비운 뒤라 사라진다).
  const [prefill] = useState(takePrefill);
  const [tab, setTab] = useState(() => (prefill?.tab && TABS.some((t) => t.k === prefill.tab) ? prefill.tab : TABS[0].k));
  const cur = TABS.find((t) => t.k === tab) || TABS[0];

  return (
    <div className="flex col gap">
      <div className="card" style={{ padding: 12 }}>
        <div className="flex gap wrap" style={{ alignItems: 'center' }}>
          {TABS.map((t) => (
            <button key={t.k} className={tab === t.k ? 'login-btn' : 'tab'} onClick={() => setTab(t.k)}>{t.label}</button>
          ))}
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>{cur.desc}</div>
        {!canEdit && (
          <div className="svc-warn" style={{ marginTop: 8 }}>
            조회만 가능합니다 — 변경은 operator 이상 권한이 필요합니다.
          </div>
        )}
      </div>

      {tab === 'tpl' && <TemplateTab canEdit={canEdit} />}
      {tab === 'bulk' && <BulkTab canEdit={canEdit} prefill={prefill?.spec || null} />}
      {tab === 'csv' && <CsvTab canEdit={canEdit} />}
    </div>
  );
}
