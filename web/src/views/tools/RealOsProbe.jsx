// RealOsProbe.jsx — '실제 OS 수집 점검'(v3.54 · 실제 OS 1단계 실측). 실제 OS 확인 도구(GuestOsTools.jsx RealOs) 맨 위 카드.
// VMware Tools 가 스스로 보고한 실제 설치 OS(게스트 계정 불필요)가 법인별로 얼마나 채워지는지 · 어떤 글자로 오는지를 보여 주고,
// 응답 그대로 JSON 파일로 내려받게 한다(VM 이름 없음 — 종류 · 버전 · 개수). 무거운 집계가 아니어도 상시 폴링하지 않는다(마운트 1회 + 버튼).
import React, { useEffect, useRef, useState } from 'react';
import { fetchJson } from '../../api.js';
import { STable } from '../../components/STable.jsx';
import { saveText } from '../../util/saveBlob.js';
import { Card } from './shared.jsx';
import { REASON_TEXT, n, pct, at, statusText, topText, probeFileName } from './realOsProbeText.js';

export function RealOsProbe({ scope }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const gen = useRef(0);
  const load = () => {
    const g = ++gen.current;
    setBusy(true);
    const qs = scope ? `?${new URLSearchParams({ vcenterId: scope })}` : '';
    return fetchJson(`/admin/os-scan/probe${qs}`)
      .then((r) => { if (g !== gen.current) return; setData(r); setErr(null); })
      .catch((e) => { if (g !== gen.current) return; setErr(e?.message || String(e)); })
      .finally(() => { if (g === gen.current) setBusy(false); });
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- load 는 scope 만 읽는다(범위가 바뀔 때 1회)
  useEffect(() => { setData(null); load(); }, [scope]);

  const t = data?.total || null;
  const all = t ? t.vms + t.templates : null;
  const reasons = data ? Object.entries(data.noDetail || {}).filter(([, c]) => c > 0) : [];
  const save = () => { if (data) saveText(JSON.stringify(data, null, 2), probeFileName(), { type: 'application/json;charset=utf-8' }); };

  return (
    <div className="card" style={{ padding: 14, marginBottom: 14, minWidth: 0 }}>
      <div className="flex gap wrap" style={{ alignItems: 'center', marginBottom: 6 }}>
        <b style={{ fontSize: 14, marginRight: 'auto' }}>VMware Tools 보고 수집 점검 — 실제 설치 OS 1단계</b>
        <button className="logout-btn" style={{ flex: 'none', padding: '7px 14px' }} disabled={busy} onClick={load}>{busy ? '읽는 중…' : '다시 읽기'}</button>
        <button className="login-btn" style={{ flex: 'none', padding: '7px 14px' }} disabled={!data} onClick={save}>JSON 내려받기</button>
      </div>
      <p className="muted" style={{ fontSize: 12, margin: '0 0 10px', lineHeight: 1.6, whiteSpace: 'normal' }}>
        게스트 계정 없이 VMware Tools 가 스스로 보고한 실제 설치 OS(vCenter 8.0.2 이상 · Tools 11.2 이상)를 6시간 주기로 모읍니다.
        이 카드는 그 값이 법인별로 얼마나 채워지는지와 실제로 어떤 글자로 오는지를 보여 줍니다. 내려받은 파일에는 VM 이름이 없고 종류 · 버전 · 개수만 있습니다.
      </p>
      {err && <div className="banner warn" style={{ marginBottom: 8 }}>점검 결과를 읽지 못했습니다: {err}{data ? ' — 아래는 직전에 받은 결과입니다.' : ''}</div>}
      {!data ? (!err && <div className="muted" style={{ fontSize: 12 }}>읽는 중…</div>) : (
        <>
          <div className="kpis" style={{ marginBottom: 10 }}>
            <Card label="VM · 템플릿" value={n(all)} meta={`켜짐 ${n(t.poweredOn)}`} />
            <Card label="Tools 보고 있음" value={n(t.detailed)} meta={`${pct(t.detailed, all)} · 꺼진 VM ${n(t.detailedOff)}`} />
            <Card label="Tools 11.2 이상" value={n(t.tools112)} meta={`판을 아는 VM ${n(t.toolsKnown)}`} />
            <Card label="어플라이언스 제품 정보" value={n(t.vapp)} meta={`시스템 VM ${n(t.managed)}`} />
          </div>
          {reasons.length > 0 && (
            <div className="flex gap wrap" style={{ marginBottom: 10, fontSize: 12, alignItems: 'center' }}>
              <span className="muted">보고 없음 사유</span>
              {reasons.map(([k, c]) => <span key={k} className="badge gray" title={k}>{REASON_TEXT[k] || k} {n(c)}</span>)}
            </div>
          )}

          <div style={{ fontSize: 12.5, fontWeight: 700, margin: '6px 0' }}>법인별 수집 현황</div>
          <div style={{ overflowX: 'auto', marginBottom: 12 }}>
            <STable className="v3-table" minWidth={1100}>
              <thead><tr>
                <th>vCenter</th><th>판</th><th className="right">VM</th><th className="right">켜짐</th><th className="right">Tools 실행</th>
                <th className="right">Tools 11.2+</th><th className="right">보고 있음</th><th className="right">보고율</th><th className="right">제품 정보</th><th className="right">시스템 VM</th><th>수집 상태</th>
              </tr></thead>
              <tbody>
                {(data.vcenters || []).map((r) => {
                  const total = r.vms + r.templates;
                  const s = statusText(r.status);
                  return (
                    <tr key={r.id}>
                      <td><b>{r.name || r.id}</b></td>
                      <td className="muted">{r.version || '—'}</td>
                      <td className="right tabular" data-sort={total}>{n(total)}</td>
                      <td className="right tabular" data-sort={r.poweredOn}>{n(r.poweredOn)}</td>
                      <td className="right tabular" data-sort={r.toolsRunning}>{n(r.toolsRunning)}</td>
                      <td className="right tabular" data-sort={r.tools112}>{n(r.tools112)}</td>
                      <td className="right tabular" data-sort={r.detailed}><b>{n(r.detailed)}</b></td>
                      <td className="right tabular" data-sort={total ? r.detailed / total : ''}>{pct(r.detailed, total)}</td>
                      <td className="right tabular" data-sort={r.vapp}>{n(r.vapp)}</td>
                      <td className="right tabular" data-sort={r.managed}>{n(r.managed)}</td>
                      <td style={{ whiteSpace: 'normal', minWidth: 180, fontSize: 12, color: s.tone === 'amber' ? 'var(--amber)' : undefined }} className={s.tone === 'muted' ? 'muted' : ''}>{s.text}</td>
                    </tr>
                  );
                })}
              </tbody>
            </STable>
          </div>

          <div style={{ fontSize: 12.5, fontWeight: 700, margin: '6px 0' }}>
            Tools 가 보고한 OS 종류 · 버전 <span className="muted" style={{ fontWeight: 500 }}>{n((data.samples || []).length)}가지{data.samplesOmitted ? ` · 상한으로 ${n(data.samplesOmitted)}가지 생략(파일에도 없음)` : ''}</span>
          </div>
          <div style={{ overflowX: 'auto', marginBottom: 12 }}>
            <STable className="v3-table" minWidth={1060} limit={50}>
              <thead><tr>
                <th>보고된 이름</th><th>계열</th><th>배포판</th><th>버전</th><th className="right">VM</th><th className="right">켜짐</th><th className="right">법인</th>
                <th data-nosort>vCenter 설정값(상위)</th><th data-nosort>커널 · 빌드(상위)</th>
              </tr></thead>
              <tbody>
                {(data.samples || []).map((r, i) => (
                  <tr key={`${r.prettyName}-${r.distroVersion}-${i}`}>
                    <td style={{ whiteSpace: 'normal', minWidth: 220 }}><b>{r.prettyName || '—'}</b>{r.appliance ? <span className="badge gray" style={{ marginLeft: 6 }} title="OVF 제품 정보가 있는 VM">어플라이언스 {n(r.appliance)}</span> : null}{r.managed ? <span className="badge gray" style={{ marginLeft: 6 }} title="vSphere 확장이 관리하는 VM(복제본 · vCLS 등)">확장 관리 {n(r.managed)}</span> : null}</td>
                    <td>{r.familyName || '—'}</td>
                    <td>{r.distroName || '—'}</td>
                    <td className="tabular">{r.distroVersion || '—'}</td>
                    <td className="right tabular" data-sort={r.count}>{n(r.count)}</td>
                    <td className="right tabular" data-sort={r.poweredOn}>{n(r.poweredOn)}</td>
                    <td className="right tabular" data-sort={r.vcenters}>{n(r.vcenters)}</td>
                    <td style={{ whiteSpace: 'normal', fontSize: 12, minWidth: 200 }} className="muted">{topText(r.configOs)}</td>
                    <td style={{ whiteSpace: 'normal', overflowWrap: 'anywhere', fontSize: 11.5, minWidth: 180, fontFamily: 'monospace' }} className="muted">{topText(r.kernels, 2)}</td>
                  </tr>
                ))}
              </tbody>
            </STable>
          </div>

          {(data.appliances || []).length > 0 && (
            <>
              <div style={{ fontSize: 12.5, fontWeight: 700, margin: '6px 0' }}>어플라이언스 제품 정보(OVF 배포)</div>
              <div style={{ overflowX: 'auto', marginBottom: 12 }}>
                <STable className="v3-table" minWidth={760}>
                  <thead><tr><th>제품</th><th>제조사</th><th>판</th><th className="right">VM</th><th data-nosort>Tools 보고 OS</th></tr></thead>
                  <tbody>
                    {data.appliances.map((r, i) => (
                      <tr key={`${r.name}-${r.version}-${i}`}>
                        <td><b>{r.name || '—'}</b></td>
                        <td>{r.vendor || '—'}</td>
                        <td className="tabular">{r.version || '—'}</td>
                        <td className="right tabular" data-sort={r.count}>{n(r.count)}</td>
                        <td className="muted" style={{ whiteSpace: 'normal', fontSize: 12 }}>{topText(r.os)}</td>
                      </tr>
                    ))}
                  </tbody>
                </STable>
              </div>
            </>
          )}

          {((data.extraKeys || []).length > 0 || (data.unparsed || []).length > 0) && (
            <div className="muted" style={{ fontSize: 12, lineHeight: 1.6, whiteSpace: 'normal' }}>
              {(data.extraKeys || []).length > 0 && <div>문서에 없는 키: {data.extraKeys.map((x) => `${x.key}(${n(x.count)})`).join(' · ')}</div>}
              {(data.unparsed || []).length > 0 && <div>형식을 읽지 못한 보고 {n(data.unparsed.reduce((a, x) => a + x.count, 0))}건 — 원문은 내려받은 파일에 있습니다.</div>}
            </div>
          )}
          <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>기준 시각 {at(data.generatedAt)}{data.scoped ? ' · 조회 범위 안 vCenter 만' : ''}</div>
        </>
      )}
    </div>
  );
}

