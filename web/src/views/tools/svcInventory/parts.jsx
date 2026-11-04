/**
 * 서비스 인벤토리 화면 부품(v2.885) — 칸 표시·구성원/영향 호스트 패널. 판정은 서버가 하고 여기는 그리기만 한다.
 */
import React, { useEffect, useRef, useState } from 'react';
import { fetchJson } from '../../../api.js';
import { STable } from '../../../components/STable.jsx';
import { Loading, ErrorBox } from '../../../components/ui.jsx';
import { SRC_LABEL, SRC_SHORT, SRC_BADGE, REASON_TEXT, pctText, numText, faultsView, backupView, srcSummary, FAULT_REASON } from '../svcInventoryText.js';

export function UsageBar({ v, w = 56 }) {
  if (v == null) return <span className="muted">—</span>;
  const tone = v >= 90 ? 'var(--red)' : v >= 75 ? 'var(--amber)' : 'var(--accent)';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }} data-sort={v}>
      <span style={{ display: 'inline-block', width: w, height: 7, borderRadius: 4, background: 'var(--panel-2)', overflow: 'hidden' }}>
        <span style={{ display: 'block', height: '100%', width: `${Math.max(0, Math.min(100, v))}%`, background: tone }} />
      </span>
      {pctText(v)}
    </span>
  );
}

/** 사용률 한 칸 — CPU·메모리 두 줄(+못 읽음·오래됨). 열을 줄이려고 합쳤다(1440px 실측 — 따로 두면 뒤쪽 열이 가로 스크롤 뒤로 숨는다). */
export function UsagePair({ cpu, mem, missing = 0 }) {
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, fontSize: 12 }}>
      <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}><span className="muted" style={{ width: 26 }}>CPU</span><UsageBar v={cpu} w={36} /></span>
      <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}><span className="muted" style={{ width: 26 }}>MEM</span><UsageBar v={mem} w={36} /></span>
      {missing ? <span className="badge amber" style={{ alignSelf: 'flex-start' }} title="사용률을 못 읽었거나 오래된 서버 — 합산에서 뺐습니다">못 읽음 {missing}</span> : null}
    </span>
  );
}
/** 구성원 수 한 칸 — 'VM 21 · BM 1' + '호스트 20 · 켜짐 19/22'. */
export function MemberCount({ st }) {
  const known = (st.power?.on || 0) + (st.power?.off || 0);
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, whiteSpace: 'nowrap' }}>
      <span><b>VM {st.n.vm}</b><span className="muted"> · </span><b>BM {st.n.bm}</b></span>
      <span className="muted" style={{ fontSize: 11 }} title={`호스트 = 구성원 VM 이 올라간 ESXi 호스트 수(파생) · 켜짐 = 켜짐/전원을 아는 구성원${st.power?.unknown ? ` · 전원 모름 ${st.power.unknown}` : ''}`}>호스트 {st.hosts} · 켜짐 {st.power?.on || 0}/{known}{st.power?.unknown ? '*' : ''}</span>
    </span>
  );
}

export function TierBadge({ tier }) {
  const cls = tier === 1 ? 'red' : tier === 3 ? 'gray' : 'amber';
  return <span className={`badge ${cls}`} title={`등급 ${tier}`} style={{ minWidth: 18, justifyContent: 'center' }}>{tier}</span>;
}

/** 부품 장애 칸 — 구성원 장애 + (영향 호스트 장애, 공유). 기능 꺼짐·못 읽음이면 '—'. */
export function FaultCell({ f, meta, stale }) {
  const v = faultsView(f, meta?.available);
  if (stale) return <span className="muted" title="엣지 보고가 오래되어 장애 수를 모릅니다">—</span>;
  if (!v) return <span className="muted" title={FAULT_REASON[meta?.reason] || '장애 수를 모릅니다'}>—</span>;
  return (
    <span style={{ whiteSpace: 'nowrap' }} title={`구성원 장애 ${v.member} · 영향 호스트 장애 ${v.host}(다른 서비스와 공유)${v.unknown ? ` · 모름 ${v.unknown}` : ''}`}>
      {v.member ? <span className="badge red">{v.member}</span> : <span className="muted">0</span>}
      {v.host ? <span className="muted" style={{ marginLeft: 4, fontSize: 11 }}>+{v.host}h</span> : null}
    </span>
  );
}

export function BackupCell({ b, meta }) {
  const v = backupView(b, meta);
  if (!v) return <span className="muted" title="Bareos 백업을 쓰지 않습니다">해당 없음</span>;
  if (v.unknown === true) return <span className="muted" title="Bareos 원장을 읽지 못했습니다">모름</span>;
  return (
    <span style={{ display: 'inline-flex', gap: 4, whiteSpace: 'nowrap' }}>
      {v.ok ? <span className="badge green" title="24시간 안에 성공">{v.ok}</span> : null}
      {v.fail ? <span className="badge red" title="실패 또는 24시간 넘게 성공 없음">{v.fail}</span> : null}
      {v.none ? <span className="badge gray" title="잡 없음">잡 없음 {v.none}</span> : null}
      {!v.ok && !v.fail && !v.none ? <span className="muted">—</span> : null}
    </span>
  );
}

export function SrcCell({ src }) {
  const list = srcSummary(src);
  if (!list.length) return <span className="muted">—</span>;
  return (
    <span style={{ whiteSpace: 'nowrap', fontSize: 12 }}>
      {list.map((x, i) => <span key={x.k} title={SRC_LABEL[x.k]}>{i ? <span className="muted"> · </span> : null}{x.label} <b>{x.n}</b></span>)}
    </span>
  );
}

function memberSrc(m) {
  return (
    <span className={`badge ${SRC_BADGE[m.src] || 'gray'}`} title={`${SRC_LABEL[m.src] || m.src}${m.via ? ` — ${m.via}` : ''}${m.reason ? ` — ${REASON_TEXT[m.reason] || m.reason}` : ''}`}>
      {SRC_SHORT[m.src] || '미지정'}{m.drift ? ' · 드리프트' : ''}{m.unchecked ? ' · 확인 안 됨' : ''}
    </span>
  );
}
function powerDot(p) {
  if (p === true) return <span style={{ color: 'var(--green)' }} title="켜짐">●</span>;
  if (p === false) return <span className="muted" title="꺼짐">○</span>;
  return <span className="muted" title="전원 상태를 모릅니다(엣지 보고 서버 등)">◌</span>;
}
const backupMember = (b) => (b === undefined ? <span className="muted">—</span> : b === null ? <span className="muted">모름</span>
  : b === 'ok' ? <span className="badge green">성공</span> : b === 'fail' ? <span className="badge red">실패·지연</span> : <span className="badge gray">잡 없음</span>);

/** 구성원 표 + 영향 호스트 표. query 가 바뀌면 다시 읽는다(늦게 온 이전 응답은 버린다). */
export function MembersPanel({ title, sub, query, reloadKey = 0, selectable = false, selected, onSelect }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const seq = useRef(0);
  const qs = JSON.stringify(query || {});
  useEffect(() => {
    if (!query) { setD(null); return; }
    const my = ++seq.current;
    setErr(null); setD(null);
    fetchJson('/tools/svc-inventory/members', query).then((r) => { if (my === seq.current) setD(r); }).catch((e) => { if (my === seq.current) setErr(e); });
  }, [qs, reloadKey]);   // eslint-disable-line react-hooks/exhaustive-deps
  if (!query) return null;
  const ms = d?.members || [];
  const hosts = d?.hosts || [];
  return (
    <>
      <div className="card" style={{ minWidth: 0 }}>
        <div className="flex wrap gap" style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', alignItems: 'center' }}>
          <b>{title}</b><span className="muted" style={{ fontSize: 12 }}>{sub}{d ? ` · ${ms.length}대${d.omitted ? ` (상한으로 ${d.omitted}대 생략)` : ''}` : ''}</span>
        </div>
        {err ? <div style={{ padding: 12 }}><ErrorBox error={err} /></div> : !d ? <Loading /> : !ms.length ? <div className="muted" style={{ padding: 16 }}>구성원이 없습니다.</div> : (
          <STable className="table svcinv-t" minWidth={selectable ? 820 : 780}>
            <thead><tr>
              {selectable ? <th data-nosort /> : null}
              <th>이름</th><th>소속 근거</th><th>사용률</th><th title="VM 은 vCPU·할당 메모리, 베어메탈은 코어·설치 메모리">vCPU·메모리</th><th>부품 장애</th><th>백업</th><th>호스트 · IP</th>
            </tr></thead>
            <tbody>{ms.map((m) => (
              <tr key={m.key}>
                {selectable ? <td><input type="checkbox" checked={!!selected?.has(m.key)} onChange={(e) => onSelect?.(m.key, e.target.checked)} aria-label={`${m.name} 선택`} /></td> : null}
                <td data-sort={m.name} title={`키 ${m.key}`}>
                  <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', whiteSpace: 'nowrap' }}>{powerDot(m.powered)}<span className={`badge ${m.kind === 'vm' ? 'blue' : 'amber'}`}>{m.kind === 'vm' ? 'VM' : 'BM'}</span><b>{m.name}</b></span>
                  <div className="svcinv-sub">{m.kind === 'vm' ? (m.folderPath == null ? '위치 모름' : m.folderPath) : (m.serviceTag ? `서비스태그 ${m.serviceTag}` : (m.source || ''))}</div>
                </td>
                <td data-sort={m.src}>{memberSrc(m)}</td>
                <td data-sort={m.usage?.cpu ?? ''}><UsagePair cpu={m.usage?.cpu ?? null} mem={m.usage?.mem ?? null} /></td>
                <td data-sort={m.cores ?? ''} style={{ whiteSpace: 'nowrap' }}>{numText(m.cores)}<span className="muted"> · {m.memGB == null ? '—' : `${Math.round(m.memGB)}GB`}</span></td>
                <td data-sort={m.faults ?? ''}>{m.faults == null ? <span className="muted">{m.kind === 'vm' ? '' : '—'}</span> : m.faults ? <span className="badge red">{m.faults}</span> : <span className="muted">0</span>}</td>
                <td data-sort={m.backup || ''}>{backupMember(m.backup)}</td>
                <td style={{ fontFamily: 'var(--mono)', fontSize: 12, whiteSpace: 'nowrap' }}>{m.kind === 'vm' ? <>{m.host || '—'}<div className="svcinv-sub">{m.ip || ''}</div></> : '—'}</td>
              </tr>
            ))}</tbody>
          </STable>
        )}
      </div>
      {d && hosts.length ? (
        <div className="card" style={{ minWidth: 0 }}>
          <div className="flex wrap gap" style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', alignItems: 'center' }}>
            <b>영향 호스트(파생)</b><span className="muted" style={{ fontSize: 12 }}>{hosts.length}대 · 이 VM 들이 올라간 ESXi 호스트와 그 호스트가 함께 떠받치는 서비스</span>
          </div>
          <STable className="table svcinv-t" minWidth={680}>
            <thead><tr><th>호스트</th><th>이 목록 VM</th><th>CPU</th><th>메모리</th><th>부품 장애</th><th>함께 떠받치는 서비스</th></tr></thead>
            <tbody>{hosts.map((h) => (
              <tr key={`${h.corp}|${h.name}`}>
                <td data-sort={h.name}><b>{h.name}</b><div className="muted" style={{ fontSize: 11, fontFamily: 'var(--mono)' }}>{h.serviceTag || ''}</div></td>
                <td data-sort={h.vmHere}>{h.vmHere}</td>
                <td><UsageBar v={h.usage?.cpuPct ?? null} /></td><td><UsageBar v={h.usage?.memPct ?? null} /></td>
                <td data-sort={h.faults ?? ''}>{h.faults == null ? <span className="muted">—</span> : h.faults ? <span className="badge red">{h.faults} → 영향 서비스 {1 + (h.others?.length || 0)}</span> : <span className="muted">0</span>}</td>
                <td className="muted" style={{ whiteSpace: 'normal' }}>{h.others?.length ? h.others.join(' · ') : '없음(전용)'}{h.unassignedOn ? ` · 미지정 VM ${h.unassignedOn}` : ''}</td>
              </tr>
            ))}</tbody>
          </STable>
        </div>
      ) : null}
    </>
  );
}
