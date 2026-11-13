import React, { useEffect, useState } from 'react';
import { fetchJson, putJson, postJson } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';
import { STable } from '../components/STable.jsx';
import { blankOr } from './blankOr.js';
import { alertsLockReason, channelUrlField, withoutHiddenUrls } from './alertChannelUrlText.js'; // v2.732(그룹 i3): 범위 계정 URL 가림·저장 잠금

const RULE_LABEL = {
  criticalAlarms: '위험(critical) 알람 발생',
  vcenterDown: 'vCenter 수집 실패(연결 불가)',
  hostDisconnected: '호스트 연결 끊김',
  datastorePct: '데이터스토어 사용률 ≥ (%)',
  ramOvercommitPct: '클러스터 RAM 오버커밋 ≥ (%)',
  vcpuPerCore: '클러스터 vCPU:코어 ≥',
  gpuAllocPct: '법인 GPU 할당률 ≥ (%)',   // v2.939(GPU 할당율 개선 6 · 기본 끔 — 예비가 음수면 위험 등급)
};

// v3.1.0(시안 docs/design/ipam-alerts-mac-dns ① — 컨펌 '기본값: 충돌 의심만 켬'): IP 스캔이 본 변화. 판정 · 묶음은 서버(ipam/changeNotify.js · conflict.js).
export const IPAM_RULES = Object.freeze([
  { k: 'ipamConflict', label: '충돌 의심', sev: '위험', tone: 'red', th: '연속 스캔 수',
    desc: 'vCenter 가 아는 VM 의 IP 에 그 VM 의 NIC 이 아닌 MAC 이 연속으로 응답합니다(스캐너와 같은 서브넷의 IP 만). 풀릴 때까지 현재 발생 중에 남고 해소되면 알립니다.' },
  { k: 'ipamMacChange', label: 'MAC 변경', sev: '경고', tone: 'amber',
    desc: '같은 IP 의 MAC 이 지난 스캔과 다릅니다(장비 교체 · IP 재사용 · 충돌). 이중화 장비처럼 정상적으로 바뀌는 IP 는 IP 관리상태 편집에서 MAC 변경 알림을 제외합니다.' },
  { k: 'ipamNewIp', label: '새 미등록 IP', sev: '경고', tone: 'amber', th: '묶음 상한(개)',
    desc: 'vCenter 가 모르는 IP 가 처음 응답했습니다. 그 대역 줄을 처음 끝까지 스캔한 결과는 기준선으로만 삼고 알리지 않습니다.' },
  { k: 'ipamReservedUp', label: '예약 · 폐기 IP 사용 시작', sev: '경고', tone: 'amber',
    desc: '관리상태가 예약 또는 폐기인 IP(직접 지정 · 대역 정책)가 응답하기 시작했습니다.' },
  { k: 'ipamRename', label: '호스트명 변경', sev: '경고', tone: 'amber',
    desc: '같은 확인 방식(역DNS · mDNS · NetBIOS)이 지난번과 다른 이름을 답했습니다.' },
]);
/** 쉼표 · 줄바꿈으로 나눈 에이전트 이름(빈 칸 · 중복 제거 — 서버 cleanQuietAgents 가 다시 정제한다). */
export function parseQuietAgents(text) {
  const out = []; const seen = new Set();
  for (const t of String(text || '').split(/[,\n]/)) { const x = t.trim(); if (x && !seen.has(x.toLowerCase())) { seen.add(x.toLowerCase()); out.push(x); } }
  return out;
}

/** 설정 → 알림: 임계치/조건 규칙 + Slack/Webhook 통지 채널. initialData 는 렌더 스모크 테스트용(화면은 넘기지 않는다 — 마운트 때 읽는다). */
export default function Alerts2({ initialData = null } = {}) {
  const [d, setD] = useState(initialData);
  const [error, setError] = useState(null);
  const [msg, setMsg] = useState(null);
  const load = () => fetchJson('/admin/alerts').then((r) => { setD(r); setError(null); }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);
  if (error) return <ErrorBox message={error} />;
  if (!d) return <Loading />;
  const c = d.config;
  const flash = (ok, t) => { setMsg({ ok, t }); setTimeout(() => setMsg(null), 4000); };
  const setCh = (ch, k, v) => setD({ ...d, config: { ...c, channels: { ...c.channels, [ch]: { ...c.channels[ch], [k]: v } } } });
  const setRule = (r, k, v) => setD({ ...d, config: { ...c, rules: { ...c.rules, [r]: { ...c.rules[r], [k]: v } } } });
  // v2.605(감사 WEB2605-05): 숫자 칸은 **원문 문자열**을 상태에 두고 전송 때만 blankOr — 빈 칸은 보내지 않는다(서버가 이전 값 유지).
  //   예전 onChange 의 Number() 는 빈 칸을 0 으로 저장·표시했고 평가는 기본값(90 등)으로 판정해 화면과 실제 기준이 달랐다.
  const toBody = (cfg) => ({
    ...cfg,
    rules: Object.fromEntries(Object.entries(cfg.rules || {}).map(([k, v]) => [k,
      v && typeof v === 'object' && 'threshold' in v ? { ...v, threshold: blankOr(v.threshold) } : v])),
    cooldownMin: blankOr(cfg.cooldownMin),
    intervalSec: blankOr(cfg.intervalSec),
    // v3.1.0: 알리지 않을 에이전트 — 칸을 고쳤을 때만 보낸다(안 고쳤으면 키를 빼 서버가 이전 값을 유지)
    ...('__quietText' in cfg ? { ipamQuietAgents: parseQuietAgents(cfg.__quietText) } : {}),
    __quietText: undefined,
  });
  // v2.732(그룹 i3): 범위 계정은 웹훅 URL 이 가려져 오고(B3-03) 저장·테스트 발송이 403 이다 — 버튼을 잠그고 사유를 미리 말한다.
  //   저장 본문에서는 가린 채널의 url 을 뺀다(빈 값을 보내면 서버가 주소를 지운다 — 심층 방어).
  const lock = alertsLockReason(c, d);
  const save = async () => { if (lock) return; const r = await putJson('/admin/alerts', toBody(withoutHiddenUrls(c))).catch((e) => ({ error: e.message })); if (r.config) { await load(); flash(true, '저장했습니다.'); } else flash(false, r.reason || r.error || '저장 실패'); };
  const test = async () => { if (lock) return; const r = await postJson('/admin/alerts/test', {}).catch((e) => ({ ok: false, results: [e.message] })); flash(r.ok, `테스트 발송: ${(r.results || []).join(', ') || '활성 채널 없음'}`); };
  const slackUrl = channelUrlField(c.channels.slack, 'https://hooks.slack.com/services/...');
  const hookUrl = channelUrlField(c.channels.webhook, 'https://your-endpoint/alerts');

  return (
    <>
      <div className="section-title" style={{ margin: '6px 0' }}>알림 / 임계치</div>
      {msg && <div style={{ marginBottom: 10, padding: '9px 12px', borderRadius: 8, fontSize: 13, background: msg.ok ? 'rgba(34,197,94,.12)' : 'rgba(239,68,68,.12)', color: msg.ok ? '#4ade80' : '#f87171' }}>{msg.t}</div>}
      {lock && <div className="banner" data-alert-lock="" style={{ marginBottom: 10, whiteSpace: 'normal' }}>{lock} 이 계정에는 웹훅 주소를 보이지 않습니다 — ‘설정됨(가림)’ 은 주소가 저장돼 있다는 뜻입니다.</div>}

      <div className="card" style={{ marginBottom: 12 }}>
        <b style={{ fontSize: 14 }}>통지 채널</b>
        <div className="spec-grid" style={{ marginTop: 8 }}>
          <label className="flex gap" style={{ alignItems: 'center', fontSize: 13 }}><input type="checkbox" checked={!!c.channels.slack.enabled} onChange={(e) => setCh('slack', 'enabled', e.target.checked)} /> Slack 사용</label>
          <label style={{ gridColumn: '1 / -1' }}>Slack Incoming Webhook URL<input className="input" value={slackUrl.value} disabled={slackUrl.disabled} title={slackUrl.title} onChange={(e) => setCh('slack', 'url', e.target.value)} placeholder={slackUrl.placeholder} /></label>
          <label className="flex gap" style={{ alignItems: 'center', fontSize: 13 }}><input type="checkbox" checked={!!c.channels.webhook.enabled} onChange={(e) => setCh('webhook', 'enabled', e.target.checked)} /> Webhook 사용</label>
          <label style={{ gridColumn: '1 / -1' }}>Webhook URL (JSON POST)<input className="input" value={hookUrl.value} disabled={hookUrl.disabled} title={hookUrl.title} onChange={(e) => setCh('webhook', 'url', e.target.value)} placeholder={hookUrl.placeholder} /></label>
          <label className="flex gap" style={{ alignItems: 'center', fontSize: 13 }}><input type="checkbox" checked={!!c.channels.email?.enabled} onChange={(e) => setCh('email', 'enabled', e.target.checked)} /> 메일 사용</label>
        </div>
        <div className="muted" style={{ fontSize: 11, marginTop: 6, lineHeight: 1.7 }}>
          ✉ 메일은 <b>설정 › 메일 발송</b>의 SMTP 설정과 수신자를 씁니다(v2.454) — 여기서는 이 채널을 쓸지만 정합니다.
          그 화면에서 <b>메일 발송 사용</b>과 <b>'알림' 종류</b>가 함께 켜져 있어야 실제로 나갑니다.
        </div>
        <div className="flex gap" style={{ marginTop: 10 }}>
          <button className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} onClick={save} disabled={!!lock} title={lock || undefined}>저장</button>
          <button className="logout-btn" style={{ padding: '8px 14px' }} onClick={test} disabled={!!lock} title={lock || undefined}>테스트 발송</button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <b style={{ fontSize: 14 }}>임계치 / 조건 규칙</b>
        <div style={{ marginTop: 8 }}>
          {Object.keys(RULE_LABEL).map((r) => (
            <div key={r} className="flex gap" style={{ alignItems: 'center', padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,.06)' }}>
              <label className="flex gap" style={{ alignItems: 'center', fontSize: 13, flex: 1 }}>
                <input type="checkbox" checked={!!c.rules[r]?.enabled} onChange={(e) => setRule(r, 'enabled', e.target.checked)} /> {RULE_LABEL[r]}
              </label>
              {'threshold' in (c.rules[r] || {}) && (
                <input className="input" type="number" style={{ maxWidth: 100 }} value={c.rules[r].threshold} onChange={(e) => setRule(r, 'threshold', e.target.value)} />
              )}
            </div>
          ))}
        </div>
        <div className="flex gap wrap" style={{ marginTop: 10, alignItems: 'flex-end' }}>
          <label style={{ fontSize: 12 }}>재통지 쿨다운(분)<input className="input" type="number" style={{ maxWidth: 110 }} value={c.cooldownMin} onChange={(e) => setD({ ...d, config: { ...c, cooldownMin: e.target.value } })} /></label>
          <label style={{ fontSize: 12 }}>평가 주기(초)<input className="input" type="number" style={{ maxWidth: 110 }} value={c.intervalSec} onChange={(e) => setD({ ...d, config: { ...c, intervalSec: e.target.value } })} /></label>
          <button className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} onClick={save} disabled={!!lock} title={lock || undefined}>저장</button>
          <span className="muted" style={{ fontSize: 11 }}>저장하면 바로 적용됩니다(재시작 불필요). 빈 칸은 이전 값을 유지합니다.</span>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 12, minWidth: 0 }}>
        <div className="flex between wrap gap" style={{ alignItems: 'baseline' }}>
          <b style={{ fontSize: 14 }}>IP 관리 — 스캔이 본 변화</b>
          <a href="#/ipam/changes" style={{ fontSize: 12 }}>IP관리 › IP 변화에서 기록 보기 ›</a>
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 4, lineHeight: 1.7 }}>
          IP 스캔이 끝날 때마다 지난 결과와 비교합니다. 알림은 <b>스캔 한 번 · 종류 하나에 한 건</b>으로 묶어 보내고, 끈 종류도 IP 변화 페이지에는 기록합니다.
        </div>
        <div style={{ marginTop: 6 }}>
          {IPAM_RULES.map((x) => (
            <div key={x.k} className="flex gap" style={{ alignItems: 'flex-start', padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,.06)', flexWrap: 'wrap', minWidth: 0 }}>
              <label className="flex gap" style={{ alignItems: 'flex-start', fontSize: 13, flex: '1 1 320px', minWidth: 0 }}>
                <input type="checkbox" style={{ marginTop: 3, flex: 'none' }} checked={!!c.rules[x.k]?.enabled} onChange={(e) => setRule(x.k, 'enabled', e.target.checked)} />
                <span style={{ minWidth: 0 }}>
                  <b style={{ fontWeight: 600 }}>{x.label}</b> <span className={`badge ${x.tone}`} style={{ fontSize: 10, marginLeft: 4 }}>{x.sev}</span>
                  <span className="muted" style={{ display: 'block', fontSize: 12, lineHeight: 1.6, marginTop: 2 }}>{x.desc}</span>
                </span>
              </label>
              {x.th && 'threshold' in (c.rules[x.k] || {}) && (
                <label className="muted flex gap" style={{ alignItems: 'center', fontSize: 12, flex: 'none' }}>{x.th}
                  <input className="input" type="number" style={{ maxWidth: 90, minWidth: 0 }} value={c.rules[x.k].threshold} onChange={(e) => setRule(x.k, 'threshold', e.target.value)} />
                </label>
              )}
            </div>
          ))}
        </div>
        <label style={{ display: 'block', fontSize: 12, marginTop: 10 }}>알리지 않을 에이전트 <span className="muted">(쉼표로 구분 — 그 에이전트의 변화는 기록만 합니다. 대역을 새로 넣는 동안 등)</span>
          <input className="input" style={{ width: '100%', boxSizing: 'border-box', marginTop: 4, minWidth: 0 }} value={c.__quietText ?? (c.ipamQuietAgents || []).join(', ')}
            onChange={(e) => setD({ ...d, config: { ...c, __quietText: e.target.value } })} placeholder="예: edge-site-b, edge-site-c" aria-label="알리지 않을 에이전트" />
        </label>
        <div className="flex gap wrap" style={{ marginTop: 10, alignItems: 'center' }}>
          <button className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} onClick={save} disabled={!!lock} title={lock || undefined}>저장</button>
          <span className="muted" style={{ fontSize: 11 }}>충돌 의심은 위의 재통지 쿨다운 · 평가 주기를 따릅니다. 나머지 넷은 한 번 일어난 사건이라 현재 발생 중에 남지 않고 최근 통지와 IP 변화 페이지에 남습니다.</span>
        </div>
      </div>

      <div className="card">
        <b style={{ fontSize: 14 }}>현재 발생 중 ({d.firing.length})</b>
        <div className="table-wrap" style={{ marginTop: 8, maxHeight: '32vh' }}>
          <STable>
            <thead><tr><th>심각도</th><th>내용</th><th>상세</th><th>발생</th></tr></thead>
            <tbody>
              {d.firing.length === 0 && <tr><td colSpan={4} className="center muted" style={{ padding: 16 }}>발생 중인 알림이 없습니다.</td></tr>}
              {d.firing.map((a) => (
                <tr key={a.key}>
                  <td><span className={`badge ${a.severity === 'critical' ? 'red' : 'amber'}`}>{a.severity === 'critical' ? '위험' : '경고'}</span></td>
                  <td>{a.title}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{a.detail || '—'}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{new Date(a.since).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </STable>
        </div>
        {d.recent?.length > 0 && (
          <>
            <b style={{ fontSize: 13, display: 'block', marginTop: 12 }}>최근 통지</b>
            <div className="muted" style={{ fontSize: 12, marginTop: 4, maxHeight: '20vh', overflowY: 'auto' }}>
              {d.recent.map((r, i) => <div key={i}>{new Date(r.at).toLocaleTimeString()} · {r.title}{r.channels ? ` (${r.channels.join(', ')})` : ''}</div>)}
            </div>
          </>
        )}
      </div>
    </>
  );
}
