import React from 'react';
import { usePolling } from '../../api.js';
import { TOOLS } from '../../views/specialToolsList.js';
import STable from '../../components/STable.jsx';
import { resolveMenu, menuById, SEG_INFO } from '../menus.js';
import { menuHash } from '../route.js';
import { serverSegments, serverCorpRows } from '../v6Data.js';
import { corpTotalLabel } from '../../views/corpSiteStatus.js'; // v2.631(감사 WEB2631-03)
import { unplacedRows, corpNoteText } from '../../views/overviewServerText.js';

/**
 * V6 메뉴 페이지(`#/m/<id>`, v2.623) — 상위 메뉴 하나의 화면·기능 카드 그리드. 카드를 누르면 기존 주소
 * (`#/<탭>` · `#/tools/<k>`)로 간다 — 도구 키는 그대로다(권한 설정·딥링크·서버 집행 매핑).
 * 서버 메뉴는 핸드오프대로 물리 서버·가상화 호스트·가상화 서버 구분 카드 + 산식 안내 + (전체일 때) 법인별 서버 구분 표를 더한다.
 * /overview 는 **서버 메뉴에서만** 부른다(다른 메뉴는 폴링 0).
 */
const BADGE = {
  screen: ['화면', 'v6-b-screen'], admin: ['관리자', 'v6-b-admin'], soon: ['준비 중', 'v6-b-soon'],
  danger: ['위험', 'v6-b-danger'], external: ['새 탭', 'v6-b-ext'],
};
const fmt = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toLocaleString('en-US'));

function Card({ it }) {
  const b = it.badge ? BADGE[it.badge] : null;
  const dim = it.locked || it.comingSoon;
  const cls = `v6-card${it.danger ? ' danger' : ''}${dim ? ' dim' : ''}`;
  const tail = it.locked ? '🔒 권한 없음' : it.comingSoon ? '' : it.href ? '새 탭 ↗' : '열기 →';
  const body = (
    <>
      <div className="v6-card-head">
        <span className="v6-card-icon" aria-hidden="true">{it.icon}</span>
        <span className="v6-card-label">{it.label}</span>
        {b && <span className={`v6-badge-s ${b[1]}`}>{b[0]}</span>}
      </div>
      <div className="v6-card-desc">{it.desc}</div>
      <div className="v6-card-foot"><code>{it.href ? '외부 포탈' : it.hash}</code><span>{tail}</span></div>
    </>
  );
  if (it.locked) return <div className={cls} aria-disabled="true" title={it.lockReason || undefined}>{body}</div>;
  if (it.href) return <a className={cls} href={it.href} target="_blank" rel="noopener noreferrer">{body}</a>;
  return <a className={cls} href={it.hash} title={it.comingSoon ? '준비 중인 기능입니다' : undefined}>{body}</a>;
}

function ServerExtras({ seg }) {
  const { data: ov, error } = usePolling('/overview', {}, 30_000);
  if (!ov) return <div className="v6-note">{error ? `서버 집계를 불러오지 못했습니다: ${error}` : '서버 집계 불러오는 중…'}</div>;
  const s = serverSegments(ov);
  const pbc = ov.physicalByCorp && !ov.physicalByCorp.error ? ov.physicalByCorp : null;
  const rows = serverCorpRows(ov);
  const extra = pbc ? unplacedRows(pbc) : [];
  const sum = (k) => { const v = rows.map((r) => r[k]).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) : null; };
  return (
    <>
      <div className="v6-segs">
        {['phys', 'host', 'vm'].map((k) => {
          const info = SEG_INFO[k];
          const on = seg === k;
          return (
            <a key={k} className={`v6-seg-card${on ? ' on' : ''}`} href={on ? menuHash('server') : menuHash('server', k)} style={{ '--seg': info.color }}
              title={on ? '다시 누르면 구분 해제' : `${info.label}만 보기`}>
              <div className="v6-seg-code">{info.code}</div>
              <div className="v6-seg-label">{info.label}</div>
              <div className="v6-seg-value">{fmt(s[k].value)}</div>
              <div className="v6-seg-sub">{s[k].sub || info.note}</div>
            </a>
          );
        })}
      </div>
      <div className="v6-formula">
        서버 합계 <b>{fmt(s.union)}</b> = 물리 전용 + 가상화 호스트 — iDRAC 와 ESXi 에서 같은 장비로 확인된 것은 한 번만 셉니다(이름·서비스태그가 맞지 않으면 못 찾을 수 있습니다). 가상화 서버(VM)는 합계에 넣지 않습니다.
        {s.error && <span className="v6-warn"> · 물리 서버 집계 실패: {s.error}</span>}
      </div>
      <div className="v6-segbar" role="tablist" aria-label="서버 구분">
        {[['', '전체'], ['phys', '물리 서버'], ['host', '가상화 호스트'], ['vm', '가상화 서버']].map(([k, l]) => (
          <a key={k || 'all'} role="tab" aria-selected={seg === k} className={`v6-segbtn${seg === k ? ' on' : ''}`} href={menuHash('server', k)}>{l}</a>
        ))}
      </div>
      {!seg && (
        <div className="v6-panel">
          <div className="v6-panel-head"><b>법인별 서버 구분</b><span>{pbc ? corpNoteText(pbc) : '물리 서버 귀속 정보를 불러오지 못했습니다'}</span></div>
          <STable className="v6-table" minWidth={720}>
            <thead><tr><th>법인</th><th className="right">물리 전용</th><th className="right">가상화 호스트</th><th className="right">서버 합계</th><th className="right">가상화 서버</th><th className="right">구동중</th><th className="right">호스트당 VM</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}><td>{r.name}{r.mark && <span className="v6-warn" style={{ marginLeft: 6, fontSize: 11 }} title={r.markTitle || undefined}>{r.mark}</span>}</td><td className="right">{fmt(r.physOnly)}</td><td className="right">{fmt(r.hosts)}</td><td className="right"><b>{fmt(r.total)}</b></td>
                  <td className="right">{fmt(r.vms)}</td><td className="right">{fmt(r.vmsOn)}</td><td className="right">{r.perHost == null ? '—' : r.perHost}</td></tr>
              ))}
              {extra.map((r) => (
                <tr key={r.id} data-pin title={r.title}><td className="muted">{r.name}</td><td className="right">{fmt(r.physOnly)}</td><td className="right">—</td><td className="right"><b>{fmt(r.total)}</b></td><td className="right">—</td><td className="right">—</td><td className="right">—</td></tr>
              ))}
              <tr data-pin className="v6-total"><td title={corpTotalLabel(rows) !== '합계' ? '첫 수집 중·연결 실패·비활성 vCenter 는 호스트·VM 을 모르므로 합계에 넣지 않았습니다' : undefined}>{corpTotalLabel(rows)}</td><td className="right">{fmt(sum('physOnly') == null ? null : sum('physOnly') + extra.reduce((a, r) => a + (r.physOnly || 0), 0))}</td>
                <td className="right">{fmt(sum('hosts'))}</td><td className="right">{fmt(sum('total') == null ? null : sum('total') + extra.reduce((a, r) => a + (r.total || 0), 0))}</td>
                <td className="right">{fmt(sum('vms'))}</td><td className="right">{fmt(sum('vmsOn'))}</td><td className="right">—</td></tr>
            </tbody>
          </STable>
        </div>
      )}
    </>
  );
}

export default function MenuPage({ menuId, seg = '', opts }) {
  const m = resolveMenu(menuById(menuId), TOOLS, opts);
  if (!m) {
    return <div className="v6-panel"><b>없는 메뉴입니다</b><div className="v6-note">주소 ‘#/m/{menuId}’ 에 해당하는 메뉴가 없습니다. 왼쪽 메뉴에서 고르세요.</div></div>;
  }
  const groups = m.id === 'server' && seg ? m.groups.filter((g) => g.seg === seg) : m.groups;
  return (
    <div className="v6-menu">
      <div className="v6-menu-head">
        <div>
          <div className="v6-menu-code">{m.code}</div>
          <h1>{m.label}</h1>
          <div className="v6-menu-desc">{m.desc}</div>
        </div>
        <div className="v6-menu-count">화면 <b>{m.screens}</b> · 기능 <b>{m.tools}</b></div>
      </div>
      {m.id === 'server' && <ServerExtras seg={seg} />}
      {m.count === 0 && <div className="v6-note">이 계정에 보이는 항목이 없습니다.</div>}
      {groups.map((g, gi) => (
        <section key={g.name} className="v6-group" id={`v6-g-${gi}`} style={g.seg ? { '--gc': SEG_INFO[g.seg].color } : undefined}>
          <div className="v6-group-head"><i /><b>{g.name}</b><span>{g.items.length}</span><hr /></div>
          <div className="v6-cards">{g.items.map((it) => <Card key={it.key} it={it} />)}</div>
        </section>
      ))}
    </div>
  );
}
