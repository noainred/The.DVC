// IpamHostName.jsx — IP 대장 '호스트명' 칸과 IP 상세 창의 '호스트명' 묶음(v2.991, 시안 docs/design/ip-scan-hostname ① ②).
// 문구 · 요약은 ipamHostText.js(순수), 판정(우선순위 · 이름 다름 · 지난 스캔 무응답)은 서버가 행 · 상세에 실어 보낸다.
import React from 'react';
import { STable } from '../../components/STable.jsx';
import { fmtDt } from './ipamShared.jsx';
import { NAME_SRC, methodRows, methodStateText, mismatchTitle } from './ipamHostText.js';

/** 출처 배지(역DNS · mDNS · NetBIOS · 수동). 모르는 값이면 그리지 않는다. */
export function NameSrcBadge({ src, style }) {
  const m = NAME_SRC[src];
  if (!m) return null;
  return <span className={`badge ${m.tone}`} title={m.title} style={{ fontSize: 10, ...style }}>{m.label}</span>;
}

/**
 * 목록의 호스트명 칸. 이름이 있으면 이름 + 출처 배지(+ 지난 스캔 무응답이면 확인 시각 · 방식마다 다르면 '이름 다름').
 * 스캔으로만 확인한 IP 에 이름이 없으면 '—' + (방식이 모두 꺼졌으면 '확인 안 함') + '+ 이름'(운영자 · 관리자 — 관리상태 편집의 호스트명 칸).
 */
export function HostNameCell({ r, canManage = false, onAdd }) {
  if (r?.netName) {
    return (
      <span className="flex" style={{ alignItems: 'center', gap: 6, flexWrap: 'nowrap' }}>
        <span style={r.netNameStale ? { color: 'var(--text-dim)' } : undefined}>{r.netName}</span>
        <NameSrcBadge src={r.netNameSrc} />
        {r.netNameStale && <span className="muted" style={{ fontSize: 11 }} title="지난 스캔에서 이 방식이 답하지 않았습니다 — 이 시각에 확인한 이름입니다">{fmtDt(r.netNameAt)} 확인</span>}
        {r.nameMismatch && <span className="badge amber" style={{ fontSize: 10 }} title={mismatchTitle(r.nameAlt)}>이름 다름</span>}
      </span>
    );
  }
  if (r?.ownerType !== 'scanned') return <span className="muted">—</span>;
  return (
    <span className="flex" style={{ alignItems: 'center', gap: 6, flexWrap: 'nowrap' }}>
      <span className="muted">—</span>
      {r.nameUnchecked && <span className="muted" style={{ fontSize: 11 }} title="이 IP 를 스캔한 에이전트는 호스트명 확인 방식(역DNS · mDNS · NetBIOS)이 모두 꺼져 있습니다 — 응답 없음과 다릅니다">확인 안 함</span>}
      {canManage && onAdd && (
        <button className="tab" style={{ padding: '1px 7px', fontSize: 11, border: '1px dashed var(--border)' }}
          title="이 IP 의 호스트명을 직접 넣습니다(IP 관리상태 편집 › 호스트명)" onClick={onAdd}>+ 이름</button>
      )}
    </span>
  );
}

/**
 * IP 상세 창의 '호스트명' 묶음 — 표시 이름 · 방식별 결과(서버 scanDetailOf) · '이름 다름' 안내 · NetBIOS 그룹/MAC · '이름 직접 지정'.
 * @param {{ row:object, scan:object|null|undefined, canManage?:boolean, onEditName?:Function }} props
 *   scan: undefined = 아직 모름(조회 중) · null = 스캔 결과 없음
 */
export function HostNameBlock({ row, scan, canManage = false, onEditName }) {
  const manual = row?.netNameSrc === 'manual' ? row.netName : '';
  const found = scan?.display?.name || '';
  const shown = manual || found;
  const src = manual ? 'manual' : (scan?.display?.src || '');
  const alt = Array.isArray(scan?.alt) && scan.alt.length ? scan.alt : null;
  const rows = methodRows(scan);
  return (
    <div className="card" style={{ padding: 12, marginBottom: 12, minWidth: 0 }}>
      <div className="flex between" style={{ alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div className="muted" style={{ fontSize: 12 }}>호스트명</div>
          <div className="flex" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 2 }}>
            <b style={{ fontSize: 16, overflowWrap: 'anywhere' }}>{shown || '—'}</b>
            <NameSrcBadge src={src} />
            {alt && <span className="badge amber" style={{ fontSize: 10 }} title={mismatchTitle(alt)}>이름 다름</span>}
          </div>
          {manual && found && manual !== found && (
            <div className="muted" style={{ fontSize: 12, marginTop: 4, overflowWrap: 'anywhere' }}>스캔이 찾은 이름은 {found}({NAME_SRC[scan.display.src]?.label || scan.display.src}) — 직접 넣은 이름이 먼저 보입니다.</div>
          )}
        </div>
        {canManage && onEditName && <button className="logout-btn" style={{ padding: '6px 12px', flex: 'none' }} onClick={onEditName}>이름 직접 지정</button>}
      </div>
      {scan === undefined ? (
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>방식별 결과를 읽는 중…</div>
      ) : scan === null ? (
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>이 IP 의 스캔 결과가 없습니다(스캔 대역 밖이거나, 스캔에 응답하지 않았거나, 보존 기간이 지났습니다) — 방식별 결과를 보일 수 없습니다.</div>
      ) : (
        <div className="table-wrap" style={{ marginTop: 10 }}>
          <STable minWidth={420} wrap={false}>
            <thead><tr><th>확인 방식</th><th>결과</th><th>확인 시각</th></tr></thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.key}>
                  <td data-sort={m.key}><NameSrcBadge src={m.key} /> <span className="muted" style={{ fontSize: 11 }}>{m.desc}</span></td>
                  <td data-sort={m.value || ''} style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
                    {m.value ? <b>{m.value}</b> : <span className="muted">{methodStateText(m)}</span>}
                    {m.key === 'netbios' && m.value && scan.nbGroup ? <span className="muted" style={{ fontSize: 12 }}> · 그룹 {scan.nbGroup}</span> : null}
                    {m.state === 'stale' && <div className="muted" style={{ fontSize: 11 }}>{methodStateText(m, scan.nameMissMax)}</div>}
                  </td>
                  <td className="muted" style={{ fontSize: 12 }} data-sort={m.at ?? ''}>{m.at ? fmtDt(m.at) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </STable>
        </div>
      )}
      {alt && (
        <div className="banner warn" style={{ marginTop: 8, whiteSpace: 'normal' }}>
          방식마다 다른 이름을 답했습니다. DNS 레코드가 예전 장비를 가리키고 있을 수 있습니다 — 어느 쪽이 맞는지는 포탈이 판정하지 않습니다.
        </div>
      )}
      {scan?.mac && (
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }} title="NetBIOS 노드 상태 응답에 실린 어댑터 MAC 입니다(어댑터가 여럿이면 그중 하나)">
          MAC <span style={{ fontFamily: 'var(--mono)' }}>{scan.mac}</span> <span style={{ fontSize: 11 }}>(NetBIOS 응답)</span>
        </div>
      )}
    </div>
  );
}
