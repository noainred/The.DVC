/**
 * NodeClientsDrawer — 노드 드로어(v2.932 2차 ③ · 사용자 요청 "특정 노드를 클릭하면 그 노드에서 연결된 클라이언트가 어떤 프로토콜을 사용해서 노드를 사용하고 있는지").
 *  · 데이터는 서버 DB 만 읽는다(`/node-clients` — 장비 호출 0). 마운트·조작 때 1회 — 폴링하지 않는다. 늦게 온 이전 응답은 버린다(seq).
 *  · 모달 안의 모달이 아니라 노드 부하 구역 안에 펼치는 구획이다(장비 상세 모달 위에 모달을 겹치지 않는다).
 *  · 판정·문구는 nodeLoadText.js(순수 — vitest). 훅은 조기 return 위에 둔다(React #310).
 */
import React, { useEffect, useRef, useState } from 'react';
import { fetchJson } from '../../../api.js';
import { STable } from '../../../components/STable.jsx';
import { opsText, latText, rateText, shareText, clientNameText, lateNote, drawerNotes, latestMapOf, protoSummaryOf, sampleText, colText } from './nodeLoadText.js';

const RANGES = [{ key: '24h', label: '24시간' }, { key: '7d', label: '7일' }];

export default function NodeClientsDrawer({ deviceId, node, end = null, offsetMin = 540, onClose, onOverlay, scrollKey = null }) {
  const [range, setRange] = useState('24h');
  const rootRef = useRef(null);
  // v2.939: 바깥(노드 표 ID 열)이 열었으면 드로어 자체를 화면 위로 — 구역 머리를 올리면 400px 에서 드로어가 뷰 아래로 밀렸다(Chromium 판독).
  useEffect(() => {
    if (scrollKey == null) return;
    try { rootRef.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' }); } catch { /* 테스트 환경 */ }
  }, [scrollKey]);
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  useEffect(() => {
    const my = ++seq.current;
    setBusy(true); setErr(null);
    const q = `node=${encodeURIComponent(node)}&range=${encodeURIComponent(range)}${end != null ? `&end=${end}` : ''}`;
    fetchJson(`/tools/storage/devices/${encodeURIComponent(deviceId)}/node-clients?${q}`)
      .then((r) => { if (my === seq.current) { setD(r); setBusy(false); } })
      .catch((e) => { if (my === seq.current) { setErr(e); setBusy(false); } });
  }, [deviceId, node, range, end]);
  // 다른 노드·장비의 늦은 응답을 이 노드 값처럼 그리지 않는다.
  const ready = d && d.ok !== false && d.deviceId === deviceId && d.node === node;
  const late = ready ? lateNote(d) : null;
  const notes = ready ? drawerNotes(d) : [];
  const nowMap = ready ? latestMapOf(d) : new Map();
  const protos = ready ? protoSummaryOf(d.protos) : [];
  const fixedN = ready ? d.clients.filter((c) => c.fixed).length : 0;
  return (
    <section className="nl-drawer" aria-label={`노드 ${node} 클라이언트`} ref={rootRef}>
      <div className="nl-drawerhead">
        <b>노드 {node} · 클라이언트와 프로토콜</b>
        <div className="nl-seg" role="group" aria-label="드로어 기간">
          {RANGES.map((r) => <button key={r.key} type="button" className={range === r.key ? 'on' : ''} aria-pressed={range === r.key} onClick={() => setRange(r.key)}>{r.label}</button>)}
        </div>
        {onOverlay && <button type="button" className="nl-btn" onClick={() => onOverlay(node)}>겹쳐 보기에 넣기</button>}
        {busy && <span className="nl-muted">불러오는 중…</span>}
        <button type="button" className="nl-btn nl-close" onClick={onClose}>닫기</button>
      </div>
      {err && <div className="nl-banner amber">클라이언트 조회 오류: {String(err?.message || err)}</div>}
      {late && <div className={`nl-banner ${late.tone}`}>{late.text}</div>}
      {ready && (
        <>
          <div className="nl-tiles">
            <div className="nl-tile"><span className="nl-tlabel">창의 클라이언트</span><b>{d.clients.length}</b>
              <span className="nl-muted">{d.range === '7d' ? '7일' : '24시간'} 안에 이 노드로 요청을 보낸 주소 · 고정 {fixedN}</span></div>
            <div className="nl-tile"><span className="nl-tlabel">지금(마지막 표본)</span><b>{d.latest.ts != null ? d.latest.rows.length : '—'}</b>
              <span className="nl-muted">{d.latest.ts != null ? `${colText(d.latest.ts, 'raw', 0, offsetMin)} · 상위 ${d.latest.rows.length}` : (d.past ? '과거 구간에는 ‘지금’ 이 없습니다' : '이 창 안에 표본이 없습니다')}</span></div>
            <div className="nl-tile"><span className="nl-tlabel">프로토콜 · 창 평균 ops/s</span>
              <b>{protos.length ? protos.map((p) => `${p.proto} ${opsText(p.ops).replace(' ops/s', '')}`).join(' · ') : '—'}</b>
              <span className="nl-muted">{protos.length ? `지연 ${protos.map((p) => `${p.proto} ${latText(p.lat)}`).join(' · ')}` : '프로토콜 표본 없음'}</span></div>
          </div>
          {notes.map((n) => <div key={n.text} className={`nl-banner ${n.tone}`}>{n.text}</div>)}
          {d.clients.length > 0 && (
            <div className="table-wrap nl-tablewrap">
              <STable minWidth={820}>
                <thead><tr>
                  <th>클라이언트</th><th>이름</th><th>프로토콜</th>
                  <th style={{ textAlign: 'right' }} title="마지막 표본의 값">지금 ops/s</th>
                  <th style={{ textAlign: 'right' }} title="창의 시간 요약 평균">창 평균 ops/s</th>
                  <th style={{ textAlign: 'right' }}>In</th><th style={{ textAlign: 'right' }}>Out</th>
                  <th style={{ textAlign: 'right' }}>지연</th>
                  <th style={{ textAlign: 'right' }} title="이 클라이언트가 창 동안 낸 ops 중 이 노드 몫">이 노드 비중</th>
                  <th>다른 노드</th>
                </tr></thead>
                <tbody>
                  {d.clients.map((c) => {
                    const now = nowMap.get(`${c.client}|${c.proto || ''}`);
                    const nm = clientNameText(c);
                    return (
                      <tr key={`${c.client}|${c.proto}`}>
                        <td className="nl-mono">{c.client}</td>
                        <td title={nm.hint}>{nm.text}{c.fixed ? <span className="nl-badge" title="창 ops 의 기준 비중 이상을 이 노드에 보냈습니다">고정</span> : null}</td>
                        <td>{c.proto || '—'}</td>
                        <td className="nl-num" data-sort={String(now?.ops ?? '')}>{now ? opsText(now.ops) : '—'}</td>
                        <td className="nl-num" data-sort={String(c.ops ?? '')}>{opsText(c.ops)}</td>
                        <td className="nl-num" data-sort={String(c.in ?? '')}>{rateText(c.in)}</td>
                        <td className="nl-num" data-sort={String(c.out ?? '')}>{rateText(c.out)}</td>
                        <td className="nl-num" data-sort={String(c.lat ?? '')}>{latText(c.lat)}</td>
                        <td className="nl-num" data-sort={String(c.share ?? '')}>{shareText(c.share)}</td>
                        <td className="nl-muted">{c.otherNodes?.length ? c.otherNodes.map((n) => `노드 ${n}`).join(', ') : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </STable>
            </div>
          )}
          <div className="nl-note">읽는 법 — ‘지금’ 은 마지막 표본의 순간값, ‘창 평균’ 은 표본들의 시간 요약 평균입니다(표본 주기 {sampleText(d.sample?.sampleMs)}). 통계에는 그 순간 요청을 보낸 클라이언트만 잡힙니다. 이름은 포탈 인벤토리에서만 붙입니다(역방향 DNS 없음). 지연 단위(µs→ms)는 실장비 확인 전 가정입니다.</div>
        </>
      )}
    </section>
  );
}
