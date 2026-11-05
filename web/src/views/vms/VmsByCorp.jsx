// views/vms/VmsByCorp.jsx — 가상화 서버 '법인별' 탭(v2.909 · 시안 docs/design/vm-screen ③).
//   숫자·판정은 서버 /vms/by-vcenter(inventory/vmByVcenter.js) — 화면은 그리기만 한다. 법인 = vCenter 1:1.
//   15초 폴링 금지(무거운 집계 · 규칙) — 탭을 열 때 1회 + '다시 읽기' 버튼. 늦게 온 이전 응답은 버린다(요청 번호).
//   행을 누르면 위 필터 바의 vCenter 를 그 법인으로 바꾸고 '현황' 탭으로 간다(onPick).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJson } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { corpMark } from '../hostCorpText.js';
import { fmtN, pctText, usageTone, TONE_COLOR, TONE_TEXT, corpVmsSort, corpCollectText, signalText } from './vmHubText.js';
import { numOrNull } from '../../numOrNull.js';

function Usage({ v }) {
  const n = numOrNull(v);
  const tone = usageTone(n);
  return (
    <span className="vmh-ub" title={n == null ? '구동 VM 의 사용률을 읽지 못했습니다' : undefined}>
      <span className="vmh-bar" aria-hidden="true"><i style={{ width: `${n == null ? 0 : Math.max(0, Math.min(100, n))}%`, background: TONE_COLOR[tone] }} /></span>
      <span style={{ color: TONE_TEXT[tone] }}>{pctText(n)}</span>
    </span>
  );
}

export default function VmsByCorp({ filters, onPick }) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const seq = useRef(0);
  const qKey = JSON.stringify(filters || {});
  const load = useCallback(async () => {
    const my = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const d = await fetchJson('/vms/by-vcenter', filters || {});
      if (my === seq.current) setState({ data: d, error: null, loading: false });
    } catch (e) {
      if (my === seq.current) setState((s) => ({ data: s.data, error: e?.message || String(e), loading: false }));
    }
  }, [qKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);

  const { data, error, loading } = state;
  if (!data && loading) return <Loading />;
  if (!data && error) return <ErrorBox message={error} />;
  const corps = data?.corps || [];
  const t = data?.totals || {};
  const max = Math.max(1, ...corps.map((c) => numOrNull(c.vms) || 0));
  const days = data?.snapAgeDays;
  const top = corps.filter((c) => numOrNull(c.vms) != null)[0] || null;
  const hot = [...corps].filter((c) => numOrNull(c.avgCpuPct) != null).sort((a, b) => b.avgCpuPct - a.avgCpuPct)[0] || null;
  const unk = numOrNull(t.signals?.usageUnknown);

  return (
    <>
      {error && <div className="badge red" style={{ display: 'block', padding: '6px 10px', whiteSpace: 'normal' }}>⚠ 다시 읽지 못했습니다 — 직전 값을 보여 줍니다({error}).</div>}
      <section className="vmh-kpis" aria-label="법인 요약">
        <div className="vmh-tile">
          <div className="lb">법인(= vCenter)</div>
          <div className="val">{fmtN(t.corps)}</div>
          <div className="sub"><span>모름 {fmtN(t.corpsUnknown)}</span><span>낡은 값 {fmtN(t.corpsStale)}</span></div>
        </div>
        <div className="vmh-tile">
          <div className="lb">VM 이 가장 많은 법인</div>
          <div className="val" style={{ fontFamily: 'inherit', fontSize: 20 }}>{top ? top.name : '—'}</div>
          <div className="sub">{top ? <><span>{fmtN(top.vms)}대</span><span>전체의 {t.vms ? Math.round((top.vms / t.vms) * 100) : 0}%</span></> : <span>—</span>}</div>
        </div>
        <div className="vmh-tile">
          <div className="lb">평균 CPU 가 가장 높은 법인</div>
          <div className="val" style={{ fontFamily: 'inherit', fontSize: 20, color: hot ? TONE_TEXT[usageTone(hot.avgCpuPct)] : undefined }}>{hot ? hot.name : '—'}</div>
          <div className="sub">{hot ? <><span>평균 {pctText(hot.avgCpuPct)}</span><span>과부하 {fmtN(hot.signals?.overload)}대</span></> : <span>구동 VM 사용률을 읽은 법인이 없습니다</span>}</div>
        </div>
        <div className="vmh-tile">
          <div className="lb">사용률 미수집 VM</div>
          <div className="val">{fmtN(unk)}</div>
          <div className="sub"><span>구동 중인데 CPU·메모리를 못 읽음 — 평균에서 뺐습니다</span></div>
        </div>
      </section>

      <section className="vmh-card" aria-label="법인별 가상화 서버 현황">
        <div className="vmh-card-head">
          <b>법인별 현황</b>
          <span className="vmh-note">행을 누르면 위 필터의 vCenter 를 그 법인으로 바꾸고 ‘현황’ 탭으로 갑니다 · 열 제목을 누르면 정렬</span>
          <span className="vmh-grow" />
          {loading && <span className="muted" style={{ fontSize: 12 }} role="status">다시 읽는 중…</span>}
          <button type="button" className="tab" style={{ flex: 'none', padding: '6px 11px' }} onClick={load} disabled={loading}>다시 읽기</button>
        </div>
        {corps.length === 0 ? (
          <div className="muted" style={{ padding: 16 }}>보여 줄 법인이 없습니다{filters && Object.keys(filters).length ? ' — 위 필터 조건에 맞는 VM 이 없습니다' : ''}.</div>
        ) : (
          <STable className="vmh-corp-table" minWidth={1000}>
            <thead>
              <tr>
                <th>법인 · vCenter</th><th style={{ textAlign: 'right' }}>VM</th><th style={{ textAlign: 'right' }}>vCPU · 메모리</th>
                <th>평균 CPU</th><th>평균 메모리</th><th style={{ textAlign: 'right' }}>GPU VM</th>
                <th style={{ textAlign: 'right' }} title={signalText('overload').desc}>과부하</th>
                <th style={{ textAlign: 'right' }} title={signalText('usageUnknown').desc}>미수집</th>
                <th style={{ textAlign: 'right' }} title={signalText('toolsOld').desc}>Tools</th>
                <th style={{ textAlign: 'right' }} title={signalText('snapOld', { days }).desc}>{signalText('snapOld', { days }).short}</th>
              </tr>
            </thead>
            <tbody>
              {corps.map((c) => {
                const m = corpMark(c);
                const known = numOrNull(c.vms) != null;
                const share = known && t.vms ? Math.round((c.vms / t.vms) * 100) : null;
                const over = numOrNull(c.signals?.overload);
                return (
                  <tr key={c.id}>
                    <td data-sort={c.name}>
                      <button type="button" className="vmh-name-btn" onClick={() => onPick && onPick(c.id)} title={`${c.name} — 이 법인의 VM 만 현황 탭에서 봅니다`}>{c.name}</button>
                      {c.unlisted && <span className="vmh-badge gray" style={{ marginLeft: 6 }} title="vCenter 목록에 없는 id 의 VM 입니다(이월 값·경합)">목록 밖</span>}
                      {m.mark && <span className="muted" style={{ marginLeft: 6 }} title={m.title}>{m.mark}</span>}
                      <span className="vmh-l2">
                        {[c.region, c.city].filter(Boolean).join(' · ') || '지역 모름'} · <span style={{ color: c.stale ? 'var(--vmh-warn-text)' : c.status === 'unreachable' ? 'var(--vmh-crit-text)' : undefined }}>{corpCollectText(c)}</span>
                      </span>
                    </td>
                    <td className="tabular" style={{ textAlign: 'right' }} data-sort={corpVmsSort(c)}>
                      <b>{fmtN(c.vms)}</b>
                      {share != null && <span className="vmh-mini" style={{ marginLeft: 'auto' }} title={`전체의 ${share}%`} aria-hidden="true"><i style={{ width: `${Math.round((c.vms / max) * 100)}%` }} /></span>}
                      <span className="vmh-l2">{known ? `구동 ${fmtN(c.on)} · 정지 ${fmtN(c.off)} · ${share}%` : '모름'}</span>
                    </td>
                    <td className="tabular" style={{ textAlign: 'right' }} data-sort={numOrNull(c.vcpu) ?? ''}>
                      {fmtN(c.vcpu)}<span className="vmh-l2">{numOrNull(c.ramGB) == null ? '—' : `${fmtN(c.ramGB)} GB`}</span>
                    </td>
                    <td data-sort={numOrNull(c.avgCpuPct) ?? ''}><Usage v={c.avgCpuPct} /></td>
                    <td data-sort={numOrNull(c.avgMemPct) ?? ''}><Usage v={c.avgMemPct} /></td>
                    <td className="tabular" style={{ textAlign: 'right' }}>{fmtN(c.gpu)}</td>
                    <td className="tabular" style={{ textAlign: 'right', color: over > 0 ? 'var(--vmh-crit-text)' : undefined, fontWeight: over > 0 ? 700 : 400 }}>{fmtN(c.signals?.overload)}</td>
                    <td className="tabular muted" style={{ textAlign: 'right' }}>{fmtN(c.signals?.usageUnknown)}</td>
                    <td className="tabular" style={{ textAlign: 'right' }}>{fmtN(c.signals?.toolsOld)}</td>
                    <td className="tabular" style={{ textAlign: 'right' }}>{fmtN(c.signals?.snapOld)}</td>
                  </tr>
                );
              })}
              <tr data-pin="bottom" style={{ fontWeight: 700 }}>
                <td>합계 · {fmtN(t.corps)} 법인</td>
                <td className="tabular" style={{ textAlign: 'right' }}>{fmtN(t.vms)}<span className="vmh-l2">구동 {fmtN(t.on)} · 정지 {fmtN(t.off)}</span></td>
                <td className="tabular" style={{ textAlign: 'right' }}>{fmtN(t.vcpu)}<span className="vmh-l2">{fmtN(t.ramGB)} GB</span></td>
                <td><Usage v={t.avgCpuPct} /></td><td><Usage v={t.avgMemPct} /></td>
                <td className="tabular" style={{ textAlign: 'right' }}>{fmtN(t.gpu)}</td>
                <td className="tabular" style={{ textAlign: 'right' }}>{fmtN(t.signals?.overload)}</td>
                <td className="tabular" style={{ textAlign: 'right' }}>{fmtN(t.signals?.usageUnknown)}</td>
                <td className="tabular" style={{ textAlign: 'right' }}>{fmtN(t.signals?.toolsOld)}</td>
                <td className="tabular" style={{ textAlign: 'right' }}>{fmtN(t.signals?.snapOld)}</td>
              </tr>
            </tbody>
          </STable>
        )}
        <div className="vmh-card-foot">
          평균은 구동 VM 기준이고 사용률을 못 읽은 VM 은 평균에서 뺍니다 · 합계 줄의 평균은 법인 평균의 평균이 아니라 전체 구동 VM 의 평균입니다 ·
          개수를 모르는 법인(첫 수집 중 · 연결 실패 · 인증 정지이며 받은 VM 이 없음)은 ‘—’ 입니다{numOrNull(days) != null ? ` · 스냅샷 기준 ${days}일은 ‘VM 구성 점검’ 설정입니다` : ''}.
        </div>
      </section>
    </>
  );
}
