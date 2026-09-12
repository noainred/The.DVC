import React from 'react';

/**
 * 설정 › 신규 포탈 보기(v2.490) — version_3(신규 포탈, Claude Design 'DVC Console' 아트보드 구현)로 들어가는 입구.
 * 기존 화면은 개발용으로 그대로 두고, V3 버튼을 누르면 해시 #/v3 로 전환된다(App.jsx 가 첫 세그먼트 'v3' 를 신규 포탈로 해석).
 */
export default function V3Portal() {
  const open = () => { window.location.hash = '#/v3'; };
  const openNew = () => { window.open(`${window.location.pathname}#/v3`, '_blank', 'noopener'); };
  return (
    <div>
      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>신규 포탈 (V3)</div>
        <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.7, margin: '0 0 12px' }}>
          Claude Design 으로 만든 <b>DVC Console</b> 시안을 그대로 옮긴 새 화면입니다(라이트 테마 · 좌측 8도메인 내비 · 전사 현황/컴퓨트/스토리지/네트워크/물리·설비/알람 센터 6화면).
          데이터는 기존 포탈과 같은 수집 API 를 그대로 읽으며, 수집 항목이 없는 것(백본 회선·계약 전력·펌웨어 기준선)은 '수집 없음' 으로 표시합니다.
          기존 화면은 개발용으로 그대로 남아 있고, 신규 포탈 안의 '개발 포탈 ↗' 버튼이나 내비의 화면 없는 항목으로 언제든 돌아올 수 있습니다.
        </p>
        <div className="flex gap wrap" style={{ alignItems: 'center', gap: 10 }}>
          <button className="login-btn" style={{ fontSize: 16, fontWeight: 800, padding: '10px 26px', letterSpacing: '.04em' }} onClick={open}>V3</button>
          <button className="tab" onClick={openNew}>새 창에서 열기</button>
          <span className="muted" style={{ fontSize: 12 }}>주소: <code>#/v3</code> · 화면별 <code>#/v3/overview</code> · <code>#/v3/compute</code> · <code>#/v3/storage</code> · <code>#/v3/network</code> · <code>#/v3/facility</code> · <code>#/v3/alarms</code></span>
        </div>
      </div>
      <div className="card">
        <div style={{ fontWeight: 700, marginBottom: 6 }}>참고</div>
        <ul className="muted" style={{ fontSize: 12.5, lineHeight: 1.7, margin: 0, paddingLeft: 18 }}>
          <li>사용률(%)·알람·전력은 기존 포탈과 같은 API(/overview·/alarms·/nsx·/datastores 등)를 읽습니다. 권한이 없는 API 는 호출하지 않고 안내만 표시합니다.</li>
          <li>글꼴: 시안은 Pretendard·JetBrains Mono 를 외부 CDN 에서 받지만 오프라인 포탈은 CDN 을 쓸 수 없어, 서버/PC 에 설치된 글꼴이 있으면 그것을, 없으면 시스템 글꼴을 씁니다.</li>
          <li>신규 포탈 코드는 <code>web/src/version_3/</code> 에 분리되어 있어 기존 화면(<code>web/src/views</code>, <code>web/src/console</code>)과 섞이지 않습니다.</li>
        </ul>
      </div>
    </div>
  );
}
