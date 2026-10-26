import React, { useEffect, useMemo, useState } from 'react';
import { fetchJson, putJson, postJson, hasRole } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import Select from '../../components/Select.jsx';
import { DAY_LABELS, daysLabel, splitEmails, isWinPattern, isLnxPattern, timeText, historyLine, MAIL_STATE_TEXT } from './guestPartText.js';

/**
 * 설정 › 수집 서버 › 게스트 파티션 사용률(v2.749 — 시안 ③④). 탭 셋: 수집·판정 / 무시 규칙(Windows·Linux) / 메일.
 *  - 수집 켜기·조회 주기는 게스트 디스크 회수와 **같은 수집**이라 그 설정(PUT /tools/guest-disk/settings)을 바꾼다(설정 한 곳).
 *  - 판정·무시 규칙·메일은 PUT /tools/guest-partition/settings 한 곳. 틀린 값은 서버가 저장하지 않고 이유를 준다 — 그대로 보여 준다.
 *  - 관리자(전체 범위)가 아니면 서버가 판정 기준만 주고 저장은 403 이다 — 화면도 읽기 전용으로 그린다.
 * 메일 규칙(받는 사람 합집합·요일·시각·소급 안 함·실패 알림 6시간)은 아이실론 디렉터리 사용량과 같은 서버 코어를 쓴다.
 */
const SEG = { flex: 'none', padding: '4px 12px' };
const PRESETS = [[1, '1시간'], [3, '3시간'], [6, '6시간'], [12, '12시간'], [24, '24시간'], [48, '2일'], [168, '7일']];
const WIN_RULES = [['reserved', '시스템 예약·복구 볼륨', '드라이브 문자 없는 볼륨(\\\\?\\Volume{…}) — Tools 가 이런 경로를 보고할 때만 해당합니다'], ['iso', 'CD-ROM·ISO 드라이브(추정)', '남은 공간 0 이고 용량이 작은 드라이브(C: 제외 — 가득 찬 C: 는 경보에 남깁니다) — 경로로는 드라이브 종류를 알 수 없어 추정입니다'], ['mountdir', '폴더 마운트 지점', 'C:\\Mount\\… 처럼 드라이브 안에 붙인 볼륨']];
const LNX_RULES = [['boot', '/boot · /boot/efi', '부트 파티션 — 커널 몇 개로 늘 높게 참'], ['virt', '/dev · /run · /sys · /proc', 'tmpfs·devtmpfs 같은 메모리 파일시스템'], ['snap', '/snap', 'snap 패키지 루프 마운트 — 늘 100%'], ['iso', '/mnt/cdrom · /media', 'ISO·이동식 매체'], ['docker', '/var/lib/docker · /var/lib/containers · /var/lib/kubelet/pods', '컨테이너 overlay 계층(같은 디스크가 여러 번 보임)']];

const box = { padding: 14, marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 };
const Check = ({ checked, onChange, disabled, children, desc }) => (
  <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: disabled ? 'default' : 'pointer' }}>
    <input type="checkbox" checked={!!checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} style={{ marginTop: 3 }} />
    <span style={{ display: 'flex', flexDirection: 'column' }}><span>{children}</span>{desc && <span className="muted" style={{ fontSize: 12 }}>{desc}</span>}</span>
  </label>
);

function PatternList({ value, onChange, ok, placeholder, disabled, label }) {
  const [draft, setDraft] = useState('');
  const [err, setErr] = useState('');
  const add = () => {
    const v = draft.trim();
    if (!v) return;
    if (!ok(v)) { setErr('형식이 맞지 않습니다 — 아래 안내를 보세요.'); return; }
    onChange([...new Set([...(value || []), v])]); setDraft(''); setErr('');
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div className="flex gap" style={{ flexWrap: 'wrap', gap: 6 }}>
        {(value || []).map((p) => (
          <span key={p} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 4px 2px 10px', borderRadius: 999, border: '1px solid rgba(148,163,184,.4)', fontFamily: 'var(--mono, monospace)', fontSize: 12.5 }}>
            {p}{!disabled && <button type="button" aria-label={`${p} 빼기`} onClick={() => onChange(value.filter((x) => x !== p))} style={{ border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 14, padding: '0 6px' }}>×</button>}
          </span>
        ))}
        {!(value || []).length && <span className="muted" style={{ fontSize: 12 }}>없음</span>}
      </div>
      {!disabled && (
        <div className="flex gap" style={{ gap: 6, flexWrap: 'wrap' }}>
          <input className="input" aria-label={label} value={draft} placeholder={placeholder} onChange={(e) => { setDraft(e.target.value); setErr(''); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} style={{ flex: '1 1 240px', minWidth: 0, fontFamily: 'var(--mono, monospace)' }} />
          <button type="button" className="tab" style={SEG} onClick={add}>추가</button>
        </div>
      )}
      {err && <span style={{ color: '#f87171', fontSize: 12 }}>{err}</span>}
    </div>
  );
}

function Days({ value, onChange, disabled }) {
  return (
    <div className="flex gap" style={{ gap: 4, flexWrap: 'wrap' }} role="group" aria-label="요일">
      {DAY_LABELS.map((l, i) => {
        const on = (value || []).includes(i);
        return <button key={l} type="button" disabled={disabled} aria-pressed={on} className={on ? 'login-btn' : 'tab'} style={{ flex: 'none', width: 40, padding: '4px 0' }}
          onClick={() => onChange(on ? value.filter((x) => x !== i) : [...(value || []), i].sort())}>{l}</button>;
      })}
    </div>
  );
}

export default function GuestPartSettings() {
  const [tab, setTab] = useState('judge');
  const [cfg, setCfg] = useState(null);       // GET /tools/guest-partition/settings
  const [form, setForm] = useState(null);     // 편집 중인 판정·규칙·메일
  const [collect, setCollect] = useState(null);
  const [vcs, setVcs] = useState([]);
  const [ignored, setIgnored] = useState(null);
  const [mail, setMail] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);
  const [testTo, setTestTo] = useState('');
  const [reload, setReload] = useState(0);
  const admin = hasRole('admin');

  useEffect(() => {
    const ac = new AbortController();
    setErr('');
    fetchJson('/tools/guest-partition/settings', {}, ac.signal).then((d) => {
      if (ac.signal.aborted) return;
      setCfg(d); setForm(JSON.parse(JSON.stringify(d.settings))); setCollect({ ...d.collect });
    }).catch((e) => { if (!ac.signal.aborted) setErr(e.message); });
    fetchJson('/tools/guest-partition', {}, ac.signal).then((d) => { if (!ac.signal.aborted) { setVcs(d.vcenters || []); setIgnored(d.ignored || null); } }).catch(() => {});
    return () => ac.abort();
  }, [reload]);
  const full = !!cfg?.full;
  useEffect(() => {
    if (!full) return undefined;
    const ac = new AbortController();
    fetchJson('/tools/guest-partition/mail', {}, ac.signal).then((d) => { if (!ac.signal.aborted) setMail(d); }).catch(() => {});
    return () => ac.abort();
  }, [full, reload]);

  const vcName = useMemo(() => { const m = new Map(vcs.map((v) => [v.id, v.name])); return (id) => m.get(id) || id; }, [vcs]);
  const set = (path, value) => setForm((f) => {
    const n = JSON.parse(JSON.stringify(f));
    let o = n; const ks = path.split('.');
    for (let i = 0; i < ks.length - 1; i++) { o[ks[i]] = o[ks[i]] ?? {}; o = o[ks[i]]; }
    o[ks[ks.length - 1]] = value;
    return n;
  });
  const ro = !full;

  const saveJudge = async () => {
    setBusy(true); setMsg(''); setErr('');
    try {
      if (collect && (collect.enabled !== cfg.collect.enabled || collect.intervalHours !== cfg.collect.intervalHours)) {
        const g = await putJson('/tools/guest-disk/settings', { enabled: collect.enabled, intervalHours: collect.intervalHours });
        if (g?.ok === false) { setErr(g.reason || g.error || '수집 설정을 저장하지 못했습니다.'); return; }
      }
      const r = await putJson('/tools/guest-partition/settings', { threshold: form.threshold, mode: form.mode, vcThresholds: form.vcThresholds });
      if (r?.ok === false) { setErr(r.reason || '저장하지 못했습니다.'); return; }   // sendJson 은 400 을 던지지 않고 본문을 준다 — 저장 거부를 성공으로 읽지 않는다
      setMsg(`저장했습니다 — 기본 임계 ${r?.settings?.threshold ?? form.threshold}%.`); setReload((x) => x + 1);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const saveRules = async () => {
    setBusy(true); setMsg(''); setErr('');
    try {
      const res = await putJson('/tools/guest-partition/settings', { rules: form.rules });
      if (res?.ok === false) { setErr(res.reason || '저장하지 못했습니다.'); return; }
      const n = (res?.settings?.rules?.win?.patterns?.length || 0) + (res?.settings?.rules?.lnx?.patterns?.length || 0);
      setMsg(`저장했습니다(경로 패턴 ${n}개) — 화면에는 바로, 메일에는 다음 발송부터 반영됩니다.`); setReload((x) => x + 1);
    }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const saveMail = async () => {
    setBusy(true); setMsg(''); setErr('');
    try {
      const before = cfg.settings.mail.vcenters || {};
      const vcenters = { ...form.mail.vcenters };
      for (const id of Object.keys(before)) if (!(id in vcenters)) vcenters[id] = null;   // 뺀 vCenter 는 null(서버가 지운다)
      for (const [id, v] of Object.entries(vcenters)) if (v) vcenters[id] = { ...v, to: Array.isArray(v.to) ? v.to : splitEmails(v.to) };
      const res = await putJson('/tools/guest-partition/settings', { mail: {
        from: form.mail.from, fromName: form.mail.fromName, commonTo: Array.isArray(form.mail.commonTo) ? form.mail.commonTo : splitEmails(form.mail.commonTo),
        digest: { ...form.mail.digest, to: Array.isArray(form.mail.digest.to) ? form.mail.digest.to : splitEmails(form.mail.digest.to), thr: form.mail.digest.thr === '' ? null : form.mail.digest.thr }, vcenters } });
      if (res?.ok === false) { setErr(res.reason || '저장하지 못했습니다.'); return; }
      setMsg(`메일 설정을 저장했습니다 — 통합 메일 ${res?.settings?.mail?.digest?.enabled ? '켜짐' : '꺼짐'} · vCenter 별 메일 ${Object.keys(res?.settings?.mail?.vcenters || {}).length}개.`); setReload((x) => x + 1);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const runNow = async () => {
    setBusy(true); setMsg('수집 중… vCenter 수에 따라 몇 분 걸릴 수 있습니다.');
    try { const r = await postJson('/tools/guest-disk/run', {}); setMsg(r.ok ? `수집 완료 — vCenter ${r.vcenters}개 · VM ${r.vms}대${r.errors?.length ? ` · 실패 ${r.errors.length}` : ''}` : (r.reason || '수집하지 못했습니다.')); setReload((x) => x + 1); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const doPreview = async (target) => {
    setPreview({ loading: true, target });
    try { setPreview({ ...(await postJson('/tools/guest-partition/mail/preview', { target })), target }); } catch (e) { setPreview({ error: e.message, target }); }
  };
  const sendNow = async (target) => {
    if (!window.confirm(`${target === 'digest' ? '통합 메일' : `${vcName(target)} 메일`}을 지금 보낼까요? (저장된 설정 기준)`)) return;
    setBusy(true); setMsg('');
    try { const r = await postJson('/tools/guest-partition/mail/send', { target }); setMsg(r.ok ? `보냈습니다(${r.recipients ?? ''}명).` : `보내지 않았습니다 — ${r.reason || MAIL_STATE_TEXT[r.state] || ''}`); setReload((x) => x + 1); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const sendTest = async () => {
    setBusy(true); setMsg('');
    try { const r = await postJson('/tools/guest-partition/mail/test', { to: splitEmails(testTo) }); setMsg(r.ok ? '테스트 메일을 보냈습니다.' : `보내지 못했습니다 — ${r.reason || ''}`); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  if (err && !cfg) return <ErrorBox message={err} />;
  if (!cfg || !form) return <Loading />;
  const r = form.rules;
  const dg = form.mail?.digest;
  const vcMail = form.mail?.vcenters || {};
  const unusedVcs = vcs.filter((v) => !(v.id in vcMail));
  const unusedThrVcs = vcs.filter((v) => !(v.id in (form.vcThresholds || {})));

  return (
    <div style={{ minWidth: 0 }}>
      <h2 style={{ margin: '0 0 4px', fontSize: 20 }}>게스트 파티션 사용률</h2>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>할당 대비 사용률이 임계 이상인 게스트를 찾는 기준·무시 규칙·메일. 화면은 특수기능 › 스토리지 › <a href="#/tools/guest-partition">게스트 파티션 사용률</a>.</div>
      {cfg.loadError && <div className="card" style={{ padding: 10, marginBottom: 10, borderColor: '#f87171', fontSize: 13 }}>{cfg.loadError}</div>}
      {ro && <div className="card muted" style={{ padding: 10, marginBottom: 10, fontSize: 13 }}>{admin ? '범위가 지정된 계정은 전 법인 공용 설정을 바꿀 수 없습니다 — 읽기 전용입니다.' : '관리자만 바꿀 수 있습니다 — 읽기 전용입니다(메일 설정은 보이지 않습니다).'}</div>}
      <div className="flex gap" style={{ flexWrap: 'wrap', marginBottom: 10 }}>
        {[['judge', '수집·판정'], ['rules', '무시 규칙(Windows·Linux)'], ...(full ? [['mail', '메일 발송']] : [])].map(([k, l]) => (
          <button key={k} type="button" className={tab === k ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '5px 14px' }} onClick={() => { setTab(k); setMsg(''); setErr(''); }}>{l}</button>
        ))}
      </div>
      {msg && <div className="card" style={{ padding: 8, marginBottom: 8, fontSize: 13 }}>{msg}</div>}
      {err && <ErrorBox message={err} />}

      {tab === 'judge' && (
        <>
          <section className="card" style={box}>
            <div className="flex gap" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' }}>
              <b>주기 수집</b>
              <Check checked={collect.enabled} disabled={ro} onChange={(v) => setCollect({ ...collect, enabled: v })}>{collect.enabled ? '켜짐 — 주기마다 자동 수집' : '꺼짐 — 지금 수집으로만'}</Check>
            </div>
            <div style={{ fontSize: 13 }}>조회 주기 — 몇 시간마다 모든 vCenter 의 게스트 파티션을 다시 읽을지</div>
            <div className="flex gap" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
              {PRESETS.map(([h, l]) => <button key={h} type="button" disabled={ro} className={collect.intervalHours === h ? 'login-btn' : 'tab'} style={SEG} onClick={() => setCollect({ ...collect, intervalHours: h })}>{l}</button>)}
              <label className="flex gap" style={{ alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span className="muted" style={{ fontSize: 12 }}>직접 입력</span>
                <input className="input" type="number" min={1} max={168} disabled={ro} value={collect.intervalHours} aria-label="조회 주기(시간)" style={{ width: 80, flex: 'none' }}
                  onChange={(e) => { const n = Math.round(Number(e.target.value)); if (n >= 1 && n <= 168) setCollect({ ...collect, intervalHours: n }); }} />
                <span className="muted" style={{ fontSize: 12 }}>시간(1~168)</span>
              </label>
            </div>
            <div className="muted" style={{ fontSize: 12.5 }}>
              하루 {collect.intervalHours >= 24 ? `${+(collect.intervalHours / 24).toFixed(1)}일에 1회` : `${+(24 / collect.intervalHours).toFixed(1)}회`} ·
              {' '}게스트 디스크 회수 화면과 <b>같은 수집</b>을 씁니다 — 이 주기를 바꾸면 두 화면이 함께 바뀝니다. 엣지 위임 vCenter 는 엣지가 정한 주기(기본 12시간)로 보냅니다.
              {collect.intervalHours < 3 && <b style={{ color: '#fbbf24' }}> 주기가 짧으면 vCenter 에 부담이 됩니다 — 파티션은 천천히 변하므로 보통 6~12시간이면 충분합니다.</b>}
            </div>
            {!ro && <div><button type="button" className="tab" style={SEG} disabled={busy} onClick={runNow}>지금 수집(중앙 직접 vCenter)</button></div>}
          </section>
          <section className="card" style={box}>
            <b>판정 기준</b>
            <div className="flex gap" style={{ flexWrap: 'wrap', alignItems: 'center', gap: 16 }}>
              <label className="flex gap" style={{ alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 13 }}>기본 임계 사용률</span>
                <input type="range" min={50} max={99} disabled={ro} value={form.threshold} onChange={(e) => set('threshold', Number(e.target.value))} aria-label="기본 임계 사용률" style={{ width: 180, flex: 'none' }} />
                <b style={{ color: '#fbbf24', fontSize: 18 }}>{form.threshold}%</b>
              </label>
              <div className="flex gap" role="group" aria-label="판정 단위">
                {[['part', '파티션 하나라도 넘으면'], ['vm', 'VM 파티션 합계로']].map(([k, l]) => <button key={k} type="button" disabled={ro} className={form.mode === k ? 'login-btn' : 'tab'} style={SEG} onClick={() => set('mode', k)}>{l}</button>)}
              </div>
            </div>
            <div className="muted" style={{ fontSize: 12.5 }}>화면에서 임계를 바꾸면 그 화면에서만 바뀝니다. 여기 값은 처음 열 때의 기본값이자 메일의 기준입니다(통합 메일은 메일 임계를 따로 둘 수 있습니다).</div>
            <div style={{ fontSize: 13 }}>vCenter 별 임계 — 기본값과 다르게 볼 vCenter 만</div>
            {Object.entries(form.vcThresholds || {}).map(([id, t]) => (
              <div key={id} className="flex gap" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                <span style={{ minWidth: 200 }}>{vcName(id)}</span>
                <input className="input" type="number" min={50} max={99} disabled={ro} value={t} aria-label={`${vcName(id)} 임계`} style={{ width: 80, flex: 'none' }}
                  onChange={(e) => set('vcThresholds', { ...form.vcThresholds, [id]: Number(e.target.value) })} />
                <span className="muted">%</span>
                {!ro && <button type="button" className="tab" style={SEG} onClick={() => { const n = { ...form.vcThresholds }; delete n[id]; set('vcThresholds', n); }}>빼기</button>}
              </div>
            ))}
            {!ro && unusedThrVcs.length > 0 && (
              <Select sort={false} className="input" value="" aria-label="vCenter 별 임계 추가" onChange={(e) => e.target.value && set('vcThresholds', { ...form.vcThresholds, [e.target.value]: form.threshold })} style={{ maxWidth: 320 }}>
                <option value="">+ vCenter 별 임계 추가</option>
                {unusedThrVcs.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </Select>
            )}
          </section>
          {!ro && <button type="button" className="login-btn" style={{ padding: '6px 18px' }} disabled={busy} onClick={saveJudge}>저장</button>}
        </>
      )}

      {tab === 'rules' && (
        <>
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>
            늘 가득 차 있는 것이 정상이거나 관리 대상이 아닌 파티션은 경보·메일에서 뺍니다(수집·저장은 그대로). OS 는 경로 모양으로 가립니다 — <b>C:\ 처럼 드라이브 문자로 시작하면 Windows</b>, <b>/ 로 시작하면 Linux</b>.
            {ignored && <> 지금 규칙으로 빠지는 파티션 <b>{ignored.total}</b>개(Windows {ignored.win} · Linux {ignored.lnx}).</>}
          </div>
          <div className="flex gap" style={{ flexWrap: 'wrap', gap: 12, alignItems: 'stretch' }}>
            <section className="card" style={{ ...box, flex: '1 1 380px' }}>
              <b>Windows <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>— 대소문자 구분 없음</span></b>
              <div style={{ fontSize: 13 }}>드라이브 통째로 무시 <span className="muted" style={{ fontSize: 12 }}>— 누른 드라이브는 모든 Windows 게스트에서 뺍니다</span></div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(44px, 1fr))', gap: 5 }} role="group" aria-label="무시할 드라이브 문자">
                {'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((c) => {
                  const on = r.win.letters.includes(c);
                  return <button key={c} type="button" disabled={ro} aria-pressed={on} className={on ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '6px 0', textDecoration: on ? 'line-through' : 'none' }}
                    onClick={() => set('rules.win.letters', on ? r.win.letters.filter((x) => x !== c) : [...r.win.letters, c].sort())}>{c}:</button>;
                })}
              </div>
              {r.win.letters.includes('C') && <div style={{ color: '#fbbf24', fontSize: 12.5 }}>C: 를 무시하면 OS 드라이브 경보가 모두 사라집니다.</div>}
              {WIN_RULES.map(([k, l, d]) => <Check key={k} checked={r.win[k]} disabled={ro} desc={d} onChange={(v) => set(`rules.win.${k}`, v)}>{l}</Check>)}
              <div style={{ fontSize: 13 }}>경로 패턴 <span className="muted" style={{ fontSize: 12 }}>— * 는 아무 글자. C:\ 처럼 드라이브 문자로 시작</span></div>
              <PatternList value={r.win.patterns} disabled={ro} ok={isWinPattern} label="Windows 경로 패턴" placeholder="예: C:\ClusterStorage\*  ·  E:\Backup\*" onChange={(v) => set('rules.win.patterns', v)} />
            </section>
            <section className="card" style={{ ...box, flex: '1 1 380px' }}>
              <b>Linux <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>— 대소문자 구분</span></b>
              {LNX_RULES.map(([k, l, d]) => <Check key={k} checked={r.lnx[k]} disabled={ro} desc={d} onChange={(v) => set(`rules.lnx.${k}`, v)}><span style={{ fontFamily: 'var(--mono, monospace)' }}>{l}</span></Check>)}
              <div style={{ fontSize: 13 }}>마운트 지점 패턴 <span className="muted" style={{ fontSize: 12 }}>— /data 는 그 지점만, /data/* 는 그 아래 전부</span></div>
              <PatternList value={r.lnx.patterns} disabled={ro} ok={isLnxPattern} label="Linux 마운트 지점 패턴" placeholder="예: /opt/backup/*  ·  /var/lib/pgsql/archive" onChange={(v) => set('rules.lnx.patterns', v)} />
            </section>
          </div>
          <section className="card" style={box}>
            <b>두 OS 공통</b>
            <div className="flex gap" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
              <Check checked={r.tinyOn} disabled={ro} onChange={(v) => set('rules.tinyOn', v)}>용량이</Check>
              <input className="input" type="number" min={0} max={100} step={0.5} disabled={ro} value={r.tinyGB} aria-label="무시할 파티션 용량 기준(GB)" style={{ width: 80, flex: 'none' }} onChange={(e) => set('rules.tinyGB', Number(e.target.value))} />
              <span>GB 미만인 파티션 무시</span>
            </div>
            <div style={{ fontSize: 13 }}>VM 이름으로 통째로 빼기 <span className="muted" style={{ fontSize: 12 }}>— * 는 아무 글자, 대소문자 구분 없음</span></div>
            <PatternList value={r.vmPatterns} disabled={ro} ok={(s) => !!s.trim() && s.length <= 100} label="VM 이름 패턴" placeholder="예: *-tmpl-*  ·  vdi-gold-*" onChange={(v) => set('rules.vmPatterns', v)} />
          </section>
          {!ro && <button type="button" className="login-btn" style={{ padding: '6px 18px' }} disabled={busy} onClick={saveRules}>저장</button>}
        </>
      )}

      {tab === 'mail' && full && dg && (
        <>
          {mail?.server && (
            <div className="card muted" style={{ padding: 10, marginBottom: 10, fontSize: 12.5 }}>
              메일 서버 {mail.server.configured ? '설정됨' : <b style={{ color: '#f87171' }}>설정 안 됨</b>} · 메일 발송 {mail.server.enabled ? '켜짐' : <b style={{ color: '#f87171' }}>꺼짐</b>} ·
              {' '}'게스트 파티션 사용률' 종류 {mail.server.kindEnabled ? '켜짐' : <b style={{ color: '#f87171' }}>꺼짐</b>} · 기본 받는 사람 {mail.server.defaultTo}명 — <a href="#/settings/mail">설정 › 메일 발송</a>에서 바꿉니다.
            </div>
          )}
          <section className="card" style={box}>
            <b>보내는 사람</b>
            <div className="flex gap" style={{ flexWrap: 'wrap', gap: 8 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 260px' }}><span className="muted" style={{ fontSize: 12 }}>주소(From) — 비우면 메일 서버 설정의 주소{mail?.server?.from ? `(${mail.server.from})` : ''}</span>
                <input className="input" value={form.mail.from} onChange={(e) => set('mail.from', e.target.value)} placeholder="예: storage-alert@회사도메인" /></label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 200px' }}><span className="muted" style={{ fontSize: 12 }}>표시 이름 — 비우면 메일 서버 설정의 이름</span>
                <input className="input" value={form.mail.fromName} onChange={(e) => set('mail.fromName', e.target.value)} placeholder="예: VMware 포탈 디스크 경보" /></label>
            </div>
            <div className="muted" style={{ fontSize: 12 }}>헤더의 보내는 사람만 바뀝니다(반송은 메일 서버 설정의 주소로 갑니다). 사내 메일 서버가 로그인 계정과 다른 주소를 거부할 수 있으니 저장 뒤 테스트 발송으로 확인하세요.</div>
          </section>
          <section className="card" style={box}>
            <div className="flex gap" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' }}>
              <b>전체 법인 통합 메일</b>
              <Check checked={dg.enabled} onChange={(v) => set('mail.digest.enabled', v)}>{dg.enabled ? '켜짐' : '꺼짐'}</Check>
            </div>
            <div className="flex gap" style={{ flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
              <Days value={dg.days} onChange={(v) => set('mail.digest.days', v)} />
              <label className="flex gap" style={{ alignItems: 'center', gap: 6, flexWrap: 'wrap' }}><span className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>시각</span>
                <input className="input" type="time" value={dg.time} onChange={(e) => set('mail.digest.time', e.target.value)} style={{ width: 120, flex: 'none' }} aria-label="통합 메일 시각" />
                <span className="muted" style={{ fontSize: 12 }}>포탈 시각(한국)</span></label>
            </div>
            <div className="muted" style={{ fontSize: 12.5 }}>{daysLabel(dg.days)} {dg.time}{mail?.status?.digest?.next?.length ? ` · 다음 ${mail.status.digest.next.map((t) => timeText(t)).join(', ')}` : ''} — 켜거나 요일·시각을 바꾸면 이미 지난 회차는 보내지 않습니다.</div>
            <Check checked={dg.includeAdmin} onChange={(v) => set('mail.digest.includeAdmin', v)} desc={`메일 설정의 기본 받는 사람 ${mail?.server?.defaultTo ?? 0}명`}>통합 관리자에게 보내기</Check>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><span className="muted" style={{ fontSize: 12 }}>추가 받는 사람(쉼표·줄바꿈으로 여러 명, 50명까지)</span>
              <textarea className="input" rows={2} value={Array.isArray(dg.to) ? dg.to.join(', ') : dg.to} onChange={(e) => set('mail.digest.to', e.target.value)} /></label>
            <div className="flex gap" style={{ flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
              <label className="flex gap" style={{ alignItems: 'center', gap: 6, flexWrap: 'wrap' }}><span style={{ fontSize: 13, whiteSpace: 'nowrap' }}>메일 임계</span>
                <input className="input" type="number" min={50} max={99} value={dg.thr ?? ''} placeholder={String(form.threshold)} style={{ width: 80, flex: 'none' }} aria-label="메일 임계(비우면 기본 임계)"
                  onChange={(e) => set('mail.digest.thr', e.target.value === '' ? '' : Number(e.target.value))} /><span className="muted" style={{ fontSize: 12 }}>% (비우면 기본·vCenter 별 임계)</span></label>
              <label className="flex gap" style={{ alignItems: 'center', gap: 6, flexWrap: 'wrap' }}><span style={{ fontSize: 13 }}>본문에 상위</span>
                <input className="input" type="number" min={1} max={50} value={dg.topN} style={{ width: 70, flex: 'none' }} aria-label="본문에 실을 개수" onChange={(e) => set('mail.digest.topN', Number(e.target.value))} /><span style={{ fontSize: 13 }}>개</span></label>
            </div>
            <Check checked={dg.newOnly} onChange={(v) => set('mail.digest.newOnly', v)} desc="지난 메일 이후 임계를 새로 넘은 게스트만 — 매번 같은 목록을 받지 않게(없으면 보내지 않음)">새로 넘은 게스트만 보내기</Check>
            <Check checked={dg.skipIfNoNew} onChange={(v) => set('mail.digest.skipIfNoNew', v)} desc="직전 발송 뒤 새 수집이 없으면 건너뜁니다(기록에는 남깁니다)">새 수집이 없으면 보내지 않기</Check>
            <Check checked={dg.critNow} onChange={(v) => set('mail.digest.critNow', v)} desc="정한 요일·시각을 기다리지 않고 수집 직후 따로 보냅니다 — 같은 파티션은 24시간에 한 번">95% 이상은 수집 직후 바로 알리기</Check>
            <Check checked={dg.csv} onChange={(v) => set('mail.digest.csv', v)} desc="본문에는 상위 N개만 싣고 전체 목록은 CSV 로 첨부합니다">전체 목록 CSV 첨부</Check>
            <div className="flex gap" style={{ flexWrap: 'wrap' }}>
              <button type="button" className="tab" style={SEG} onClick={() => doPreview('digest')}>미리보기(저장된 설정)</button>
              <button type="button" className="tab" style={SEG} disabled={busy} onClick={() => sendNow('digest')}>지금 보내기</button>
            </div>
          </section>
          <section className="card" style={box}>
            <b>vCenter 별 담당자 메일</b>
            <div className="muted" style={{ fontSize: 12.5 }}>그 vCenter 분만 담당자에게 보냅니다. 받는 사람 = 공통 받는 사람(빼지 않으면) ∪ 담당자 — 같은 주소는 한 번만 갑니다.</div>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><span className="muted" style={{ fontSize: 12 }}>공통 받는 사람 — 모든 vCenter 별 메일을 함께 받습니다</span>
              <textarea className="input" rows={2} value={Array.isArray(form.mail.commonTo) ? form.mail.commonTo.join(', ') : form.mail.commonTo} onChange={(e) => set('mail.commonTo', e.target.value)} /></label>
            {Object.entries(vcMail).map(([id, m]) => (
              <div key={id} className="card" style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div className="flex gap" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' }}>
                  <b>{vcName(id)}</b>
                  <div className="flex gap" style={{ flexWrap: 'wrap' }}>
                    <button type="button" className="tab" style={SEG} onClick={() => doPreview(id)}>미리보기</button>
                    <button type="button" className="tab" style={SEG} disabled={busy} onClick={() => sendNow(id)}>지금 보내기</button>
                    <button type="button" className="tab" style={SEG} onClick={() => { const n = { ...vcMail }; delete n[id]; set('mail.vcenters', n); }}>빼기</button>
                  </div>
                </div>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><span className="muted" style={{ fontSize: 12 }}>담당자(여러 명)</span>
                  <input className="input" value={Array.isArray(m.to) ? m.to.join(', ') : m.to} onChange={(e) => set('mail.vcenters', { ...vcMail, [id]: { ...m, to: e.target.value } })} placeholder="예: seoul-infra@회사도메인, kim@회사도메인" /></label>
                <div className="flex gap" style={{ flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
                  <div className="flex gap" role="group" aria-label="보내는 때">
                    {[['scan', '수집이 끝날 때마다'], ['schedule', '정한 요일·시각']].map(([k, l]) => <button key={k} type="button" className={m.when === k ? 'login-btn' : 'tab'} style={SEG} onClick={() => set('mail.vcenters', { ...vcMail, [id]: { ...m, when: k } })}>{l}</button>)}
                  </div>
                  {m.when === 'schedule' && <>
                    <Days value={m.days} onChange={(v) => set('mail.vcenters', { ...vcMail, [id]: { ...m, days: v } })} />
                    <input className="input" type="time" value={m.time} aria-label={`${vcName(id)} 보내는 시각`} style={{ width: 120, flex: 'none' }} onChange={(e) => set('mail.vcenters', { ...vcMail, [id]: { ...m, time: e.target.value } })} />
                  </>}
                </div>
                <div className="flex gap" style={{ flexWrap: 'wrap', gap: 14 }}>
                  <Check checked={m.excludeCommon} onChange={(v) => set('mail.vcenters', { ...vcMail, [id]: { ...m, excludeCommon: v } })}>공통 받는 사람 빼기</Check>
                  <Check checked={m.onlyOnChange} onChange={(v) => set('mail.vcenters', { ...vcMail, [id]: { ...m, onlyOnChange: v } })}>새로 넘은 게스트가 없으면 보내지 않기</Check>
                  {m.when === 'schedule' && <Check checked={m.skipIfNoNew} onChange={(v) => set('mail.vcenters', { ...vcMail, [id]: { ...m, skipIfNoNew: v } })}>새 수집이 없으면 보내지 않기</Check>}
                  <Check checked={m.onFailure} onChange={(v) => set('mail.vcenters', { ...vcMail, [id]: { ...m, onFailure: v } })}>수집 실패·지연 알림(6시간에 한 번)</Check>
                </div>
              </div>
            ))}
            {unusedVcs.length > 0 && (
              <Select sort={false} className="input" value="" aria-label="담당자 메일을 둘 vCenter 추가" style={{ maxWidth: 340 }}
                onChange={(e) => e.target.value && set('mail.vcenters', { ...vcMail, [e.target.value]: { to: [], excludeCommon: false, onlyOnChange: false, onFailure: false, when: 'scan', days: [1], time: '09:00', skipIfNoNew: true } })}>
                <option value="">+ 담당자 메일을 둘 vCenter 추가</option>
                {unusedVcs.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </Select>
            )}
          </section>
          <div className="flex gap" style={{ flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
            <button type="button" className="login-btn" style={{ padding: '6px 18px' }} disabled={busy} onClick={saveMail}>메일 설정 저장</button>
            <input className="input" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="테스트 받을 주소(5명까지)" aria-label="테스트 받을 주소" style={{ flex: '1 1 220px', maxWidth: 340 }} />
            <button type="button" className="tab" style={SEG} disabled={busy || !testTo.trim()} onClick={sendTest}>테스트 발송(통합 메일 내용)</button>
          </div>
          {preview && (
            <section className="card" style={box}>
              <div className="flex gap" style={{ justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap' }}>
                <b>미리보기 — {preview.target === 'digest' ? '통합 메일' : vcName(preview.target)}</b>
                <button type="button" className="tab" style={SEG} onClick={() => setPreview(null)}>닫기</button>
              </div>
              {preview.loading && <Loading />}
              {preview.error && <ErrorBox message={preview.error} />}
              {preview.subject && <>
                <div style={{ fontSize: 13 }}><b>제목</b> {preview.subject}</div>
                <div className="muted" style={{ fontSize: 12.5 }}>받는 사람 {preview.recipients}명 · 실을 대상 {preview.rows}개 · 새로 넘음 {preview.newCount}{preview.attachment ? ` · 첨부 ${preview.attachment}` : ''}{preview.demo ? ' · 데모 데이터' : ''}</div>
                <iframe title="메일 미리보기" sandbox="" srcDoc={preview.html} style={{ width: '100%', height: 560, border: '1px solid rgba(148,163,184,.3)', borderRadius: 8, background: '#fff' }} />
              </>}
            </section>
          )}
          <section className="card" style={box}>
            <b>최근 발송 기록</b>
            <STable minWidth={640} limit={30} style={{ width: '100%' }}>
              <thead><tr><th>시각</th><th>결과</th><th>내용</th></tr></thead>
              <tbody>
                {(mail?.status?.history || []).map((h, i) => (
                  <tr key={`${h.at}-${i}`}>
                    <td data-sort={h.at}>{timeText(h.at)}</td>
                    <td style={{ color: h.state === 'sent' ? '#86efac' : h.state === 'failed' ? '#fca5a5' : undefined }}>{MAIL_STATE_TEXT[h.state] || h.state}</td>
                    <td style={{ fontSize: 12.5 }}>{historyLine(h, vcName)}</td>
                  </tr>
                ))}
                {!(mail?.status?.history || []).length && <tr><td colSpan={3} className="muted" style={{ textAlign: 'center', padding: 14 }}>기록이 없습니다.</td></tr>}
              </tbody>
            </STable>
          </section>
        </>
      )}
    </div>
  );
}
