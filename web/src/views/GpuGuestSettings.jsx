// GpuGuestSettings.jsx — GPU 게스트 수집 설정 셸(v2.295 대형 파일 분할 · 1차 감사 확정 #4·#8).
// 구 891줄 중 별개 도메인/최다 수정 지점을 gpu-guest/ 로 분리하고, 이 파일은 전역 설정 폼 +
// 배포 대상 선택 + 공용 계정 표 + 상태 카드 + QuickSshTest + toForm 만 남는다(경로·default
// export 불변 — Settings.jsx 소비자 무변경, IdracAdmin v2.292 와 같은 '원 경로=셸 유지' 규약).
//  · gpu-guest/PhysicalGpuManager.jsx : 물리 GPU 서버(베어메탈 — 별개 백엔드 도메인)
//  · gpu-guest/VmCredManager.jsx      : VM별 계정·테스트 러너(이 화면 기능 커밋 최다 지점)
//  · gpu-guest/shared.jsx             : Field(셸·하위가 공용 — 복제 금지). fmtAgo 는 util/fmt(v2.613)
import { unitText } from './unitText.js';
import React, { useEffect, useRef, useState } from 'react';
import { fetchJson, putJson, postJson } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';
import { Field } from './gpu-guest/shared.jsx';
import { fmtAgo, fmtTime } from '../util/fmt.js'; // v2.613 DEPS2613-11 · v2.744(회귀 검토 GI-R2) fmtTime
import { VmCredManager } from './gpu-guest/VmCredManager.jsx';
import { PhysicalGpuManager } from './gpu-guest/PhysicalGpuManager.jsx';
import { STable } from '../components/STable.jsx';
import { applyDrafts } from './blankKeep.js';
import { droppedSecretNote } from './droppedSecretText.js'; // v2.611: 계정명 변경 시 폐기된 비밀번호 안내
import BoldText from '../components/boldText.jsx'; // v2.733(C4-01): 위임·비활성 안내의 **강조**
import { readFailText } from './readFailText.js'; // v2.733(C5-02): vCenter 목록 조회 실패를 '등록된 vCenter 가 없습니다' 로 그리지 않는다

// v2.601(감사 RECENT2601-05): 숫자 칸의 저장값 변환(하한·초→ms). 입력 중에는 원문(초안)만 들고 있고
// 저장할 때 한 번만 적용한다 — 입력 중에 걸면 칸을 비울 수 없고 하한이 중간 입력을 망가뜨린다.
const NUM_MAPS = {
  pollIntervalMs: (n) => Math.max(10, n) * 1000,
  concurrency: (n) => n,
  timeoutMs: (n) => Math.max(3, n) * 1000,
  maxVmsPerVcenter: (n) => Math.max(1, n),
  sshPort: (n) => Math.max(1, n),
};

/**
 * v2.622(감사 WEB-01): 대상(로컬/엣지) 전환 게이트(순수). 폼이 지금 고른 대상의 값으로 채워졌을 때만
 * 편집·저장을 허용한다. 예전에는 새 대상 조회가 실패하거나 늦으면 이전 대상(로컬) 값이 새 엣지 폼에 남아
 * '설정 저장' 이 그 값을 엣지 배포 설정으로 덮어썼다.
 *  - formFor: 폼을 채운 대상('' = 로컬). null 이면 아직 채우지 않았다.
 *  - loadErr: 지금 대상의 조회 실패 문구(없으면 null).
 */
export function gpuTargetGate({ deployAgent = '', formFor = null, loadErr = null } = {}) {
  const ready = formFor != null && formFor === deployAgent;
  if (ready) return { ready: true, canSave: true, state: 'ready' };
  return { ready: false, canSave: false, state: loadErr ? 'error' : 'loading' };
}

/**
 * v2.733(점검 3회차 C4-01): '이 포탈(로컬 수집)' 대상에서 이 노드가 **직접 수집하지 않는** vCenter 를 말한다(순수).
 * 판정 순서는 서버 vcenter/collectTarget.js directCollectSkipReason 과 같다(비활성 → 점검중 → 엣지 위임). 예전에는 엣지 위임(site)
 * vCenter 가 구분 없이 나열돼 여기서 켜면 중앙이 그 vCenter 에 직접 로그인했다 — 이제 서버가 건너뛰고, 화면이 그 사실을 말한다.
 * 원격 엣지 배포 대상(deployAgent)을 편집 중이면 null(그 엣지의 판정은 엣지 자신의 등록부가 한다).
 * @returns {null|{kind:'disabled'|'maintenance'|'site', text:string}}
 */
export function gpuVcTargetNote(vc, deployAgent = '') {
  if (deployAgent || !vc || typeof vc !== 'object') return null;
  if (vc.enabled === false) return { kind: 'disabled', text: '**비활성 vCenter** — 수집하지 않습니다. 이 포탈 설정은 쓰이지 않습니다.' };
  if (vc.maintenance) return { kind: 'maintenance', text: '**점검중** — 수집을 멈췄습니다(로그인하지 않음). 점검이 끝나면 다시 수집합니다.' };
  if (vc.collectMode === 'site') {
    const agent = String(vc.remoteAgent || '').trim();
    return {
      kind: 'site',
      text: agent
        ? `**엣지가 수집** — 엣지 위임(${agent}) vCenter 입니다. 이 포탈 설정은 쓰이지 않습니다(이 포탈은 로그인하지 않음). 위 설정 대상에서 그 엣지(**${agent}**)를 골라 설정하세요.`
        : '**엣지가 수집** — 엣지 위임 vCenter 입니다(담당 엣지 미지정). 이 포탈 설정은 쓰이지 않습니다(이 포탈은 로그인하지 않음).',
    };
  }
  return null;
}

/** v2.733(C4-01): 마지막 수집에서 로그인하지 않고 건너뛴 vCenter 개수(서버 lastRun.skippedCounts) — 없으면 null. */
export function gpuSkippedNote(last) {
  const c = last && typeof last.skippedCounts === 'object' && last.skippedCounts ? last.skippedCounts : null;
  if (!c) return null;
  const parts = [['site', '엣지 위임'], ['disabled', '비활성'], ['maintenance', '점검중']]
    .map(([k, label]) => { const n = Number(c[k]); return Number.isFinite(n) && n > 0 ? `${label} **${n}**곳` : null; })
    .filter(Boolean);
  return parts.length ? `건너뜀(로그인하지 않음): ${parts.join(' · ')}` : null;
}

/*
 * v2.744(감사 LEFT-08①): 배포 목록 행의 folded(중앙이 설정 파일을 읽을 때 대소문자만 다른 엣지 이름의 사본을 하나로 합친 사실)를
 *   화면이 말한다. 예전에는 서버가 행에 folded 를 싣고 콘솔에도 적었지만 이 화면은 그 필드를 그리지 않아 — 합친 사실도, 최근 사본의
 *   빈 값 대신 옛 값을 유지한 항목도 화면에서는 알 수 없었다. 짧은 표지는 선택지·대상 줄에, 항목 경로는 title 로 한 번만 보인다.
 *   경로 이름은 같은 응답의 foldReport(서버가 그룹마다 앞 일부 + 전체 개수)에서 읽는다 — 없으면(구버전 중앙) 개수만 말한다.
 *   값·비밀번호는 응답에 없다.
 */
export const GPU_FOLD_BY_TEXT = Object.freeze({
  authenticated: '엣지 인증 이름과 같은 이름을 남겼습니다.',
  registry: '수집 서버 등록부 이름과 같은 이름을 남겼습니다.',
  older: '이름 근거가 없어 먼저 있던 이름을 남겼습니다.',
});

const foldCount = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const foldList = (label, paths, total) => {
  const shown = Array.isArray(paths) ? paths.map(String) : [];
  const n = foldCount(total) ?? shown.length;
  if (!n) return null;
  if (!shown.length) return `${label} ${n}개(항목 이름은 이 응답에 없습니다)`;
  return `${label} ${n}개: ${shown.join(', ')}${n > shown.length ? ` 외 ${n - shown.length}개` : ''}`;
};

/** 배포 대상 행의 합침 표지 — folded 가 없으면 null. { short, title } (문구에 백틱·별표 없음). */
export function gpuGuestFoldNote(row, foldReport = null) {
  const f = row && typeof row === 'object' && row.folded && typeof row.folded === 'object' ? row.folded : null;
  if (!f) return null;
  const agent = String(row.agent || '');
  const from = Array.isArray(f.from) ? f.from.map(String).filter(Boolean) : [];
  const kept = foldCount(f.keptOlder);
  const short = `대소문자만 다른 이름 ${from.length}개를 합침 · 옛 값 유지 ${kept == null ? '—' : kept}`;
  const groups = Array.isArray(foldReport?.groups) ? foldReport.groups : [];
  const g = groups.find((x) => x && typeof x === 'object' && String(x.kept || '').toLowerCase() === agent.toLowerCase()) || null;
  const lines = [`중앙이 설정 파일을 읽을 때 대소문자만 다른 엣지 이름의 배포 설정을 하나로 합쳤습니다: ${from.join(', ') || '—'} → ${agent || '—'}`];
  if (GPU_FOLD_BY_TEXT[f.by]) lines.push(GPU_FOLD_BY_TEXT[f.by]);
  lines.push('값은 옛 사본 위에 최근 사본의 기본값이 아닌 값을 얹었습니다(VM 계정·고정 IP 는 합집합). 값이 맞는지 확인하고 필요하면 고쳐 저장하세요.');
  // v2.744(회귀 검토 GI-R2): 표지가 '지금 상태' 가 아니라 중앙이 설정 파일을 읽은 때(기동)의 일임을 밝힌다 — 이 엣지를 저장하면 중앙이 표지를 내린다.
  const foldAt = typeof foldReport?.at === 'number' && Number.isFinite(foldReport.at) && foldReport.at > 0 ? foldReport.at : null;
  if (foldAt != null) lines.push(`합친 때: ${fmtTime(foldAt)}(중앙이 설정 파일을 읽은 때) — 이 엣지 설정을 저장하면 이 표지는 사라집니다.`);
  const items = g
    ? [
      foldList('최근 사본의 빈 값 대신 옛 값을 유지한 항목', g.keptOlder, g.keptOlderTotal),
      foldList('옛 사본에만 있던 vCenter 를 옮김', g.vcentersFromOlder, g.vcentersFromOlderTotal),
      foldList('계정이 바뀌어 비밀번호를 승계하지 않은 항목', g.droppedSecrets, g.droppedSecretsTotal),
    ]
    : [
      foldList('최근 사본의 빈 값 대신 옛 값을 유지한 항목', null, kept),
      foldList('옛 사본에만 있던 vCenter 를 옮김', null, foldCount(f.vcentersFromOlder)),
      foldList('계정이 바뀌어 비밀번호를 승계하지 않은 항목', null, foldCount(f.droppedSecrets)),
    ];
  for (const it of items) if (it) lines.push(it);
  return { short, title: lines.join('\n') };
}

/**
 * GPU 게스트 수집 설정 — 패스쓰루 GPU는 ESXi에서 사용률을 못 보므로, 선택한 법인의
 * VM에 VMware Tools 게스트 작업으로 nvidia-smi를 실행해 사용률을 가져온다.
 * 법인 공용 계정 + VM별 개별 계정(다른 비밀번호)을 모두 지원하며, 로그인/데이터 읽기
 * 테스트를 개별·일괄로 할 수 있다.
 */
export default function GpuGuestSettings() {
  const [data, setData] = useState(null);   // { settings, status }
  const [vcs, setVcs] = useState([]);       // [{id,name,...}]
  // v2.733(C5-02): vCenter 목록 조회 실패 — 예전에는 catch 가 빈 목록으로 바꿔 '등록된 vCenter가 없습니다. 먼저 vCenter를 등록하세요.'(틀린 조치)를 그렸다.
  //   실패면 직전에 읽은 목록을 그대로 쓴다(30초 폴링이 한 번 실패해도 표가 사라지지 않게).
  const [vcsErr, setVcsErr] = useState(null);
  const [vcsLoaded, setVcsLoaded] = useState(false);
  const vcsRef = useRef([]);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null);   // local editable copy (전역 + 공용 계정)
  const [formFor, setFormFor] = useState(null); // v2.622(감사 WEB-01): 폼을 채운 대상('' = 로컬)
  const [loadErr, setLoadErr] = useState(null); // v2.622(감사 WEB-01): 지금 대상의 조회 실패 — 데이터가 있어도 보인다
  const targetRef = useRef('');                  // 지금 고른 대상(늦게 온 이전 대상 응답을 버린다)
  const seqRef = useRef(0);                      // 대상 전환 로드 세대
  const [drafts, setDrafts] = useState({}); // 숫자 칸 입력 원문(저장 전). 빈 칸이면 저장 시 이전 값
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  // 설정 대상: '' = 이 포탈(로컬 수집), 그 외 = 원격 엣지(agent) 앞으로 배포(엣지가 pull해 적용).
  const [deployAgent, setDeployAgent] = useState('');
  const [agents, setAgents] = useState([]);
  const [foldReport, setFoldReport] = useState(null); // v2.744(감사 LEFT-08①): 같은 응답의 합침 보고(경로 이름)

  const settingsUrl = (agent) => (agent ? `/admin/gpu-guest/deploy/${encodeURIComponent(agent)}` : '/admin/gpu-guest/settings');

  const load = async (agent = deployAgent, force = false) => {
    // v2.622(감사 WEB-01): 늦게 온 응답은 버린다 — 대상이 바뀌었거나(폴링 포함) 더 새 전환 로드가 있으면.
    const mySeq = force ? ++seqRef.current : seqRef.current;
    const stale = () => agent !== targetRef.current || mySeq !== seqRef.current;
    try {
      const [d, vr] = await Promise.all([
        fetchJson(settingsUrl(agent)),
        fetchJson('/admin/vcenters').then((v) => ({ ok: true, list: Array.isArray(v?.vcenters) ? v.vcenters : [] }), (e) => ({ ok: false, err: e })),
      ]);
      if (stale()) return;
      // 로컬: { settings, status } · 배포: { assigned, settings } (미지정이면 settings=null)
      const settings = agent ? (d.settings || { vcenters: {} }) : d.settings;
      setData(agent ? { settings, status: {}, deploy: true, assigned: !!d.assigned } : d);
      // v2.733(C5-02): vCenter 목록 실패는 직전 목록을 쓰고 사유를 따로 든다(빈 목록으로 바꾸지 않는다).
      const list = vr.ok ? vr.list : vcsRef.current;
      if (vr.ok) { vcsRef.current = list; setVcs(list); setVcsLoaded(true); setVcsErr(null); }
      else setVcsErr(vr.err || new Error('vCenter 목록 조회 실패'));
      // 대상 전환(force) 시 폼을 새로 채움. 로컬 30초 폴링은 최초 1회만(미저장 입력 보존).
      setForm((cur) => (force || !cur ? toForm(settings || { vcenters: {} }, list) : cur));
      if (force) setDrafts({});
      setFormFor(agent);
      setError(null);
      setLoadErr(null);
    } catch (e) {
      if (stale()) return;
      setError(e.message);
      setLoadErr(e.message || String(e));
    }
  };
  // 배포 대상 후보 목록(1회).
  useEffect(() => { fetchJson('/admin/gpu-guest/deploy/agents').then((r) => { setAgents(r.agents || []); setFoldReport(r.foldReport || null); }).catch(() => {}); }, []);
  // 대상 전환 시 폼 재로딩. 로컬일 때만 30초 자동 폴링(배포 편집 중 덮어쓰기 방지).
  useEffect(() => {
    // v2.622(감사 WEB-01): 전환하는 순간 이전 대상의 폼을 비운다 — 새 대상 조회가 성공해야 다시 채워진다.
    targetRef.current = deployAgent;
    setFormFor(null);
    setForm(null);
    setLoadErr(null);
    load(deployAgent, true);
    if (deployAgent) return undefined;
    const t = setInterval(() => load('', false), 30_000);
    return () => clearInterval(t);
    // eslint-disable-next-line
  }, [deployAgent]);

  if (error && !data) return <ErrorBox message={error} />; // 데이터 보유 중 일시 폴링 오류로 화면 전체를 갈아치우지 않음(CLAUDE.md)
  if (!data) return <Loading />;
  const gate = gpuTargetGate({ deployAgent, formFor: form ? formFor : null, loadErr });

  // 숫자 칸: 입력 중에는 원문을 보여 주고(비울 수 있다), 건드리지 않은 칸은 저장값을 보여 준다.
  const numInput = (key, shown) => ({
    value: drafts[key] ?? shown,
    onChange: (e) => { const raw = e.target.value; setDrafts((d) => ({ ...d, [key]: raw })); },
  });
  const setVc = (id, patch) => setForm((f) => ({ ...f, vcenters: { ...f.vcenters, [id]: { ...f.vcenters[id], ...patch } } }));

  const save = async () => {
    if (!gate.canSave) return; // v2.622(감사 WEB-01): 다른 대상의 값으로 채워진 폼은 저장하지 않는다
    setBusy(true); setMsg(null);
    try {
      const payload = applyDrafts(form, drafts, NUM_MAPS);
      const r = await putJson(settingsUrl(deployAgent), payload);
      const settings = deployAgent ? (r.settings || payload) : r.settings;
      if (!deployAgent) setData(r);
      setForm(toForm(settings, vcs, payload));
      setDrafts({});
      setMsg(deployAgent
        // v2.612 RECENT2612-05: 배포 경로도 폐기된 비밀번호를 응답한다 — 말하지 않으면 '저장됨' 만 보인다.
        ? [`원격 엣지 [${deployAgent}]로 배포 저장됨 — 엣지가 다음 pull 주기(약 1분)에 가져가 적용합니다.`, droppedSecretNote(r)].filter(Boolean).join(' ')
        : ['저장되었습니다. 새 설정이 다음 주기부터 적용됩니다.', droppedSecretNote(r), r.ignoredReason || ''].filter(Boolean).join(' '));
      if (deployAgent) fetchJson('/admin/gpu-guest/deploy/agents').then((rr) => { setAgents(rr.agents || []); setFoldReport(rr.foldReport || null); }).catch(() => {});
    } catch (e) { setMsg(`오류: ${e.message}`); }
    finally { setBusy(false); }
  };

  const status = data.status || {};
  const last = status.lastRun;

  // 설정 대상: 이 포탈(로컬) vs 원격 엣지 배포. 원격 엣지는 폐쇄망/NAT라 중앙이 직접 접속 못 하므로,
  // 여기서 지정한 설정을 엣지가 pull해 자기 로컬에 적용한다(실제 SSH/게스트작업은 엣지에서 수행).
  // v2.744(감사 LEFT-08①): 지금 고른 엣지가 합친 키면 대상 줄에 짧은 표지(세부는 title).
  const selFold = deployAgent ? gpuGuestFoldNote(agents.find((a) => a.agent === deployAgent), foldReport) : null;
  const targetCard = (
      <div className="card" style={{ padding: '10px 16px', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <b style={{ fontSize: 13 }}>설정 대상</b>
        <Select className="select" style={{ minWidth: 260 }} value={deployAgent} onChange={(e) => { setDeployAgent(e.target.value); setMsg(null); }}
          title="이 포탈(로컬)에서 직접 수집할지, 원격 엣지 앞으로 설정을 배포할지 선택. 원격 엣지 앞 설정은 엣지가 주기적으로 가져가 적용합니다.">
          <option value="">🖥️ 이 포탈(로컬 수집)</option>
          {agents.length > 0 && <optgroup label="원격 엣지에 배포(pull)">
            {agents.map((a) => {
              const fold = gpuGuestFoldNote(a, foldReport);
              return <option key={a.agent} value={a.agent} title={fold?.title}>📡 {a.agent}{a.assigned ? ` · 배포됨(vC ${a.vcenters}·VM계정 ${a.vmCreds})` : ''}{fold ? ` · ${fold.short}` : ''}</option>;
            })}
          </optgroup>}
        </Select>
        {selFold && (
          <span style={{ fontSize: 12, color: 'var(--amber,#f59e0b)', border: '1px solid var(--amber,#f59e0b)', borderRadius: 4, padding: '1px 6px', whiteSpace: 'normal', maxWidth: '100%' }}
            title={selFold.title}>⚠ {selFold.short}</span>
        )}
        {deployAgent && (
          <span className="muted" style={{ fontSize: 12, color: 'var(--amber,#f59e0b)' }}>
            ℹ 이 설정은 원격 엣지 <b>{deployAgent}</b>로 배포됩니다. 엣지가 다음 pull 주기(약 1분)에 가져가 로컬에 적용하고, <b>실제 SSH/게스트작업은 엣지에서</b> 수행합니다. (테스트 버튼은 중앙에서 원격 VM에 도달 못 하므로 비활성)
          </span>
        )}
      </div>
  );

  // v2.622(감사 WEB-01): 폼이 지금 대상의 값이 아니면 편집 화면을 그리지 않는다(저장 버튼도 없다).
  if (!gate.ready) {
    return (
      <div style={{ maxWidth: 1280 }}>
        <div className="section-title" style={{ marginTop: 0 }}>🎮 GPU 게스트 수집</div>
        {targetCard}
        {gate.state === 'error' ? (
          <div className="banner warn">
            {deployAgent ? <>원격 엣지 <b>{deployAgent}</b></> : '이 포탈'}의 설정을 불러오지 못했습니다: {loadErr} — 이전 대상의 값으로 저장하지 않도록 편집 화면을 닫았습니다.{' '}
            <button className="tab" onClick={() => load(deployAgent, true)}>다시 시도</button>
          </div>
        ) : <Loading />}
      </div>
    );
  }
  const monitoredCount = Object.values(form.vcenters).filter((v) => v.enabled).length;

  return (
    <div style={{ maxWidth: 1280 }}>
      <div className="section-title" style={{ marginTop: 0 }}>🎮 GPU 게스트 수집</div>
      {loadErr && <div className="banner warn" style={{ marginBottom: 8 }}>설정을 다시 불러오지 못했습니다: {loadErr} — 아래는 직전에 받은 값입니다.</div>}
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
패스쓰루(DirectPath I/O) GPU는 ESXi가 사용률을 보지 못하고, vGPU도 VM별 사용률은 게스트에서 읽는 게 정확합니다. 선택한 <b>법인의 VM</b>에
        VMware Tools 게스트 작업으로 <code>nvidia-smi</code>를 실행해 사용률을 수집합니다.
        VM마다 계정이 다르면 <b>VM별 계정</b>을 등록하세요.
        <span className="badge amber" style={{ marginLeft: 6 }}>실환경 BETA</span>
      </p>

      {targetCard}

      <div className="card" style={{ padding: 16 }}>
        <label className="flex gap" style={{ alignItems: 'center', cursor: 'pointer' }}>
          <input type="checkbox" checked={form.enabled} onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))} />
          <b>게스트 GPU 수집 사용</b>
        </label>
        <div className="flex gap wrap" style={{ marginTop: 12 }}>
          <Field label="수집 주기(초)"><input className="input" type="number" min={10} style={{ width: 100 }}
            {...numInput('pollIntervalMs', Math.round(form.pollIntervalMs / 1000))} /></Field>
          <Field label="동시 실행 VM 수"><input className="input" type="number" min={1} max={32} style={{ width: 80 }}
            {...numInput('concurrency', form.concurrency)} /></Field>
          <Field label="VM당 타임아웃(초)"><input className="input" type="number" min={3} max={120} style={{ width: 90 }}
            {...numInput('timeoutMs', Math.round(form.timeoutMs / 1000))} /></Field>
          <Field label="법인당 최대 VM"><input className="input" type="number" min={1} max={100000} style={{ width: 100 }}
            {...numInput('maxVmsPerVcenter', form.maxVmsPerVcenter)} /></Field>
          <Field label="수집 방식"><Select sort={false} className="select" style={{ width: 210 }} value={form.collectMethod}
            title="auto(권장)=게스트작업 먼저→실패 시 SSH 자동 폴백(VM별 성공 방식 학습). VMware Tools=게스트작업만. SSH 직접=게스트 IP로 SSH해 nvidia-smi만."
            onChange={(e) => setForm((f) => ({ ...f, collectMethod: e.target.value }))}>
            <option value="auto">auto · 자동 폴백(권장)</option>
            <option value="guestops">VMware Tools만</option>
            <option value="ssh">SSH 직접만</option>
          </Select></Field>
          {form.collectMethod !== 'guestops' && (
            <Field label="SSH 포트"><input className="input" type="number" min={1} max={65535} style={{ width: 80 }}
              {...numInput('sshPort', form.sshPort)} /></Field>
          )}
        </div>
        {form.collectMethod === 'ssh' && (
          <div className="muted" style={{ fontSize: 12, marginTop: 6, color: 'var(--amber,#f59e0b)' }}>
            ℹ Windows VM은 기본적으로 SSH 서버(sshd)가 없어 <b>SSH 직접</b> 방식으로는 수집되지 않습니다.
            Windows VM은 자동으로 <b>VMware Tools 게스트 작업</b>(nvidia-smi.exe)으로 수집합니다(리눅스는 SSH 그대로).
          </div>
        )}
        <div className="flex gap" style={{ alignItems: 'center', marginTop: 12 }}>
          <button className="login-btn" style={{ flex: 'none', padding: '8px 18px' }} disabled={busy} onClick={save}>{busy ? '저장 중…' : '설정 저장'}</button>
          <span className="muted" style={{ fontSize: 12 }}>수집 방식·주기·동시성 등 전역 설정을 저장합니다(아래 공용 계정도 함께).</span>
          {msg && <span className="muted" style={{ fontSize: 13 }}>{msg}</span>}
        </div>
      </div>

      <div className="card" style={{ padding: 16, marginTop: 14 }}>
        <div className="flex between" style={{ alignItems: 'center', marginBottom: 8 }}>
          <b>법인(vCenter)별 모니터링 + 공용 계정</b>
          <span className="muted" style={{ fontSize: 12 }}>선택됨 {monitoredCount} / {vcsLoaded ? vcs.length : '—'}</span>
        </div>
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
          여기 계정은 그 법인 VM에 <b>공용(기본)</b>으로 쓰입니다. <b>Linux/Windows를 구분</b>해 입력하면 게스트 OS에 맞는 계정으로 수집합니다(Windows 칸 비우면 Linux 계정으로 폴백). VM마다 계정이 다르면 아래 <b>VM별 계정</b>에서 개별 지정하세요(개별이 공용보다 우선).
        </div>
        {vcsErr && (
          <div className="banner warn" style={{ marginBottom: 8 }}>
            {readFailText('vCenter 목록', vcsErr, { notMeaning: '등록된 vCenter 가 없다는 뜻이 아닙니다', stale: vcsLoaded })}
            <button className="tab" style={{ marginLeft: 6, padding: '2px 10px' }} onClick={() => load(deployAgent, false)}>다시 읽기</button>
          </div>
        )}
        {vcs.length === 0 ? (vcsLoaded ? <span className="muted">등록된 vCenter가 없습니다. 먼저 vCenter를 등록하세요.</span> : null) : (
          <div style={{ overflowX: 'auto' }}>
            <STable className="data-table" style={{ width: '100%' }}>
              <thead><tr>
                <th style={{ textAlign: 'left' }}>모니터링</th>
                <th style={{ textAlign: 'left' }}>법인 / vCenter</th>
                <th style={{ textAlign: 'left' }}>🐧 Linux 계정</th>
                <th style={{ textAlign: 'left' }}>Linux 비번</th>
                <th style={{ textAlign: 'left' }}>🪟 Windows 계정</th>
                <th style={{ textAlign: 'left' }}>Windows 비번</th>
              </tr></thead>
              <tbody>
                {vcs.map((vc) => {
                  const v = form.vcenters[vc.id] || { enabled: false, username: '', password: '', hasPassword: false, winUsername: '', winPassword: '', hasWinPassword: false };
                  // v2.733(C4-01): 이 노드가 직접 수집하지 않는 vCenter(엣지 위임·비활성·점검중)는 그 사실을 말한다 — 켜도 서버가 로그인하지 않는다.
                  //   체크는 막지 않는다(이미 켜 둔 항목을 끌 수 있어야 한다).
                  const note = gpuVcTargetNote(vc, deployAgent);
                  return (
                    <tr key={vc.id}>
                      <td><input type="checkbox" checked={!!v.enabled} onChange={(e) => setVc(vc.id, { enabled: e.target.checked })} /></td>
                      <td style={note ? { whiteSpace: 'normal', minWidth: 220, maxWidth: 360 } : undefined}><b>{vc.name || vc.id}</b><div className="muted" style={{ fontSize: 11 }}>{vc.location?.region || vc.location?.country || vc.id}</div>
                        {note && <div style={{ fontSize: 11, marginTop: 4, color: 'var(--amber,#f59e0b)' }}><BoldText text={note.text} /></div>}</td>
                      <td><input className="input" style={{ width: 140 }} placeholder="root" value={v.username}
                        onChange={(e) => setVc(vc.id, { username: e.target.value })} /></td>
                      <td><input className="input" type="password" style={{ width: 140 }}
                        placeholder={v.hasPassword ? '●●●●● (변경시 입력)' : 'Linux 비번'} value={v.password || ''}
                        onChange={(e) => setVc(vc.id, { password: e.target.value })} /></td>
                      <td><input className="input" style={{ width: 140 }} placeholder="Administrator" value={v.winUsername || ''}
                        onChange={(e) => setVc(vc.id, { winUsername: e.target.value })} /></td>
                      <td><input className="input" type="password" style={{ width: 140 }}
                        placeholder={v.hasWinPassword ? '●●●●● (변경시 입력)' : 'Windows 비번'} value={v.winPassword || ''}
                        onChange={(e) => setVc(vc.id, { winPassword: e.target.value })} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </STable>
          </div>
        )}
        <div className="flex gap" style={{ alignItems: 'center', marginTop: 12 }}>
          <button className="login-btn" style={{ flex: 'none', padding: '8px 18px' }} disabled={busy} onClick={save}>{busy ? '저장 중…' : '전역·공용 설정 저장'}</button>
          {msg && <span className="muted" style={{ fontSize: 13 }}>{msg}</span>}
        </div>
      </div>

      {/* VM 목록 조회 없이 IP+계정만으로 1대 즉시 테스트 */}
      <QuickSshTest />

      {/* VM별 계정 관리 + 테스트 */}
      <VmCredManager vcs={vcs} vcenters={form.vcenters} collectMethod={form.collectMethod} onSavedShared={() => load(deployAgent, false)} deployAgent={deployAgent} />

      {/* 물리(베어메탈) 서버 GPU 수집 — 가상화 안 한 서버 SSH nvidia-smi. 로컬 전용(엣지 배포 대상 아님). */}
      {!deployAgent && <PhysicalGpuManager vcs={vcs} />}

      {deployAgent ? (
        <div className="card" style={{ padding: 16, marginTop: 14 }}>
          <div className="muted" style={{ fontSize: 12 }}>
            원격 엣지 <b style={{ color: 'var(--text)' }}>{deployAgent}</b> 배포 모드 — 실제 수집 상태/진단은 이 엣지에서 수행되며, GPU 수집 진단 화면의 <b>Agent: {deployAgent}</b> 블록에서 확인하세요.
          </div>
        </div>
      ) : (
        <div className="card" style={{ padding: 16, marginTop: 14 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>현재 상태</div>
          <div className="flex gap wrap" style={{ fontSize: 13 }}>
            <span className="muted">상태 <b style={{ color: status.enabled ? 'var(--green)' : 'var(--text-dim)' }}>{status.enabled ? '활성' : '비활성'}</b></span>
            <span className="muted">대상 법인 <b style={{ color: 'var(--text)' }}>{status.monitored ?? 0}</b></span>
            <span className="muted">마지막 수집 <b style={{ color: 'var(--text)' }}>{fmtAgo(last?.at, { dash: '없음' })}</b></span>
            {last && (last.skipped
              ? <span className="muted">({last.skipped})</span>
              : status.fleetCountsHidden
                // v2.733: 수집 개수는 전 함대 집계라 범위 계정 응답에 싣지 않는다(서버 scopeGpuGuestStatus) — 0 으로 보이지 않게 그 사실을 말한다.
                ? <span className="muted">[{last.mode}] 수집 개수는 전 법인 집계라 표시하지 않습니다</span>
                : <span className="muted">[{last.mode}] 호스트 <b style={{ color: 'var(--text)' }}>{last.hosts ?? '—'}</b> · VM <b style={{ color: 'var(--text)' }}>{last.vms ?? '—'}</b>{last.errors ? ` · 오류 ${last.errors}` : ''}</span>)}
            {/* v2.590: 인증 실패로 주기 수집을 멈춘 VM·vCenter 수(조용한 정지 금지 — 상세는 GPU 게스트 수집 진단) */}
            {last && last.authStoppedVms > 0 && <span className="badge red" title="게스트 계정 인증 실패로 이 VM들의 주기 수집을 멈췄습니다(반복 로그인은 계정을 잠급니다). 계정을 고치면 자동으로 다시 시작합니다 — 대상 VM은 설정 › GPU 게스트 수집 진단에서 확인하세요.">인증 실패 정지 VM {last.authStoppedVms}대</span>}
            {last && Array.isArray(last.vcAuthStopped) && last.vcAuthStopped.length > 0 && <span className="badge red" title={`vCenter 계정 인증 실패로 멈춘 vCenter: ${last.vcAuthStopped.join(', ')} — 설정 › vCenter 에서 계정을 고치면 자동으로 다시 시작합니다.`}>vCenter 인증 실패 정지 {last.vcAuthStopped.length}곳</span>}
            {/* v2.733(C4-01): 이 노드가 직접 수집하지 않아 로그인하지 않고 건너뛴 vCenter(엣지 위임·비활성·점검중) — 조용히 빼지 않는다 */}
            {gpuSkippedNote(last) && <span className="muted" title="엣지 위임 vCenter 는 그 엣지가 수집합니다(설정 대상에서 그 엣지를 골라 설정). 비활성·점검중 vCenter 는 수집하지 않습니다."><BoldText text={gpuSkippedNote(last)} /></span>}
          </div>
        </div>
      )}
    </div>
  );
}

/** 빠른 단일 테스트 — VM 목록/ vCenter 조회 없이 IP+계정만으로 nvidia-smi 1대 즉시 SSH 테스트. */
function QuickSshTest() {
  const [ip, setIp] = useState('');
  const [username, setUsername] = useState('root');
  const [password, setPassword] = useState('');
  const [port, setPort] = useState(22);
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState(null);
  const run = async () => {
    if (!ip.trim() || !username.trim()) return;
    setBusy(true); setRes(null);
    try { setRes(await postJson('/admin/gpu-guest/test-ssh', { ip: ip.trim(), username: username.trim(), password, port: Number(port) || 22, revealCreds: reveal })); }
    catch (e) { setRes({ error: e.message }); }
    setBusy(false);
  };
  const fmtT = (t) => { const d = new Date(t); return d.toLocaleTimeString('ko-KR', { hour12: false }); };
  return (
    <div className="card" style={{ padding: 16, marginTop: 14 }}>
      <div className="section-title" style={{ fontSize: 14, marginTop: 0 }}>⚡ 빠른 단일 테스트 (SSH)</div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>VM 목록 조회 없이 <b>IP + 계정</b>만으로 게스트에 직접 SSH해 nvidia-smi 1대를 즉시 테스트합니다(VMware Tools 게스트작업 인증이 막힐 때 확인용). 비번을 비우면 passwordless/키 인증.</div>
      <div className="flex gap wrap" style={{ alignItems: 'center' }}>
        <input className="input" style={{ width: 160 }} placeholder="게스트 IP (예: 10.0.0.5)" value={ip} onChange={(e) => setIp(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && run()} />
        <input className="input" style={{ width: 120 }} placeholder="계정(root 등)" value={username} onChange={(e) => setUsername(e.target.value)} />
        <input className="input" type="password" style={{ width: 130 }} placeholder="비밀번호(빈칸 가능)" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && run()} />
        <input className="input" type="number" style={{ width: 80 }} min={1} max={65535} value={port} onChange={(e) => setPort(e.target.value)} title="SSH 포트" />
        <button className="login-btn" style={{ flex: 'none', padding: '9px 18px' }} disabled={busy || !ip.trim() || !username.trim()} onClick={run}>{busy ? '테스트 중…' : '테스트'}</button>
        <label className="flex gap" style={{ alignItems: 'center', fontSize: 12 }} title="실행 로그에 계정명과 비밀번호 길이를 표시합니다(디버그) — 비밀번호 값은 서버가 보내지 않습니다.">
          <input type="checkbox" checked={reveal} onChange={(e) => setReveal(e.target.checked)} /> 🔓 계정 확인
        </label>
      </div>
      {res && (
        <div style={{ marginTop: 12 }}>
          <div className="flex gap" style={{ alignItems: 'center', marginBottom: 6 }}>
            {res.error && !res.trace ? <span className="badge red">오류: {res.error}</span> : (
              <>
                <span className={`badge ${res.login ? 'green' : 'red'}`}>로그인 {res.login ? 'OK' : '실패'}</span>
                <span className={`badge ${res.read ? 'green' : 'gray'}`}>읽기 {res.read ? 'OK' : '실패'}</span>
                {res.sample && <span className="badge teal">GPU {res.sample.gpus} · 사용률 {res.sample.utilNA ? 'N/A(MIG)' : unitText(res.sample.utilPct, '%')} · mem {unitText(res.sample.memUsedPct, '%')}</span>}
                {!res.read && res.error && <span className="muted" style={{ fontSize: 12 }}>{res.error}</span>}
              </>
            )}
          </div>
          {(res.trace || []).length > 0 && (
            <pre style={{ margin: 0, padding: '8px 10px', maxHeight: 200, overflow: 'auto', fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 12, background: '#0a0f1a', color: '#cbd5e1', whiteSpace: 'pre-wrap', wordBreak: 'break-all', borderRadius: 6 }}>
              {res.trace.map((l, i) => {
                const ok = /✓|성공|OK/.test(l.msg); const bad = /✗|실패|오류|타임아웃|거부/.test(l.msg);
                return <div key={i} style={{ color: ok ? '#86efac' : bad ? '#fca5a5' : (l.msg.includes('🔓') ? '#fcd34d' : '#cbd5e1') }}>{fmtT(l.t)} {l.msg}</div>;
              })}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function toForm(settings, vcs, prev) {
  const vcenters = {};
  const mk = (s) => ({ enabled: !!s.enabled, username: s.username || '', hasPassword: !!s.hasPassword, password: '', winUsername: s.winUsername || '', hasWinPassword: !!s.hasWinPassword, winPassword: '' });
  for (const vc of vcs) vcenters[vc.id] = mk(settings.vcenters?.[vc.id] || {});
  for (const [id, s] of Object.entries(settings.vcenters || {})) { if (!vcenters[id]) vcenters[id] = mk(s); }
  return {
    enabled: !!settings.enabled, pollIntervalMs: settings.pollIntervalMs || 60000, concurrency: settings.concurrency || 4,
    timeoutMs: settings.timeoutMs || 20000, maxVmsPerVcenter: settings.maxVmsPerVcenter || 1000,
    collectMethod: settings.collectMethod || 'auto', sshPort: settings.sshPort || 22, vcenters,
  };
}

import Select from '../components/Select.jsx';