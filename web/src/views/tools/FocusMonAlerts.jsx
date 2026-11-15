/**
 * views/tools/FocusMonAlerts.jsx — 서버 집중 모니터링 ‘알림’ 탭(v3.16.0 ⑯ — 시안 Alerts · 사용자 "기본값대로 모두 구현해줘").
 *  · 알림 규칙(지표 · 문턱 · 지속 · 대상 · 심각도) — 계속 수집 서버에만 · 보내는 곳은 포탈의 기존 알람 · 메일 채널(새 채널 없음).
 *  · 규칙 만들기 — '지난 24시간에 걸었다면'(서버 하나의 1분 요약 · 추정) · 저장은 관리자 · 전체 쓰기 범위(서버가 다시 막는다) · 감사.
 *  · 지난 24시간 발생 · 해제 · 판정 보류 · OOM · 커널 오류(60초마다 · 원문 없음 · 권한 없음은 따로) · 수집 부하 자동 조절(기본 꺼짐).
 *  · 무거운 조회가 아니지만 2초마다 묻지 않는다(판정이 1분마다) — 30초.
 */
import React, { useMemo, useState } from 'react';
import { postJson, putJson, delJson } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import Select from '../../components/Select.jsx';
import { DASH, clockText, agoShort } from './focusMonText.js';
import { SEV_TEXT, READ_TEXT, scopeText, nowText, thresholdIssue, previewText, kerrText } from './focusMonAlertsText.js';
import { usePoll } from './focusMonPoll.js';
import { Seg } from './FocusMonBulk.jsx';

/** 고르기 — 공용 Select(네이티브) 위에 값 · 목록만 받는 얇은 겉. */
function Pick({ value, onChange, options, ariaLabel }) {
  return <Select sort={false} className="fm-input" value={value} aria-label={ariaLabel} onChange={(e) => onChange(e.target.value)}>{options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>;
}

const EMPTY = { name: '', metric: 'cpu', threshold: 90, durMin: 5, severity: 'warn', scope: { kind: 'record' }, app: '' };

function PreviewStrip({ p }) {
  if (!p || !Array.isArray(p.series) || !p.series.length) return null;
  const from = p.from; const to = p.to; const W = 600;
  const x = (t) => ((t - from) / (to - from)) * W;
  return (
    <svg viewBox={`0 0 ${W} 14`} className="fm-alprev" role="img" aria-label={`지난 24시간 — 발생했을 구간 ${p.count}개`}>
      <rect x="0" y="5" width={W} height="4" fill="var(--fm-track)" />
      {p.intervals.map(([a, b], i) => <rect key={i} x={x(a)} y="2" width={Math.max(2, x(b ?? to) - x(a))} height="10" fill="#ef4444"><title>{`${clockText(a, true)} ~ ${b ? clockText(b, true) : '지금'}`}</title></rect>)}
    </svg>
  );
}

function RuleForm({ data, main, onSaved, setMsg, editing, onCancel }) {
  const [f, setF] = useState(() => (editing ? { ...EMPTY, ...editing, app: editing.app || '' } : EMPTY));
  const [pv, setPv] = useState(null); const [pvTarget, setPvTarget] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const M = data.metrics[f.metric];
  const recordTargets = useMemo(() => main.targets.filter((t) => (main.sessions || []).some((s) => s.mode === 'record' && s.targets.includes(t.id))), [main.targets, main.sessions]);
  const groups = (main.groups?.list || []).map((g) => g.name);
  const set = (k, v) => { setF((x) => ({ ...x, [k]: v })); setPv(null); };
  const tIssue = thresholdIssue(f.threshold, M);
  const body = () => ({ ...f, threshold: Number(f.threshold), app: f.metric === 'app' ? f.app : undefined });
  const save = () => {
    setBusy(true); setErr('');
    const p = editing ? putJson(`/tools/focus-mon/alerts/rules/${encodeURIComponent(editing.id)}`, body()) : postJson('/tools/focus-mon/alerts/rules', body());
    p.then(() => { setMsg?.({ tone: 'ok', text: `규칙 ‘${f.name}’ 을(를) ${editing ? '고쳤' : '만들었'}습니다.` }); onSaved(); })
      .catch((e) => setErr(e?.body?.reason || e?.message || '저장하지 못했습니다.')).finally(() => setBusy(false));
  };
  const preview = () => {
    const tid = pvTarget || recordTargets[0]?.id || main.targets[0]?.id;
    if (!tid) return;
    setBusy(true); setErr('');
    postJson('/tools/focus-mon/alerts/preview', { target: tid, rule: body() }).then((r) => setPv({ ...r, target: tid })).catch((e) => setErr(e?.body?.reason || e?.message || '미리 보지 못했습니다.')).finally(() => setBusy(false));
  };
  return (
    <div className="fm-card fm-col fm-alform">
      <h3 className="fm-h3">{editing ? `규칙 고치기 — ${editing.name}` : '규칙 만들기'}</h3>
      <label className="fm-col"><span className="fm-lbl">이름</span><input className="fm-input" value={f.name} maxLength={60} onChange={(e) => set('name', e.target.value)} placeholder="예: DB CPU 높음" /></label>
      <div className="fm-col"><span className="fm-lbl">지표</span>
        <Pick value={f.metric} onChange={(v) => set('metric', v)} options={Object.entries(data.metrics).map(([k, m]) => ({ value: k, label: m.label }))} ariaLabel="지표" /></div>
      {f.metric === 'app' ? <label className="fm-col"><span className="fm-lbl">필수 앱(서비스 이름)</span><input className="fm-input fm-mono" value={f.app} maxLength={100} onChange={(e) => set('app', e.target.value.trim())} placeholder="oracle-db.service" /></label> : null}
      <label className="fm-col"><span className="fm-lbl">문턱 — {M.op === 'lt' ? '이 수보다 적으면' : '이 값 이상이면'}({M.unit})</span>
        <input className="fm-input" type="number" value={f.threshold} min={M.range[0]} max={M.range[1]} onChange={(e) => set('threshold', e.target.value)} />{tIssue ? <span className="fm-why">{tIssue}</span> : null}</label>
      <div className="fm-col"><span className="fm-lbl">지속</span><Seg label="지속" value={f.durMin} onChange={(v) => set('durMin', v)} options={data.limits.dur.map((d) => [d, `${d}분`])} /></div>
      <div className="fm-col"><span className="fm-lbl">대상</span>
        <Seg label="대상" value={f.scope.kind} onChange={(k) => set('scope', k === 'group' ? { kind: k, group: groups[0] || '' } : k === 'server' ? { kind: k, target: recordTargets[0]?.id || main.targets[0]?.id || '' } : { kind: k })} options={[['record', '계속 수집 전체'], ['group', '그룹'], ['server', '서버 하나']]} />
        {f.scope.kind === 'group' ? (groups.length ? <Pick value={f.scope.group} onChange={(v) => set('scope', { kind: 'group', group: v })} options={groups.map((g) => ({ value: g, label: g }))} ariaLabel="그룹" /> : <span className="fm-why">그룹이 없습니다 — ‘대상 · 키’ 탭에서 만드세요.</span>) : null}
        {f.scope.kind === 'server' ? <Pick value={f.scope.target} onChange={(v) => set('scope', { kind: 'server', target: v })} options={main.targets.map((t) => ({ value: t.id, label: t.name }))} ariaLabel="서버" /> : null}
      </div>
      <div className="fm-col"><span className="fm-lbl">심각도</span><Seg label="심각도" value={f.severity} onChange={(v) => set('severity', v)} options={[['warn', '주의'], ['crit', '위험']]} /></div>
      <div className="fm-col"><span className="fm-lbl">보내는 곳</span><span className="fm-dim">포탈 알람 · 메일(설정 › 알림 채널 그대로 — 이 화면에서 새 채널을 만들지 않습니다)</span></div>
      <div className="fm-col fm-alpv"><span className="fm-lbl">지난 24시간에 걸었다면(추정)</span>
        <div className="fm-row fm-flexwrap"><Pick value={pvTarget || recordTargets[0]?.id || main.targets[0]?.id || ''} onChange={setPvTarget} options={main.targets.map((t) => ({ value: t.id, label: t.name }))} ariaLabel="미리 볼 서버" />
          <button type="button" className="fm-btn" disabled={busy || !!tIssue} onClick={preview}>미리 보기</button></div>
        {pv ? <><span className="fm-dim">{previewText(pv)}</span><PreviewStrip p={pv} /><span className="fm-dim">빨간 줄 = 발생했을 구간 · 1분 요약(평균)으로 계산 — 실제 판정(표본마다)과 조금 다를 수 있습니다</span></> : null}
      </div>
      {err ? <div className="fm-why">{err}</div> : null}
      <div className="fm-row">{editing ? <button type="button" className="fm-btn" onClick={onCancel}>취소</button> : null}
        <button type="button" className="fm-btn pri" disabled={busy || !f.name.trim() || !!tIssue || (f.metric === 'app' && !f.app)} onClick={save}>규칙 저장</button></div>
    </div>
  );
}

/** ‘알림’ 탭. */
export function AlertsTab({ main, setMsg, reloadMain }) {
  const q = usePoll('/tools/focus-mon/alerts', null, 30_000, true);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const d = q.data;
  const nameOf = (id) => main.targets.find((t) => t.id === id)?.name || id;
  if (q.error && !d) return <ErrorBox error={q.error} />;
  if (!d) return <Loading />;
  const act = (p, ok) => { setBusy(true); p.then(() => { setMsg?.({ tone: 'ok', text: ok }); q.reload(); }).catch((e) => setMsg?.({ tone: 'bad', text: e?.body?.reason || e?.message })).finally(() => setBusy(false)); };
  const firing = d.rules.reduce((a, r) => a + (r.firing || 0), 0); const hold = d.rules.reduce((a, r) => a + (r.hold || 0), 0);
  return (
    <div className="fm-col fm-alerts">
      {d.mock ? <div className="fm-ban">데모 모드 — 알림을 실제 채널로 보내지 않습니다(기록만 남깁니다).</div> : null}
      <div className="fm-split fm-alsplit">
        <div className="fm-col">
          <div className="fm-card fm-flush">
            <div className="fm-pad fm-row fm-between"><h3 className="fm-h3">알림 규칙 — {d.rules.length}개</h3><span className="fm-dim">지금 발생 {firing}건 · 판정 보류 {hold}건</span></div>
            {d.rules.length ? (
              <div className="fm-tblbox">
                <STable className="fm-table" minWidth={760}>
                  <thead><tr><th>규칙</th><th>대상</th><th>조건</th><th>심각도</th><th>지금</th><th data-nosort="1" /></tr></thead>
                  <tbody>{d.rules.map((r) => { const nw = nowText(r, { judged: d.lastCycleAt != null }); const sv = SEV_TEXT[r.severity]; return (
                    <tr key={r.id}>
                      <td>{r.name}</td><td>{scopeText(r, nameOf)}</td><td className="fm-brk">{r.cond}</td>
                      <td><span className={`fm-badge ${sv?.tone || 'off'}`}>{sv?.label || r.severity}</span></td>
                      <td><span className={`fm-badge ${nw.tone}`}>{nw.text}</span></td>
                      <td><div className="fm-row fm-flexwrap">
                        <button type="button" className="fm-btn sm" disabled={busy} onClick={() => setEditing(r)}>고치기</button>
                        <button type="button" className="fm-btn sm" disabled={busy} onClick={() => act(putJson(`/tools/focus-mon/alerts/rules/${encodeURIComponent(r.id)}`, { enabled: !r.enabled }), `‘${r.name}’ 을(를) ${r.enabled ? '껐' : '켰'}습니다.`)}>{r.enabled ? '끄기' : '켜기'}</button>
                        <button type="button" className="fm-btn sm" disabled={busy} onClick={() => { if (window.confirm(`규칙 ‘${r.name}’ 을(를) 지울까요?`)) act(delJson(`/tools/focus-mon/alerts/rules/${encodeURIComponent(r.id)}`), `‘${r.name}’ 을(를) 지웠습니다.`); }}>지우기</button>
                      </div></td>
                    </tr>); })}</tbody>
                </STable>
              </div>
            ) : <div className="fm-note fm-pad">규칙이 없습니다 — 오른쪽에서 만드세요.</div>}
            <div className="fm-note fm-pad">규칙은 계속 수집 서버에만 겁니다 — 잠깐 보기는 끝나면 값이 끊겨 ‘얼마 동안’ 을 판정할 수 없습니다. 값을 못 읽은 동안(수집 끊김 · 엣지 응답 없음)은 정상도 발생도 아닌 판정 보류로 따로 셉니다(해제로 알리지 않습니다). 해제는 문턱보다 {Math.round(d.limits.resolveMargin * 100)}% 낮은 값이 같은 시간 이어질 때입니다. 정비 창(베어메탈 사용률 — 같은 법인 · IP 의 서버를 덮고 ‘알림’ 을 켠 창) 동안은 보내지 않고 기록만 남깁니다. 판정은 중앙이 1분마다 받은 표본으로 합니다.</div>
          </div>
          <div className="fm-card fm-flush">
            <div className="fm-pad fm-row fm-between"><h3 className="fm-h3">최근 24시간 발생 · 해제 · 보류</h3><span className="fm-dim">포탈 알람 · 메일과 같은 기록 · 서버 상세의 사건에도 붙습니다</span></div>
            {d.history.length ? (
              <div className="fm-tblbox"><STable className="fm-table" minWidth={620}>
                <thead><tr><th>시각</th><th>서버</th><th>내용</th></tr></thead>
                <tbody>{d.history.map((e) => <tr key={`${e.id}-${e.target}`}><td className="fm-mono" data-sort={e.at}>{clockText(e.at, true)}</td><td>{nameOf(e.target)}</td><td className="fm-brk">{e.text}</td></tr>)}</tbody>
              </STable></div>
            ) : <div className="fm-note fm-pad">지난 24시간에 발생 · 해제가 없습니다.</div>}
          </div>
        </div>
        <RuleForm key={editing?.id || 'new'} data={d} main={main} editing={editing} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); q.reload(); }} setMsg={setMsg} />
      </div>
      <div className="fm-card fm-flush">
        <div className="fm-pad fm-row fm-between"><h3 className="fm-h3">OOM · 커널 오류</h3><span className="fm-dim">60초마다 · 새 줄만 · 원문은 보관하지 않고 종료된 프로그램 이름 · 횟수 · 시각만</span></div>
        {d.kmsg.length ? (
          <div className="fm-tblbox"><STable className="fm-table" minWidth={680}>
            <thead><tr><th>서버</th><th>커널 메시지 읽기</th><th className="fm-r">OOM(24시간)</th><th>마지막 OOM</th><th>그 밖 커널 오류(24시간)</th></tr></thead>
            <tbody>{d.kmsg.map((k) => { const rd = READ_TEXT[k.read]; return (
              <tr key={k.id}><td>{k.name}</td>
                <td>{rd ? <span className={`fm-badge ${rd.tone}`}>{rd.label}</span> : <span className="fm-dim">아직 모름</span>}</td>
                <td className="fm-r fm-num" data-sort={k.oom}>{k.read === 'denied' && !k.oom ? DASH : k.oom}</td>
                <td data-sort={k.lastOom?.at ?? null}>{k.lastOom ? `${clockText(k.lastOom.at, true)} · ${k.lastOom.text.replace(/^OOM — /, '')}` : DASH}</td>
                <td>{k.read === 'denied' && !k.kerr ? DASH : kerrText(k.kerr)}</td></tr>); })}</tbody>
          </STable></div>
        ) : <div className="fm-note fm-pad">계속 수집 중인 서버가 없습니다.</div>}
        <div className="fm-note fm-pad">커널 메시지는 서버 설정(kernel.dmesg_restrict = 0)일 때만 일반 계정이 읽습니다 — 막힌 서버는 ‘권한 없음’ 이지 ‘OOM 없음’ 이 아닙니다(‘—’). OOM 은 서버 상세의 사건에도 붙습니다.</div>
      </div>
      <div className="fm-card fm-flush">
        <div className="fm-pad fm-row fm-between"><h3 className="fm-h3">수집 부하 자동 조절</h3>
          <Seg label="자동 조절" value={d.tune.enabled ? 'on' : 'off'} onChange={(v) => act(putJson('/tools/focus-mon/settings', { autoTune: v === 'on' ? 1 : 0 }).then(() => reloadMain?.()), v === 'on' ? '자동 조절을 켰습니다.' : '자동 조절을 껐습니다.')} options={[['off', '꺼짐'], ['on', '켜짐']]} /></div>
        <div className="fm-note fm-pad">켜면 계속 수집 서버마다 수집 비용이 주의 문턱({d.tune.warnPct}% — 수집 부하 탭의 판정 문턱)을 두 창(30초씩) 넘으면 프로세스 표본 주기를 한 단계 늘리고(5 → 15 → 30초), 문턱의 절반 아래가 1시간 이어지면 한 단계씩 되돌립니다(설정 {d.tune.base}초까지). 원격 명령은 미리 만든 상수 가운데 고르기만 합니다. 바꿀 때 접속을 한 번 다시 열고(몇 초 공백) 사건에 남깁니다.</div>
        {d.tune.recent.length ? (
          <div className="fm-tblbox"><STable className="fm-table" minWidth={600}>
            <thead><tr><th>시각</th><th>서버</th><th>바꾼 것</th><th>까닭</th></tr></thead>
            <tbody>{d.tune.recent.map((x, i) => <tr key={i}><td className="fm-mono" data-sort={x.at}>{agoShort(x.at, Date.now())}</td><td>{x.name}</td><td>프로세스 표본 {x.from}초 → {x.to}초</td><td className="fm-brk">{x.why}</td></tr>)}</tbody>
          </STable></div>
        ) : <div className="fm-note fm-pad">최근 바꾼 것이 없습니다.</div>}
      </div>
    </div>
  );
}
