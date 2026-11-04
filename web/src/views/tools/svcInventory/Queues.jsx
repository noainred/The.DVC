/**
 * 서비스 인벤토리 — 운영 큐(미지정 출처별 묶음 · 매핑 안 된 값 · 검토)와 소속 규칙 탭(v2.887).
 * 묶음 단위로 연결하면 같은 출처의 서버가 앞으로도 자동으로 들어온다(폴더 규칙·스캔 라벨·별칭). 서비스는 사람이 만든다.
 */
import React, { useEffect, useRef, useState } from 'react';
import { fetchJson } from '../../../api.js';
import { STable } from '../../../components/STable.jsx';
import Select from '../../../components/Select.jsx';
import { Loading, ErrorBox } from '../../../components/ui.jsx';
import { GROUP_TITLE, groupActions, SRC_LABEL } from '../svcInventoryText.js';

const btn = { padding: '5px 10px', fontSize: 12, flex: 'none' };
const svcLabel = (s) => `${s.path ? `${s.path}\\` : ''}${s.name}`;

function useQueues(corp, reloadKey) {
  const [q, setQ] = useState(null); const [err, setErr] = useState(null); const seq = useRef(0);
  useEffect(() => {
    const my = ++seq.current; setErr(null); setQ(null);
    fetchJson('/tools/svc-inventory/queues', corp ? { corp } : {}).then((r) => { if (my === seq.current) setQ(r); }).catch((e) => { if (my === seq.current) setErr(e); });
  }, [corp, reloadKey]);
  return { q, err };
}

/** 미지정 — 출처별 묶음. */
export function UnassignedView({ corp, reloadKey, servicesOf, writableOf, op, busy, onPinGroup, corpName }) {
  const { q, err } = useQueues(corp, reloadKey);
  const [pick, setPick] = useState({});
  if (err) return <div className="card" style={{ padding: 12 }}><ErrorBox error={err} /></div>;
  if (!q) return <div className="card"><Loading /></div>;
  const list = q.unassigned || [];
  return (
    <div className="card" style={{ minWidth: 0 }}>
      <div className="flex wrap gap" style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', alignItems: 'center' }}>
        <b>(미지정) — 출처별 묶음</b><span className="muted" style={{ fontSize: 12 }}>{list.reduce((a, g) => a + g.n, 0)}대 · {list.length}묶음 · 묶음 단위로 연결하면 같은 출처의 서버가 앞으로도 자동으로 들어옵니다</span>
      </div>
      {!list.length ? <div className="muted" style={{ padding: 16 }}>미지정 구성원이 없습니다.</div> : list.map((g) => {
        const a = groupActions(g);
        const can = g.corp && writableOf(g.corp);
        const svcs = g.corp ? servicesOf(g.corp) : [];
        const sel = pick[g.key] || '';
        return (
          <div key={g.key} style={{ borderBottom: '1px solid var(--border)' }}>
            <div className="flex wrap gap" style={{ padding: '9px 14px', alignItems: 'center', background: 'var(--panel-2)' }}>
              <b style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{(GROUP_TITLE[g.kind] || (() => g.kind))(g)}</b>
              <span className="badge gray">{g.corp ? corpName(g.corp) : '법인 미지정'}</span>
              <span className="badge amber">{g.n}대{g.vm && g.bm ? ` (VM ${g.vm} · 베어메탈 ${g.bm})` : ''}</span>
              {g.unchecked ? <span className="badge gray" title="태그를 읽지 못해 태그 규칙을 확인하지 못한 VM">태그 확인 안 됨 {g.unchecked}</span> : null}
              <span style={{ flex: 1 }} />
              {a.none ? <span className="muted" style={{ fontSize: 12 }}>통합 서버 인벤토리에서 법인을 먼저 정합니다</span> : null}
              {a.pinOnly && can ? <button type="button" className="logout-btn" style={btn} disabled={busy} onClick={() => onPinGroup(g)}>한 대씩 고정</button> : null}
              {!a.none && !a.pinOnly && can ? (
                <>
                  <Select className="select" value={sel} onChange={(e) => setPick((p) => ({ ...p, [g.key]: e.target.value }))} style={{ maxWidth: 220, padding: '4px 8px', fontSize: 12 }} aria-label="연결할 서비스">
                    <option value="">서비스 선택…</option>
                    {svcs.map((s) => <option key={s.id} value={s.id}>{svcLabel(s)}</option>)}
                  </Select>
                  <button type="button" className="login-btn" style={btn} disabled={busy || !sel} onClick={() => {
                    const s = svcs.find((x) => x.id === sel);
                    if (a.op === 'rule.add') op({ op: 'rule.add', corp: g.corp, prefix: g.value, serviceId: sel }, `폴더 규칙 ‘${g.value}’ → ‘${s?.name}’ 을 만들었습니다(${g.n}대 · 앞으로 이 폴더의 VM 은 자동 소속).`);
                    else if (a.op === 'alias.add') op({ op: 'alias.add', corp: g.corp, kind: a.aliasKind, value: g.value, serviceId: sel }, `${a.aliasKind === 'scan' ? '스캔 라벨' : '태그'} 별칭 ‘${g.value}’ → ‘${s?.name}’ 을 만들었습니다.`);
                    else if (a.op === 'scan.label') op({ op: 'scan.label', corp: g.corp, entryId: g.value, label: s?.name || '' }, `스캔 엔트리 라벨을 ‘${s?.name}’ 으로 정했습니다(다음 조회부터 이 엔트리의 서버가 자동 소속).`);
                  }}>{a.link}</button>
                  {a.create ? <button type="button" className="logout-btn" style={btn} disabled={busy} title="그 이름의 서비스를 법인 루트에 만들고 규칙·별칭을 붙입니다"
                    onClick={() => op({ op: 'service.createLinked', corp: g.corp, kind: a.createKind, value: g.value, name: a.createName }, `서비스 ‘${a.createName}’ 을 만들고 연결했습니다.`)}>‘{a.createName}’ 서비스로 만들기</button> : null}
                </>
              ) : null}
              {!can && g.corp && !a.none ? <span className="muted" style={{ fontSize: 12 }}>조회 전용</span> : null}
            </div>
            <div className="muted" style={{ padding: '6px 14px 9px', fontSize: 12, display: 'flex', flexWrap: 'wrap', gap: '4px 14px' }}>
              {g.names.map((x) => <span key={x.key}>{x.kind === 'vm' ? '🟦' : '🟧'} {x.name}</span>)}
              {g.namesOmitted ? <span>… 외 {g.namesOmitted}대</span> : null}
            </div>
          </div>
        );
      })}
      <div className="muted" style={{ padding: '8px 14px', fontSize: 12 }}>법인 귀속이 없는 베어메탈은 통합 서버 인벤토리에서 법인을 먼저 정합니다(범위 계정에는 보이지 않습니다). 묶을 출처가 없는 서버는 한 대씩 고정합니다.</div>
    </div>
  );
}

/** 매핑 안 된 값 — 규칙 값은 있는데 서비스가 없는 것(스캔 라벨·태그 값). */
export function UnmappedView({ corp, reloadKey, servicesOf, writableOf, op, busy, corpName }) {
  const { q, err } = useQueues(corp, reloadKey);
  const [pick, setPick] = useState({});
  if (err) return <div className="card" style={{ padding: 12 }}><ErrorBox error={err} /></div>;
  if (!q) return <div className="card"><Loading /></div>;
  const list = q.unmapped || [];
  return (
    <div className="card" style={{ minWidth: 0 }}>
      <div className="flex wrap gap" style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', alignItems: 'center' }}>
        <b>매핑 안 된 값</b><span className="muted" style={{ fontSize: 12 }}>{list.length}건 · 서비스는 자동으로 만들지 않습니다 — 만들거나 기존 서비스에 연결합니다</span>
      </div>
      {!list.length ? <div className="muted" style={{ padding: 16 }}>매핑 안 된 값이 없습니다.</div> : (
        <STable className="table" minWidth={760}>
          <thead><tr><th>출처</th><th>값</th><th>법인</th><th>대수</th><th data-nosort>조치</th></tr></thead>
          <tbody>{list.map((x) => {
            const k = `${x.corp}|${x.kind}|${x.value}`; const can = writableOf(x.corp); const svcs = servicesOf(x.corp);
            return (
              <tr key={k}>
                <td>{x.kind === 'scan' ? '스캔 엔트리 라벨' : '태그 값'}</td><td style={{ fontFamily: 'var(--mono)' }}><b>{x.value}</b></td>
                <td>{corpName(x.corp)}</td><td data-sort={x.n}>{x.n}</td>
                <td>{can ? (
                  <span className="flex wrap gap" style={{ alignItems: 'center' }}>
                    <button type="button" className="logout-btn" style={btn} disabled={busy} onClick={() => op({ op: 'service.createLinked', corp: x.corp, kind: x.kind, value: x.value, name: x.value }, `서비스 ‘${x.value}’ 을 만들고 연결했습니다.`)}>서비스로 만들기</button>
                    <Select className="select" value={pick[k] || ''} onChange={(e) => setPick((p) => ({ ...p, [k]: e.target.value }))} style={{ maxWidth: 200, padding: '4px 8px', fontSize: 12 }} aria-label="기존 서비스">
                      <option value="">기존 서비스에 연결…</option>
                      {svcs.map((s) => <option key={s.id} value={s.id}>{svcLabel(s)}</option>)}
                    </Select>
                    <button type="button" className="login-btn" style={btn} disabled={busy || !pick[k]} onClick={() => op({ op: 'alias.add', corp: x.corp, kind: x.kind, value: x.value, serviceId: pick[k] }, `별칭 ‘${x.value}’ 을 연결했습니다.`)}>연결</button>
                  </span>) : <span className="muted">조회 전용</span>}</td>
              </tr>
            );
          })}</tbody>
        </STable>
      )}
    </div>
  );
}

/** 검토 — 드리프트 · 고정 법인 불일치 · 불필요한 고정 · 유령 키(판정 보류 포함). */
export function ReviewView({ corp, reloadKey, svcName, writableOf, op, busy, corpName }) {
  const { q, err } = useQueues(corp, reloadKey);
  if (err) return <div className="card" style={{ padding: 12 }}><ErrorBox error={err} /></div>;
  if (!q) return <div className="card"><Loading /></div>;
  const ghostsBy = new Map();
  for (const g of q.ghosts || []) { if (!ghostsBy.has(g.corp)) ghostsBy.set(g.corp, []); ghostsBy.get(g.corp).push(g); }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
      <div className="card" style={{ minWidth: 0 }}>
        <div className="flex wrap gap" style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', alignItems: 'center' }}>
          <b>드리프트(고정 ≠ 자동 판정)</b><span className="muted" style={{ fontSize: 12 }}>{q.drift.length}건 · 어느 쪽도 조용히 이기지 않습니다 — 고릅니다</span>
        </div>
        {!q.drift.length ? <div className="muted" style={{ padding: 14 }}>드리프트가 없습니다.</div> : (
          <STable className="table svcinv-t" minWidth={700}>
            <thead><tr><th>구성원 · 법인</th><th>고정된 서비스</th><th>자동 판정</th><th data-nosort>조치</th></tr></thead>
            <tbody>{q.drift.map((x) => (
              <tr key={x.key}>
                <td data-sort={x.name} title={x.key}><b>{x.name}</b><div className="svcinv-sub">{corpName(x.corp)}</div><div className="svcinv-sub" style={{ fontFamily: 'var(--mono)' }}>{x.key}</div></td>
                <td>{svcName(x.pin.serviceId)}<div className="svcinv-sub">{x.pin.by || '?'}{x.pin.at ? ` · ${new Date(x.pin.at).toLocaleDateString()}` : ''}</div></td>
                <td>{svcName(x.auto.serviceId)} <span className="badge blue">{SRC_LABEL[x.auto.src] || x.auto.src}</span>
                  {/* 바뀜 표지는 줄을 따로 — 같은 줄에 두면 1440px 에서 조치 열이 가로 스크롤 뒤로 밀린다(실측) */}
                  {x.changed?.legacy ? <div><span className="badge amber" title="업그레이드 전에 ‘고정 유지’ 한 항목입니다 — 그때의 자동 판정을 기록하지 않아 바뀌었는지 모릅니다. 한 번 다시 고르면 이후에는 같은 드리프트를 묻지 않습니다">다시 확인</span></div>
                    : x.changed ? <div><span className="badge amber" title={`‘고정 유지’ 를 누른 뒤 자동 판정이 바뀌었습니다(${x.changed.reviewedAuto ? svcName(x.changed.reviewedAuto) : '자동 판정 없음'} → ${svcName(x.auto.serviceId)}) — 다시 고릅니다`}>바뀜</span></div> : null}
                  <div className="svcinv-sub" title={x.auto.via}>{x.auto.via}</div></td>
                <td>{writableOf(x.corp) ? (
                  <span className="flex wrap gap">
                    <button type="button" className="logout-btn" style={btn} disabled={busy} onClick={() => op({ op: 'pins.clear', corp: x.corp, keys: [x.key] }, '고정을 지웠습니다 — 자동 판정으로 돌아갑니다.')}>자동으로 되돌리기</button>
                    <button type="button" className="logout-btn" style={btn} disabled={busy} onClick={() => op({ op: 'pins.review', corp: x.corp, keys: [x.key] }, '고정을 유지합니다 — 자동 판정이 지금과 같으면 다시 묻지 않습니다(다른 서비스로 바뀌면 다시 묻습니다).')}>고정 유지</button>
                  </span>) : <span className="muted">조회 전용</span>}</td>
              </tr>
            ))}</tbody>
          </STable>
        )}
      </div>
      {q.mismatch?.length ? (
        <div className="card" style={{ padding: '10px 14px', borderLeft: '3px solid var(--amber)', fontSize: 13 }}>
          ⚠ 고정한 뒤 법인이 바뀐 구성원 {q.mismatch.length}대 — 그 고정은 무시하고 자동 판정을 씁니다: {q.mismatch.slice(0, 10).map((x) => x.name).join(', ')}{q.mismatch.length > 10 ? ' …' : ''}
        </div>
      ) : null}
      <div className="card" style={{ minWidth: 0 }}>
        <div className="flex wrap gap" style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', alignItems: 'center' }}>
          <b>유령 키(고정이 가리키는 서버가 없음)</b>
          <span className="muted" style={{ fontSize: 12 }}>{q.ghosts.length}건{q.ghostsHeld?.length ? ` · 판정 보류 ${q.ghostsHeld.length}건(읽지 못한 법인·베어메탈 출처 — 유령으로 보지 않습니다)` : ''}</span>
        </div>
        {!q.ghosts.length && !q.ghostsHeld?.length ? <div className="muted" style={{ padding: 14 }}>유령 키가 없습니다.</div> : (
          <>
            <STable className="table svcinv-t" minWidth={680}>
              <thead><tr><th>키</th><th>법인</th><th>고정된 서비스</th><th>고정한 사람 · 시각</th><th>상태</th></tr></thead>
              <tbody>
                {q.ghosts.map((g) => <tr key={g.key}><td style={{ fontFamily: 'var(--mono)', fontSize: 12, wordBreak: 'break-all' }}>{g.key}</td><td>{corpName(g.corp)}</td><td>{g.serviceName || '?'}</td><td>{g.by || '?'}{g.at ? ` · ${new Date(g.at).toLocaleDateString()}` : ''}</td><td><span className="badge amber">정리 대상</span></td></tr>)}
                {(q.ghostsHeld || []).map((g) => <tr key={g.key} style={{ opacity: 0.6 }}><td style={{ fontFamily: 'var(--mono)', fontSize: 12, wordBreak: 'break-all' }}>{g.key}</td><td>{corpName(g.corp)}</td><td>{g.serviceName || '?'}</td><td>{g.by || '?'}</td><td><span className="badge gray">판정 보류 — 지금 읽지 못함</span></td></tr>)}
              </tbody>
            </STable>
            <div className="flex wrap gap" style={{ padding: '8px 14px' }}>
              {[...ghostsBy.keys()].filter((c) => writableOf(c)).map((c) => (
                <button key={c} type="button" className="logout-btn" style={btn} disabled={busy} onClick={() => op({ op: 'ghosts.prune', corp: c }, `${corpName(c)} 의 유령 고정을 정리했습니다(판정 보류는 남깁니다).`)}>{corpName(c)} 유령 {ghostsBy.get(c).length}건 정리</button>
              ))}
            </div>
          </>
        )}
      </div>
      <RedundantCard q={q} svcName={svcName} writableOf={writableOf} op={op} busy={busy} corpName={corpName} />
      {q.orphaned ? <div className="muted" style={{ fontSize: 12 }}>등록 해제된 vCenter 의 고정 {q.orphaned}건 — 유령 정리로는 지울 수 없고, 트리에서 그 법인을 골라 ‘법인 항목 정리’ 로 지웁니다(전체 범위 관리자).</div> : null}
    </div>
  );
}

/**
 * 불필요한 고정(고정 = 자동 판정) — 지워도 소속이 바뀌지 않는다. 폴더 규칙을 나중에 만들면 그 전의 '한 대씩 고정' 이 여기에 쌓인다(5차 검토 M3).
 * 법인마다 한 번에 지운다(사람이 누른다 — 자동 정리는 하지 않는다). 키는 서버가 고른 법인 것만 싣는다(R9).
 */
function RedundantCard({ q, svcName, writableOf, op, busy, corpName }) {
  const items = q.redundant?.items || [];
  const n = q.redundant?.n || 0;
  if (!n) return null;
  const byCorp = new Map();
  for (const x of items) { if (!byCorp.has(x.corp)) byCorp.set(x.corp, []); byCorp.get(x.corp).push(x); }
  return (
    <div className="card" style={{ minWidth: 0 }}>
      <div className="flex wrap gap" style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', alignItems: 'center' }}>
        <b>불필요한 고정(고정 = 자동 판정)</b><span className="muted" style={{ fontSize: 12 }}>{n}건 · 지워도 소속이 바뀌지 않습니다 — 고정이 남아 있으면 나중에 규칙을 바꿨을 때 드리프트가 됩니다</span>
      </div>
      <div style={{ padding: '8px 14px', fontSize: 12, display: 'flex', flexWrap: 'wrap', gap: '4px 12px' }}>
        {items.slice(0, 30).map((x) => <span key={x.key}><b>{x.name}</b> <span className="muted">→ {svcName(x.serviceId)}</span></span>)}
        {n > 30 ? <span className="muted">… 외 {n - 30}건</span> : null}
      </div>
      <div className="flex wrap gap" style={{ padding: '0 14px 10px' }}>
        {[...byCorp.entries()].filter(([c]) => writableOf(c)).map(([c, list]) => (
          <button key={c} type="button" className="logout-btn" style={btn} disabled={busy}
            onClick={() => op({ op: 'pins.clear', corp: c, keys: list.map((x) => x.key) }, `${corpName(c)} 의 불필요한 고정 ${list.length}건을 지웠습니다 — 자동 판정 그대로 소속됩니다.`)}>
            {corpName(c)} 불필요한 고정 {list.length}건 지우기
          </button>
        ))}
      </div>
    </div>
  );
}

/** 소속 규칙 탭 — 판정 순서 + 이 법인의 규칙·별칭·이름 규칙 · 태그 켜기 · (전체 범위 관리자) 태그 카테고리. */
export function RulesView({ corp, corpRow, servicesOf, writable, op, busy, canFleet, tagCategory, corpName }) {
  const [f, setF] = useState({ prefix: '', svc: '', match: 'prefix', nv: '', nsvc: '', cat: tagCategory || '' });
  useEffect(() => { setF((x) => ({ ...x, cat: tagCategory || '' })); }, [tagCategory]);
  const svcs = corp ? servicesOf(corp) : [];
  const nameOf = (id) => svcs.find((s) => s.id === id)?.name || '?';
  const ORDER = [
    ['고정(수동)', '한 대씩 추가한 지정. 자동 판정과 다르면 드리프트로 검토 탭에 오릅니다.'],
    ['vCenter 폴더 규칙(VM 1순위)', '정확한 vSphere 위치(‘/ERP/prod’ 꼴)의 ‘/’ 경계 접두 · 가장 긴 접두가 이깁니다. 매 수집 주기로 반영됩니다.'],
    ['스캔 엔트리 라벨(베어메탈)', 'iDRAC 스캔 엔트리의 서비스 라벨 = 서비스명 또는 별칭.'],
    ['vSphere 태그(선택)', '전역 카테고리를 정하고 법인이 켰을 때만. 태그를 못 읽은 VM 은 ‘확인 안 됨’ 입니다.'],
    ['이름 규칙(선택)', '접두·접미·포함 3종(정규식 아님).'],
  ];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12, minWidth: 0 }}>
      <div className="card" style={{ minWidth: 0 }}>
        <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}><b>소속 판정 순서</b> <span className="muted" style={{ fontSize: 12 }}>위가 이깁니다 · 서비스는 자동으로 만들지 않습니다</span></div>
        {ORDER.map(([h, p], i) => <div key={h} style={{ padding: '8px 14px', borderBottom: '1px solid var(--border)' }}><b>{i + 1}. {h}</b><div className="muted" style={{ fontSize: 12 }}>{p}</div></div>)}
        {canFleet ? (
          <div className="flex wrap gap" style={{ padding: '10px 14px', alignItems: 'center' }}>
            <span className="muted" style={{ fontSize: 12 }}>전역 태그 카테고리</span>
            <input className="input" value={f.cat} onChange={(e) => setF({ ...f, cat: e.target.value })} placeholder="예: Service (비우면 태그 규칙 끔)" style={{ maxWidth: 220 }} />
            <button type="button" className="login-btn" style={btn} disabled={busy} onClick={() => op({ op: 'settings.tagCategory', value: f.cat }, `태그 카테고리를 ‘${f.cat || '(없음)'}’ 로 정했습니다.`)}>저장</button>
          </div>
        ) : <div className="muted" style={{ padding: '10px 14px', fontSize: 12 }}>전역 태그 카테고리: {tagCategory || '(정하지 않음)'} — 전체 범위 관리자가 정합니다.</div>}
      </div>
      <div className="card" style={{ minWidth: 0 }}>
        <div className="flex wrap gap" style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', alignItems: 'center' }}>
          <b>{corp ? `${corpName(corp)} 규칙` : '법인 규칙'}</b>
          {corp && writable ? (
            <label className="muted" style={{ fontSize: 12, display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={!!corpRow?.tagEnabled} disabled={busy} onChange={(e) => op({ op: 'tag.enable', corp, enabled: e.target.checked }, `태그 규칙을 ${e.target.checked ? '켰' : '껐'}습니다.`)} /> 이 법인에서 태그 규칙 사용
            </label>) : null}
        </div>
        {!corp ? <div className="muted" style={{ padding: 14 }}>왼쪽 트리에서 법인을 고르면 그 법인의 규칙이 나옵니다.</div> : (
          <>
            <STable className="table" minWidth={520}>
              <thead><tr><th>종류</th><th>값</th><th>→ 서비스</th><th data-nosort /></tr></thead>
              <tbody>
                {(corpRow?.folderRules || []).map((r) => <tr key={`f${r.prefix}`}><td>폴더 접두</td><td style={{ fontFamily: 'var(--mono)' }}>{r.prefix}</td><td><b>{nameOf(r.serviceId)}</b></td><td>{writable ? <button type="button" className="logout-btn" style={btn} disabled={busy} onClick={() => op({ op: 'rule.remove', corp, prefix: r.prefix }, `규칙 ‘${r.prefix}’ 을 지웠습니다.`)}>지우기</button> : null}</td></tr>)}
                {(corpRow?.aliases || []).map((a) => <tr key={`a${a.kind}${a.value}`}><td>{a.kind === 'scan' ? '스캔 라벨 별칭' : '태그 별칭'}</td><td style={{ fontFamily: 'var(--mono)' }}>{a.value}</td><td><b>{nameOf(a.serviceId)}</b></td><td>{writable ? <button type="button" className="logout-btn" style={btn} disabled={busy} onClick={() => op({ op: 'alias.remove', corp, kind: a.kind, value: a.value }, `별칭 ‘${a.value}’ 을 지웠습니다.`)}>지우기</button> : null}</td></tr>)}
                {(corpRow?.nameRules || []).map((r) => <tr key={`n${r.match}${r.value}`}><td>이름 {r.match === 'prefix' ? '접두' : r.match === 'suffix' ? '접미' : '포함'}</td><td style={{ fontFamily: 'var(--mono)' }}>{r.value}</td><td><b>{nameOf(r.serviceId)}</b></td><td>{writable ? <button type="button" className="logout-btn" style={btn} disabled={busy} onClick={() => op({ op: 'namerule.remove', corp, match: r.match, value: r.value }, '이름 규칙을 지웠습니다.')}>지우기</button> : null}</td></tr>)}
              </tbody>
            </STable>
            {writable ? (
              <div style={{ padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div className="flex wrap gap" style={{ alignItems: 'center' }}>
                  <span className="muted" style={{ fontSize: 12 }}>폴더 규칙</span>
                  <input className="input" value={f.prefix} onChange={(e) => setF({ ...f, prefix: e.target.value })} placeholder="/ERP" style={{ maxWidth: 180 }} />
                  <Select className="select" value={f.svc} onChange={(e) => setF({ ...f, svc: e.target.value })} style={{ maxWidth: 200 }} aria-label="서비스"><option value="">서비스 선택…</option>{svcs.map((s) => <option key={s.id} value={s.id}>{svcLabel(s)}</option>)}</Select>
                  <button type="button" className="login-btn" style={btn} disabled={busy || !f.prefix || !f.svc} onClick={() => op({ op: 'rule.add', corp, prefix: f.prefix, serviceId: f.svc }, `폴더 규칙 ‘${f.prefix}’ 을 만들었습니다.`)}>추가</button>
                </div>
                <div className="flex wrap gap" style={{ alignItems: 'center' }}>
                  <span className="muted" style={{ fontSize: 12 }}>이름 규칙</span>
                  <Select className="select" sort={false} value={f.match} onChange={(e) => setF({ ...f, match: e.target.value })} style={{ maxWidth: 110 }} aria-label="방식"><option value="prefix">접두</option><option value="suffix">접미</option><option value="contains">포함</option></Select>
                  <input className="input" value={f.nv} onChange={(e) => setF({ ...f, nv: e.target.value })} placeholder="erp-" style={{ maxWidth: 140 }} />
                  <Select className="select" value={f.nsvc} onChange={(e) => setF({ ...f, nsvc: e.target.value })} style={{ maxWidth: 200 }} aria-label="서비스"><option value="">서비스 선택…</option>{svcs.map((s) => <option key={s.id} value={s.id}>{svcLabel(s)}</option>)}</Select>
                  <button type="button" className="login-btn" style={btn} disabled={busy || !f.nv || !f.nsvc} onClick={() => op({ op: 'namerule.add', corp, match: f.match, value: f.nv, serviceId: f.nsvc }, '이름 규칙을 만들었습니다.')}>추가</button>
                </div>
              </div>
            ) : <div className="muted" style={{ padding: '8px 14px', fontSize: 12 }}>조회 전용 법인입니다.</div>}
          </>
        )}
      </div>
    </div>
  );
}
