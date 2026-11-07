// v2.925(B-③): 호스트 상세 ‘네트워크’ 카드 — ESXi vmnic 드롭·에러(vCenter 실시간 최근 1시간)와 같은 창의 스위치(CVP) 포트 드롭을 나란히.
//   주기 수집이 아니라 버튼으로만 읽는다(vCenter 로그인 1회 · 고RTT 사이트에서 화면을 열 때마다 로그인하지 않게). 문구·판정은 hostNicText.js(순수).
import React, { useEffect, useRef, useState } from 'react';
import { fetchJson } from '../api.js';
import { ErrorBox } from '../components/ui.jsx';
import { STable } from '../components/STable.jsx';
import { countCell, countText, nicRows, nicSummary, verdictText, verdictTone } from './hostNicText.js';

export default function HostNicCounters({ hostId, uplinks = null }) {
  const [st, setSt] = useState({ loading: false, data: null, error: null });
  const seq = useRef(0);
  useEffect(() => { seq.current += 1; setSt({ loading: false, data: null, error: null }); }, [hostId]);   // 다른 호스트로 바뀌면 늦게 온 응답은 버린다

  const load = () => {
    const my = ++seq.current;
    setSt((s) => ({ ...s, loading: true, error: null }));
    fetchJson(`/hosts/${encodeURIComponent(hostId)}/nic-stats`)
      .then((d) => { if (my === seq.current) setSt({ loading: false, data: d, error: null }); })
      .catch((e) => { if (my === seq.current) setSt({ loading: false, data: null, error: e }); });
  };

  const cvp = Array.isArray(uplinks);
  const rows = st.data ? nicRows(st.data, cvp ? uplinks : null) : [];
  const sum = st.data ? nicSummary(st.data) : null;
  return (
    <div style={{ marginTop: 12 }}>
      <div className="flex wrap" style={{ alignItems: 'baseline', gap: 8, justifyContent: 'space-between' }}>
        <div style={{ fontSize: 12.5, minWidth: 0 }}><b>ESXi vmnic 드롭 · 에러</b> <span className="muted">{sum ? sum.text : 'vCenter 실시간 통계(최근 1시간)를 버튼으로 읽습니다'}</span></div>
        <button className="btn" disabled={st.loading} onClick={load}>{st.loading ? '읽는 중…' : st.data ? '다시 읽기' : 'vmnic 카운터 읽기'}</button>
      </div>
      {st.error && <div style={{ marginTop: 6 }}><ErrorBox error={st.error} /></div>}
      {sum?.notes?.map((t) => <div key={t} className="muted hd-note" style={{ marginTop: 4 }}>{t}</div>)}
      {rows.length > 0 && (
        <div className="table-wrap" style={{ marginTop: 6, maxHeight: '32vh' }}>
          <STable minWidth={cvp ? 980 : 640}>
            <thead><tr>
              <th>vmnic</th>
              <th style={{ textAlign: 'right' }} title="ESXi 가 받으면서 버린 패킷(net.droppedRx)">수신 드롭</th>
              <th style={{ textAlign: 'right' }} title="ESXi 가 보내면서 버린 패킷(net.droppedTx)">송신 드롭</th>
              <th style={{ textAlign: 'right' }}>수신 에러</th>
              <th style={{ textAlign: 'right' }}>송신 에러</th>
              <th style={{ textAlign: 'right' }}>패킷 수신 / 송신</th>
              {cvp && <>
                <th title="CVP 업링크 매칭(LLDP · MAC 테이블 · 포트 설명)으로 이 vmnic 에 붙은 스위치 포트">스위치 포트</th>
                <th style={{ textAlign: 'right' }} title="같은 1시간 스위치 discards — Out = 서버 쪽으로 보내다 버림 · In = 서버에서 받다 버림">스위치 드롭 Out / In</th>
              </>}
              <th title="수신 = 스위치 Out 드롭 ↔ ESXi 수신 드롭 · 송신 = 스위치 In 드롭 ↔ ESXi 송신 드롭. 양쪽 값이 같은 1시간에 다 있을 때만 판정합니다">어느 쪽 드롭</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => {
                const c = (k) => countCell(r, k);
                const tone = verdictTone(r);
                const why = [r.rx?.why && `수신: ${r.rx.why}`, r.tx?.why && `송신: ${r.tx.why}`].filter(Boolean).join('\n');
                return (
                  <tr key={r.nic}>
                    <td><b>{r.nic}</b></td>
                    {['droppedRx', 'droppedTx', 'errorsRx', 'errorsTx'].map((k) => (
                      <td key={k} style={{ textAlign: 'right' }} data-sort={r[k] ?? ''} title={c(k).title}>{c(k).text === '—' ? <span className="muted">—</span> : c(k).text}</td>
                    ))}
                    <td style={{ textAlign: 'right' }} className="muted" data-sort={r.packetsRx ?? ''}>{countText(r.packetsRx)} / {countText(r.packetsTx)}</td>
                    {cvp && <>
                      <td data-sort={r.port || ''}>{r.port ? r.port : <span className="muted">미매칭</span>}</td>
                      <td style={{ textAlign: 'right' }} data-sort={r.swRx ?? ''} title={r.swPartial ? '드롭 값이 없는 표본이 섞인 합입니다' : ''}>{r.port && !/^매칭 포트/.test(r.port) ? `${countText(r.swRx)} / ${countText(r.swTx)}${r.swPartial ? ' (일부)' : ''}` : <span className="muted">—</span>}</td>
                    </>}
                    <td data-sort={verdictText(r)} title={why}><span className={`badge ${tone}`}>{verdictText(r)}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </STable>
        </div>
      )}
    </div>
  );
}
