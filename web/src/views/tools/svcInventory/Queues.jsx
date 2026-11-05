/**
 * 서비스 인벤토리 — 운영 큐(미지정 출처별 묶음 · 매핑 안 된 값 · 검토)와 소속 규칙 탭(v2.887).
 * 묶음 단위로 연결하면 같은 출처의 서버가 앞으로도 자동으로 들어온다(폴더 규칙·스캔 라벨·별칭). 서비스는 사람이 만든다.
 */
import React, { useEffect, useRef, useState } from 'react';
import { fetchJson, postJson } from '../../../api.js';
import { STable } from '../../../components/STable.jsx';
import Select from '../../../components/Select.jsx';
import { Loading, ErrorBox } from '../../../components/ui.jsx';
import { GROUP_TITLE, groupActions, SRC_LABEL, opErrorText, keyText, isMaskedKey, MASKED_KEY_TITLE } from '../svcInventoryText.js';

const btn = { padding: '5px 10px', fontSize: 12, flex: 'none' };
const svcLabel = (s) => `${s.path ? `${s.path}\\` : ''}${s.name}`;

function useQueues(corp, reloadKey, nocorp = false) {
  const [q, setQ] = useState(null); const [err, setErr] = useState(null); const seq = useRef(0);
  useEffect(() => {
    const my = ++seq.current; setErr(null); setQ(null);
    // nocorp = 트리 '(법인 미지정)' — 법인 귀속 없는 항목만(6차 6: 빈 corp 는 '조건 없음' 이라 전 법인 큐가 나왔다)
    fetchJson('/tools/svc-inventory/queues', nocorp ? { nocorp: '1' } : corp ? { corp } : {}).then((r) => { if (my === seq.current) setQ(r); }).catch((e) => { if (my === seq.current) setErr(e); });
  }, [corp, reloadKey, nocorp]);
  return { q, err };
}

/** 미지정 — 출처별 묶음. */
export function UnassignedView({ corp, nocorp = false, reloadKey, servicesOf, writableOf, op, busy, onPinGroup, corpName }) {
  const { q, err } = useQueues(corp, reloadKey, nocorp);
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
export function UnmappedView({ corp, nocorp = false, reloadKey, servicesOf, writableOf, op, busy, corpName }) {
  const { q, err } = useQueues(corp, reloadKey, nocorp);
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
export function ReviewView({ corp, nocorp = false, reloadKey, svcName, writableOf, op, busy, corpName }) {
  const { q, err } = useQueues(corp, reloadKey, nocorp);
  if (err) return <div className="card" style={{ padding: 12 }}><ErrorBox error={err} /></div>;
  if (!q) return <div className="card"><Loading /></div>;
  // 법인별 유령 개수 — 서버는 행을 앞 500건만 싣고 개수는 따로 준다(6차 8). 옛 서버 응답이면 행으로 센다.
  const ghostsBy = new Map(Object.entries(q.ghostsByCorp || {}));
  if (!q.ghostsByCorp) for (const g of q.ghosts || []) ghostsBy.set(g.corp, (ghostsBy.get(g.corp) || 0) + 1);
  const ghostsN = q.ghostsN ?? (q.ghosts || []).length;
  const heldN = q.ghostsHeldN ?? (q.ghostsHeld || []).length;
  const shownN = (q.ghosts || []).length + (q.ghostsHeld || []).length;
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
                <td data-sort={x.name} title={isMaskedKey(x.key) ? MASKED_KEY_TITLE : x.key}><b>{x.name}</b><div className="svcinv-sub">{corpName(x.corp)}</div><div className="svcinv-sub" style={{ fontFamily: 'var(--mono)' }}>{keyText(x.key)}</div></td>
                <td>{svcName(x.pin.serviceId)}<div className="svcinv-sub">{x.pin.by || '?'}{x.pin.at ? ` · ${new Date(x.pin.at).toLocaleDateString()}` : ''}</div></td>
                <td>{svcName(x.auto.serviceId)} <span className="badge blue">{SRC_LABEL[x.auto.src] || x.auto.src}</span>
                  {/* 바뀜 표지는 줄을 따로 — 같은 줄에 두면 1440px 에서 조치 열이 가로 스크롤 뒤로 밀린다(실측) */}
                  {x.changed?.legacy ? <div><span className="badge amber" title="업그레이드 전에 ‘고정 유지’ 한 항목입니다 — 그때의 자동 판정을 기록하지 않아 바뀌었는지 모릅니다. 한 번 다시 고르면 이후에는 같은 드리프트를 묻지 않습니다">다시 확인</span></div>
                    : x.changed ? <div><span className="badge amber" title={`‘고정 유지’ 를 누른 뒤 자동 판정이 바뀌었습니다(${x.changed.reviewedAuto ? svcName(x.changed.reviewedAuto) : '자동 판정 없음'} → ${svcName(x.auto.serviceId)}) — 다시 고릅니다`}>바뀜</span></div> : null}
                  <div className="svcinv-sub" title={x.auto.via}>{x.auto.via}</div></td>
                <td>{writableOf(x.corp) ? (
                  <span className="flex wrap gap">
                    <button type="button" className="logout-btn" style={btn} disabled={busy} onClick={() => op({ op: 'pins.clear', corp: x.corp, keys: [x.key] }, '고정을 지웠습니다 — 자동 판정으로 돌아갑니다.')}>자동으로 되돌리기</button>
                    <button type="button" className="logout-btn" style={btn} disabled={busy} onClick={() => op({ op: 'pins.review', corp: x.corp, keys: [x.key], expectAuto: { [x.key]: x.auto.serviceId ?? null } }, '고정을 유지합니다 — 자동 판정이 지금과 같으면 다시 묻지 않습니다(다른 서비스로 바뀌면 다시 묻습니다).')}>고정 유지</button>
                  </span>) : <span className="muted">조회 전용</span>}</td>
              </tr>
            ))}</tbody>
          </STable>
        )}
      </div>
      {q.mismatch?.length ? <MismatchCard q={q} svcName={svcName} writableOf={writableOf} op={op} busy={busy} corpName={corpName} /> : null}
      <div className="card" style={{ minWidth: 0 }}>
        <div className="flex wrap gap" style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', alignItems: 'center' }}>
          <b>유령 키(고정이 가리키는 서버가 없음)</b>
          <span className="muted" style={{ fontSize: 12 }}>{ghostsN}건{heldN ? ` · 판정 보류 ${heldN}건(아직 수집 전이거나 읽지 못한 법인·베어메탈 출처·VM 식별 키 — 유령으로 보지 않습니다)` : ''}</span>
        </div>
        {!ghostsN && !heldN ? <div className="muted" style={{ padding: 14 }}>유령 키가 없습니다.</div> : (
          <>
            <STable className="table svcinv-t" minWidth={680} limit={100}>
              <thead><tr><th>키</th><th>법인</th><th>고정된 서비스</th><th>고정한 사람 · 시각</th><th>상태</th></tr></thead>
              <tbody>
                {q.ghosts.map((g) => <tr key={g.key}><td style={{ fontFamily: 'var(--mono)', fontSize: 12, wordBreak: 'break-all' }} title={isMaskedKey(g.key) ? MASKED_KEY_TITLE : undefined}>{keyText(g.key)}</td><td>{corpName(g.corp)}</td><td>{g.serviceName || '?'}</td><td>{g.by || '?'}{g.at ? ` · ${new Date(g.at).toLocaleDateString()}` : ''}</td><td><span className="badge amber">정리 대상</span></td></tr>)}
                {(q.ghostsHeld || []).map((g) => (
                  <tr key={g.key}>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 12, wordBreak: 'break-all', opacity: 0.7 }} title={isMaskedKey(g.key) ? MASKED_KEY_TITLE : undefined}>{keyText(g.key)}</td><td>{corpName(g.corp)}</td><td>{g.serviceName || '?'}</td><td>{g.by || '?'}{g.at ? ` · ${new Date(g.at).toLocaleDateString()}` : ''}</td>
                    <td><span className="badge gray" title={HELD_TEXT[g.held] || ''}>판정 보류</span>
                      {/* 사유 · 시작 시각은 줄바꿈한다 — svcinv-sub 기본(한 줄 말줄임 260px)이면 '… 부터' 가 잘렸다(Chromium 1440 실측) */}
                      <div className="svcinv-sub" style={{ whiteSpace: 'normal', overflow: 'visible' }}>{HELD_SHORT[g.held] || g.held}{g.heldSince ? ` · ${new Date(g.heldSince).toLocaleString()} 부터` : ''}</div>
                      {/* 보류는 일괄 정리에서 빠진다 — 필요 없는 고정은 한 건씩 직접 지운다(6차 반증 F5: 예전에는 문구만 있고 버튼이 없었다) */}
                      {writableOf(g.corp) ? <button type="button" className="logout-btn" style={{ ...btn, marginTop: 4 }} disabled={busy} title="이 고정 한 건만 지웁니다(보류 사유와 무관하게 — 서버가 정말 없어진 것을 알 때)" onClick={() => op({ op: 'pins.clear', corp: g.corp, keys: [g.key] }, '보류 중이던 고정 한 건을 지웠습니다.')}>고정 지우기</button> : null}</td>
                  </tr>))}
              </tbody>
            </STable>
            {ghostsN + heldN > shownN ? <div className="muted" style={{ padding: '8px 14px 0', fontSize: 12 }}>유령·보류 각각 앞 {Math.max((q.ghosts || []).length, (q.ghostsHeld || []).length)}건까지만 실었습니다(전체 유령 {ghostsN}건 · 보류 {heldN}건). 정리 버튼은 전체 개수 기준입니다.</div> : null}
            {heldN ? (
              <div className="muted" style={{ padding: '8px 14px', fontSize: 12 }}>
                ‘부터’ 시각은 보류가 실제로 시작된 때가 아니라 이 포탈이 보류 상태를 처음 확인한 때입니다(검토 화면을 연 시각 기준 · 재시작하면 다시 셉니다). 오래 보류돼 있으면 아래 원인을 먼저 고치십시오 — 원인이 풀리면 유령인지 아닌지 다시 판정합니다.
                {q.bmBlocked && q.bmBlockedSources?.length ? (
                  <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{q.bmBlockedSources.slice(0, 8).map((u, i) => <li key={i}>{u.reason || SOURCE_TEXT[u.source] || u.source}</li>)}</ul>
                ) : null}
              </div>
            ) : null}
            <div className="flex wrap gap" style={{ padding: '8px 14px' }}>
              {[...ghostsBy.keys()].filter((c) => writableOf(c)).map((c) => (
                <GhostPrune key={c} corp={c} n={ghostsBy.get(c)} corpName={corpName} op={op} busy={busy} />
              ))}
            </div>
          </>
        )}
      </div>
      <AliasPinsCard q={q} svcName={svcName} writableOf={writableOf} op={op} busy={busy} corpName={corpName} />
      <TagAmbiguousCard q={q} svcName={svcName} writableOf={writableOf} op={op} busy={busy} corpName={corpName} />
      <RuleOverlapCard q={q} svcName={svcName} writableOf={writableOf} op={op} busy={busy} corpName={corpName} />
      <RedundantCard q={q} svcName={svcName} writableOf={writableOf} op={op} busy={busy} corpName={corpName} />
      {q.orphaned ? <div className="muted" style={{ fontSize: 12 }}>등록 해제된 vCenter 의 고정 {q.orphaned}건 — 유령 정리로는 지울 수 없고, 트리에서 그 법인을 골라 ‘법인 항목 정리’ 로 지웁니다(전체 범위 관리자).</div> : null}
    </div>
  );
}

/**
 * 고정한 뒤 법인이 바뀐 구성원(직접 키 · 옛 키 고정 — 6차 4). 판정은 그 고정을 쓰지 않는다. 고정이 있는 법인에 쓰기 권한이 있으면 한 건씩 지운다
 * (6차 반증 2회차 R2: 보이기만 하고 지울 길이 없었다). 범위 밖 법인의 고정이면 법인·서비스를 싣지 않는다(서버가 비움 — 버튼도 없다).
 */
function MismatchCard({ q, svcName, writableOf, op, busy, corpName }) {
  const rows = q.mismatch || [];
  const members = new Set(rows.map((x) => x.key)).size;
  return (
    <div className="card" style={{ minWidth: 0, borderLeft: '3px solid var(--amber)' }}>
      <div className="flex wrap gap" style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', alignItems: 'center' }}>
        <b>고정한 뒤 법인이 바뀐 구성원</b><span className="muted" style={{ fontSize: 12 }}>{members}대 · 고정 {rows.length}건 — 그 고정은 무시하고 자동 판정을 씁니다(필요 없으면 지웁니다)</span>
      </div>
      <STable className="table svcinv-t" minWidth={560} limit={50}>
        <thead><tr><th>구성원 · 지금 법인</th><th>고정이 있는 법인 · 서비스</th><th data-nosort>조치</th></tr></thead>
        <tbody>{rows.map((x) => (
          <tr key={`${x.key}|${x.aliasKey || ''}`}>
            <td data-sort={x.name}><b>{x.name}</b><div className="svcinv-sub">{corpName(x.corp)}{x.aliasKey ? ' · 옛 키 고정' : ''}</div></td>
            <td>{x.pinCorpHidden ? <span className="muted" title="이 계정의 조회 범위 밖 법인입니다">범위 밖 법인</span> : <>{corpName(x.pinCorp)}<div className="svcinv-sub">{svcName(x.serviceId)}</div></>}</td>
            <td>{!x.pinCorpHidden && x.pinCorp && writableOf(x.pinCorp)
              ? <button type="button" className="logout-btn" style={btn} disabled={busy} title="그 법인에 남은 이 고정만 지웁니다(구성원의 지금 소속은 바뀌지 않습니다)" onClick={() => op({ op: 'pins.clear', corp: x.pinCorp, keys: [x.aliasKey || x.key] }, `${x.name}: ${corpName(x.pinCorp)} 에 남은 고정을 지웠습니다.`)}>고정 지우기</button>
              : <span className="muted" style={{ fontSize: 12 }}>{x.pinCorpHidden ? '—' : '조회 전용'}</span>}</td>
          </tr>
        ))}</tbody>
      </STable>
    </div>
  );
}

const HELD_SHORT = { 'corp-unread': '법인 vCenter 를 지금 못 읽음', 'bm-source-unread': '베어메탈 출처를 못 읽음', 'uuid-unread': 'VM 식별 키(instanceUuid)를 못 읽음',
  'snapshot-initial': '포탈 기동 직후 — 첫 수집 전', 'corp-pending': '법인 vCenter 첫 수집 대기', 'corp-disabled': '법인 vCenter 수집 꺼짐', 'corp-no-vms': '법인 VM 이 한 대도 없음' };
const HELD_TEXT = {
  'snapshot-initial': '포탈이 막 기동해 아직 어느 vCenter 도 수집하지 않았습니다 — 첫 수집이 끝나면 판정합니다',
  'corp-pending': '이 법인 vCenter 를 아직 한 번도 수집하지 않았습니다(기동 직후·사이트 에이전트 수집 대기) — 수집되면 판정합니다',
  'corp-disabled': '이 법인 vCenter 수집이 꺼져 있어 이 키의 서버가 정말 없는지 모릅니다 — 수집을 켜면 판정합니다(필요 없는 고정이면 행의 ‘고정 지우기’ 로 한 건씩 지웁니다)',
  'corp-no-vms': '이 법인에서 VM 을 한 대도 받지 못했습니다 — VM 이 정말 모두 없어졌는지, 아직 못 받았는지 구분할 수 없어 VM 고정을 지우지 않습니다',
  'corp-unread': '그 법인 vCenter 를 지금 읽지 못해 이 키의 VM 이 정말 없는지 모릅니다 — 다시 읽히면 판정합니다',
  'bm-source-unread': 'iDRAC 등록부·OME·수집 서버·엣지 중 읽지 못한 출처가 있어 이 베어메탈이 정말 없는지 모릅니다 — 어느 출처에 있는지 알 수 없어 법인을 가리지 않고 보류합니다',
  'uuid-unread': '이 법인 vCenter 에서 VM 의 instanceUuid 를 하나도 읽지 못했습니다(REST 폴백 수집 등) — 이 키의 VM 이 정말 없는지 모릅니다. 다시 읽히면 판정합니다',
};
const SOURCE_TEXT = { 'idrac-registry': 'iDRAC 등록부를 읽지 못함', ome: 'OME 장비 목록을 아직 받지 못함', 'collector-registry': '수집 서버 등록부를 읽지 못함', collector: '수집 서버 목록을 아직 받지 못함', edge: '엣지 보고를 받지 못함', snapshot: '인벤토리 스냅샷 없음', 'fleet-keys': '베어메탈 출처 목록을 만들지 못함' };

/** 유령 정리 — 먼저 개수를 묻고(dry) 확인한 개수만 지운다(5차 R11: 예전에는 미리보기 없이 즉시 삭제 · expect 가 다르면 서버 409). */
function GhostPrune({ corp, n, corpName, op, busy }) {
  const [ask, setAsk] = useState(null);   // { keys } | null
  const [err, setErr] = useState('');
  const cur = useRef(0);
  if (ask) {
    return (
      <span className="flex wrap gap" style={{ alignItems: 'center', padding: '4px 8px', border: '1px solid var(--amber)', borderRadius: 6 }}>
        <span style={{ fontSize: 12 }}>{corpName(corp)} 유령 고정 <b>{ask.keys.length}</b>건을 지웁니다(판정 보류는 남깁니다){ask.held ? ` · 보류 ${ask.held}건 제외` : ''}{ask.total > ask.keys.length ? ` · 전체 ${ask.total}건 중 앞 ${ask.keys.length}건 — 지운 뒤 다시 누르면 다음 묶음` : ''}.</span>
        {/* 미리 본 키를 그대로 보낸다 — 서버는 그 키 ∩ 지금 유령만 지운다(3차 반증 3: 개수만 보내면 확인창에 없던 키가 끼어 지워졌다) */}
        <button type="button" className="login-btn" style={btn} disabled={busy || !ask.keys.length} onClick={async () => { const r = await op({ op: 'ghosts.prune', corp, keys: ask.keys }, `${corpName(corp)} 의 유령 고정을 정리했습니다(미리 본 ${ask.keys.length}건 중 지금도 유령인 것만).`); if (r) setAsk(null); }}>지우기</button>
        <button type="button" className="logout-btn" style={btn} onClick={() => setAsk(null)}>취소</button>
      </span>
    );
  }
  return (
    <span className="flex wrap gap" style={{ alignItems: 'center' }}>
      <button type="button" className="logout-btn" style={btn} disabled={busy} onClick={async () => {
        const my = ++cur.current; setErr('');
        try {
          const r = await postJson('/tools/svc-inventory/op', { op: 'ghosts.prune', corp, dry: true });
          if (my !== cur.current) return;
          if (!r || r.ok === false) throw new Error(r?.reason || '개수를 확인하지 못했습니다.');
          setAsk({ keys: r.result?.keys || [], held: r.result?.held || 0, total: r.result?.total || 0 });
        } catch (e) { if (my === cur.current) setErr(opErrorText(e)); }
      }}>{corpName(corp)} 유령 {n}건 정리…</button>
      {err ? <span style={{ color: 'var(--red)', fontSize: 12 }}>{err}</span> : null}
    </span>
  );
}

/**
 * 태그가 둘 이상의 서비스에 걸린 구성원(5차 M5·R14) — 서버는 정렬 첫 값으로 정했지만 조용히 이기지 않게 여기에 올린다.
 * '이대로 고정' 은 지금 판정을 사람이 확인한 것으로 남긴다(고정하면 이 목록에서 빠진다). 다른 서비스면 '한 대씩 고정' 으로.
 */
function TagAmbiguousCard({ q, svcName, writableOf, op, busy, corpName }) {
  const items = q.tagAmbiguous?.items || [];
  const n = q.tagAmbiguous?.n || 0;
  if (!n) return null;
  return (
    <div className="card" style={{ minWidth: 0 }}>
      <div className="flex wrap gap" style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', alignItems: 'center' }}>
        <b>태그가 둘 이상의 서비스에 걸림</b><span className="muted" style={{ fontSize: 12 }}>{n}대 · 태그 값 정렬 첫 값으로 정했습니다 — 맞으면 ‘이대로 고정’, 아니면 ‘한 대씩 고정’ 으로 고릅니다</span>
      </div>
      <STable className="table svcinv-t" minWidth={640}>
        <thead><tr><th>구성원 · 법인</th><th>지금 판정</th><th>태그 값</th><th data-nosort>조치</th></tr></thead>
        <tbody>{items.map((x) => (
          <tr key={x.key}>
            <td data-sort={x.name}><b>{x.name}</b><div className="svcinv-sub">{corpName(x.corp)}</div></td>
            <td>{svcName(x.serviceId)}</td>
            <td style={{ whiteSpace: 'normal', fontSize: 12 }}>{(x.tags || []).join(', ')}</td>
            <td>{writableOf(x.corp) ? <button type="button" className="logout-btn" style={btn} disabled={busy} onClick={() => op({ op: 'pins.set', corp: x.corp, keys: [x.key], serviceId: x.serviceId }, `${x.name} 을(를) ‘${svcName(x.serviceId)}’ 에 고정했습니다.`)}>이대로 고정</button> : <span className="muted">조회 전용</span>}</td>
          </tr>
        ))}</tbody>
      </STable>
      {n > items.length ? <div className="muted" style={{ padding: '8px 14px', fontSize: 12 }}>앞 {items.length}대만 보입니다(전체 {n}대).</div> : null}
    </div>
  );
}

/**
 * 옛 키로 저장된 고정(5차 R15) — 서버 키가 한 단계 올라(VM: moref → instanceUuid · 베어메탈: fleetId → 서비스태그) 고정이 옛 키에 남아 있다.
 * 판정은 이미 그 고정을 쓰므로 소속은 그대로다. '새 키로 옮기기' 는 법인마다 한 번에(사람이 누른다 — 읽기 경로는 쓰지 않는다).
 */
function AliasPinsCard({ q, svcName, writableOf, op, busy, corpName }) {
  const items = q.aliasPins?.items || [];
  const n = q.aliasPins?.n || 0;
  if (!n) return null;
  // '새 키로 옮기기' 는 옮길 것이 있는 법인만(서버 movable — 충돌만 남은 법인에는 할 일이 없다). 옛 서버 응답이면 전체 법인.
  const corps = q.aliasPins?.movable || q.aliasPins?.corps || [...new Set(items.map((x) => x.corp))];   // 200건에서 잘리기 전 전체 법인(4차 반증 8)
  const conflicts = items.filter((x) => x.state === 'conflict').length;
  return (
    <div className="card" style={{ minWidth: 0 }}>
      <div className="flex wrap gap" style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', alignItems: 'center' }}>
        <b>옛 키로 저장된 고정</b><span className="muted" style={{ fontSize: 12 }}>{n}건 · 서버 식별 키가 한 단계 올라(VM: moref → instanceUuid · 베어메탈: fleetId → 서비스태그) 고정이 옛 키에 남아 있습니다 — 옛 키만 있으면 소속은 그대로이고 옮기면 정리됩니다.
          새 키에도 고정이 있으면 판정은 새 키를 씁니다{conflicts ? <> — <b style={{ color: 'var(--amber)' }}>서비스가 다른 {conflicts}건</b>은 어느 쪽을 남길지 고르십시오(‘새 키로 옮기기’ 는 이 행을 건너뜁니다)</> : ''}.</span>
      </div>
      <STable className="table svcinv-t" minWidth={640} limit={50}>
        <thead><tr><th>구성원 · 법인</th><th>판정에 쓰는 고정</th><th>옛 키</th><th data-nosort>조치</th></tr></thead>
        <tbody>{items.map((x) => (
          <tr key={`${x.key}|${x.aliasKey}`}>
            <td data-sort={x.name}><b>{x.name}</b><div className="svcinv-sub">{corpName(x.corp)} · {x.kind === 'vm' ? 'VM' : '베어메탈'}</div></td>
            <td>{svcName(x.serviceId)}
              {x.state === 'conflict' ? <div><span className="badge amber" title="새 키 고정과 옛 키 고정의 서비스가 다릅니다 — 판정은 새 키를 쓰고 있습니다">충돌 — 옛 키: {svcName(x.aliasServiceId)}</span></div>
                : x.state === 'dup' ? <div><span className="badge gray" title="새 키에도 같은 서비스로 고정돼 있습니다 — 옛 키는 지워도 소속이 바뀌지 않습니다">중복(같은 서비스)</span></div>
                  : <div className="svcinv-sub">옛 키 고정을 쓰는 중</div>}</td>
            <td style={{ fontFamily: 'var(--mono)', fontSize: 12, wordBreak: 'break-all' }} title={isMaskedKey(x.aliasKey) ? MASKED_KEY_TITLE : undefined}>{keyText(x.aliasKey)}</td>
            <td>{!writableOf(x.corp) ? <span className="muted">조회 전용</span> : x.state === 'conflict' ? (
              <span className="flex wrap gap">
                <button type="button" className="logout-btn" style={btn} disabled={busy} title="새 키 고정을 남기고 옛 키 고정을 지웁니다(소속은 지금과 같습니다)" onClick={() => op({ op: 'pins.rekey', corp: x.corp, keys: [x.key], keepNew: true }, `${x.name}: 새 키 고정(‘${svcName(x.serviceId)}’)을 남기고 옛 키 고정을 지웠습니다.`)}>지금 것 유지</button>
                <button type="button" className="logout-btn" style={btn} disabled={busy} title="옛 키의 서비스로 새 키를 고정합니다(옛 키는 정리됩니다)" onClick={() => op({ op: 'pins.set', corp: x.corp, keys: [x.key], serviceId: x.aliasServiceId }, `${x.name} 을(를) 옛 키의 서비스 ‘${svcName(x.aliasServiceId)}’ 로 고정했습니다.`)}>옛 키 서비스로</button>
              </span>
            ) : x.state === 'dup' ? (
              <button type="button" className="logout-btn" style={btn} disabled={busy} onClick={() => op({ op: 'pins.rekey', corp: x.corp, keys: [x.key] }, `${x.name}: 중복된 옛 키 고정을 지웠습니다(소속은 그대로).`)}>옛 키 지우기</button>
            ) : <span className="muted" style={{ fontSize: 12 }}>아래 법인 단위로</span>}</td>
          </tr>
        ))}</tbody>
      </STable>
      <div className="flex wrap gap" style={{ padding: '8px 14px' }}>
        {corps.filter((c) => writableOf(c)).map((c) => (
          <button key={c} type="button" className="logout-btn" style={btn} disabled={busy} onClick={() => op({ op: 'pins.rekey', corp: c }, `${corpName(c)} 의 옛 키 고정을 새 키로 옮겼습니다(소속은 그대로).`)}>{corpName(c)} 새 키로 옮기기</button>
        ))}
      </div>
    </div>
  );
}

/**
 * 이름 규칙 둘 이상(다른 서비스)이 걸린 구성원(3차 반증 1) — 결과가 적용 순서에 달렸다. v2.894 에서 순서를 '등록 순' 에서 '접두·접미 > 포함 · 긴 값' 으로
 * 바꿨으므로 업그레이드 뒤 소속이 옮겨 간 구성원은 여기에 모두 있다. '이대로 고정' 은 지금 판정을 사람이 확인한 것으로 남긴다.
 */
function RuleOverlapCard({ q, svcName, writableOf, op, busy, corpName }) {
  const items = q.ruleOverlap?.items || [];
  const n = q.ruleOverlap?.n || 0;
  if (!n) return null;
  return (
    <div className="card" style={{ minWidth: 0 }}>
      <div className="flex wrap gap" style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', alignItems: 'center' }}>
        <b>이름 규칙이 겹침</b><span className="muted" style={{ fontSize: 12 }}>{n}대 · 다른 서비스로 가는 이름 규칙도 걸립니다 — 적용 순서(접두·접미 &gt; 포함 · 긴 값)로 정했습니다. 맞으면 ‘이대로 고정’, 아니면 규칙을 고치거나 ‘한 대씩 고정’</span>
      </div>
      <STable className="table svcinv-t" minWidth={640}>
        <thead><tr><th>구성원 · 법인</th><th>지금 판정(이긴 규칙)</th><th>함께 걸린 규칙</th><th data-nosort>조치</th></tr></thead>
        <tbody>{items.map((x) => (
          <tr key={x.key}>
            <td data-sort={x.name}><b>{x.name}</b><div className="svcinv-sub">{corpName(x.corp)} · {x.kind === 'vm' ? 'VM' : '베어메탈'}</div></td>
            <td>{svcName(x.serviceId)}<div className="svcinv-sub" style={{ fontFamily: 'var(--mono)' }}>{x.via}</div></td>
            <td style={{ whiteSpace: 'normal', fontSize: 12, fontFamily: 'var(--mono)' }}>{(x.others || []).join(', ')}</td>
            <td>{writableOf(x.corp) ? <button type="button" className="logout-btn" style={btn} disabled={busy} onClick={() => op({ op: 'pins.set', corp: x.corp, keys: [x.key], serviceId: x.serviceId }, `${x.name} 을(를) ‘${svcName(x.serviceId)}’ 에 고정했습니다.`)}>이대로 고정</button> : <span className="muted">조회 전용</span>}</td>
          </tr>
        ))}</tbody>
      </STable>
      {n > items.length ? <div className="muted" style={{ padding: '8px 14px', fontSize: 12 }}>앞 {items.length}대만 보입니다(전체 {n}대).</div> : null}
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
            onClick={() => op({ op: 'pins.clear', corp: c, keys: list.map((x) => x.key), onlyIfRedundant: true }, `${corpName(c)} 의 불필요한 고정을 지웠습니다 — 자동 판정 그대로 소속됩니다(그 사이 자동 판정이 바뀐 고정은 남깁니다).`)}>
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
  // 추가 입력칸은 '＋ 폴더 규칙'·'＋ 이름 규칙' 을 눌렀을 때만 연다(예약 2) · 행의 '대상 바꾸기' 는 한 행씩(예약 1-d — 지우고 다시 넣는 사이에 소속이 비지 않게 한 연산)
  const [adding, setAdding] = useState('');            // '' | 'folder' | 'name'
  const [edit, setEdit] = useState(null);              // { k, body, svc } | null
  useEffect(() => { setF((x) => ({ ...x, cat: tagCategory || '' })); }, [tagCategory]);
  useEffect(() => { setAdding(''); setEdit(null); }, [corp]);
  const svcs = corp ? servicesOf(corp) : [];
  const nameOf = (id) => svcs.find((s) => s.id === id)?.name || '?';
  const closeAdd = () => { setAdding(''); setF((x) => ({ ...x, prefix: '', svc: '', nv: '', nsvc: '', match: 'prefix' })); };
  /** 규칙 한 행의 '→ 서비스' 칸과 조치 칸. body = 그 규칙을 가리키는 연산 인자(update 는 serviceId 만 더한다). */
  const ruleCells = (k, serviceId, body, label) => (edit?.k === k ? (
    <>
      <td><Select className="select" value={edit.svc} onChange={(e) => setEdit({ ...edit, svc: e.target.value })} style={{ maxWidth: 200 }} aria-label="새 대상 서비스">{svcs.map((s) => <option key={s.id} value={s.id}>{svcLabel(s)}</option>)}</Select></td>
      <td><span className="flex wrap gap">
        <button type="button" className="login-btn" style={btn} disabled={busy || !edit.svc || edit.svc === serviceId} onClick={async () => { const r = await op({ ...body, op: body.op.replace('.remove', '.update'), serviceId: edit.svc }, `${label} 의 대상을 ‘${nameOf(edit.svc)}’ 로 바꿨습니다.`); if (r) setEdit(null); }}>저장</button>
        <button type="button" className="logout-btn" style={btn} onClick={() => setEdit(null)}>취소</button>
      </span></td>
    </>
  ) : (
    <>
      <td><b>{nameOf(serviceId)}</b></td>
      <td>{writable ? <span className="flex wrap gap">
        <button type="button" className="logout-btn" style={btn} disabled={busy || svcs.length < 2} title={svcs.length < 2 ? '이 법인에 다른 서비스가 없습니다' : '이 규칙이 가리키는 서비스를 바꿉니다(규칙 값은 그대로)'} onClick={() => setEdit({ k, svc: serviceId })}>대상 바꾸기</button>
        <button type="button" className="logout-btn" style={btn} disabled={busy} onClick={() => op(body, `${label} 을(를) 지웠습니다.`)}>지우기</button>
      </span> : null}</td>
    </>
  ));
  const ORDER = [
    ['고정(수동)', '한 대씩 추가한 지정. 자동 판정과 다르면 드리프트로 검토 탭에 오릅니다.'],
    ['vCenter 폴더 규칙(VM 1순위)', '정확한 vSphere 위치(‘/ERP/prod’ 꼴)의 ‘/’ 경계 접두 · 가장 긴 접두가 이깁니다 · 대소문자를 구분합니다(vSphere 폴더 이름이 구분하므로 ‘/ERP’ 와 ‘/erp’ 는 다른 폴더). 매 수집 주기로 반영됩니다.'],
    ['스캔 엔트리 라벨(베어메탈)', 'iDRAC 스캔 엔트리의 서비스 라벨 = 서비스명 또는 별칭.'],
    ['vSphere 태그(선택)', '전역 카테고리를 정하고 법인이 켰을 때만. 태그가 여럿이면 서비스(이름·별칭)에 걸리는 값을 고르고, 둘 이상의 서비스에 걸리면 검토 탭에 올립니다. 태그를 못 읽은 VM 은 ‘확인 안 됨’ 입니다.'],
    ['이름 규칙(선택)', '접두·접미·포함 3종(정규식 아님). 적용 순서는 등록 순이 아닙니다 — 접두·접미가 포함보다 먼저, 같은 종류면 긴 값 먼저, 그다음 등록 순(규칙 표의 ‘N번째’). 대소문자는 구분하지 않습니다.'],
  ];
  return (
    // 두 카드가 나란히 서려면 칸마다 460px — 1440px 에서는 위아래로 쌓아 규칙 표의 '지우기' 열이 가로 스크롤 뒤로 숨지 않게 한다(5차 3차 Chromium 실측 · 400px 은 min(…, 100%) 로 넘치지 않게)
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(460px, 100%), 1fr))', gap: 12, minWidth: 0 }}>
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
            <STable className="table" minWidth={560}>
              <thead><tr><th>종류</th><th>값</th><th>→ 서비스</th><th data-nosort /></tr></thead>
              <tbody>
                {(corpRow?.folderRules || []).map((r) => <tr key={`f${r.prefix}`}><td>폴더 접두</td><td style={{ fontFamily: 'var(--mono)' }}>{r.prefix}</td>{ruleCells(`f${r.prefix}`, r.serviceId, { op: 'rule.remove', corp, prefix: r.prefix }, `폴더 규칙 ‘${r.prefix}’`)}</tr>)}
                {(corpRow?.aliases || []).map((a) => <tr key={`a${a.kind}${a.value}`}><td>{a.kind === 'scan' ? '스캔 라벨 별칭' : '태그 별칭'}</td><td style={{ fontFamily: 'var(--mono)' }}>{a.value}</td>{ruleCells(`a${a.kind}${a.value}`, a.serviceId, { op: 'alias.remove', corp, kind: a.kind, value: a.value }, `별칭 ‘${a.value}’`)}</tr>)}
                {(corpRow?.nameRules || []).map((r) => <tr key={`n${r.match}${r.value}`}><td>이름 {r.match === 'prefix' ? '접두' : r.match === 'suffix' ? '접미' : '포함'}{r.order ? <span className="badge gray" style={{ marginLeft: 4 }} title="이름 규칙 적용 순서 — 접두·접미가 포함보다 먼저, 같은 종류면 긴 값 먼저, 그다음 등록 순">{r.order}번째</span> : null}</td><td style={{ fontFamily: 'var(--mono)' }}>{r.value}</td>{ruleCells(`n${r.match}${r.value}`, r.serviceId, { op: 'namerule.remove', corp, match: r.match, value: r.value }, `이름 규칙 ‘${r.value}’`)}</tr>)}
              </tbody>
            </STable>
            {writable ? (
              <div style={{ padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                {!adding ? (
                  <div className="flex wrap gap">
                    <button type="button" className="logout-btn" style={btn} disabled={!svcs.length} title={svcs.length ? undefined : '먼저 이 법인에 서비스를 만드십시오'} onClick={() => setAdding('folder')}>＋ 폴더 규칙</button>
                    <button type="button" className="logout-btn" style={btn} disabled={!svcs.length} title={svcs.length ? undefined : '먼저 이 법인에 서비스를 만드십시오'} onClick={() => setAdding('name')}>＋ 이름 규칙</button>
                  </div>
                ) : null}
                {adding === 'folder' ? (
                  <div className="flex wrap gap" style={{ alignItems: 'center' }}>
                    <span className="muted" style={{ fontSize: 12 }}>폴더 규칙</span>
                    <input className="input" autoFocus value={f.prefix} onChange={(e) => setF({ ...f, prefix: e.target.value })} placeholder="/ERP" style={{ maxWidth: 180 }} aria-label="vCenter 폴더 접두" />
                    <Select className="select" value={f.svc} onChange={(e) => setF({ ...f, svc: e.target.value })} style={{ maxWidth: 200 }} aria-label="서비스"><option value="">서비스 선택…</option>{svcs.map((s) => <option key={s.id} value={s.id}>{svcLabel(s)}</option>)}</Select>
                    <button type="button" className="login-btn" style={btn} disabled={busy || !f.prefix || !f.svc} onClick={async () => { const r = await op({ op: 'rule.add', corp, prefix: f.prefix, serviceId: f.svc }, `폴더 규칙 ‘${f.prefix}’ 을 만들었습니다.`); if (r) closeAdd(); }}>추가</button>
                    <button type="button" className="logout-btn" style={btn} onClick={closeAdd}>취소</button>
                  </div>
                ) : null}
                {adding === 'name' ? (
                  <div className="flex wrap gap" style={{ alignItems: 'center' }}>
                    <span className="muted" style={{ fontSize: 12 }}>이름 규칙</span>
                    <Select className="select" sort={false} value={f.match} onChange={(e) => setF({ ...f, match: e.target.value })} style={{ maxWidth: 110 }} aria-label="방식"><option value="prefix">접두</option><option value="suffix">접미</option><option value="contains">포함</option></Select>
                    <input className="input" autoFocus value={f.nv} onChange={(e) => setF({ ...f, nv: e.target.value })} placeholder="erp-" style={{ maxWidth: 140 }} aria-label="이름 규칙 값" />
                    <Select className="select" value={f.nsvc} onChange={(e) => setF({ ...f, nsvc: e.target.value })} style={{ maxWidth: 200 }} aria-label="서비스"><option value="">서비스 선택…</option>{svcs.map((s) => <option key={s.id} value={s.id}>{svcLabel(s)}</option>)}</Select>
                    <button type="button" className="login-btn" style={btn} disabled={busy || !f.nv || !f.nsvc} onClick={async () => { const r = await op({ op: 'namerule.add', corp, match: f.match, value: f.nv, serviceId: f.nsvc }, '이름 규칙을 만들었습니다.'); if (r) closeAdd(); }}>추가</button>
                    <button type="button" className="logout-btn" style={btn} onClick={closeAdd}>취소</button>
                  </div>
                ) : null}
              </div>
            ) : <div className="muted" style={{ padding: '8px 14px', fontSize: 12 }}>조회 전용 법인입니다.</div>}
          </>
        )}
      </div>
    </div>
  );
}
