import React, { useEffect, useMemo, useRef, useState } from 'react';
import BoldText from '../../../components/boldText.jsx';
import { fetchJson } from '../../../api.js';
import { Loading, ErrorBox, Kpi } from '../../../components/ui.jsx';
import { STable } from '../../../components/STable.jsx';
import IfaceDevicePanel from './IfaceDevicePanel.jsx';
import { Seg, Legend, Strip, UtilBar, StateCell, SpeedCell, WhyDetail } from './ifaceParts.jsx';
import {
  RANGES, KINDS, UNITS, rateText, pctText, timeText, hourText,
  KIND_LABEL, flattenRows, kindMatch, textMatch, isProblem, kpisOf, sortVal, notesOf, groupByWhy, portWwn,
} from './ifaceText.js';

/**
 * 스토리지 모니터링 › 🔌 인터페이스(v3.35.0 — 사용자 요청 'Unity SAN/NAS 인터페이스의 속도 사용량 모니터링/트래킹' · 시안 docs/design/unity-iface ①).
 * 서버(GET /tools/storage/ifaces)가 판정까지 해서 주고, 여기는 그린다. 무거운 조회라 폴링하지 않는다(탭 열 때 1회 + 새로 고침).
 * 조건(기간)을 바꾸면 이전 요청을 끊고 늦게 온 응답은 버린다. 장비를 누르면 그 장비 화면(시안 ②)으로.
 */
const ifText = (r) => (r.kind === 'fc' ? (r.wwn ? `WWN ${portWwn(r.wwn)}` : '') : (r.ifs || []).map((x) => [x.nasServer || x.id, x.ip, x.vlan ? `VLAN ${x.vlan}` : ''].filter(Boolean).join(' ')).join(' · '));

export default function StorageIfacesView({ dcName = (x) => x || '미지정' }) {
  const [range, setRange] = useState('24h');
  const [kind, setKind] = useState('all');
  const [unit, setUnit] = useState('mbs');
  const [q, setQ] = useState('');
  const [onlyProblem, setOnlyProblem] = useState(false);
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);
  const [deviceId, setDeviceId] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const reqRef = useRef(0);
  const load = (rk = range) => {
    const my = ++reqRef.current;
    const ac = new AbortController();
    setLoading(true);
    fetchJson('/tools/storage/ifaces', { range: rk }, ac.signal)
      .then((r) => { if (my === reqRef.current) { setData(r); setErr(null); } })
      .catch((e) => { if (my === reqRef.current && e?.name !== 'AbortError') setErr(e); })
      .finally(() => { if (my === reqRef.current) setLoading(false); });
    return ac;
  };
  useEffect(() => { const ac = load(range); return () => ac.abort(); }, [range]); // eslint-disable-line react-hooks/exhaustive-deps

  const allRows = useMemo(() => flattenRows(data?.devices || [], dcName), [data, dcName]);
  const k = useMemo(() => kpisOf(data?.devices || [], allRows), [data, allRows]);
  const rows = useMemo(() => allRows.filter((r) => kindMatch(r, kind) && textMatch(r, q) && (!onlyProblem || isProblem(r)))
    .sort((a, b) => (b.peakPct ?? -1) - (a.peakPct ?? -1)), [allRows, kind, q, onlyProblem]);
  const problems = allRows.filter(isProblem).length;
  const nameOf = useMemo(() => new Map((data?.devices || []).map((d) => [d.id, d.name || d.id])), [data]);

  if (deviceId) return <IfaceDevicePanel deviceId={deviceId} range={range} onRange={setRange} unit={unit} onUnit={setUnit} dcName={dcName} onBack={() => setDeviceId(null)} />;
  if (err && !data) return <ErrorBox error={err.message || String(err)} />;
  if (!data) return <Loading label="인터페이스" />;

  const devs = data.devices || [];
  const methods = { ssh: devs.filter((d) => d.collectMethod === 'ssh').length, api: devs.filter((d) => d.collectMethod !== 'ssh').length };
  const collected = devs.map((d) => d.collectedAt).filter((x) => x != null);
  const ar = data.alertRules || {};
  const LIMIT = showAll ? 2000 : 40;   // 처음엔 40행(피크 높은 순) — '더 보기' 로 전부
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
      <div className="card" style={{ padding: '10px 14px', display: 'flex', gap: '8px 18px', flexWrap: 'wrap', alignItems: 'center', fontSize: 12.5 }}>
        <span><b>Unity {devs.length}대</b> <span className="muted">(SSH {methods.ssh} · REST {methods.api})</span></span>
        <span className="muted">포트 <b style={{ color: 'var(--text)' }}>{k.ports}</b> — FC {k.fc} · 이더넷 {k.eth}</span>
        <span className="muted">속도 · 구성은 장비 수집 때마다, 사용량은 REST 장비의 <b style={{ color: 'var(--text)' }}>5분 표본</b>입니다</span>
        <span style={{ flexGrow: 1 }} />
        {collected.length > 0 && <span className="muted" style={{ fontFamily: 'var(--mono)' }}>마지막 수집 {timeText(Math.min(...collected))} ~ {timeText(Math.max(...collected))}</span>}
        <button type="button" className="tab" style={{ flex: 'none', padding: '4px 12px' }} disabled={loading} onClick={() => load(range)}>{loading ? '읽는 중…' : '새로 고침'}</button>
      </div>
      {err && <ErrorBox error={`새로 고침 실패 — 아래는 직전 결과입니다: ${err.message || err}`} />}
      {data.registryError && <div className="badge amber" style={{ whiteSpace: 'normal', padding: '6px 10px' }}>장비 등록부를 읽지 못했습니다 — 목록이 비어 보일 수 있습니다.</div>}
      {data.addressHidden && <div className="muted" style={{ fontSize: 12 }}>관리자가 아니어서 장비 주소와 iSCSI · NAS 인터페이스 IP 는 가렸습니다.</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
        <Kpi label="포트" value={k.ports} meta={`링크 업 ${k.up} · 다운 ${k.down} · 미연결 ${k.unused}${k.unknown ? ` · 못 읽음 ${k.unknown}` : ''}`} />
        <Kpi label="속도 저하" value={k.slow} accent={k.slow ? 'var(--amber)' : undefined} meta="자동 협상인데 최대보다 낮음" onClick={k.slow ? () => setOnlyProblem(true) : undefined} />
        <Kpi label="포화 근접" value={k.busy} accent={k.busy ? 'var(--amber)' : undefined} meta={`기간 피크 ${pctText(data.busyPct)} 이상`} onClick={k.busy ? () => setOnlyProblem(true) : undefined} />
        <Kpi label="링크 다운" value={k.down} accent={k.down ? 'var(--red)' : undefined} meta="직전에 업이던 포트" onClick={k.down ? () => setOnlyProblem(true) : undefined} />
        <Kpi label="유휴" value={k.idle} meta={`링크 업 · 피크 ${pctText(data.idlePct)} 미만`} />
        <Kpi label="SP 편중" value={k.skew} unit="대" meta="한쪽 SP 처리량 70% 이상" />
        <Kpi label="사용량 못 읽음" value={k.unreadDevices} unit="대" meta={`${k.unreadPorts} 포트 · 정상에도 이상에도 넣지 않음`} />
      </div>

      {/* v3.36.1(사용자 신고 '사용량이 보이지 않음'): 사유를 표 **위에** 사유별로 묶어 근거와 함께 — 예전엔 40행 표 아래에 있어 보이지 않았고, 짝 실패는 사유가 비었다. */}
      {(groupByWhy(devs).length > 0 || devs.some((d) => !d.view)) && (
        <div className="card" style={{ padding: '10px 14px', fontSize: 12.5, display: 'flex', flexDirection: 'column', gap: 10, borderColor: 'rgba(245,158,11,.45)' }}>
          <b style={{ fontSize: 13 }}>사용량을 못 읽는 장비 {groupByWhy(devs).reduce((a, [, l]) => a + l.length, 0)}대 — 사유별</b>
          {groupByWhy(devs).map(([why, list]) => (
            <div key={why} style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 8, borderTop: '1px solid var(--border-soft, #1f2a40)' }}>
              <span className="flex gap" style={{ flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                <span className="badge amber">{list.length}대</span>
                {list.map((d) => <button key={d.id} type="button" className="tab" style={{ flex: 'none', padding: '2px 9px', fontSize: 12 }} onClick={() => setDeviceId(d.id)}>{d.name || d.id}</button>)}
              </span>
              <WhyDetail why={why} detail={list[0].view.throughputDetail} />
              {list.length > 1 && <span className="muted" style={{ fontSize: 11.5 }}>근거는 첫 장비({list[0].name || list[0].id})의 것입니다 — 다른 장비는 이름을 눌러 장비 화면에서 확인하세요.</span>}
            </div>
          ))}
          {devs.filter((d) => !d.view).map((d) => <span key={d.id}>{d.name || d.id}<span className="muted"> — 화면을 만들지 못했습니다(서버 오류)</span></span>)}
        </div>
      )}

      <div className="flex gap" style={{ flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
        <Seg label="기간" items={RANGES} value={range} onPick={setRange} />
        <Seg label="종류" items={KINDS} value={kind} onPick={setKind} />
        <Seg label="단위" items={UNITS} value={unit} onPick={setUnit} />
        <input className="input" style={{ width: 220, maxWidth: '100%' }} placeholder="장비 · 포트 · IP · NAS 서버 검색" aria-label="검색" value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="button" className={onlyProblem ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '4px 12px' }} aria-pressed={onlyProblem} onClick={() => setOnlyProblem(!onlyProblem)}>문제만 보기 {problems}</button>
        <span style={{ flexGrow: 1 }} />
        <Legend />
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '10px 14px', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'baseline', borderBottom: '1px solid var(--border-soft, #1f2a40)' }}>
          <b>인터페이스 포트</b>
          <span className="muted" style={{ fontSize: 12 }}>
            {rows.length}개{rows.length > LIMIT ? ` 중 ${LIMIT}개 표시` : ''} · 기간 피크 높은 순 · 제목을 누르면 정렬 · 장비 이름을 누르면 그 장비 화면
          </span>
        </div>
        {rows.length === 0 ? (
          <div className="muted" style={{ padding: 16 }}>
            {devs.length === 0 ? '등록된 Unity 장비가 없습니다.' : allRows.length === 0 ? '아직 포트 구성을 읽은 장비가 없습니다 — 다음 수집을 기다리거나 장비 화면의 수집 출처에서 사유를 확인하세요.' : '조건에 맞는 포트가 없습니다.'}
          </div>
        ) : (
          <STable minWidth={1360} limit={LIMIT}>
            <thead><tr>
              <th>법인</th><th>장비</th><th>포트</th><th>종류</th><th>링크 속도</th><th>상태</th>
              <th style={{ textAlign: 'right' }}>읽기</th><th style={{ textAlign: 'right' }}>쓰기</th><th>최근 5분 사용률</th>
              <th style={{ textAlign: 'right' }}>기간 피크</th><th style={{ textAlign: 'right' }}>평균</th><th data-nosort>{RANGES.find(([x]) => x === range)?.[1]} (칸 = 피크)</th><th>인터페이스 · WWN</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.deviceId}:${r.id}`}>
                  <td>{r.corp}</td>
                  <td><button type="button" className="link-btn" style={{ background: 'none', border: 0, color: 'var(--accent)', cursor: 'pointer', padding: 0, font: 'inherit' }} onClick={() => setDeviceId(r.deviceId)}>{r.deviceName}</button></td>
                  <td style={{ fontFamily: 'var(--mono)' }}>{r.id}</td>
                  <td><span className={`badge ${r.portKind === 'fc' ? 'blue' : r.portKind === 'eth' ? 'gray' : 'teal'}`}>{KIND_LABEL[r.portKind]}</span></td>
                  <td data-sort={sortVal(r.speedGbps)}><SpeedCell r={r} /></td>
                  <td><StateCell r={r} /></td>
                  <td data-sort={sortVal(r.readBps)} style={{ textAlign: 'right', fontFamily: 'var(--mono)' }}>{rateText(r.readBps, unit)}</td>
                  <td data-sort={sortVal(r.writeBps)} style={{ textAlign: 'right', fontFamily: 'var(--mono)' }}>{rateText(r.writeBps, unit)}</td>
                  <td data-sort={sortVal(r.nowPct)}><UtilBar pct={r.nowPct} /></td>
                  <td data-sort={sortVal(r.peakPct)} style={{ textAlign: 'right' }}>
                    <span style={{ fontFamily: 'var(--mono)', color: r.peakPct != null && r.peakPct >= data.busyPct ? '#fdba74' : undefined, fontWeight: r.peakPct != null && r.peakPct >= data.busyPct ? 700 : undefined }}>{pctText(r.peakPct)}</span>
                    {r.peakAt && <span className="muted" style={{ fontSize: 11, marginLeft: 4 }}>{hourText(r.peakAt)}</span>}
                  </td>
                  <td data-sort={sortVal(r.avgPct)} style={{ textAlign: 'right', fontFamily: 'var(--mono)' }}>{pctText(r.avgPct)}</td>
                  <td data-nosort><Strip cells={r.cells} label={`${r.id} 기간 칸별 피크 사용률`} /></td>
                  <td className="muted" style={{ fontSize: 12, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' }} title={ifText(r)}>{ifText(r) || '—'}</td>
                </tr>
              ))}
            </tbody>
          </STable>
        )}
        {rows.length > 40 && (
          <div style={{ padding: '8px 14px', borderTop: '1px solid var(--border-soft, #1f2a40)', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <button type="button" className="tab" style={{ flex: 'none', padding: '4px 12px' }} onClick={() => setShowAll(!showAll)}>{showAll ? '처음 40개만' : `더 보기(${rows.length - LIMIT})`}</button>
            <span className="muted" style={{ fontSize: 12 }}>‘—’ 는 0 이 아닙니다 — 값을 읽지 못했거나 링크가 내려가 있습니다.</span>
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 420px), 1fr))', gap: 12 }}>
        <div className="card" style={{ padding: 0, overflow: 'hidden', minWidth: 0 }}>
          <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border-soft, #1f2a40)', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'baseline' }}>
            <b>속도 · 링크 변화 이력</b>
            <span className="muted" style={{ fontSize: 12 }}>최근 30일 · 시각은 변화를 처음 본 수집 시각(수집 주기만큼 늦을 수 있음){data.changesTruncated ? ' · 최근 200건만' : ''}</span>
          </div>
          {(data.changes || []).length === 0 ? <div className="muted" style={{ padding: 14, fontSize: 12.5 }}>기록된 변화가 없습니다. 두 수집 사이에 내려갔다 올라온 변화는 남지 않습니다.</div> : (
            <STable minWidth={560}>
              <thead><tr><th>처음 본 시각</th><th>장비</th><th>포트</th><th>변화</th></tr></thead>
              <tbody>
                {data.changes.map((c, i) => (
                  <tr key={i}>
                    <td data-sort={String(c.ts)} style={{ fontFamily: 'var(--mono)' }}>{timeText(c.ts)}</td>
                    <td><button type="button" style={{ background: 'none', border: 0, color: 'var(--accent)', cursor: 'pointer', padding: 0, font: 'inherit' }} onClick={() => setDeviceId(c.deviceId)}>{nameOf.get(c.deviceId) || c.deviceId}</button></td>
                    <td style={{ fontFamily: 'var(--mono)' }}>{c.port}</td>
                    <td><span style={{ fontFamily: 'var(--mono)' }}>{c.before === 'down' ? '링크 다운' : c.before} → {c.after === 'down' ? '링크 다운' : c.after}</span></td>
                  </tr>
                ))}
              </tbody>
            </STable>
          )}
        </div>
        <div className="card" style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
          <b>이 표를 읽는 법</b>
          <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12.5 }}>
            {notesOf(data).map((t, i) => <li key={i}><BoldText text={t} /></li>)}
          </ul>
          <span className="muted" style={{ fontSize: 12 }}>
            알림(설정 › 알림): 링크 다운 {ar.down ? '켬' : '끔'} · 속도 저하 {ar.slow ? '켬' : '끔'} · 사용률 {ar.busy ? `켬(${pctText(data.busyPct)} 이상)` : '끔'}
          </span>
        </div>
      </div>
    </div>
  );
}
