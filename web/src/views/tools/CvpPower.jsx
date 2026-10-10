import React, { useEffect, useState } from 'react';
import BoldText from '../../components/boldText.jsx';
import { fetchJson } from '../../api.js';
import { Loading, ErrorBox, Kpi } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { agoText, countText } from './cvpText.js';
import { corpLabel } from './cvpOverviewText.js';
import { POWER_NOTE, wattText, powerKpis, basisText, powerEmptyNote, powerRowNote } from './cvpPowerText.js';
import { numOrNull } from '../../numOrNull.js';
import Select from '../../components/Select.jsx';

/**
 * CVP › 전력(v2.647 — 사용자 요청 '전체 네트워크 장비의 소비전력'). `/tools/cvp/power` 1회(폴링 금지 — 마운트 + 새로고침).
 * 합계는 값을 읽은 장비만 — 못 읽은 장비는 사유별 개수로 밝힌다.
 */
const NOTE = { fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6 };

export default function CvpPowerView({ servers = [], onOpen, initialData = null }) {
  // initialData 는 렌더 스모크 테스트용(서버 없이 계약 모양 응답으로 그린다) — 화면은 넘기지 않는다(마운트 때 읽는다).
  const [cvpId, setCvpId] = useState('');
  const [r, setR] = useState(initialData);
  const [err, setErr] = useState(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setErr(null);
    fetchJson('/tools/cvp/power', cvpId ? { cvpId } : {})
      .then((x) => { if (active) setR(x); }).catch((e) => { if (active) { setErr(e); setR(null); } });
    return () => { active = false; };
  }, [cvpId, reload]);
  const corps = r && Array.isArray(r.corps) ? r.corps : [];
  const models = r && Array.isArray(r.models) ? r.models : [];
  const devices = r && Array.isArray(r.devices) ? r.devices : [];
  const empty = r ? powerEmptyNote(r.totals) : '';
  const maxCorp = Math.max(0, ...corps.map((c) => c.watts || 0));
  return (
    <div style={{ display: 'grid', gap: 14, minWidth: 0 }}>
      <div className="card" style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <b>네트워크 장비 소비전력</b>
          {servers.length > 1 && (
            <Select className="input" value={cvpId} onChange={(e) => setCvpId(e.target.value)} style={{ maxWidth: 220 }}>
              <option value="">모든 CVP</option>
              {servers.map((s) => <option key={s.id} value={String(s.id)}>{s.name || s.id}</option>)}
            </Select>
          )}
          <button type="button" className="btn" style={{ marginLeft: 'auto' }} onClick={() => setReload((x) => x + 1)}>새로고침</button>
        </div>
        <div style={{ ...NOTE, marginTop: 6 }}><BoldText text={POWER_NOTE} /></div>
      </div>
      {err && <ErrorBox error={err} />}
      {!r && !err && <Loading />}
      {r && (
        <>
          <div className="kpis">
            {powerKpis(r.totals).map((k) => <Kpi key={k.key} label={k.label} value={k.value} accent={k.accent} meta={k.meta} />)}
          </div>
          {empty && <div className="banner"><BoldText text={empty} /></div>}
          <div className="card" style={{ minWidth: 0 }}>
            <b>법인별</b>
            {corps.length === 0 ? <div style={{ ...NOTE, marginTop: 6 }}>아직 수집된 장비가 없습니다.</div> : (
              <STable minWidth={640} style={{ marginTop: 8 }}>
                <thead><tr><th>법인</th><th>소비전력 합</th><th data-nosort>비교</th><th>읽은 장비</th><th>일부만 읽음</th></tr></thead>
                <tbody>
                  {corps.map((c) => (
                    <tr key={c.corpId || '(none)'}>
                      <td><b>{corpLabel(c)}</b></td>
                      <td className="right" data-sort={c.read ? c.watts : ''}>{c.read ? wattText(c.watts) : '—'}</td>
                      <td style={{ minWidth: 140 }}><div style={{ height: 6, borderRadius: 3, background: 'var(--border)' }}><div style={{ height: 6, borderRadius: 3, width: maxCorp && c.read ? `${(c.watts / maxCorp) * 100}%` : '0%', background: 'var(--accent)' }} /></div></td>
                      <td className="right" data-sort={c.read}>{countText(c.read)} / {countText(c.devices)}
                        {/* v2.732(그룹 i3): 서버 B2-03 — 부품 값이 오래된 장비는 합계에서 뺐다(읽은 장비 칸의 빈 자리를 설명한다) */}
                        {(numOrNull(c.stale) ?? 0) > 0 && <div style={{ fontSize: 11, color: 'var(--amber)' }}>오래된 값 {countText(c.stale)}대 제외</div>}
                      </td>
                      <td className="right" data-sort={c.partial}>{countText(c.partial)}</td>
                    </tr>
                  ))}
                </tbody>
              </STable>
            )}
          </div>
          <div className="card" style={{ minWidth: 0 }}>
            <b>모델별</b>
            <STable minWidth={560} style={{ marginTop: 8 }}>
              <thead><tr><th>모델</th><th>소비전력 합</th><th>장비당 평균</th><th>읽은 장비</th></tr></thead>
              <tbody>
                {models.map((m) => (
                  <tr key={m.model || '(none)'}>
                    <td style={{ fontSize: 12 }}>{m.model || '(모델 미상)'}</td>
                    <td className="right" data-sort={m.read ? m.watts : ''}>{m.read ? wattText(m.watts) : '—'}</td>
                    <td className="right" data-sort={m.avgW ?? ''}>{wattText(m.avgW)}</td>
                    <td className="right" data-sort={m.read}>{countText(m.read)} / {countText(m.devices)}</td>
                  </tr>
                ))}
              </tbody>
            </STable>
          </div>
          <div className="card" style={{ minWidth: 0 }}>
            <b>장비별</b> <span style={NOTE}>소비전력 큰 순</span>
            <STable minWidth={900} limit={1000} style={{ marginTop: 8 }}>
              <thead><tr><th>장비</th><th>모델</th><th>소비전력</th><th>PSU(읽음/장착)</th><th>기준</th><th>PSU 용량</th><th>법인</th><th>CVP</th><th>수집</th></tr></thead>
              <tbody>
                {devices.map((d) => (
                  <tr key={`${d.cvpId}|${d.key}`}>
                    <td><button type="button" onClick={() => onOpen?.({ cvpId: d.cvpId, key: d.key, hostname: d.hostname })}
                      style={{ background: 'none', border: 0, padding: 0, color: 'inherit', cursor: 'pointer', fontWeight: 600, textDecoration: 'underline dotted', textUnderlineOffset: 3 }}>{d.hostname || d.key}</button></td>
                    <td style={{ fontSize: 12 }}>{d.model || '—'}</td>
                    <td className="right" data-sort={d.watts ?? ''}><b>{wattText(d.watts)}</b>
                      {/* v2.732(그룹 i3): 서버 B2-03 — 지금 값이 아닌 장비는 소비전력 칸이 비어 있다. 왜 '—' 인지(사유·직전 값·합계 제외)를 행이 말한다 */}
                      {powerRowNote(d) && <div data-power-row-note="" style={{ fontSize: 11, color: 'var(--amber)', whiteSpace: 'normal', fontWeight: 400 }}>{powerRowNote(d)}</div>}
                    </td>
                    <td className="right" style={{ color: d.partial ? 'var(--amber)' : undefined }}>{d.psus == null ? '—' : `${countText(d.psuRead)} / ${countText(d.psus)}`}</td>
                    <td style={{ fontSize: 12 }}>{basisText(d.basis)}</td>
                    <td className="right" data-sort={d.capW ?? ''}>{wattText(d.capW)}</td>
                    <td style={{ fontSize: 12 }}>{corpLabel(d)}</td>
                    <td style={{ fontSize: 12 }}>{d.cvpName}</td>
                    <td style={{ fontSize: 12 }} data-sort={d.partsAt || 0}>{agoText(d.partsAt)}</td>
                  </tr>
                ))}
              </tbody>
            </STable>
            {devices.length > 1000 && <div style={{ ...NOTE, marginTop: 6 }}>표는 정렬 기준 상위 1,000대만 그립니다({countText(devices.length - 1000)}대 생략).</div>}
          </div>
        </>
      )}
    </div>
  );
}
