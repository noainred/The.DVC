// IpamHostName.jsx — IP 대장 '호스트명' 칸과 IP 상세 창의 '호스트명' 묶음(v2.991, 시안 docs/design/ip-scan-hostname ① ②).
// 문구 · 요약은 ipamHostText.js(순수), 판정(우선순위 · 이름 다름 · 지난 스캔 무응답)은 서버가 행 · 상세에 실어 보낸다.
import React from 'react';
import { fmtDt } from './ipamShared.jsx';
import { NAME_SRC, methodRows, methodStateText, mismatchTitle } from './ipamHostText.js';
import { dnsBadge, dnsDetailLine } from './ipamDnsText.js'; // v3.2.0 DNS 정합성(역DNS 이름의 정방향 확인)

/** 출처 배지(역DNS · mDNS · NetBIOS · 수동). 모르는 값이면 그리지 않는다. */
export function NameSrcBadge({ src, style }) {
  const m = NAME_SRC[src];
  if (!m) return null;
  return <span className={`badge ${m.tone}`} title={m.title} style={{ fontSize: 10, ...style }}>{m.label}</span>;
}

/** v3.2.0: 정방향 확인이 어긋났을 때만(DNS 다른 IP · 정방향 없음) — 일치 · 확인 못 함은 달지 않는다(요약 줄이 센다). */
export function DnsBadge({ r }) {
  const b = dnsBadge(r, fmtDt);
  return b ? <span className={`badge ${b.tone}`} style={{ fontSize: 10 }} title={b.title}>{b.label}</span> : null;
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
        <DnsBadge r={r} />
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

/** v3.2.0: 역DNS 줄 아래 정방향 결과(이름을 다시 물은 답 — 하루 동안 다시 쓰므로 확인 시각이 스캔 시각과 다를 수 있다). 확인하지 않았으면 그리지 않는다. */
function FwdLine({ d }) {
  const l = dnsDetailLine(d);
  if (!l) return null;
  return (
    <span className="flex" style={{ flex: '1 0 100%', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 8, rowGap: 2, fontSize: 12, marginTop: 2 }}>
      <span className="muted" style={{ flex: '0 0 auto' }}>↳ 정방향</span>
      <span style={{ flex: '1 1 180px', minWidth: 0, overflowWrap: 'anywhere', color: l.tone === 'amber' ? 'var(--amber)' : l.tone === 'green' ? 'var(--green)' : 'var(--text-dim)' }}>{l.text}</span>
      {l.at ? <span className="muted" style={{ flex: '0 0 auto' }} title="정방향 확인 결과는 설정한 기간(기본 24시간) 동안 다시 씁니다 — 스캔 시각과 다를 수 있습니다">{fmtDt(l.at)} 확인</span> : null}
    </span>
  );
}

/**
 * IP 상세 창의 '호스트명' 묶음 — 표시 이름 · 방식별 결과(서버 scanDetailOf) · '이름 다름' 안내 · NetBIOS 그룹 · '이름 직접 지정'.
 * v2.999: NetBIOS MAC 은 아래 'MAC · 제조사' 묶음(IpamMac.jsx MacBlock)으로 옮겼다(ARP MAC 과 함께 — 출처를 밝혀).
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
        // 방식 3줄 — 표가 아니라 줄바꿈되는 행(400px 에서 3열 표는 이름이 글자 단위로 끊기고 시각 열이 잘렸다 — Chromium 판독).
        <div role="list" aria-label="확인 방식별 결과" style={{ marginTop: 10, border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
          {rows.map((m, i) => (
            <div role="listitem" key={m.key} className="flex" style={{ flexWrap: 'wrap', alignItems: 'baseline', columnGap: 12, rowGap: 2, padding: '8px 12px', borderTop: i ? '1px solid rgba(36,48,73,.5)' : 'none' }}>
              <span style={{ flex: '0 0 150px', whiteSpace: 'nowrap' }}><NameSrcBadge src={m.key} /> <span className="muted" style={{ fontSize: 11 }}>{m.desc}</span></span>
              <span style={{ flex: '1 1 180px', minWidth: 0, overflowWrap: 'break-word' }}>
                {m.value ? <b>{m.value}</b> : <span className="muted">{methodStateText(m)}</span>}
                {m.key === 'netbios' && m.value && scan.nbGroup ? <span className="muted" style={{ fontSize: 12 }}> · 그룹 {scan.nbGroup}</span> : null}
                {m.state === 'stale' && <span className="muted" style={{ display: 'block', fontSize: 11 }}>{methodStateText(m, scan.nameMissMax)}</span>}
              </span>
              <span className="muted" style={{ flex: '0 0 auto', fontSize: 12 }}>{m.at ? fmtDt(m.at) : ''}</span>
              {m.key === 'dns' && m.value && <FwdLine d={scan.dnsFwd} />}
            </div>
          ))}
        </div>
      )}
      {alt && (
        <div className="banner warn" style={{ marginTop: 8, whiteSpace: 'normal' }}>
          방식마다 다른 이름을 답했습니다. DNS 레코드가 예전 장비를 가리키고 있을 수 있습니다 — 어느 쪽이 맞는지는 포탈이 판정하지 않습니다.
        </div>
      )}
    </div>
  );
}
