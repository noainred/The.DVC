import React, { useEffect, useRef, useState } from 'react';
import { fetchJson, postJson } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import Select from '../../components/Select.jsx';
import BoldText from '../../components/boldText.jsx';
import { bytesText } from './bareosInstallText.js';
import { unitText } from '../unitText.js';
import {
  SECRET_SLOT, consoleText, sdDeviceText, dirStorageText, passwordIssue, pwPairIssue, nameIssue, storageRows, portalText, diskText, pathCheckLines,
  accountRows, portalOf, tlsText, profileOptions, DEFAULT_PROFILE, poolFormOf, retentionText, PORTAL_POOLS, PORTAL_SCHEDULE, maskPw, sshSourceText, noSshNeeded,
} from './bareosCorpText.js';

/**
 * 법인별 Bareos 설정(v2.845 · 설정 탭 — 전 법인 범위 관리자만 보인다).
 * 사용자 요청: 'bareos web login 계정 설정/추가/비밀번호 변경 · 백업 스토리지 추가/관리 · 법인별로 bareos 설정관리'.
 * 읽기는 Director 콘솔(비밀번호 칸 없음) · 서버 파일(만든 곳 · 경로 · 여유)은 SSH 읽기(디스크 읽기) · 쓰기는 SSH root(포탈 표지 파일만 — 검사 · reload · 실패면 되돌림).
 * SSH 는 배포 등록부(Director 가 그 엣지 노드일 때) 아니면 **그때마다 입력**(저장하지 않는다 — 실행마다 비운다). 쓰기는 본인 OTP(세션 보안 설정을 따름).
 */
export const P = '/tools/bareos-backup/settings/corp';
const ROW = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' };
const BTN = { padding: '4px 10px', fontSize: 12 };
const INP = { minWidth: 0, width: '100%', boxSizing: 'border-box' };
const FIELD = { fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 };
const GRID = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(170px, 100%), 1fr))', gap: 10, marginTop: 8, alignItems: 'end' };
const CARD = { padding: 14, marginTop: 10, minWidth: 0 };
const DEEP = { padding: 12, marginTop: 10, minWidth: 0, background: 'var(--panel-deep)' };
const PRE = { margin: '6px 0 0', padding: 10, background: 'var(--panel-deep)', borderRadius: 6, fontSize: 11.5, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 260, overflow: 'auto' };
const WRAP = { whiteSpace: 'normal', overflowWrap: 'anywhere', minWidth: 0 };
const GET = { retries: 0, timeoutMs: 200_000 };
const LONG = { timeoutMs: 600_000 };   // 엣지 대행 쓰기(회신 시한 480초 + 인출) — 서버 요청 시한 안
const TABS = [['overview', '개요'], ['storage', '백업 스토리지'], ['accounts', 'WebUI 계정'], ['pools', '풀 · 스케줄']];

function Badge({ cls, children }) { return <span className={`badge ${cls}`} style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{children}</span>; }
function Msg({ m }) {
  if (!m) return null;
  return <div className={`banner ${m.ok === false ? 'bad' : m.ok === 'warn' ? 'warn' : 'ok'}`} role={m.ok === false ? 'alert' : 'status'} style={{ marginTop: 10, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}><BoldText text={m.text} /></div>;
}
/** postJson 은 409 를 던지지 않는다 — ok:false 면 던진다(본문을 붙여서). */
export async function call(path, body, opts) {
  const r = await postJson(path, body, opts);
  if (r?.ok === false) throw Object.assign(new Error(r.reason || '실패했습니다.'), { body: r, status: 409 });
  return r;
}
const copyText = (t, say) => { try { navigator.clipboard.writeText(t).then(() => say({ ok: true, text: '복사했습니다.' }), () => say({ ok: false, text: '복사하지 못했습니다 — 직접 선택해 복사하세요.' })); } catch { say({ ok: false, text: '복사하지 못했습니다.' }); } };
export const FILE_ACTION = Object.freeze({ created: '새 파일', updated: '바꿈', deleted: '지움', unchanged: '그대로' });
export const filesText = (r) => (r.files || []).map((f) => `${f.path}(${FILE_ACTION[f.action] || f.action})`).join(' · ');

/** 한 번만 보여 주는 생성 비밀번호(가림 · 보기 · 복사 · 닫으면 사라진다). */
export function OneTimePassword({ pw, onClose, say }) {
  const [show, setShow] = useState(false);
  if (!pw) return null;
  return (
    <div className="card" style={{ ...DEEP, borderLeft: '3px solid var(--amber)' }} role="status">
      <b>비밀번호 — 한 번만 표시됩니다</b>
      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>이 창을 닫으면 다시 볼 수 없습니다. 포탈은 저장하지 않았고 로그 · 감사에도 없습니다. 사용자에게 안전한 경로로 전달하세요(다시 필요하면 ‘비밀번호 변경’ 으로 새로 만듭니다).</div>
      <div style={{ ...ROW, marginTop: 8 }}>
        <code style={{ fontSize: 14, wordBreak: 'break-all' }}>{show ? pw : maskPw(pw)}</code>
        <button type="button" className="logout-btn" style={BTN} onClick={() => setShow((x) => !x)}>{show ? '가리기' : '보기'}</button>
        <button type="button" className="logout-btn" style={BTN} onClick={() => copyText(pw, say)}>복사</button>
        <button type="button" className="logout-btn" style={BTN} onClick={onClose}>닫기(비밀번호 지움)</button>
      </div>
    </div>
  );
}

/** SSH(입력 출처일 때만 칸) + OTP. 비밀번호는 실행마다 부른 쪽이 비운다. */
function AuthBox({ corp, ssh, setSsh, otpRequired, write = true }) {
  const input = !noSshNeeded(corp.ssh);
  return (
    <div style={GRID}>
      {input && (
        <>
          <label className="muted" style={FIELD}>SSH 주소<input className="input" style={INP} value={ssh.host} onChange={(e) => setSsh((x) => ({ ...x, host: e.target.value.trim() }))} placeholder="Bareos 서버 주소" aria-label="SSH 주소" /></label>
          <label className="muted" style={FIELD}>SSH 포트<input className="input" style={INP} inputMode="numeric" value={ssh.sshPort} onChange={(e) => setSsh((x) => ({ ...x, sshPort: e.target.value.replace(/\D/g, '') }))} aria-label="SSH 포트" /></label>
          <label className="muted" style={FIELD}>SSH 계정(root)<input className="input" style={INP} value={ssh.username} onChange={(e) => setSsh((x) => ({ ...x, username: e.target.value.trim() }))} aria-label="SSH 계정" /></label>
          <label className="muted" style={FIELD}>SSH 비밀번호(저장 안 함)<input className="input" style={INP} type="password" autoComplete="off" value={ssh.password} onChange={(e) => setSsh((x) => ({ ...x, password: e.target.value }))} aria-label="SSH 비밀번호" /></label>
        </>
      )}
      {write && otpRequired && <label className="muted" style={FIELD}>본인 OTP(6자리)<input className="input" style={INP} inputMode="numeric" autoComplete="one-time-code" value={ssh.otp} onChange={(e) => setSsh((x) => ({ ...x, otp: e.target.value.replace(/\D/g, '').slice(0, 6) }))} aria-label="OTP" /></label>}
    </div>
  );
}
const authIssue = (corp, ssh, otpRequired, write = true) => {
  if (!noSshNeeded(corp.ssh)) {
    if (!ssh.host) return 'SSH 주소를 적으세요.';
    if (!ssh.password) return 'SSH 비밀번호를 입력하세요(저장하지 않습니다 — 실행마다 다시 입력).';
  }
  if (write && otpRequired && !/^\d{6}$/.test(ssh.otp)) return '본인 OTP 6자리를 입력하세요.';
  return '';
};
const sshBody = (corp, ssh) => (noSshNeeded(corp.ssh) ? {} : { ssh: { host: ssh.host, sshPort: ssh.sshPort || '22', username: ssh.username || 'root', password: ssh.password } });

export default function BareosCorpPanel({ writable = true }) {
  const [list, setList] = useState(null);
  const [err, setErr] = useState(null);
  const [sel, setSel] = useState('');
  const [tab, setTab] = useState('overview');
  const [cfg, setCfg] = useState(null);
  const [cfgErr, setCfgErr] = useState(null);
  const [scan, setScan] = useState(null);
  const [scanErr, setScanErr] = useState(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);
  const [ssh, setSsh] = useState({ host: '', sshPort: '22', username: 'root', password: '', otp: '' });
  const [oneTime, setOneTime] = useState('');
  const gen = useRef(0);
  const scanGen = useRef(0);

  useEffect(() => {
    fetchJson(P, { retries: 0 }).then((r) => { setList(r); setErr(null); if (!sel && r.directors?.[0]) setSel(r.directors[0].id); }).catch(setErr);
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  const corp = list?.directors?.find((d) => d.id === sel) || null;
  const loadCfg = (refresh = false) => {
    if (!sel) return Promise.resolve();
    const g = ++gen.current;
    setCfgErr(null);
    return fetchJson(`${P}/${encodeURIComponent(sel)}/config${refresh ? '?refresh=1' : ''}`, GET)
      .then((r) => { if (g === gen.current) setCfg(r); })
      .catch((e) => { if (g === gen.current) { setCfg(null); setCfgErr(e); } });
  };
  const runScan = async (path = '') => {
    if (!corp) return null;
    const g = ++scanGen.current;
    setScanErr(null);
    try {
      const r = await call(`${P}/${encodeURIComponent(corp.id)}/scan`, { ...sshBody(corp, ssh), ...(path ? { input: { path } } : {}) }, { timeoutMs: 200_000 });
      if (g === scanGen.current) { if (!path) setScan(r); }
      return r;
    } catch (e) { if (g === scanGen.current) setScanErr(e); throw e; } finally {
      setSsh((x) => ({ ...x, password: '' }));   // 사용자 결정 '그때마다 SSH 비밀번호 입력' — 실행마다 비운다
    }
  };
  // 법인을 바꾸면 그 법인 값만(늦게 온 이전 법인 응답은 세대로 버린다) · SSH 입력은 비운다 · 등록부 법인은 서버 파일도 한 번 읽는다(버튼으로 다시)
  useEffect(() => {
    setCfg(null); setScan(null); setScanErr(null); setMsg(null); setOneTime('');
    const c = list?.directors?.find((d) => d.id === sel);
    setSsh({ host: c?.ssh?.host || '', sshPort: String(c?.ssh?.port || 22), username: c?.ssh?.username || 'root', password: '', otp: '' });
    if (!sel) return;
    loadCfg(false);
    if (c && noSshNeeded(c.ssh)) {
      const g = ++scanGen.current;
      postJson(`${P}/${encodeURIComponent(sel)}/scan`, {}, { timeoutMs: 200_000 }).then((r) => { if (g === scanGen.current && r?.ok !== false) setScan(r); else if (g === scanGen.current) setScanErr(new Error(r?.reason || '서버 파일을 읽지 못했습니다.')); }).catch((e) => { if (g === scanGen.current) setScanErr(e); });
    }
  }, [sel, list]);   // eslint-disable-line react-hooks/exhaustive-deps

  if (err && !list) return <ErrorBox error={err} />;
  if (!list) return <Loading />;
  if (!list.directors?.length) return <div className="card" style={CARD}>등록된 법인 Director 가 없습니다 — ‘기본 설정’ 에서 Director 를 추가하거나 ‘완전 설치’ 로 설치하세요.</div>;

  /** 쓰기 공통 — 결과 문구 · 생성 비밀번호 · 설정 다시 읽기 · OTP · SSH 비밀번호 비우기. */
  const write = async (action, input, extra = {}, okText = '') => {
    setBusy(action); setMsg(null);
    try {
      const r = await call(`${P}/${encodeURIComponent(corp.id)}/manage`, { action, input, ...sshBody(corp, ssh), otp: ssh.otp, ...extra }, LONG);
      if (r.generatedPassword) setOneTime(r.generatedPassword);
      setMsg({ ok: true, text: `${okText || '적용했습니다'} — ${filesText(r)}${r.restarted ? ' · SD 재시작' : ''}${r.reloaded ? ' · Director reload' : ''}${r.relay ? ` · 법인 엣지 ‘${r.relay}’ 가 적용` : ''}${r.demo ? ' · 데모(장비에 닿지 않음)' : ''}` });
      await loadCfg(true);
      // 바꾼 뒤 서버 파일 정보: SSH 가 필요 없는 출처(등록부 · 데모)면 다시 읽고, 입력 출처면 '오래됨' 표시(비밀번호를 다시 묻지 않는다)
      if (noSshNeeded(corp.ssh)) postJson(`${P}/${encodeURIComponent(corp.id)}/scan`, {}, { timeoutMs: 200_000 }).then((x) => setScan(x?.ok === false ? (s) => (s ? { ...s, stale: true } : s) : x)).catch(() => setScan((s) => (s ? { ...s, stale: true } : s)));
      else setScan((s) => (s ? { ...s, stale: true } : s));
      return r;
    } catch (e) {
      const b = e?.body || {};
      setMsg({ ok: false, text: `${b.code === 'unknown' ? '결과 모름' : '실패'}: ${e.message}${b.needEnroll ? '' : ''}` });
      throw e;
    } finally {
      setBusy(''); setSsh((x) => ({ ...x, password: '', otp: '' }));
    }
  };
  const ctx = { corp, cfg, scan, busy, write, writable, otpRequired: list.otpRequired, ssh, setSsh, say: setMsg, runScan, demo: list.demo };

  return (
    <div style={{ minWidth: 0 }}>
      <div className="card" style={CARD}>
        <div style={ROW}>
          <label className="muted" style={{ ...FIELD, flex: '1 1 320px' }}>법인(= vCenter = Bareos · 1:1:1)
            <Select className="input" style={INP} sort={false} value={sel} onChange={(e) => { const v = e.target.value; setSel(v); }} aria-label="법인 고르기">{(list.directors.map((d) => ({ value: d.id, label: `${d.name}${d.vcenters.length ? ` — ${d.vcenters.map((v) => v.name).join(', ')}` : ''}` }))).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>
          </label>
          {corp && <Badge cls={corp.agent ? 'blue' : 'gray'}>{corp.agent ? `담당 = 법인 엣지 ‘${corp.agent}’` : '담당 = 중앙 직접'}</Badge>}
          {corp && <Badge cls={noSshNeeded(corp.ssh) ? 'green' : 'amber'}>{sshSourceText(corp.ssh)}</Badge>}
          <Badge cls="gray">{list.otpRequired ? 'OTP: 쓰기마다 본인 OTP(세션 보안 설정)' : 'OTP: 본인 OTP 재확인 꺼짐(OTP 등록 계정만)'}</Badge>
        </div>
        {corp && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}><BoldText text={`${corp.agent
          ? `이 화면의 변경은 법인 엣지 **‘${corp.agent}’** 가 그 법인 서버에 SSH 로 적용합니다(작업 하나를 보내고 결과만 받습니다). 포탈이 만든 파일(첫 줄 표지)만 바꾸고, 사람이 만든 파일은 읽기만 합니다. 다른 법인에는 영향이 없습니다.`
          : '이 Director 는 담당 엣지가 없어 중앙 포탈이 직접 SSH 로 적용합니다. 포탈이 만든 파일(첫 줄 표지)만 바꾸고, 사람이 만든 파일은 읽기만 합니다.'} ${corp.ssh?.why || ''}`} /></div>}
        {list.demo && <div className="banner warn" style={{ marginTop: 8 }}>데모 모드 — 메모리의 데모 설정을 바꿉니다(장비 · 엣지에 닿지 않음).</div>}
        {!writable && <div className="banner warn" style={{ marginTop: 8 }}>쓰기 범위가 지정된 계정은 조회만 됩니다(바꾸기는 쓰기 범위가 무제한인 관리자만).</div>}
      </div>
      <div style={{ ...ROW, marginTop: 10 }} role="tablist" aria-label="법인 설정 탭">
        {TABS.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={`tab${tab === k ? ' active' : ''}`} onClick={() => setTab(k)}>{l}</button>)}
        <span style={{ flex: 1 }} />
        <button type="button" className="logout-btn" style={BTN} disabled={!!busy} onClick={() => loadCfg(true)}>설정 다시 읽기</button>
      </div>
      <Msg m={msg} />
      <OneTimePassword pw={oneTime} onClose={() => setOneTime('')} say={setMsg} />
      {cfgErr && <div className="banner bad" role="alert" style={{ marginTop: 10 }}>Director 설정을 읽지 못했습니다 — {String(cfgErr.message || cfgErr).slice(0, 300)}</div>}
      {!cfg && !cfgErr && <Loading />}
      {cfg && tab === 'overview' && <Overview {...ctx} onTab={setTab} />}
      {cfg && tab === 'storage' && <StorageTab {...ctx} scanErr={scanErr} />}
      {cfg && tab === 'accounts' && <AccountsTab {...ctx} />}
      {cfg && tab === 'pools' && <PoolsTab {...ctx} />}
    </div>
  );
}

const resOf = (cfg, k) => (cfg?.results?.[k]?.ok ? cfg.results[k].value : null);
function ReadFail({ cfg, k, what }) {
  const r = cfg?.results?.[k];
  if (!r || r.ok) return null;
  return <div className="banner warn" style={{ marginTop: 8 }}>{what}을(를) 읽지 못했습니다({r.code}) — {r.message}</div>;
}

/* ───────── 개요 ───────── */
function Overview({ corp, cfg, scan, onTab, writable, busy }) {
  const st = resOf(cfg, 'storages') || [];
  const cons = resOf(cfg, 'consoles') || [];
  const pools = resOf(cfg, 'pools') || [];
  const pf = poolFormOf(pools, resOf(cfg, 'schedules') || []);
  const rows = storageRows(st, scan, cfg.mappedStorages || []);
  const acc = accountRows(cons, scan, cfg.portalConsole);
  const webui = acc.filter((a) => !a.own && !a.reserved);
  const free = rows.reduce((a, r) => (r.disk?.availBytes != null ? a + r.disk.availBytes : a), 0);
  const known = rows.some((r) => r.disk?.availBytes != null);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(300px, 100%), 1fr))', gap: 10, marginTop: 10 }}>
      <div className="card" style={{ padding: 14, minWidth: 0 }}>
        <b>Director</b>
        <div style={{ fontSize: 12.5, marginTop: 6, lineHeight: 1.7 }}>
          <div>이름 <b>{corp.name}</b>{cfg.version ? ` · Bareos ${cfg.version}` : ''}</div>
          <div>포탈 콘솔 <code>{cfg.portalConsole || '—'}</code></div>
          <div>담당 {corp.agent ? `법인 엣지 ‘${corp.agent}’` : '중앙 직접'}</div>
          <div className="muted">마지막 읽기 {cfg.at ? new Date(cfg.at).toLocaleTimeString() : '—'}</div>
        </div>
      </div>
      <div className="card" style={{ padding: 14, minWidth: 0 }}>
        <b>백업 스토리지</b>
        <div style={{ fontSize: 12.5, marginTop: 6, lineHeight: 1.7 }}>
          <div>{st.length}개{scan ? ` · 포탈 ${rows.filter((r) => r.portal === true).length} · 사람이 만든 ${rows.filter((r) => r.portal === false).length}` : ' · 만든 곳은 서버 파일을 읽은 뒤'}</div>
          <div>디스크 여유 합계 {known ? bytesText(free) : '—(디스크 읽기 전)'}</div>
        </div>
        <button type="button" className="logout-btn" style={{ ...BTN, marginTop: 8 }} onClick={() => onTab('storage')}>스토리지 관리</button>
      </div>
      <div className="card" style={{ padding: 14, minWidth: 0 }}>
        <b>WebUI 계정</b>
        <div style={{ fontSize: 12.5, marginTop: 6, lineHeight: 1.7 }}>
          <div>{webui.length}개{scan ? ` — 포탈 ${webui.filter((a) => a.portal === true).length} · 사람이 만든 파일 ${webui.filter((a) => a.portal === false).length}` : ''}</div>
          <div className="muted">로그인 = Director 의 Console + Profile(TLS 끔)</div>
        </div>
        <button type="button" className="logout-btn" style={{ ...BTN, marginTop: 8 }} onClick={() => onTab('accounts')}>WebUI 계정 관리</button>
      </div>
      <div className="card" style={{ padding: 14, minWidth: 0 }}>
        <b>포탈 풀 · 스케줄</b>
        <div style={{ fontSize: 12.5, marginTop: 6, lineHeight: 1.7 }}>
          {pf.hasPools ? <div>{PORTAL_POOLS[0]} {unitText(pf.fullDays, '일')} · {PORTAL_POOLS[1]} {unitText(pf.incrDays, '일')} · 볼륨 최대 {unitText(pf.maxVolumeGB, ' GB')}</div> : <div className="muted">포탈 풀이 없습니다(자동 설정 · 완전 설치에서 만들 때 생깁니다).</div>}
          {pf.hasSchedule ? <div>{PORTAL_SCHEDULE} Full {pf.fullDay && pf.time ? `${pf.fullDay} ${pf.time}(서버 시각)` : '—(읽지 못함)'}</div> : <div className="muted">포탈 스케줄 없음</div>}
        </div>
        <button type="button" className="logout-btn" style={{ ...BTN, marginTop: 8 }} onClick={() => onTab('pools')}>풀 · 스케줄</button>
      </div>
      <Reregister corp={corp} writable={writable} busyOuter={!!busy} />
    </div>
  );
}

/** 재설치 뒤 Director 에 없어진 대상 다시 등록(v2.844 남긴 일). */
function Reregister({ corp, writable, busyOuter }) {
  const [items, setItems] = useState(null);
  const [pick, setPick] = useState({});
  const [busy, setBusy] = useState(false);
  const [m, setM] = useState(null);
  const [res, setRes] = useState(null);
  const load = async () => {
    setBusy(true); setM(null); setRes(null);
    try { const r = await fetchJson(`${P}/${encodeURIComponent(corp.id)}/missing`, GET); setItems(r.items); setPick(Object.fromEntries(r.items.map((x) => [x.id, true]))); }
    catch (e) { setM({ ok: false, text: `확인하지 못했습니다: ${e.message}` }); } finally { setBusy(false); }
  };
  const run = async () => {
    setBusy(true); setM(null);
    try {
      const ids = Object.entries(pick).filter(([, v]) => v).map(([k]) => k);
      const r = await call(`${P}/${encodeURIComponent(corp.id)}/reregister`, { ids }, LONG);
      setRes(r.results);
      const ok = r.results.filter((x) => x.ok).length;
      setM({ ok: ok === r.results.length ? true : ok ? 'warn' : false, text: `다시 등록 — 성공 ${ok} · 실패 ${r.results.length - ok}(꺼 둔 대상은 다음 대조에서 다시 끕니다).` });
      const left = await fetchJson(`${P}/${encodeURIComponent(corp.id)}/missing`, GET).catch(() => null);
      if (left) setItems(left.items);
    } catch (e) { setM({ ok: false, text: `실패: ${e.message}` }); } finally { setBusy(false); }
  };
  const n = Object.values(pick).filter(Boolean).length;
  return (
    <div className="card" style={{ padding: 14, minWidth: 0, gridColumn: '1 / -1' }}>
      <div style={ROW}>
        <div style={{ flex: '1 1 360px', minWidth: 0 }}>
          <b>재설치 뒤 대상 다시 등록</b>
          <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>완전 설치(초기화 후 재설치) 뒤에는 Director 에 백업 잡이 없습니다. 포탈 원장의 대상 중 Director 에 없는 것을 같은 대상(이력 · 스케줄 · 레벨 · 켜짐 그대로)으로 다시 만듭니다 — Director 콘솔로 만들고 SSH 는 쓰지 않습니다.</div>
        </div>
        <button type="button" className="logout-btn" style={BTN} disabled={busy || busyOuter} onClick={load}>빠진 대상 확인</button>
      </div>
      <Msg m={m} />
      {items && !items.length && <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>Director 에 없는 원장 대상이 없습니다.</div>}
      {items && items.length > 0 && (
        <>
          <div style={{ overflowX: 'auto', marginTop: 8 }}>
            <STable className="table" limit={500}>
              <thead><tr><th data-nosort>고름</th><th>VM</th><th>잡 이름(원장)</th><th>레벨</th><th>스케줄</th><th>켜짐</th>{res && <th>결과</th>}</tr></thead>
              <tbody>{items.map((x) => {
                const r = res?.find((y) => y.id === x.id);
                return (
                  <tr key={x.id}>
                    <td><input type="checkbox" checked={!!pick[x.id]} onChange={(e) => setPick((p) => ({ ...p, [x.id]: e.target.checked }))} aria-label={`${x.vmName} 고르기`} /></td>
                    <td>{x.vmName}</td><td><code>{x.bareosJob}</code></td><td>{x.level}</td><td>{x.schedule || '(그룹 · 스케줄 없음)'}</td><td>{x.enabled ? '켬' : '끔'}</td>
                    {res && <td style={WRAP}>{r ? (r.ok ? <Badge cls="green">✓ {r.name}</Badge> : <span className="muted">{r.reason}</span>) : '—'}</td>}
                  </tr>
                );
              })}</tbody>
            </STable>
          </div>
          <div style={{ ...ROW, marginTop: 8 }}>
            <button type="button" className="login-btn" style={{ flex: 'none', padding: '6px 14px' }} disabled={busy || !n || !writable} onClick={run}>{busy ? '등록 중…' : `${n}개 다시 등록`}</button>
            <span className="muted" style={{ fontSize: 12 }}>서버가 Director 를 다시 읽어 지금 빠진 것만 만듭니다(화면 목록을 믿지 않습니다).</span>
          </div>
        </>
      )}
    </div>
  );
}

/* ───────── 백업 스토리지 ───────── */
function StorageTab({ corp, cfg, scan, scanErr, busy, write, writable, otpRequired, ssh, setSsh, say, runScan }) {
  const [mode, setMode] = useState(null);   // { kind:'add' } | { kind:'edit', row } | { kind:'delete', row }
  const st = resOf(cfg, 'storages');
  const rows = storageRows(st || [], scan, cfg.mappedStorages || []);
  const scanNow = async () => { try { await runScan(); say({ ok: true, text: '서버 파일을 읽었습니다.' }); } catch (e) { say({ ok: false, text: `서버 파일을 읽지 못했습니다: ${e.message}` }); } };
  return (
    <div className="card" style={CARD}>
      <div style={ROW}>
        <div style={{ flex: '1 1 420px', minWidth: 0 }}>
          <b>백업 스토리지 — {st ? `${st.length}개` : '—'}</b>
          <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>스토리지는 이 법인 서버의 디스크 디렉터리입니다. 추가 · 편집은 SD 장치 파일과 Director Storage 파일(포탈 표지)을 쓰고 bareos-sd -t · bareos-dir -t 뒤 SD 재시작 · Director reload 를 합니다 — SD 재시작은 <b>실행 중 작업이 0 일 때만</b>(확인하지 못하면 멈춤). 실패하면 바꾼 파일을 되돌립니다.</div>
        </div>
        <button type="button" className="logout-btn" style={BTN} disabled={!!busy} onClick={scanNow}>디스크 · 파일 읽기(SSH)</button>
        <button type="button" className="login-btn" style={{ flex: 'none', padding: '6px 14px' }} disabled={!writable || !!busy || !st} onClick={() => setMode({ kind: 'add' })}>+ 스토리지 추가</button>
      </div>
      {!noSshNeeded(corp.ssh) && !mode && <AuthBox corp={corp} ssh={ssh} setSsh={setSsh} otpRequired={otpRequired} write={false} />}
      <ReadFail cfg={cfg} k="storages" what="Director 스토리지 목록" />
      {scanErr && <div className="banner warn" style={{ marginTop: 8 }}>서버 파일을 읽지 못했습니다 — {String(scanErr.message || scanErr).slice(0, 300)}(만든 곳 · 경로 · 여유는 ‘모름’ 으로 둡니다)</div>}
      {scan?.stale && <div className="banner warn" style={{ marginTop: 8 }}>설정을 바꾼 뒤라 서버 파일 정보가 오래됐습니다 — ‘디스크 · 파일 읽기’ 로 다시 읽으세요.</div>}
      <div style={{ overflowX: 'auto', marginTop: 10 }}>
        <STable className="table" limit={200} minWidth={860}>
          <thead><tr><th>이름</th><th>SD 장치 · Media Type</th><th data-sort="num">동시</th><th>경로</th><th>디스크 여유 / 전체</th><th data-sort="num">볼륨 파일</th><th>만든 곳</th><th data-nosort>동작</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.name}>
              <td><b>{r.name}</b>{r.mapped && <div className="muted" style={{ fontSize: 11 }}>포탈 매핑에 사용</div>}</td>
              <td data-sort={r.device}><code>{r.device || '—'}</code><div className="muted" style={{ fontSize: 11 }}>{r.mediaType || '—'}</div></td><td data-sort={r.mcj ?? ''}>{r.mcj ?? '—'}</td>
              <td style={{ whiteSpace: 'nowrap' }}>{r.path || '—'}</td><td style={{ whiteSpace: 'nowrap' }}>{diskText(r.disk)}</td><td data-sort={r.files ?? ''}>{r.files ?? '—'}</td>
              <td><Badge cls={r.portal === true ? 'blue' : r.portal === false ? 'gray' : 'amber'}>{portalText(r.portal)}</Badge></td>
              <td style={{ ...WRAP, minWidth: 150 }}>
                {r.portal === true ? (
                  <div style={ROW}>
                    <button type="button" className="logout-btn" style={BTN} disabled={!writable || !!busy} onClick={() => setMode({ kind: 'edit', row: r })}>편집</button>
                    <button type="button" className="logout-btn" style={BTN} disabled={!writable || !!busy || !!r.delIssue} title={r.delIssue ? `삭제 불가 — ${r.delIssue}` : undefined} onClick={() => setMode({ kind: 'delete', row: r })}>삭제</button>
                  </div>
                ) : null}
                {r.delIssue && <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{r.portal === true ? `삭제 불가 — ${r.delIssue}` : r.portal === false ? '읽기만' : r.delIssue}</div>}
              </td>
            </tr>
          ))}</tbody>
        </STable>
      </div>
      <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>‘디스크 여유 / 전체’ 는 서버에서 df 로 읽은 값이고 읽지 못하면 ‘—’ 입니다(0 이 아님). 정렬은 제목 클릭.</div>
      {mode?.kind === 'add' && <StorageAdd {...{ corp, cfg, busy, write, otpRequired, ssh, setSsh, runScan, say }} onClose={() => setMode(null)} />}
      {mode?.kind === 'edit' && <StorageEdit {...{ corp, busy, write, otpRequired, ssh, setSsh }} row={mode.row} onClose={() => setMode(null)} />}
      {mode?.kind === 'delete' && <StorageDelete {...{ corp, busy, write, otpRequired, ssh, setSsh }} row={mode.row} onClose={() => setMode(null)} />}
    </div>
  );
}

function StorageAdd({ corp, cfg, busy, write, otpRequired, ssh, setSsh, runScan, onClose }) {
  const [f, setF] = useState({ name: '', mediaType: '', path: '', count: '10', description: '' });
  const [pc, setPc] = useState(null);
  const [pcErr, setPcErr] = useState('');
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const device = f.name ? `${f.name}Storage` : '';
  const mediaType = f.mediaType || f.name;
  const issue = nameIssue(f.name, '스토리지 이름') || (f.mediaType && nameIssue(f.mediaType, 'Media Type')) || (!f.path ? '볼륨 경로를 적으세요.' : '') || (!/^\d+$/.test(f.count) || +f.count < 1 || +f.count > 50 ? '동시 작업 수는 1~50 입니다.' : '') || authIssue(corp, ssh, otpRequired);
  const check = async () => {
    setPcErr(''); setPc(null);
    try { const r = await runScan(f.path.trim()); setPc(r.pathCheck || null); if (!r.pathCheck) setPcErr('경로 점검 결과가 없습니다(옛 엣지일 수 있습니다).'); }
    catch (e) { setPcErr(e.message); }
  };
  const go = async () => { try { await write('storage.add', { name: f.name.trim(), mediaType: f.mediaType.trim(), path: f.path.trim(), count: Number(f.count), description: f.description.trim() }, {}, `스토리지 ‘${f.name}’ 를 추가했습니다`); onClose(); } catch { /* 문구는 위 */ } };
  const prev = { device, mediaType, archiveDevice: f.path || '/…', count: f.count || '10', description: f.description };
  return (
    <div className="card" style={DEEP}>
      <div style={ROW}><b style={{ flex: 1 }}>스토리지 추가 — 법인 서버의 디렉터리</b><button type="button" className="logout-btn" style={BTN} onClick={onClose}>← 목록으로</button></div>
      <div style={GRID}>
        <label className="muted" style={FIELD}>이름(영문 · 숫자 · ._-)<input className="input" style={INP} value={f.name} onChange={(e) => set('name', e.target.value.trim())} aria-label="스토리지 이름" /></label>
        <label className="muted" style={FIELD}>Media Type(비우면 이름)<input className="input" style={INP} value={f.mediaType} onChange={(e) => set('mediaType', e.target.value.trim())} placeholder={f.name || ''} aria-label="Media Type" /></label>
        <label className="muted" style={{ ...FIELD, gridColumn: 'span 2' }}>볼륨 경로(그 서버의 절대 경로)<input className="input" style={INP} value={f.path} onChange={(e) => { set('path', e.target.value.trim()); setPc(null); }} placeholder="/mnt/nas01/bareos" aria-label="볼륨 경로" /></label>
        <label className="muted" style={FIELD}>동시 작업 수(장치 수 · 1~50)<input className="input" style={INP} inputMode="numeric" value={f.count} onChange={(e) => set('count', e.target.value.replace(/\D/g, ''))} aria-label="동시 작업 수" /></label>
        <label className="muted" style={FIELD}>설명(선택)<input className="input" style={INP} value={f.description} onChange={(e) => set('description', e.target.value)} aria-label="설명" /></label>
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Media Type 은 스토리지마다 달라야 합니다(같으면 볼륨이 엉뚱한 장치로 갑니다). 동시 작업 수는 SD 장치 Count 와 Director Storage 의 Maximum Concurrent Jobs 에 같은 값으로 들어갑니다(패키지 기본 FileStorage 와 같은 모양).</div>
      <AuthBox corp={corp} ssh={ssh} setSsh={setSsh} otpRequired={otpRequired} />
      <div style={{ ...ROW, marginTop: 8 }}>
        <button type="button" className="logout-btn" style={BTN} disabled={!f.path || !!busy || (!noSshNeeded(corp.ssh) && !ssh.password)} onClick={check}>경로 점검(읽기만)</button>
        {pcErr && <span className="banner bad" style={{ padding: '4px 8px' }}>{pcErr}</span>}
      </div>
      {pc && (
        <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12.5, lineHeight: 1.7 }}>
          {pathCheckLines(pc, f.path).map((l) => <li key={l.label}><Badge cls={l.ok === true ? 'green' : l.ok === false ? 'red' : 'amber'}>{l.ok === true ? '✓' : l.ok === false ? '✗' : '!'} {l.label}</Badge> <span style={WRAP}>{l.text}</span></li>)}
        </ul>
      )}
      <details style={{ marginTop: 8 }}>
        <summary className="muted" style={{ fontSize: 12, cursor: 'pointer' }}>무엇을 바꾸나요 — 미리 보기</summary>
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>새 파일 /etc/bareos/bareos-sd.d/device/{device || '…'}.conf · 새 파일 /etc/bareos/bareos-dir.d/storage/{f.name || '…'}.conf(Address = 기존 스토리지 주소{cfg.sdAddress ? ` ${cfg.sdAddress}` : ''} · Password = 기존 SD 비밀번호를 서버 안에서 읽어 넣음) · 경로가 없으면 만듦(bareos:bareos 0750) — 이미 있는 디렉터리는 <b>비어 있을 때만</b>, 다른 장치가 쓰는 경로 · 다른 프로그램의 데이터 경로(/var/log · /var/lib/pgsql 등)는 거부. 순서: 실행 중 작업 0 확인 → 파일 쓰기 → bareos-sd -t → bareos-dir -t → (같은 셸에서 실행 중 작업 0 재확인) SD 재시작 → Director reload. 실패하면 새 파일 삭제 · 이번에 만든 디렉터리 · 이번에 넣은 SELinux 규칙 삭제.</div>
        <pre style={PRE}>{sdDeviceText(prev)}</pre>
        <pre style={PRE}>{dirStorageText({ name: f.name || '…', address: cfg.sdAddress || '(기존 스토리지 주소)', sdPassword: SECRET_SLOT, device: device || '…', mediaType: mediaType || '…', count: f.count || '10', description: f.description })}</pre>
      </details>
      <div style={{ ...ROW, marginTop: 10 }}>
        <button type="button" className="login-btn" style={{ flex: 'none', padding: '6px 14px' }} disabled={!!issue || !!busy} onClick={go}>{busy === 'storage.add' ? '추가 중…' : '추가 — 검사 뒤 적용'}</button>
        {issue && <span className="muted" style={{ fontSize: 12 }}>필요: {issue}</span>}
      </div>
    </div>
  );
}

function StorageEdit({ corp, row, busy, write, otpRequired, ssh, setSsh, onClose }) {
  const [f, setF] = useState({ count: String(row.mcj ?? 10), description: row.description || '' });
  const issue = (!/^\d+$/.test(f.count) || +f.count < 1 || +f.count > 50 ? '동시 작업 수는 1~50 입니다.' : '') || authIssue(corp, ssh, otpRequired);
  const go = async () => { try { await write('storage.edit', { name: row.name, count: Number(f.count), description: f.description.trim() }, {}, `스토리지 ‘${row.name}’ 를 바꿨습니다`); onClose(); } catch { /* */ } };
  return (
    <div className="card" style={DEEP}>
      <div style={ROW}><b style={{ flex: 1 }}>편집 — ‘{row.name}’</b><button type="button" className="logout-btn" style={BTN} onClick={onClose}>취소</button></div>
      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>바꿀 수 있는 것: 동시 작업 수 · 설명. 이름 · 경로 · Media Type 은 볼륨이 생긴 뒤 바꾸면 카탈로그와 어긋나 바꾸지 않습니다(새 스토리지를 추가하고 풀을 옮기세요).</div>
      <div style={GRID}>
        <label className="muted" style={FIELD}>경로<input className="input" style={INP} value={row.path || '(디스크 읽기 전)'} disabled aria-label="경로" /></label>
        <label className="muted" style={FIELD}>Media Type<input className="input" style={INP} value={row.mediaType} disabled aria-label="Media Type" /></label>
        <label className="muted" style={FIELD}>동시 작업 수(1~50)<input className="input" style={INP} inputMode="numeric" value={f.count} onChange={(e) => setF((x) => ({ ...x, count: e.target.value.replace(/\D/g, '') }))} aria-label="동시 작업 수" /></label>
        <label className="muted" style={FIELD}>설명<input className="input" style={INP} value={f.description} onChange={(e) => setF((x) => ({ ...x, description: e.target.value }))} aria-label="설명" /></label>
      </div>
      <AuthBox corp={corp} ssh={ssh} setSsh={setSsh} otpRequired={otpRequired} />
      <div style={{ ...ROW, marginTop: 10 }}>
        <button type="button" className="login-btn" style={{ flex: 'none', padding: '6px 14px' }} disabled={!!issue || !!busy} onClick={go}>{busy === 'storage.edit' ? '저장 중…' : '저장 — 검사 뒤 적용'}</button>
        <span className="muted" style={{ fontSize: 12 }}>{issue ? `필요: ${issue}` : 'SD 재시작이 들어갑니다 — 실행 중 작업이 있으면 서버가 막습니다.'}</span>
      </div>
    </div>
  );
}

function StorageDelete({ corp, row, busy, write, otpRequired, ssh, setSsh, onClose }) {
  const [typed, setTyped] = useState('');
  const issue = (typed !== row.name ? '확인을 위해 스토리지 이름을 그대로 적으세요.' : '') || authIssue(corp, ssh, otpRequired);
  const go = async () => { try { await write('storage.delete', { name: row.name }, {}, `스토리지 ‘${row.name}’ 를 지웠습니다`); onClose(); } catch { /* */ } };
  return (
    <div className="card" style={{ ...DEEP, borderLeft: '3px solid var(--red)' }}>
      <div style={ROW}><b style={{ flex: 1 }}>삭제 — ‘{row.name}’</b><button type="button" className="logout-btn" style={BTN} onClick={onClose}>취소</button></div>
      <div style={{ fontSize: 12.5, marginTop: 6 }}><b>지우는 것</b>: SD 장치 파일(bareos-sd.d/device/{row.device}.conf) · Director Storage 파일(bareos-dir.d/storage/{row.name}.conf). <b>지우지 않는 것</b>: 디렉터리 {row.path || '(경로)'}(원래 있던 · 다른 장치와 나눠 쓰는 디렉터리일 수 있어 그대로 둡니다 — 필요하면 서버에서 직접 지우세요). 서버가 다시 확인합니다: 볼륨 경로를 읽을 수 있는가 · 볼륨 파일 0 · 이 스토리지 · 장치를 가리키는 설정 0 · 실행 중 작업 0(재시작 직전에 한 번 더).</div>
      <div style={GRID}><label className="muted" style={FIELD}>스토리지 이름 다시 적기<input className="input" style={INP} value={typed} onChange={(e) => setTyped(e.target.value.trim())} aria-label="스토리지 이름 확인" /></label></div>
      <AuthBox corp={corp} ssh={ssh} setSsh={setSsh} otpRequired={otpRequired} />
      <div style={{ ...ROW, marginTop: 10 }}>
        <button type="button" className="login-btn" style={{ flex: 'none', padding: '6px 14px', background: 'var(--red)' }} disabled={!!issue || !!busy} onClick={go}>{busy === 'storage.delete' ? '지우는 중…' : '삭제'}</button>
        {issue && <span className="muted" style={{ fontSize: 12 }}>필요: {issue}</span>}
      </div>
    </div>
  );
}

/* ───────── WebUI 계정 ───────── */
function AccountsTab({ corp, cfg, scan, busy, write, writable, otpRequired, ssh, setSsh, say, runScan }) {
  const [mode, setMode] = useState(null);   // { kind:'add' } | { kind:'pw', row } | { kind:'del', row }
  const cons = resOf(cfg, 'consoles');
  const profs = resOf(cfg, 'profiles') || [];
  const rows = accountRows(cons || [], scan, cfg.portalConsole);
  const scanNow = async () => { try { await runScan(); say({ ok: true, text: '서버 파일을 읽었습니다(만든 곳).' }); } catch (e) { say({ ok: false, text: `서버 파일을 읽지 못했습니다: ${e.message}` }); } };
  return (
    <div className="card" style={CARD}>
      <div style={ROW}>
        <div style={{ flex: '1 1 420px', minWidth: 0 }}>
          <b>WebUI 계정 — {cons ? `${rows.filter((r) => !r.own && !r.reserved).length}개` : '—'}</b>
          <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>WebUI 로그인 계정 = Director 의 Console 리소스 + Profile(TLS 끔 — bareos-webui 는 TLS-PSK 를 쓰지 못합니다). 비밀번호는 포탈에 저장하지 않고 화면 · 로그 · 감사에 남기지 않습니다(생성한 비밀번호만 결과 창에 한 번). 포탈이 만든 파일만 바꾸고 사람이 만든 파일은 읽기만 합니다.</div>
        </div>
        <button type="button" className="logout-btn" style={BTN} disabled={!!busy} onClick={scanNow}>만든 곳 읽기(SSH)</button>
        <button type="button" className="login-btn" style={{ flex: 'none', padding: '6px 14px' }} disabled={!writable || !!busy || !cons} onClick={() => setMode({ kind: 'add' })}>+ 계정 추가</button>
      </div>
      {!noSshNeeded(corp.ssh) && !mode && <AuthBox corp={corp} ssh={ssh} setSsh={setSsh} otpRequired={otpRequired} write={false} />}
      <ReadFail cfg={cfg} k="consoles" what="Director 콘솔 목록" />
      <div style={{ overflowX: 'auto', marginTop: 10 }}>
        <STable className="table" limit={500} minWidth={760}>
          <thead><tr><th>계정 이름</th><th>권한 Profile</th><th>TLS</th><th>만든 곳</th><th data-nosort>동작</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.name}>
              <td><b>{r.name}</b></td><td style={WRAP}>{r.profile}</td><td>{tlsText(r.tls)}</td>
              <td><Badge cls={r.own ? 'blue' : r.portal === true ? 'blue' : r.portal === false ? 'gray' : 'amber'}>{r.own ? '포탈 전용 콘솔' : r.reserved ? '패키지' : portalText(r.portal)}</Badge></td>
              <td style={WRAP}>
                {r.lock ? <span className="muted" style={{ fontSize: 11 }}>{r.lock}</span> : (
                  <div style={ROW}>
                    <button type="button" className="logout-btn" style={BTN} disabled={!writable || !!busy} onClick={() => setMode({ kind: 'pw', row: r })}>비밀번호 변경</button>
                    <button type="button" className="logout-btn" style={BTN} disabled={!writable || !!busy} onClick={() => setMode({ kind: 'del', row: r })}>삭제</button>
                    {r.portal === null && <span className="muted" style={{ fontSize: 11 }}>만든 곳 모름 — 사람이 만든 파일이면 서버가 거부합니다</span>}
                  </div>
                )}
              </td>
            </tr>
          ))}</tbody>
        </STable>
      </div>
      {mode?.kind === 'add' && <AccountForm {...{ corp, busy, write, otpRequired, ssh, setSsh, profs }} rows={rows} onClose={() => setMode(null)} />}
      {mode?.kind === 'pw' && <AccountForm {...{ corp, busy, write, otpRequired, ssh, setSsh, profs }} row={mode.row} rows={rows} onClose={() => setMode(null)} />}
      {mode?.kind === 'del' && <AccountDelete {...{ corp, busy, write, otpRequired, ssh, setSsh }} row={mode.row} onClose={() => setMode(null)} />}
    </div>
  );
}

function AccountForm({ corp, row = null, rows, profs, busy, write, otpRequired, ssh, setSsh, onClose }) {
  const add = !row;
  const opts = profileOptions(profs);
  const [f, setF] = useState({ name: '', profile: opts.some((o) => o.value === DEFAULT_PROFILE) ? DEFAULT_PROFILE : (opts[0]?.value || ''), mode: 'generate', pw: '', pw2: '' });
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const name = add ? f.name : row.name;
  const dup = add && rows.some((r) => r.name.toLowerCase() === f.name.toLowerCase());
  const issue = (add ? nameIssue(f.name, '계정 이름') || (dup ? '같은 이름의 계정이 이미 있습니다.' : '') || (!f.profile ? '권한(Profile)을 고르세요.' : '') : '')
    || (f.mode === 'input' ? pwPairIssue(f.pw, f.pw2) : '') || authIssue(corp, ssh, otpRequired);
  const go = async () => {
    const extra = f.mode === 'generate' ? { generate: true } : { accountPassword: f.pw };
    try { await write(add ? 'console.add' : 'console.password', add ? { name: f.name, profile: f.profile } : { name }, extra, add ? `계정 ‘${f.name}’ 를 만들었습니다` : `‘${name}’ 의 비밀번호를 바꿨습니다`); onClose(); }
    catch { /* */ } finally { setF((x) => ({ ...x, pw: '', pw2: '' })); }
  };
  return (
    <div className="card" style={DEEP}>
      <div style={ROW}><b style={{ flex: 1 }}>{add ? '계정 추가' : `비밀번호 변경 — ‘${row.name}’`}</b><button type="button" className="logout-btn" style={BTN} onClick={onClose}>취소</button></div>
      <div style={GRID}>
        {add && <label className="muted" style={FIELD}>계정 이름(영문 · 숫자 · ._-)<input className="input" style={INP} value={f.name} onChange={(e) => set('name', e.target.value.trim())} aria-label="계정 이름" /></label>}
        {add && <label className="muted" style={FIELD}>권한 Profile(Director 에서 읽음)<Select className="input" style={INP} value={f.profile} onChange={(e) => { const v = e.target.value; set('profile', v); }} aria-label="권한 Profile">{(opts).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select></label>}
        <label className="muted" style={FIELD}>비밀번호
          <Select className="input" style={INP} sort={false} value={f.mode} onChange={(e) => { const v = e.target.value; set('mode', v); }} aria-label="비밀번호 방식">{([{ value: 'generate', label: '생성 — 결과 창에서 한 번만 보기' }, { value: 'input', label: '직접 입력(2번)' }]).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>
        </label>
        {f.mode === 'input' && <label className="muted" style={FIELD}>새 비밀번호(12자 이상)<input className="input" style={INP} type="password" autoComplete="new-password" value={f.pw} onChange={(e) => set('pw', e.target.value)} aria-label="새 비밀번호" /></label>}
        {f.mode === 'input' && <label className="muted" style={FIELD}>한 번 더<input className="input" style={INP} type="password" autoComplete="new-password" value={f.pw2} onChange={(e) => set('pw2', e.target.value)} aria-label="새 비밀번호 확인" /></label>}
      </div>
      {f.mode === 'input' && f.pw && passwordIssue(f.pw) && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{passwordIssue(f.pw)}</div>}
      <AuthBox corp={corp} ssh={ssh} setSsh={setSsh} otpRequired={otpRequired} />
      <details style={{ marginTop: 8 }}>
        <summary className="muted" style={{ fontSize: 12, cursor: 'pointer' }}>무엇을 바꾸나요 — 미리 보기</summary>
        <pre style={PRE}>{consoleText({ name: name || '…', password: SECRET_SLOT, profile: add ? (f.profile || '…') : '(지금 파일의 Profile 그대로)' })}</pre>
        <div className="muted" style={{ fontSize: 12 }}>→ /etc/bareos/bareos-dir.d/console/{name || '…'}.conf({add ? '새 파일' : '포탈 파일 덮어쓰기'}) · 순서: 파일 쓰기 → bareos-dir -t → reload → 새 비밀번호로 서버 안 bconsole 접속 확인 → 실패면 되돌림 · 감사에는 계정 이름만(비밀번호 없음).</div>
      </details>
      <div style={{ ...ROW, marginTop: 10 }}>
        <button type="button" className="login-btn" style={{ flex: 'none', padding: '6px 14px' }} disabled={!!issue || !!busy} onClick={go}>{busy ? '적용 중…' : add ? '계정 만들기' : '비밀번호 바꾸기'}</button>
        {issue && <span className="muted" style={{ fontSize: 12 }}>필요: {issue}</span>}
      </div>
    </div>
  );
}

function AccountDelete({ corp, row, busy, write, otpRequired, ssh, setSsh, onClose }) {
  const [typed, setTyped] = useState('');
  const issue = (typed !== row.name ? '확인을 위해 계정 이름을 그대로 적으세요.' : '') || authIssue(corp, ssh, otpRequired);
  const go = async () => { try { await write('console.delete', { name: row.name }, {}, `계정 ‘${row.name}’ 를 지웠습니다`); onClose(); } catch { /* */ } };
  return (
    <div className="card" style={{ ...DEEP, borderLeft: '3px solid var(--red)' }}>
      <div style={ROW}><b style={{ flex: 1 }}>계정 삭제 — ‘{row.name}’</b><button type="button" className="logout-btn" style={BTN} onClick={onClose}>취소</button></div>
      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>bareos-dir.d/console/{row.name}.conf(포탈 파일)를 지우고 bareos-dir -t → reload 합니다. 사람이 만든 파일이면 서버가 거부합니다.</div>
      <div style={GRID}><label className="muted" style={FIELD}>계정 이름 다시 적기<input className="input" style={INP} value={typed} onChange={(e) => setTyped(e.target.value.trim())} aria-label="계정 이름 확인" /></label></div>
      <AuthBox corp={corp} ssh={ssh} setSsh={setSsh} otpRequired={otpRequired} />
      <div style={{ ...ROW, marginTop: 10 }}>
        <button type="button" className="login-btn" style={{ flex: 'none', padding: '6px 14px', background: 'var(--red)' }} disabled={!!issue || !!busy} onClick={go}>{busy ? '지우는 중…' : '삭제'}</button>
        {issue && <span className="muted" style={{ fontSize: 12 }}>필요: {issue}</span>}
      </div>
    </div>
  );
}

/* ───────── 풀 · 스케줄 ───────── */
const WD_OPTS = [['', '(고르세요)'], ['sun', '일요일'], ['mon', '월요일'], ['tue', '화요일'], ['wed', '수요일'], ['thu', '목요일'], ['fri', '금요일'], ['sat', '토요일']].map(([value, label]) => ({ value, label }));
function PoolsTab({ corp, cfg, scan, busy, write, writable, otpRequired, ssh, setSsh }) {
  const pools = resOf(cfg, 'pools');
  const schedules = resOf(cfg, 'schedules');
  const init = poolFormOf(pools || [], schedules || []);
  const [f, setF] = useState(init);
  useEffect(() => { setF(poolFormOf(pools || [], schedules || [])); }, [cfg]);   // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const portalPool = (n) => portalOf(scan, 'pool', n);
  const changedPools = f.fullDays !== init.fullDays || f.incrDays !== init.incrDays || f.maxVolumeGB !== init.maxVolumeGB;
  const changedSched = f.fullDay !== init.fullDay || f.time !== init.time;
  const num = (v, lo, hi) => /^\d+$/.test(v) && +v >= lo && +v <= hi;
  const issue = (!changedPools && !changedSched ? '바뀐 값이 없습니다.' : '')
    || (changedPools && !init.hasPools ? '포탈 풀이 이 Director 에 없습니다(자동 설정 · 완전 설치로 먼저 만듭니다).' : '')
    || (changedSched && !init.hasSchedule ? '포탈 스케줄이 이 Director 에 없습니다.' : '')
    || (changedPools && (!num(f.fullDays, 1, 3650) || !num(f.incrDays, 1, 3650)) ? '보존 기간은 1~3650일입니다.' : '')
    || (changedPools && !num(f.maxVolumeGB, 1, 1024) ? '볼륨 최대 크기는 1~1024 GB 입니다.' : '')
    || (changedSched && (!f.fullDay || !/^([01]\d|2[0-3]):[0-5]\d$/.test(f.time)) ? '요일 · 시각(HH:MM)을 적으세요.' : '')
    || authIssue(corp, ssh, otpRequired);
  const go = async () => {
    const input = { ...(changedPools ? { pools: { fullDays: +f.fullDays, incrDays: +f.incrDays, maxVolumeGB: +f.maxVolumeGB } } : {}), ...(changedSched ? { schedule: { fullDay: f.fullDay, time: f.time } } : {}) };
    try { await write('pools.edit', input, {}, '포탈 풀 · 스케줄을 바꿨습니다'); } catch { /* */ }
  };
  return (
    <div className="card" style={CARD}>
      <b>풀 — {pools ? `${pools.length}개` : '—'}</b>
      <ReadFail cfg={cfg} k="pools" what="풀 목록" />
      {pools && (
        <div style={{ overflowX: 'auto', marginTop: 8 }}>
          <STable className="table" limit={300} minWidth={760}>
            <thead><tr><th>이름</th><th>유형</th><th data-sort="num">보존</th><th data-sort="num">볼륨 최대</th><th data-sort="num">볼륨 수 / 상한</th><th>만든 곳</th></tr></thead>
            <tbody>{pools.map((p) => {
              const own = PORTAL_POOLS.includes(p.name) ? portalPool(p.name) : (scan ? false : null);
              return (
                <tr key={p.name}><td><b>{p.name}</b></td><td>{p.type || '—'}</td><td data-sort={p.volRetentionSec ?? ''}>{retentionText(p.volRetentionSec)}</td>
                  <td data-sort={p.maxVolBytes ?? ''}>{p.maxVolBytes > 0 ? bytesText(p.maxVolBytes) : '—'}</td><td data-sort={p.numVols ?? ''}>{p.numVols ?? '—'} / {p.maxVols > 0 ? p.maxVols : '무제한'}</td>
                  <td><Badge cls={own === true ? 'blue' : own === false ? 'gray' : 'amber'}>{portalText(own)}</Badge></td></tr>
              );
            })}</tbody>
          </STable>
        </div>
      )}
      <div style={{ marginTop: 14 }}><b>스케줄 — {schedules ? `${schedules.length}개` : '—'}</b></div>
      <ReadFail cfg={cfg} k="schedules" what="스케줄 목록" />
      {schedules && (
        <div style={{ overflowX: 'auto', marginTop: 8 }}>
          <STable className="table" limit={200} minWidth={560}>
            <thead><tr><th>이름</th><th>실행(Director 서버 시각)</th></tr></thead>
            <tbody>{schedules.map((s) => <tr key={s.name}><td><b>{s.name}</b></td><td style={WRAP}>{(s.run || []).map((r) => r.text).join(' · ') || '—'}</td></tr>)}</tbody>
          </STable>
        </div>
      )}
      <div className="card" style={DEEP}>
        <b>포탈 기본값 편집 — {PORTAL_POOLS.join(' · ')} · {PORTAL_SCHEDULE}</b>
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>자동 설정 · 완전 설치가 만든 포탈 풀 · 스케줄 파일만 다시 씁니다(사람이 만든 풀 · 스케줄은 바뀌지 않음). 바뀐 항목만 씁니다. <b>보존 기간 · 볼륨 최대 크기는 새 볼륨부터</b> 적용됩니다 — 기존 볼륨까지 맞추려면 그 서버에서 bconsole ‘update volume … AllFromPool’ 을 직접 실행하세요(포탈은 하지 않습니다). 시각은 Director 서버 시각입니다(한국 시각 아님).</div>
        <div style={GRID}>
          <label className="muted" style={FIELD}>Full 보존(일)<input className="input" style={INP} inputMode="numeric" value={f.fullDays} onChange={(e) => set('fullDays', e.target.value.replace(/\D/g, ''))} aria-label="Full 보존" /></label>
          <label className="muted" style={FIELD}>Incr 보존(일)<input className="input" style={INP} inputMode="numeric" value={f.incrDays} onChange={(e) => set('incrDays', e.target.value.replace(/\D/g, ''))} aria-label="Incr 보존" /></label>
          <label className="muted" style={FIELD}>볼륨 최대(GB)<input className="input" style={INP} inputMode="numeric" value={f.maxVolumeGB} onChange={(e) => set('maxVolumeGB', e.target.value.replace(/\D/g, ''))} aria-label="볼륨 최대" /></label>
          <label className="muted" style={FIELD}>전체 백업 요일<Select className="input" style={INP} sort={false} value={f.fullDay} onChange={(e) => { const v = e.target.value; set('fullDay', v); }} aria-label="전체 백업 요일">{(WD_OPTS).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select></label>
          <label className="muted" style={FIELD}>시각(서버 시각 HH:MM)<input className="input" style={INP} value={f.time} onChange={(e) => set('time', e.target.value.trim())} placeholder="02:00" aria-label="백업 시각" /></label>
        </div>
        <AuthBox corp={corp} ssh={ssh} setSsh={setSsh} otpRequired={otpRequired} />
        <div style={{ ...ROW, marginTop: 10 }}>
          <button type="button" className="login-btn" style={{ flex: 'none', padding: '6px 14px' }} disabled={!writable || !!issue || !!busy} onClick={go}>{busy === 'pools.edit' ? '저장 중…' : '저장 — 검사 뒤 reload'}</button>
          <button type="button" className="logout-btn" style={BTN} onClick={() => setF(init)}>되돌리기(입력값)</button>
          {issue && <span className="muted" style={{ fontSize: 12 }}>필요: {issue}</span>}
        </div>
      </div>
    </div>
  );
}
