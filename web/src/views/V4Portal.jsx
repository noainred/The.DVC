import React from 'react';
import { TOOLS } from './specialToolsList.js';
import { writeShell } from '../version_5/route.js';

/**
 * 설정 › 신규 포탈 보기 — 신규 포탈(version_4)로 들어가는 입구.
 * v2.490 에 V3(6화면)로 시작해 v2.508 에 V4 로 승격했다(UI 개편 시안 구현 · 화면 9개 · 모드 토글 · ⌘K).
 * 기존 개발 포탈 화면은 그대로 두고, V4 버튼을 누르면 해시 #/v4 로 전환된다
 * (App.jsx 가 첫 세그먼트 'v4' 를 신규 포탈로 해석하고, 옛 #/v3/* 는 #/v4/* 로 넘긴다).
 *
 * v2.616: V5 버튼을 더했다 — V5 는 새 라우터가 아니라 **기존 화면 위의 새 틀**이다(version_5/route.js).
 * 버튼은 #/v5 로 보내고 App 이 셸 플래그를 켠 뒤 #/overview 로 바꾼다. V4 는 그대로 둔다(사용자 선택 '둘 다 유지').
 */
const PAGES = [
  ['overview', '전사 현황'], ['compare', '법인 비교 · 용량'], ['power', '전력 · 비용 · 탄소'],
  ['compute', '컴퓨트'], ['storage', '스토리지'], ['network', '네트워크'],
  ['facility', '물리 · 설비'], ['alarms', '알람 센터'], ['tools', '기능 찾기'],
];

export default function V4Portal() {
  const open = () => { window.location.hash = '#/v4'; };
  const openNew = () => { window.open(`${window.location.pathname}#/v4`, '_blank', 'noopener'); };
  const openV5 = () => { writeShell(true); window.location.hash = '#/v5'; };
  const openV5New = () => { window.open(`${window.location.pathname}#/v5`, '_blank', 'noopener'); };
  return (
    <div>
      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>V5 (좌측 메뉴 틀)</div>
        <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.7, margin: '0 0 12px' }}>
          어두운 테마의 좌측 메뉴 틀입니다. 특수 기능 <b>{TOOLS.length}개</b>와 기존 메뉴를 <b>운영 관제 · 자산 · 용량·최적화 · 네트워크 · 보호·규정 · 자동화 · 보안 · 플랫폼 관리</b>로
          나눠 좌측에 넣었고, 기능은 <b>틀 안에서</b> 열립니다(주소는 기존과 같습니다 — 예: <code>#/vms</code>, <code>#/tools/storage-mon</code>).
          상단 검색으로 VM·IP·시리얼·알람·기능을 찾고, 상단 법인 선택이 인벤토리 화면과 특수 기능의 vCenter 범위에 함께 적용됩니다.
          V5 를 켜면 이 브라우저에 기억되고, 좌측 아래 <b>기존 화면으로</b> 버튼으로 끕니다.
        </p>
        <div className="flex gap wrap" style={{ alignItems: 'center', gap: 10 }}>
          <button className="login-btn" style={{ fontSize: 16, fontWeight: 800, padding: '10px 26px', letterSpacing: '.04em' }} onClick={openV5}>V5</button>
          <button className="tab" onClick={openV5New}>새 창에서 열기</button>
          <span className="muted" style={{ fontSize: 12 }}>주소: <code>#/v5</code></span>
        </div>
      </div>
      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>신규 포탈 (V4)</div>
        <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.7, margin: '0 0 12px' }}>
          UI 개편 시안(<code>Design/uiredesign/</code> 아트보드 8장)을 구현한 라이트 테마 화면입니다.
          좌측 내비에 <b>특수 기능 {TOOLS.length}개 + 개발 포탈 탭 + 신규 화면 9개</b>가 한 트리로 들어가 있고(미분류 0),
          상단에서 <b>경영 보기 ↔ 엔지니어 보기</b>를 전환하며, <b>⌘K / Ctrl+K</b> 로 기능을 바로 찾습니다.
          데이터는 기존 포탈과 같은 수집 API 를 그대로 읽고, 수집 항목이 없는 것(계약 전력·백본 회선·펌웨어 기준선·
          SLA/가용률·자원의 금액 환산)은 <b>그리지 않고 왜 없는지 화면에 적습니다</b>.
        </p>
        <div className="flex gap wrap" style={{ alignItems: 'center', gap: 10 }}>
          <button className="login-btn" style={{ fontSize: 16, fontWeight: 800, padding: '10px 26px', letterSpacing: '.04em' }} onClick={open}>V4</button>
          <button className="tab" onClick={openNew}>새 창에서 열기</button>
          <span className="muted" style={{ fontSize: 12 }}>주소: <code>#/v4</code></span>
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 10, lineHeight: 1.9 }}>
          화면별 주소: {PAGES.map(([k, l], i) => (
            <span key={k}>{i > 0 && ' · '}<code>{`#/v4/${k}`}</code> {l}</span>
          ))}
        </div>
      </div>
      <div className="card">
        <div style={{ fontWeight: 700, marginBottom: 6 }}>참고</div>
        <ul className="muted" style={{ fontSize: 12.5, lineHeight: 1.7, margin: 0, paddingLeft: 18 }}>
          <li><b>모드는 권한이 아닙니다.</b> ‘경영 보기 / 엔지니어 보기’ 는 표 행수·기간·원시 열·펼침을 바꿀 뿐,
            권한·데이터 범위·임계값(75/90%)은 두 모드가 같습니다. 패널 구성이 달라 호출하는 API 집합은 다를 수 있지만,
            모드를 바꿔서 볼 수 있는 데이터가 늘거나 줄지 않습니다. 선택은 브라우저에 저장되고 <code>?view=exec|eng</code> 로 덮어쓸 수 있습니다.</li>
          <li>권한이 없는 API 는 호출하지 않고(403 을 만들지 않습니다) 해당 패널에 <b>무엇이 필요한지</b>를 적습니다.
            <code>tools</code> 권한이 없는 계정은 용량·회수·추이 패널이 잠깁니다.</li>
          <li>기능(도구) 화면은 기존 개발 포탈(<code>#/tools/&lt;키&gt;</code>)에서 열립니다 — 그 키는 권한 설정(<code>toolsDenied</code>)과
            북마크가 쓰는 값이라 메뉴 이름이 바뀌어도 그대로입니다.</li>
          <li>이전 주소 <code>#/v3</code> · <code>#/v3/&lt;화면&gt;</code> 로 들어오면 <code>#/v4</code> 로 자동 이동합니다 — 저장해 둔 북마크가 죽지 않습니다.</li>
          <li>글꼴: 시안은 Pretendard·JetBrains Mono 를 쓰지만 오프라인 포탈은 CDN 을 쓸 수 없어, 서버/PC 에 설치된 글꼴이 있으면 그것을, 없으면 시스템 글꼴을 씁니다.</li>
          <li>신규 포탈 코드는 <code>web/src/version_4/</code> 에 분리되어 있어 기존 화면(<code>web/src/views</code>)과 섞이지 않습니다.</li>
        </ul>
      </div>
    </div>
  );
}
