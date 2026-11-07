// v2.934(SAN·CVP 설계 C-③): VM 상세 ‘네트워크 위치(CVP)’ 카드 — vNIC MAC 마다 CVP EndpointLocation 이 답한 스위치 · 포트 · VLAN · 학습 시각과
//   지금 호스트 업링크와의 일치 여부. 열 때 1회 + 버튼(지금 조회 — admin · operator). 늦게 온 이전 응답은 버린다. 문구는 vmCvpLocText.js(순수).
import React, { useEffect, useRef, useState } from 'react';
import { fetchJson, postJson } from '../../api.js';
import { ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { Card, Note } from './VcdParts.jsx';
import { locRows, locSummary } from './vmCvpLocText.js';
import { epLocateText } from '../hostNetText.js';

export default function VmCvpLocation({ vmId }) {
  const [st, setSt] = useState({ d: null, error: null });
  const [loc, setLoc] = useState({ busy: false, text: '', error: '' });
  const seq = useRef(0);
  const load = () => {
    const my = ++seq.current;
    fetchJson(`/vms/${encodeURIComponent(vmId)}/endpoint-locations`)
      .then((d) => { if (my === seq.current) setSt({ d, error: null }); })
      .catch((e) => { if (my === seq.current) setSt({ d: null, error: e }); });
  };
  useEffect(() => { setSt({ d: null, error: null }); setLoc({ busy: false, text: '', error: '' }); load(); }, [vmId]); // eslint-disable-line react-hooks/exhaustive-deps
  const locate = () => {
    setLoc({ busy: true, text: '', error: '' });
    postJson(`/vms/${encodeURIComponent(vmId)}/endpoint-locate`, {})
      .then((r) => { setLoc({ busy: false, text: epLocateText(r), error: '' }); load(); })
      .catch((e) => setLoc({ busy: false, text: '', error: e?.message || String(e) }));
  };
  const d = st.d;
  const rows = locRows(d);
  return (
    <Card style={{ gridColumn: '1 / -1' }} title="네트워크 위치(CVP)" sub={d ? locSummary(d) : 'CVP EndpointLocation'}>
      <div style={{ padding: '8px 14px 0' }}>
        {st.error ? <ErrorBox error={st.error} /> : !d ? <div className="muted" style={{ fontSize: 12.5 }}>읽는 중…</div> : (
          <>
            <div className="flex wrap" style={{ alignItems: 'center', gap: '4px 10px', marginBottom: 8, fontSize: 12 }}>
              {d.canLocate ? <button type="button" className="btn" disabled={loc.busy} onClick={locate} title="이 VM 의 vNIC MAC 을 CVP EndpointLocation 에 지금 묻습니다(위임 CVP 는 담당 엣지에 요청)">{loc.busy ? '묻는 중…' : 'CVP 위치 조회 · 지금'}</button> : null}
              {loc.text ? <span className="muted" style={{ minWidth: 0 }}>{loc.text}</span> : null}
              {loc.error ? <span style={{ color: 'var(--red)', minWidth: 0 }}>조회 실패: {loc.error}</span> : null}
            </div>
            {rows.length > 0 && (
              <div className="table-wrap">
                <STable minWidth={720}>
                  <thead><tr><th>vNIC</th><th>호스트 업링크와</th><th>CVP 위치(스위치 · 포트)</th><th>VLAN</th><th>학습</th><th>MAC</th></tr></thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.key}>
                        <td><b>{r.label}</b></td>
                        <td data-sort={r.v.label} title={[r.note || r.v.note, r.reason].filter(Boolean).join(' — ')}><span className={`badge ${r.v.tone}`}>{r.v.label}</span>{r.note ? <div className="muted" style={{ fontSize: 11, maxWidth: 240, overflowWrap: 'anywhere' }}>{r.note}</div> : null}</td>
                        <td data-sort={r.where}>{r.where}</td>
                        <td>{r.vlan}</td>
                        <td className="muted">{r.learned}</td>
                        <td className="mono muted" style={{ fontSize: 11 }}>{r.mac}</td>
                      </tr>
                    ))}
                  </tbody>
                </STable>
              </div>
            )}
          </>
        )}
      </div>
      <Note>CVP 가 MAC · ARP · LLDP 표를 모아 답한 ‘지금 배운 곳’ 입니다(경로 · 필드는 공개 문서 기준 추정). 불일치는 vMotion 직후 옛 위치일 수 있으니 학습 시각을 함께 보세요.</Note>
    </Card>
  );
}
