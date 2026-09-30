import React from 'react';
import BoldText from '../../components/boldText.jsx';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { agoText, spanText, countText, bpsText, faultEventText, faultKindLabel } from './cvpText.js';
import {
  HEALTH_KEYS, HEALTH_LABEL, HEALTH_COLOR, CORP_NOTE, TRAFFIC_NOTE,
  healthRing, healthNote, overviewKpis, corpCards, modelBars, versionList, freshnessRows, trafficRows, modelTableRows, corpLabel,
} from './cvpOverviewText.js';

/**
 * CVP Overview · 모델 · 트래픽 화면(v2.645 — 사용자 승인 시안 반영).
 * 데이터는 `/tools/cvp/overview` 한 번(부모가 받아 넘긴다 — 폴링하지 않는다). 판정은 서버(cvp/overview.js),
 * 모양은 cvpOverviewText.js. 법인 칸을 누르면 그 법인으로 좁힌 장비 화면으로 간다(onCorp).
 */
const CARD = { padding: 18, minWidth: 0 };
const H2 = { margin: 0, fontSize: 15, fontWeight: 600 };
const NOTE = { fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6 };
const MONO = { fontFamily: 'var(--mono, ui-monospace, monospace)', fontVariantNumeric: 'tabular-nums' };
const TONE_COLOR = { bad: 'var(--red)', warn: 'var(--amber)', ok: 'var(--green)' };
const LINK = { background: 'none', border: 0, padding: 0, color: 'var(--accent)', cursor: 'pointer', fontSize: 12 };

function Unavailable({ ov }) {
  const u = ov && ov.unavailable && typeof ov.unavailable === 'object' ? ov.unavailable : {};
  const bad = Object.entries(u).filter(([, v]) => v).map(([k]) => ({ devices: '장비', faults: '장애', traffic: '트래픽', events: '이벤트', faultEvents: '장애 이력', portUsage: '포트 사용량' }[k] || k));
  if (!bad.length) return null;
  return <div className="banner">중앙 CVP DB 에서 <b>{bad.join(' · ')}</b> 을(를) 읽지 못했습니다 — 해당 칸은 빈 값이 아니라 모르는 값입니다.</div>;
}

export function CvpOverviewView({ ov, err, onGo, onCorp, onOpenDevice }) {
  if (err && !ov) return <ErrorBox error={err} />;
  if (!ov) return <Loading />;
  const ring = healthRing(ov.totals?.health);
  const kpis = overviewKpis(ov);
  const corps = corpCards(ov.corps);
  const models = modelBars(ov.models);
  const vl = versionList(ov);
  const versions = vl.rows;
  const fr = freshnessRows(ov.freshness);
  const traffic = trafficRows(ov.corps).slice(0, 8);
  const recent = Array.isArray(ov.recentFaults) ? ov.recentFaults : [];
  return (
    <div style={{ display: 'grid', gap: 14, minWidth: 0 }}>
      <Unavailable ov={ov} />
      <div className="cvp-ov-top">
        <div className="card" style={{ ...CARD, display: 'grid', gap: 14 }}>
          <div style={{ fontSize: 13, color: 'var(--text-dim)', fontWeight: 600 }}>관리 상태</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
            <svg width="140" height="140" viewBox="0 0 148 148" role="img" aria-label={ring.okPct == null ? '정상 판정 —' : `정상 판정 ${ring.okPct}%`} style={{ flex: 'none' }}>
              <circle cx="74" cy="74" r="60" fill="none" stroke="var(--border)" strokeWidth="16" />
              {ring.segs.map((s) => (
                <circle key={s.key} cx="74" cy="74" r="60" fill="none" stroke={s.color} strokeWidth="16" strokeDasharray={s.dash} strokeDashoffset={s.offset} transform="rotate(-90 74 74)" />
              ))}
              <text x="74" y="72" textAnchor="middle" fill="var(--text)" fontSize="28" fontWeight="700">{ring.okPct == null ? '—' : `${ring.okPct}%`}</text>
              <text x="74" y="94" textAnchor="middle" fill="var(--text-dim)" fontSize="12">정상 판정</text>
            </svg>
            <div style={{ display: 'grid', gap: 8, flex: 1, minWidth: 140 }}>
              {HEALTH_KEYS.map((k) => (
                <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 3, background: HEALTH_COLOR[k], flex: 'none' }} />
                  <span style={{ flex: 1, fontSize: 14 }}>{HEALTH_LABEL[k]}</span>
                  <span style={{ ...MONO, fontSize: 15 }}>{countText(ov.totals?.health?.[k])}</span>
                </div>
              ))}
            </div>
          </div>
          <div style={{ ...NOTE, paddingTop: 10, borderTop: '1px solid var(--border)' }}>{healthNote(ov.totals)}</div>
        </div>
        <div className="cvp-ov-kpis">
          {kpis.map((k) => (
            <button key={k.key} type="button" className="card cvp-ov-kpi" onClick={() => onGo?.(k.go)} title="눌러서 자세히 보기">
              <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>{k.label}</div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 28, fontWeight: 700, color: TONE_COLOR[k.tone] || 'var(--text)' }}>{k.value}</span>
                <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>{k.unit}</span>
              </div>
              <div style={{ ...NOTE, textAlign: 'left' }}>{k.sub}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="card" style={CARD}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
          <h2 style={H2}>법인별 상태</h2>
          <div style={NOTE}>칸을 누르면 그 법인의 장비로 이동 · 이름순</div>
        </div>
        {corps.length === 0 ? <div style={{ ...NOTE, marginTop: 8 }}>아직 수집된 장비가 없습니다.</div> : (
          <div className="cvp-ov-corps">
            {corps.map((c) => (
              <button key={c.corpId || '(none)'} type="button" className="cvp-ov-corp" onClick={() => onCorp?.(c.name)} title={c.cvps.length ? `CVP: ${c.cvps.join(', ')}` : ''}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                  <span style={{ width: 9, height: 9, borderRadius: '50%', background: c.dot, flex: 'none' }} />
                </div>
                <div style={{ ...MONO, fontSize: 22 }}>{countText(c.count)}<span style={{ fontSize: 12, color: 'var(--text-dim)' }}> 대</span></div>
                <div style={{ height: 5, borderRadius: 3, background: 'var(--border)', display: 'flex', overflow: 'hidden' }}>
                  <span style={{ width: c.okPct, background: HEALTH_COLOR.ok }} />
                  <span style={{ width: c.warnPct, background: HEALTH_COLOR.warn }} />
                  <span style={{ width: c.badPct, background: HEALTH_COLOR.bad }} />
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{c.note}</div>
              </button>
            ))}
          </div>
        )}
        <div style={{ ...NOTE, marginTop: 10 }}><BoldText text={CORP_NOTE} /></div>
      </div>

      <div className="cvp-ov-three">
        <div className="card" style={{ ...CARD, display: 'grid', gap: 10, alignContent: 'start' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <h2 style={H2}>모델 분포</h2>
            <button type="button" style={LINK} onClick={() => onGo?.('models')}>전체 모델 보기</button>
          </div>
          {models.length === 0 ? <div style={NOTE}>—</div> : models.map((m) => (
            <div key={m.model || '(none)'} style={{ display: 'grid', gap: 4 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, gap: 8 }}>
                <span style={{ ...MONO, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name}</span>
                <span style={MONO}>{countText(m.count)}</span>
              </div>
              <div style={{ height: 6, borderRadius: 3, background: 'var(--border)' }}><div style={{ height: 6, borderRadius: 3, width: m.pct, background: 'var(--accent)' }} /></div>
            </div>
          ))}
        </div>
        <div className="card" style={{ ...CARD, display: 'grid', gap: 6, alignContent: 'start' }}>
          <h2 style={H2}>EOS 버전</h2>
          <div style={NOTE}>버전 순(최신 먼저) · '버전 갈림' 은 같은 모델에 다른 버전이 섞인 것 · 모델 {countText(ov.modelsSplit)}종이 갈려 있습니다</div>
          {versions.length === 0 ? <div style={NOTE}>—</div> : versions.map((v) => (
            <div key={v.version || '(none)'} title={v.title} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 0', borderBottom: '1px solid var(--border)' }}>
              <span style={{ ...MONO, fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.name}</span>
              <span style={{ fontSize: 12, padding: '1px 8px', borderRadius: 999, whiteSpace: 'nowrap', color: v.split ? 'var(--amber)' : 'var(--text-dim)', border: `1px solid ${v.split ? 'var(--amber)' : 'var(--border)'}` }}>{v.tag}</span>
              <span style={{ ...MONO, fontSize: 13, width: 44, textAlign: 'right' }}>{countText(v.count)}</span>
            </div>
          ))}
          {vl.omitted > 0 && <div style={NOTE}>그 밖 {countText(vl.omitted)}개 버전은 생략했습니다(전체 {countText(vl.total)}개 — 모델 화면의 EOS 버전 열에 전부 있습니다).</div>}
        </div>
        <div className="card" style={{ ...CARD, display: 'grid', gap: 10, alignContent: 'start' }}>
          <h2 style={H2}>데이터 신선도</h2>
          <div style={NOTE}>마지막 수집 시각 기준 · 수집 주기 {spanText(ov.intervalMs)}</div>
          <div style={{ display: 'flex', height: 24, borderRadius: 8, overflow: 'hidden', background: 'var(--border)' }}>
            {fr.rows.map((r) => <span key={r.key} style={{ width: r.pct, background: r.color, opacity: 0.75 }} />)}
          </div>
          {fr.rows.map((r) => (
            <div key={r.key} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}><span>{r.label}</span><span style={MONO}>{countText(r.count)}</span></div>
          ))}
          {fr.note && <div style={{ ...NOTE, paddingTop: 8, borderTop: '1px solid var(--border)' }}>{fr.note}</div>}
        </div>
      </div>

      <div className="cvp-ov-bottom">
        <div className="card" style={{ ...CARD, display: 'grid', gap: 10, alignContent: 'start' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <h2 style={H2}>법인별 트래픽 합계</h2>
            <button type="button" style={LINK} onClick={() => onGo?.('traffic')}>트래픽 자세히</button>
          </div>
          <div style={NOTE}>링크 올라온 포트의 수신 + 송신 · 마지막 수집 순간값</div>
          {traffic.length === 0 ? <div style={NOTE}>—</div> : traffic.map((t) => (
            <div key={t.corpId || '(none)'} style={{ display: 'grid', gap: 4 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13 }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
                <span style={MONO}>{t.sumText}</span>
              </div>
              <div style={{ height: 6, borderRadius: 3, background: 'var(--border)' }}><div style={{ height: 6, borderRadius: 3, width: t.pct, background: 'var(--accent)' }} /></div>
            </div>
          ))}
        </div>
        <div className="card" style={{ ...CARD, display: 'grid', gap: 8, alignContent: 'start', minWidth: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <h2 style={H2}>최근 장애 전이</h2>
            <button type="button" style={LINK} onClick={() => onGo?.('events')}>이벤트 전체</button>
          </div>
          {recent.length === 0 ? <div style={NOTE}>최근 7일 동안 열리거나 닫힌 장애가 없습니다(장애 판정이 꺼져 있으면 기록되지 않습니다).</div> : recent.map((f, i) => (
            <button key={`${f.at}-${i}`} type="button" onClick={() => onOpenDevice?.({ cvpId: f.cvpId, key: f.deviceKey, hostname: f.deviceName })}
              style={{ display: 'grid', gridTemplateColumns: '64px 70px minmax(0,1fr)', gap: 8, alignItems: 'baseline', textAlign: 'left', background: 'none', border: 0, borderBottom: '1px solid var(--border)', padding: '6px 0', color: 'var(--text)', cursor: 'pointer' }}>
              <span style={{ ...MONO, fontSize: 12, color: 'var(--text-dim)' }}>{agoText(f.at)}</span>
              <span style={{ fontSize: 12, color: f.event === 'close' ? 'var(--green)' : f.state === 'fault' ? 'var(--red)' : 'var(--amber)' }}>{faultKindLabel(f.kind, f.label)}</span>
              <span style={{ fontSize: 13, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <b>{f.deviceName || f.deviceKey}</b> · {f.label} — {faultEventText(f)}
                <span style={{ color: 'var(--text-dim)' }}> · {corpLabel(f)}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function CvpModelsView({ ov, err, onModel }) {
  if (err && !ov) return <ErrorBox error={err} />;
  if (!ov) return <Loading />;
  const rows = modelTableRows(ov.models);
  return (
    <div className="card" style={CARD}>
      <b>등록된 모델 {countText(rows.length)}종 · 장비 {countText(ov.totals?.devices)}대</b>
      <div style={{ ...NOTE, marginTop: 4 }}>모델·EOS 버전은 장비가 보고한 문자열 그대로 묶었습니다. 행을 누르면 그 모델의 장비 목록으로 갑니다.</div>
      {rows.length === 0 ? <div style={{ ...NOTE, marginTop: 8 }}>아직 수집된 장비가 없습니다.</div> : (
        <STable minWidth={820} style={{ marginTop: 8 }}>
          <thead><tr><th>모델</th><th>대수</th><th>법인</th><th>정상</th><th>주의</th><th>장애</th><th>확인 불가</th><th>EOS 버전(대수)</th></tr></thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.model || '(none)'} style={{ cursor: 'pointer' }} onClick={() => onModel?.(m.model)}>
                <td><b style={{ textDecoration: 'underline dotted', textUnderlineOffset: 3 }}>{m.name}</b></td>
                <td className="right" data-sort={m.count}>{countText(m.count)}</td>
                <td className="right" data-sort={m.corps}>{countText(m.corps)}곳</td>
                {HEALTH_KEYS.map((k) => (
                  <td key={k} className="right" data-sort={m.health[k] ?? 0} style={{ color: k !== 'ok' && m.health[k] > 0 ? HEALTH_COLOR[k] : undefined }}>{countText(m.health[k] ?? 0)}</td>
                ))}
                <td style={{ fontSize: 12, whiteSpace: 'normal', color: m.versionCount > 1 ? 'var(--amber)' : undefined }} data-sort={m.versionCount}>{m.versionsText}</td>
              </tr>
            ))}
          </tbody>
        </STable>
      )}
    </div>
  );
}

export function CvpTrafficView({ ov, err, onOpenDevice, onCorp }) {
  if (err && !ov) return <ErrorBox error={err} />;
  if (!ov) return <Loading />;
  const rows = trafficRows(ov.corps);
  const t = ov.traffic || {};
  return (
    <div style={{ display: 'grid', gap: 14, minWidth: 0 }}>
      <div className="kpis">
        <div className="kpi"><div className="label">전체 수신</div><div className="value">{t.portsMeasured > 0 ? bpsText(t.inBps) : '—'}</div></div>
        <div className="kpi"><div className="label">전체 송신</div><div className="value">{t.portsMeasured > 0 ? bpsText(t.outBps) : '—'}</div></div>
        <div className="kpi"><div className="label">측정 포트</div><div className="value">{countText(t.portsMeasured)}</div><div className="meta">처리량 없음 {countText(t.portsUnmeasured)}개 제외</div></div>
        <div className="kpi"><div className="label">측정 장비</div><div className="value">{countText(t.devicesMeasured)}</div><div className="meta">미측정 {countText(t.devicesUnmeasured)}대</div></div>
      </div>
      <div className="card" style={CARD}>
        <b>법인별 트래픽 합계</b>
        <div style={{ ...NOTE, marginTop: 4 }}><BoldText text={TRAFFIC_NOTE} /></div>
        {rows.length === 0 ? <div style={{ ...NOTE, marginTop: 8 }}>아직 수집된 장비가 없습니다.</div> : (
          <STable minWidth={900} style={{ marginTop: 8 }}>
            <thead><tr><th>법인</th><th>수신 + 송신</th><th>수신</th><th>송신</th><th>측정</th><th>상위 장비</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.corpId || '(none)'}>
                  <td><button type="button" style={{ ...LINK, color: 'inherit', textDecoration: 'underline dotted', textUnderlineOffset: 3, fontWeight: 600, fontSize: 13 }} onClick={() => onCorp?.(r.name)}>{r.name}</button></td>
                  <td className="right" data-sort={r.sum ?? ''}><b>{r.sumText}</b></td>
                  <td className="right" data-sort={r.inBps ?? ''}>{r.inText}</td>
                  <td className="right" data-sort={r.outBps ?? ''}>{r.outText}</td>
                  <td style={{ fontSize: 12, whiteSpace: 'normal', color: r.partial ? 'var(--amber)' : 'var(--text-dim)' }}>{r.note}</td>
                  <td style={{ fontSize: 12, whiteSpace: 'normal' }} data-nosort>
                    {r.top.length === 0 ? '—' : r.top.map((d) => (
                      <button key={`${d.cvpId}|${d.key}`} type="button" onClick={() => onOpenDevice?.({ cvpId: d.cvpId, key: d.key, hostname: d.hostname, tab: 'ports' })}
                        style={{ ...LINK, color: 'inherit', marginRight: 10, textDecoration: 'underline dotted', textUnderlineOffset: 3 }}>
                        {d.hostname} {bpsText((d.inBps || 0) + (d.outBps || 0))}
                      </button>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </STable>
        )}
      </div>
    </div>
  );
}

