import React, { useEffect, useMemo, useRef, useState } from 'react';
import { usePolling, postJson, putJson, delJson, fetchJson, getCurrentUser, downloadFile } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';

/**
 * 성능점검 — Claude Design 핸드오프(design_handoff_perf_check) 기준 구현.
 * 좌: 트리(법인/서비스, 경로 파생) · 스플리터 · 우: 점검 목록(그룹 헤더 + 행) + 상세 모달.
 *
 * 색·간격·타이포는 핸드오프 README 의 토큰을 그대로 따른다(pc-* 클래스, styles.css 하단).
 * 인프라/서비스 두 모드는 대상의 kind('infra'|'service')로 분리 — 트리·목록이 함께 교체된다.
 */

const LEFT_W_KEY = 'perfcheck.leftW';
const DEFAULT_LEFT_W = 340;
const TARGET_PAGE = 50;          // 폴더당 한 번에 표시할 대상 수('더 보기'로 늘린다)

/** 상태 매핑(README): Ok/Host is alive → ok, Warning → warn, Disabled → off, 그 외 → bad. */
const STATUS = {
  ok: { label: 'Ok', cls: 'pc-ok' },
  warn: { label: 'Warning', cls: 'pc-warn' },
  bad: { label: 'No answer', cls: 'pc-bad' },
  disabled: { label: 'Disabled', cls: 'pc-off' },
  // '중지'와 구분해야 하는 두 상태 — 감시 공백을 의도적 중지로 보이게 하면 안 된다.
  pending: { label: '점검 대기', cls: 'pc-pending' },
  stale: { label: '갱신 안 됨', cls: 'pc-stale' },
  none: { label: '—', cls: 'pc-off' },
};
const METHOD = {
  ping: 'ping (timeout - 4000 ms)', trace: 'traceroute', tcp: 'TCP port', udp: 'UDP probe',
  http: 'HTTP/URL', soap: 'SOAP/XML', dns: 'DNS query', cert: 'SSL certificate expiry',
  ntp: 'NTP offset', smtp: 'SMTP banner', pop3: 'POP3 banner', imap: 'IMAP banner',
  ssh: 'SSH banner', ldap: 'LDAP bind', domain: 'Domain expiry (whois)',
};

/** 계단식 추가 메뉴 — HostMonitor 의 Test→Add 계층을 우리 구현 가능 범위로 정리. */
const ADD_MENU = [
  { label: '📡 Ping / Trace', items: [
    { type: 'ping', label: 'Ping (ICMP RTT)' },
    { type: 'trace', label: 'Trace (경로·홉 수)' },
  ] },
  { label: '🔌 TCP / UDP / 포트', items: [
    { type: 'tcp', label: 'TCP 포트 열림' },
    { type: 'udp', label: 'UDP 응답' },
    { type: 'ssh', label: 'SSH 배너 (22)' },
  ] },
  { label: '🌐 Web / 인증서', items: [
    { type: 'http', label: 'HTTP / URL (코드·키워드)' },
    { type: 'soap', label: 'SOAP / XML (POST)' },
    { type: 'cert', label: 'SSL 인증서 만료' },
    { type: 'domain', label: '도메인 만료 (whois)' },
  ] },
  { label: '✉️ E-Mail', items: [
    { type: 'smtp', label: 'SMTP 배너 (25/587)' },
    { type: 'pop3', label: 'POP3 배너 (110/995)' },
    { type: 'imap', label: 'IMAP 배너 (143/993)' },
  ] },
  { label: '🧭 이름·시간·디렉터리', items: [
    { type: 'dns', label: 'DNS 질의' },
    { type: 'ntp', label: 'NTP 오프셋' },
    { type: 'ldap', label: 'LDAP bind (389/636)' },
  ] },
];
/** 다음 단계 예정(엔진 미구현) — 메뉴에 회색으로 노출해 어떤 기능이 올지 보이게 한다. */
const ADD_MENU_PLANNED = [
  'SNMP Get / Table / Trap', 'IPMI / Redfish 센서', 'Cisco·Juniper·F5·Netscaler',
  'NetApp·QNAP·Synology (NAS)', 'UPS·프린터', 'Database 세션(ODBC/MSSQL/Oracle)',
];

/** 유형별 설명·파라미터 정의 — 마법사 3단계 폼을 이 표에서 생성한다(한 곳만 고치면 됨). */
const F = (key, label, opts = {}) => ({ key, label, ...opts });
const TYPE_META = {
  ping: { desc: 'ICMP 로 도달성·왕복시간(RTT)을 봅니다. CLI 프로세스를 쓰므로 대량 등록 시 TCP 병용 권장.', fields: [] },
  trace: { desc: '경로(홉)를 추적해 홉 수와 완주 여부를 봅니다. 경로 변화 감시용 — 주기를 길게 두세요.',
    fields: [F('maxHops', '최대 홉', { ph: '15', hint: '이 값을 넘으면 주의' })] },
  tcp: { desc: '포트에 TCP 연결만 시도하고 바이트를 보내지 않습니다. 사내 서비스 가동 판정에 가장 안전.',
    fields: [F('port', '포트', { ph: '8080', req: true })] },
  udp: { desc: '패킷을 보내고 응답이 오는지 봅니다. 무응답이 정상인 서비스(단방향 syslog 등)는 부적합.',
    fields: [F('port', '포트', { ph: '161', req: true }), F('payload', '보낼 문자열', { ph: '(비우면 CRLF)' })] },
  http: { desc: '상태코드와 본문 키워드로 판정합니다. 리다이렉트는 추적하지 않습니다(302·401 = 살아있음).',
    fields: [F('url', 'URL', { ph: 'http://10.0.0.5:8080/health', req: true }),
      F('keyword', '본문 키워드', { ph: 'ok — 없으면 주의' }),
      F('expectStatus', '기대 상태코드', { ph: '200 (비우면 500 미만 정상)' }),
      F('warnMs', '느림 임계(ms)', { ph: '3000' })] },
  soap: { desc: 'POST + text/xml 로 SOAP 요청을 보내고 응답 XML 을 키워드로 확인합니다.',
    fields: [F('url', 'URL', { ph: 'https://host/svc', req: true }), F('soapAction', 'SOAPAction'),
      F('body', '요청 본문(XML)', { area: true }), F('keyword', '응답 키워드')] },
  dns: { desc: '대상(또는 지정 서버)을 네임서버로 보고 A/AAAA 질의를 합니다. 기대 IP 와 다르면 주의.',
    fields: [F('record', '조회할 이름', { ph: 'portal.example.com', req: true }),
      F('server', 'DNS 서버', { ph: '(비우면 대상 호스트)' }), F('expect', '기대 IP', { ph: '10.0.0.9' })] },
  cert: { desc: 'TLS 핸드셰이크로 인증서 만료일을 읽습니다. 만료 임박은 주의, 만료는 실패.',
    fields: [F('port', '포트', { ph: '443' }), F('warnDays', '경고 임계(일)', { ph: '30' })] },
  domain: { desc: 'whois(TCP 43) 로 도메인 만료일을 확인합니다. TLD 별 형식 차이로 파싱 실패가 있을 수 있어 주기는 1일 권장.',
    fields: [F('record', '도메인', { ph: 'example.com — 비우면 대상 호스트' }), F('warnDays', '경고 임계(일)', { ph: '60' })] },
  ntp: { desc: 'SNTP 로 서버 시각과의 오프셋을 봅니다. 시간 오차는 인증·OTP 실패의 흔한 원인입니다.',
    fields: [F('server', 'NTP 서버', { ph: '(비우면 대상 호스트)' }),
      F('warnMs', '주의 임계(ms)', { ph: '1000' }), F('badMs', '실패 임계(ms)', { ph: '5000' })] },
  smtp: { desc: '연결 후 220 인사말을 확인합니다. 포트만 열린 좀비 프로세스를 걸러냅니다.',
    fields: [F('port', '포트', { ph: '25' }), F('send', '보낼 명령', { ph: 'EHLO test' }), F('keyword', '응답 키워드')] },
  pop3: { desc: '연결 후 +OK 인사말을 확인합니다. 995(TLS) 는 배너가 암호화되어 TCP 점검을 권장.',
    fields: [F('port', '포트', { ph: '110' }), F('keyword', '응답 키워드')] },
  imap: { desc: '연결 후 * OK 인사말을 확인합니다. 993(TLS) 는 TCP 점검을 권장.',
    fields: [F('port', '포트', { ph: '143' }), F('keyword', '응답 키워드')] },
  ssh: { desc: 'SSH-2.0 배너를 확인합니다. 응답값에 버전 문자열이 남아 패치 추적에도 쓸 수 있습니다.',
    fields: [F('port', '포트', { ph: '22' }), F('keyword', '응답 키워드')] },
  ldap: { desc: '익명 simple bind 로 디렉터리 서버 응답을 확인합니다(익명 금지 서버도 응답하면 정상 판정).',
    fields: [F('port', '포트', { ph: '389' })] },
};

// 서버가 계산한 state 를 그대로 쓴다 — 낡음 판정 기준(주기×3)을 화면에 또 두면 갈라지고,
// 브라우저 시계가 틀린 경우 판정이 달라진다. state 가 없는 응답(구버전)만 폴백한다.
const statusOf = (t, x) => x.state
  || ((t.enabled === false || x.enabled === false) ? 'disabled' : (x.result?.status || 'pending'));
const methodText = (t, x) => {
  const base = METHOD[x.type] || x.type;
  if (x.type === 'tcp') return `${base} ${x.port || ''}`.trim();
  if (x.type === 'http') return `${base} (${x.url})`;
  if (x.type === 'dns') return `${base} (${x.record || ''} @ ${x.server || t.host})`;
  return `${base} (${t.host})`;
};

/* ── 트리: 명시적 폴더 + 대상 경로를 합쳐 만든다(빈 폴더도 유지) ── */
function buildTree(targets, folders = [], sortMode = 'manual') {
  const root = { id: '', name: 'Root', children: new Map(), targets: [] };
  const ensure = (p) => {
    let node = root;
    for (const seg of (p || '').split('\\').filter(Boolean)) {
      if (!node.children.has(seg)) node.children.set(seg, { id: node.id ? `${node.id}\\${seg}` : seg, name: seg, children: new Map(), targets: [] });
      node = node.children.get(seg);
    }
    return node;
  };
  for (const f of folders) ensure(f.path);          // 대상이 없어도 보이는 폴더
  for (const t of targets) ensure(t.path).targets.push(t);
  if (sortMode === 'name') {                        // 이름순 정렬(폴더·대상 모두)
    const sortNode = (n) => {
      n.children = new Map([...n.children.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ko')));
      n.targets.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
      for (const c of n.children.values()) sortNode(c);
    };
    sortNode(root);
  } else {
    // 수동 정렬 — order 필드로 정렬한다. 대상 order 는 생성 시 Date.now() 라 기본은 생성순(=기존 동작)
    // 이고, 재정렬하면 그 폴더 대상에 0..n 이 부여된다. 폴더는 order 가 있으면 그 값, 없으면 folders
    // 배열 인덱스(=기존 표시 순서)로 정렬해 재정렬 전 순서를 그대로 보존한다.
    const fOrder = new Map();
    folders.forEach((f, i) => fOrder.set(f.path, f.order != null ? f.order : i));
    const ord = (id) => (fOrder.has(id) ? fOrder.get(id) : Number.MAX_SAFE_INTEGER);
    const sortNode = (n) => {
      n.children = new Map([...n.children.entries()].sort((a, b) => (ord(a[1].id) - ord(b[1].id)) || a[0].localeCompare(b[0], 'ko')));
      n.targets.sort((a, b) => ((a.order ?? 0) - (b.order ?? 0)) || a.name.localeCompare(b.name, 'ko'));
      for (const c of n.children.values()) sortNode(c);
    };
    sortNode(root);
  }
  return root;
}
function statsOf(node) {
  let alarms = 0, worst = 'none';
  // stale(갱신 안 됨)도 조치가 필요한 상태다 — 알람 수에 포함하고 최악 상태 순위에도 넣는다.
  const rank = { bad: 4, stale: 3, warn: 2, ok: 1, pending: 0, none: 0, disabled: 0 };
  const visit = (n) => {
    for (const t of n.targets) for (const x of t.tests) {
      const st = statusOf(t, x);
      if (st === 'bad' || st === 'warn' || st === 'stale') alarms += 1;
      if (rank[st] > rank[worst]) worst = st;
    }
    for (const c of n.children.values()) visit(c);
  };
  visit(node);
  return { alarms, worst };
}
const matchNode = (node, q) => !q || node.name.toLowerCase().includes(q)
  || node.targets.some((t) => t.name.toLowerCase().includes(q) || (t.host || '').toLowerCase().includes(q))
  || [...node.children.values()].some((c) => matchNode(c, q));

// 드롭 하이라이트(인라인 — 별도 CSS 불필요). inside=폴더 안, before/after=형제 사이 선(boxShadow).
const DROP_INSIDE = { outline: '2px dashed var(--accent, #3b82f6)', outlineOffset: '-2px', borderRadius: 4, background: 'rgba(59,130,246,.10)' };
const DROP_BEFORE = { boxShadow: 'inset 0 3px 0 0 var(--accent, #3b82f6)' };
const DROP_AFTER = { boxShadow: 'inset 0 -3px 0 0 var(--accent, #3b82f6)' };
// dnd.over({id,zone}) 에 맞는 드롭 표시 스타일.
function dropStyle(dnd, id) {
  const o = dnd.over;
  if (!o || o.id !== id) return null;
  return o.zone === 'inside' ? DROP_INSIDE : o.zone === 'before' ? DROP_BEFORE : DROP_AFTER;
}

function TreeRows({ node, depth, sel, setSel, expanded, toggle, q, onCtx, dnd }) {
  if (depth > 0 && !matchNode(node, q)) return null;
  const open = q ? true : (expanded[node.id] !== false);   // 검색 중 강제 확장(README)
  const { alarms, worst } = statsOf(node);
  const hasKids = node.children.size > 0 || node.targets.length > 0;
  return (
    <>
      {depth > 0 && (
        <div className={`pc-tree-row${sel === node.id ? ' sel' : ''}`} style={{ paddingLeft: 8 + depth * 16, ...(dropStyle(dnd, node.id) || {}) }}
          draggable={dnd.canEdit}
          onDragStart={(e) => { e.stopPropagation(); dnd.start(e, { type: 'folder', path: node.id, name: node.name }); }}
          onDragEnd={dnd.end}
          onDragOver={(e) => dnd.onOver(e, node.id, true)}
          onDragLeave={() => dnd.onLeave(node.id)}
          onDrop={(e) => dnd.onDrop(e, node.id, true)}
          onClick={() => setSel(node.id)}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setSel(node.id); onCtx({ x: e.clientX, y: e.clientY, node: node.id }); }}>
          <span className="pc-tog" onClick={(e) => { e.stopPropagation(); toggle(node.id); }}>{hasKids ? (open ? '−' : '+') : '·'}</span>
          <span className={`pc-dot ${STATUS[worst]?.cls || 'pc-off'}`} />
          <span className={`pc-tree-label${alarms ? ' alarm' : ''}${sel === node.id ? ' on' : ''}`}>{node.name}</span>
          {alarms > 0 && <span className="pc-badge">{alarms}</span>}
        </div>
      )}
      {open && (
        <>
          {[...node.children.values()].map((c) => (
            <TreeRows key={c.id} node={c} depth={depth + 1} sel={sel} setSel={setSel} expanded={expanded} toggle={toggle} q={q} onCtx={onCtx} dnd={dnd} />
          ))}
          {node.targets.filter((t) => !q || t.name.toLowerCase().includes(q) || (t.host || '').toLowerCase().includes(q)).map((t) => {
            const st = statsOf({ children: new Map(), targets: [t] });
            const id = `target:${t.id}`;
            return (
              <div key={t.id} className={`pc-tree-row${sel === id ? ' sel' : ''}`} style={{ paddingLeft: 8 + (depth + 1) * 16, ...(dropStyle(dnd, t.id) || {}) }}
                draggable={dnd.canEdit}
                onDragStart={(e) => { e.stopPropagation(); dnd.start(e, { type: 'target', id: t.id, path: t.path, name: t.name }); }}
                onDragEnd={dnd.end}
                onDragOver={(e) => dnd.onOver(e, t.id, false)}
                onDragLeave={() => dnd.onLeave(t.id)}
                onDrop={(e) => dnd.onDrop(e, t.id, false)}
                onClick={() => setSel(id)}
                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setSel(id); onCtx({ x: e.clientX, y: e.clientY, node: t.path, targetId: t.id }); }}>
                <span className="pc-tog">·</span>
                <span className={`pc-dot ${STATUS[st.worst]?.cls || 'pc-off'}`} />
                <span className={`pc-tree-label leaf${st.alarms ? ' alarm' : ''}${sel === id ? ' on' : ''}`}>{t.name}</span>
                {st.alarms > 0 && <span className="pc-badge">{st.alarms}</span>}
              </div>
            );
          })}
        </>
      )}
    </>
  );
}

const EMPTY_TARGET = { kind: 'infra', path: 'B.Service', name: '', host: '' };
const EMPTY_TEST = { name: '', type: 'ping', intervalSec: 60, port: '', url: '', keyword: '', record: '', server: '' };

export default function SvcMonitor() {
  const [seq, setSeq] = useState(0);
  const refresh = () => setSeq((n) => n + 1);
  const { data, error, loading } = usePolling('/svcmon/state', { seq }, 15_000);
  const me = getCurrentUser();
  const canEdit = me?.role === 'admin' || me?.role === 'operator';

  const [mode, setMode] = useState('infra');           // 'infra' | 'service'
  const [sel, setSel] = useState('');
  const [expanded, setExpanded] = useState({});
  const [treeQ, setTreeQ] = useState('');
  const [testQ, setTestQ] = useState('');
  const [filter, setFilter] = useState('ALL');
  const [sort, setSort] = useState('none');            // none | name | status
  const [detail, setDetail] = useState(null);
  const [leftW, setLeftW] = useState(() => Number(localStorage.getItem(LEFT_W_KEY)) || DEFAULT_LEFT_W);
  const [dragging, setDragging] = useState(false);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const dragRef = useRef(false);
  // 트리 드래그&드롭 이동(스플리터 dragging 과 별개) — { type:'folder'|'target', path, id?, name }
  const [dragItem, setDragItem] = useState(null);
  const [dragOver, setDragOver] = useState(null);       // { id, zone:'before'|'inside'|'after' } · id='' = Root
  const [moveErr, setMoveErr] = useState('');
  // 우클릭 컨텍스트 메뉴 — { x, y, node:'root'|path, targetId? } · 계단식 서브메뉴 인덱스
  const [ctx, setCtx] = useState(null);
  // 서브메뉴 상태는 단계별로 분리해야 한다 — 변수 하나로 관리하면 3단계에 진입하는 순간
  // 2단계 조건이 거짓이 되어 부모 메뉴가 언마운트되고 커서 밑에서 메뉴가 사라진다(v2.238 수정).
  const [subL2, setSubL2] = useState(false);   // '이 대상에 점검 추가' 열림
  const [subL3, setSubL3] = useState(-1);      // 열린 카테고리 인덱스
  const closeSubs = () => { setSubL2(false); setSubL3(-1); };
  const subTimer = useRef(null);               // 메뉴 사이 이동 중 깜빡임 방지(닫기 지연)
  const holdOpen = (fn) => { if (subTimer.current) { clearTimeout(subTimer.current); subTimer.current = null; } fn(); };
  const delayClose = (fn) => {
    if (subTimer.current) clearTimeout(subTimer.current);
    subTimer.current = setTimeout(() => { fn(); subTimer.current = null; }, 160);
  };
  const [logCfg, setLogCfg] = useState(null);   // 로그 설정 모달 데이터
  // 폴더 안 대상 표시 개수 — 대량 등록으로 한 폴더에 수백~수천 대상이 들어가므로
  // 고정 상한(과거 8개)으로 자르면 나머지가 화면에서 조용히 사라진다.
  const [pageN, setPageN] = useState(TARGET_PAGE);
  // 점검 추가 마법사 — { targetId, targetName, step:1|2|3, cat, type, form, editId }
  // 호버 계단식 메뉴를 단계형으로 바꿨다: 커서가 메뉴 사이를 지나다 닫히는 문제가 원천적으로 없다.
  const [wiz, setWiz] = useState(null);

  // 선택 노드나 모드가 바뀌면 표시 개수를 처음으로 되돌린다(이전 폴더에서 늘려 둔 값 승계 금지).
  useEffect(() => { setPageN(TARGET_PAGE); }, [sel, mode]);

  // 컨텍스트 메뉴는 바깥 클릭·ESC·스크롤로 닫는다.
  useEffect(() => {
    if (!ctx) return undefined;
    const close = () => { setCtx(null); closeSubs(); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
      if (subTimer.current) { clearTimeout(subTimer.current); subTimer.current = null; }
    };
  }, [ctx]);

  // 스플리터 드래그(README: min 220, max = max(320, innerWidth-480), 더블클릭 340 초기화)
  useEffect(() => {
    const move = (e) => {
      if (!dragRef.current) return;
      const max = Math.max(320, window.innerWidth - 480);
      setLeftW(Math.min(max, Math.max(220, e.clientX - 20)));
    };
    const up = () => {
      if (!dragRef.current) return;
      dragRef.current = false; setDragging(false);
      document.body.style.userSelect = '';
      try { localStorage.setItem(LEFT_W_KEY, String(leftW)); } catch { /* 저장 실패는 무시 */ }
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  }, [leftW]);

  const allTargets = data?.targets || [];
  const targets = useMemo(() => allTargets.filter((t) => (t.kind || 'infra') === mode), [allTargets, mode]);
  const folders = useMemo(() => (data?.folders || []).filter((f) => (f.kind || 'infra') === mode), [data, mode]);
  const sortMode = data?.sort?.[mode] || 'manual';
  const tree = useMemo(() => buildTree(targets, folders, sortMode), [targets, folders, sortMode]);

  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorBox message={error} />;

  const summary = (() => {
    const s = { total: 0, ok: 0, warn: 0, bad: 0, disabled: 0 };
    for (const t of targets) for (const x of t.tests) {
      s.total += 1;
      const st = statusOf(t, x);
      if (st === 'ok') s.ok += 1; else if (st === 'warn') s.warn += 1; else if (st === 'bad') s.bad += 1; else s.disabled += 1;
    }
    return s;
  })();

  // 선택 노드 이하 대상 — 전체를 구한 뒤 표시분만 자르고, 남은 수를 화면에 알린다.
  const scoped = (() => {
    if (!sel) return targets;
    if (sel.startsWith('target:')) return targets.filter((t) => t.id === sel.slice(7));
    return targets.filter((t) => t.path === sel || t.path.startsWith(`${sel}\\`));
  })();
  const selected = scoped.slice(0, pageN);
  const hiddenTargets = scoped.length - selected.length;

  const q = testQ.trim().toLowerCase();
  const groups = selected.map((t) => {
    let tests = t.tests.filter((x) => {
      const st = statusOf(t, x);
      if (filter === 'OK' && st !== 'ok') return false;
      if (filter === 'WARN' && st !== 'warn') return false;
      if (filter === 'FAIL' && st !== 'bad') return false;
      if (filter === 'DISABLED' && st !== 'disabled') return false;
      if (filter === 'PENDING' && st !== 'pending') return false;
      if (filter === 'STALE' && st !== 'stale') return false;
      return !q || x.name.toLowerCase().includes(q) || methodText(t, x).toLowerCase().includes(q);
    });
    if (sort === 'name') tests = [...tests].sort((a, b) => a.name.localeCompare(b.name));
    if (sort === 'status') {
      const rank = { bad: 0, stale: 1, warn: 2, pending: 3, ok: 4, disabled: 5, none: 5 };
      tests = [...tests].sort((a, b) => rank[statusOf(t, a)] - rank[statusOf(t, b)]);
    }
    return { target: t, tests };
  }).filter((g) => g.tests.length > 0);   // 결과 0인 대상은 그룹 헤더도 숨김(README)

  const shown = groups.reduce((a, g) => a + g.tests.length, 0);
  const avgMs = (() => {
    const v = groups.flatMap((g) => g.tests.map((x) => x.result?.ms).filter((n) => n != null));
    return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : 0;
  })();
  const selPath = sel ? `Root\\${sel.replace(/^target:/, '')}` : 'Root';


  /* ── 점검 추가/수정 마법사 (1 카테고리 → 2 유형 → 3 파라미터) ── */
  const openWizard = (targetId, targetName, test = null) => {
    if (test) {
      const cat = ADD_MENU.findIndex((g) => g.items.some((i) => i.type === test.type));
      setWiz({ targetId, targetName, step: 3, cat: cat < 0 ? 0 : cat, type: test.type, editId: test.id,
        form: { ...EMPTY_TEST, ...test } });
    } else {
      setWiz({ targetId, targetName, step: 1, cat: -1, type: '', editId: null, form: { ...EMPTY_TEST } });
    }
    setErr('');
  };
  const wizSave = async () => {
    setBusy(true); setErr('');
    try {
      const f = wiz.form;
      const body = { ...f, type: wiz.type, intervalSec: Number(f.intervalSec) || 60 };
      // 빈 문자열은 서버가 '미지정'으로 보게 제거한다(포트 0 → 1 클램프 같은 사고 방지).
      for (const k of Object.keys(body)) if (body[k] === '') delete body[k];
      if (wiz.editId) await putJson(`/svcmon/targets/${wiz.targetId}/tests/${wiz.editId}`, body);
      else await postJson(`/svcmon/targets/${wiz.targetId}/tests`, body);
      setWiz(null); refresh();
    } catch (e) { setErr(e.message || String(e)); } finally { setBusy(false); }
  };

  const submit = async () => {
    setBusy(true); setErr('');
    try {
      if (modal.kind === 'target') {
        const body = { ...form, kind: mode };
        if (modal.edit) await putJson(`/svcmon/targets/${modal.edit}`, body); else await postJson('/svcmon/targets', body);
      } else {
        const body = { ...form, port: form.port || undefined, intervalSec: Number(form.intervalSec) || 60 };
        if (modal.edit) await putJson(`/svcmon/targets/${modal.targetId}/tests/${modal.edit}`, body);
        else await postJson(`/svcmon/targets/${modal.targetId}/tests`, body);
      }
      setModal(null); refresh();
    } catch (e) { setErr(e.message || String(e)); } finally { setBusy(false); }
  };
  const selTarget = targets.find((t) => `target:${t.id}` === sel) || null;
  const doRefresh = async () => { try { await postJson('/svcmon/refresh', {}); setTimeout(refresh, 1500); } catch (e) { window.alert(e.message); } };

  /* ── 폴더 / 정렬 / 로그 설정 ── */
  const folderPath = ctx && ctx.node !== 'root' && !ctx.targetId ? ctx.node : '';
  const newFolder = async () => {
    const name = window.prompt(folderPath ? `'${folderPath}' 하위에 만들 폴더 이름` : '최상위 폴더 이름');
    const n = (name || '').trim();
    if (!n) return;
    try {
      await postJson('/svcmon/folders', { kind: mode, path: folderPath ? `${folderPath}\\${n}` : n });
      setExpanded((e) => ({ ...e, [folderPath]: true }));
      refresh();
    } catch (e) { window.alert(e.message); }
  };
  const renameFolderAt = async (p) => {
    const cur = p.split('\\').pop();
    const name = window.prompt('새 폴더 이름', cur);
    const n = (name || '').trim();
    if (!n || n === cur) return;
    try { await putJson('/svcmon/folders/rename', { kind: mode, path: p, newName: n }); refresh(); }
    catch (e) { window.alert(e.message); }
  };
  // 대상(등록 노드) 이름 빠른 변경 — 폴더 rename 과 같은 프롬프트 방식. name 만 부분 업데이트(호스트·점검 보존).
  const renameTargetAt = async (id) => {
    const t = targets.find((x) => x.id === id);
    if (!t) return;
    const name = window.prompt('새 대상 이름', t.name);
    const n = (name || '').trim();
    if (!n || n === t.name) return;
    try { await putJson(`/svcmon/targets/${id}`, { name: n }); refresh(); }
    catch (e) { window.alert(e.message); }
  };
  // 대상 수정 모달(이름·호스트·위치) 열기 — 현재 값으로 프리필. (기존 '대상 수정' 모달을 활성화)
  const editTargetAt = (id) => {
    const t = targets.find((x) => x.id === id);
    if (!t) return;
    setForm({ kind: mode, path: t.path, name: t.name, host: t.host });
    setErr(''); setModal({ kind: 'target', edit: t.id });
  };
  const deleteFolderAt = async (p) => {
    try {
      await postJson('/svcmon/folders/delete', { kind: mode, path: p });
      if (sel === p || sel.startsWith(`${p}\\`)) setSel('');
      refresh();
    } catch (e) {
      // 409 = 하위 대상 존재 → 강제 삭제 확인
      if (/대상 \d+개/.test(e.message || '') && window.confirm(`${e.message}\n\n하위 대상까지 모두 삭제할까요?`)) {
        try { await postJson('/svcmon/folders/delete', { kind: mode, path: p, force: true }); setSel(''); refresh(); }
        catch (e2) { window.alert(e2.message); }
      } else window.alert(e.message);
    }
  };
  /* ── 드래그&드롭: 폴더 reparent(안으로) · 대상→폴더 이동 · 형제 순서 재정렬(위/아래) ── */
  const parentOf = (p) => (p.includes('\\') ? p.slice(0, p.lastIndexOf('\\')) : '');
  // 어떤 (대상 id/폴더 경로, zone) 조합이 드롭 가능한지. isFolder=드롭 대상이 폴더 행인가.
  const canDropZone = (id, zone, isFolder) => {
    if (!dragItem || !canEdit) return false;
    if (dragItem.type === 'folder') {
      if (!isFolder) return false;                                  // 폴더는 대상 사이에 못 낀다
      const src = dragItem.path;
      if (zone === 'inside') {
        if (id === '') return src.includes('\\');                   // Root 안으로 = 최상위로(이미 최상위면 no-op)
        if (id === src || String(id).startsWith(`${src}\\`)) return false;   // 자기/하위 금지
        return parentOf(src) !== id;                                // 이미 그 부모면 no-op
      }
      // before/after = id 폴더의 형제로 재정렬. Root 행은 형제 개념 없음.
      if (id === '') return false;
      const dp = parentOf(id);
      if (id === src || String(id).startsWith(`${src}\\`)) return false;     // 기준이 자기/하위면 불가
      if (dp === src || String(dp).startsWith(`${src}\\`)) return false;     // 목적 부모가 자기/하위면 순환
      return true;
    }
    // 대상 드래그
    if (isFolder) return zone === 'inside' && id !== '' && id !== dragItem.path;   // 폴더 안으로 이동
    // 대상 행 위/아래 = 그 대상의 폴더에서 순서 재정렬(다른 폴더면 이동+재정렬)
    return id !== dragItem.id;
  };
  const clearDrag = () => { setDragItem(null); setDragOver(null); };

  // 대상 X 를 refTargetId 기준 앞/뒤로 그 폴더에 놓는다(다른 폴더면 경로 이동 후 재정렬).
  const reorderTargetTo = async (dragId, refTargetId, after) => {
    const ref = targets.find((t) => t.id === refTargetId);
    const drag = targets.find((t) => t.id === dragId);
    if (!ref || !drag) return;
    const destPath = ref.path;
    if (drag.path !== destPath) await putJson(`/svcmon/targets/${dragId}`, { path: destPath });
    let ids = targets.filter((t) => t.path === destPath)
      .sort((a, b) => ((a.order ?? 0) - (b.order ?? 0)) || a.name.localeCompare(b.name, 'ko'))
      .map((t) => t.id).filter((id) => id !== dragId);
    const idx = ids.indexOf(refTargetId);
    ids.splice(after ? idx + 1 : idx, 0, dragId);
    await putJson('/svcmon/reorder/targets', { kind: mode, path: destPath, ids });
    refresh();
  };
  // 폴더 X 를 refPath 형제 기준 앞/뒤로. 부모가 다르면 그 부모로 옮기고(reparent) 위치는 기본(끝).
  const reorderFolderTo = async (dragPath, refPath, after) => {
    if (refPath === dragPath) return;
    const destParent = parentOf(refPath);
    if (parentOf(dragPath) !== destParent) {
      await postJson('/svcmon/folders/move', { kind: mode, path: dragPath, newParent: destParent });
      refresh();
      return;
    }
    const fidx = new Map(); folders.forEach((f, i) => fidx.set(f.path, f.order != null ? f.order : i));
    let paths = folders.filter((f) => parentOf(f.path) === destParent).map((f) => f.path)
      .sort((a, b) => fidx.get(a) - fidx.get(b)).filter((p) => p !== dragPath);
    const idx = paths.indexOf(refPath);
    paths.splice(after ? idx + 1 : idx, 0, dragPath);
    await putJson('/svcmon/reorder/folders', { kind: mode, parent: destParent, paths });
    refresh();
  };

  const doDrop = async (id, zone, isFolder) => {
    const item = dragItem;
    clearDrag(); setMoveErr('');
    if (!item || !canDropZone(id, zone, isFolder)) return;
    try {
      if (item.type === 'folder') {
        if (zone === 'inside') {
          await postJson('/svcmon/folders/move', { kind: mode, path: item.path, newParent: id });   // id='' → 최상위
          if (id) setExpanded((ex) => ({ ...ex, [id]: true }));
          refresh();
        } else {
          await reorderFolderTo(item.path, id, zone === 'after');
        }
      } else if (isFolder) {
        await putJson(`/svcmon/targets/${item.id}`, { path: id });                                    // 대상 → 폴더 안으로
        setExpanded((ex) => ({ ...ex, [id]: true }));
        refresh();
      } else {
        await reorderTargetTo(item.id, id, zone === 'after');                                          // 대상 순서 재정렬
      }
    } catch (e) { setMoveErr(e.message || '이동 실패'); }
  };
  const dnd = {
    canEdit, over: dragOver, active: !!dragItem,
    start: (e, item) => {
      setDragItem(item); setMoveErr('');
      try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', item.path || item.id || ''); } catch { /* noop */ }
    },
    end: clearDrag,
    onOver: (e, id, isFolder, forceZone) => {
      const zone = forceZone || zone2(e, id, isFolder);
      if (!canDropZone(id, zone, isFolder)) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'move'; } catch { /* noop */ }
      if (dragOver?.id !== id || dragOver?.zone !== zone) setDragOver({ id, zone });
    },
    onLeave: (id) => setDragOver((cur) => (cur && cur.id === id ? null : cur)),
    onDrop: (e, id, isFolder, forceZone) => { e.preventDefault(); e.stopPropagation(); doDrop(id, forceZone || zone2(e, id, isFolder), isFolder); },
  };
  // 커서 Y 위치로 zone 판정(폴더: 상 30%/중 40%/하 30% = before/inside/after · 대상: 상/하 = before/after).
  function zone2(e, id, isFolder) {
    const r = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - r.top; const h = r.height || 1;
    return isFolder ? (y < h * 0.3 ? 'before' : y > h * 0.7 ? 'after' : 'inside') : (y < h * 0.5 ? 'before' : 'after');
  }

  const setSortMode = async (m) => {
    try { await putJson('/svcmon/sort', { kind: mode, mode: m }); refresh(); }
    catch (e) { window.alert(e.message); }
  };
  const openLogSettings = async () => {
    try { const r = await fetchJson('/svcmon/log'); setLogCfg(r); } catch (e) { window.alert(e.message); }
  };
  const saveLogSettings = async () => {
    setBusy(true);
    try {
      const r = await putJson('/svcmon/log', {
        enabled: logCfg.enabled, mode: logCfg.mode, rotate: logCfg.rotate,
        keepFiles: Number(logCfg.keepFiles), maxFileMB: Number(logCfg.maxFileMB),
        maxTotalMB: Number(logCfg.maxTotalMB),
      });
      setLogCfg(r);
    } catch (e) { window.alert(e.message); } finally { setBusy(false); }
  };
  const downloadLog = async (name) => {
    try { await downloadFile(`/svcmon/log/files/${encodeURIComponent(name)}`, name); }
    catch (e) { window.alert(e.message); }
  };
  const exportFolderCsv = async (p) => {
    const qs = new URLSearchParams({ kind: mode });
    if (p) qs.set('path', p);
    try { await downloadFile(`/svcmon/targets/export.csv?${qs}`); }
    catch (e) { window.alert(e.message); }
  };
  /**
   * 성능점검 설정 화면으로 이동 — 경로·구분을 1회용 프리필로 넘긴다.
   * 딥링크 URL 로 넘기지 않는 이유: 도구 해시 파서가 `#/tools/<key>` 까지만 읽고
   * openTool 이 해시를 통째로 덮어써, 전 도구 공용 경로를 건드려야 한다.
   */
  const goToConfig = (tab, spec) => {
    try {
      sessionStorage.setItem('svcmon.prefill', JSON.stringify({
        tab, spec: { kind: spec.kind, path: spec.path },
      }));
    } catch { /* 프리필 실패는 무시 — 화면은 열린다 */ }
    window.location.hash = '#/tools/svcmon-config';
  };
  const doReset = () => { setFilter('ALL'); setTestQ(''); setTreeQ(''); setSort('none'); setDetail(null); };
  const removeSel = async () => {
    if (!selTarget) return;
    if (!window.confirm(`'${selTarget.name}' 대상과 점검 ${selTarget.tests.length}개를 삭제할까요?`)) return;
    try { await delJson(`/svcmon/targets/${selTarget.id}`); setSel(''); refresh(); } catch (e) { window.alert(e.message); }
  };

  return (
    <div className="pc-root">
      <div className="pc-modebar">
        <button className={`pc-mode${mode === 'infra' ? ' on' : ''}`} onClick={() => { setMode('infra'); setSel(''); doReset(); }}>
          {mode === 'infra' && <span className="pc-pulse" />}인프라</button>
        <button className={`pc-mode${mode === 'service' ? ' on' : ''}`} onClick={() => { setMode('service'); setSel(''); doReset(); }}>
          {mode === 'service' && <span className="pc-pulse" />}서비스</button>
      </div>

      <div className="pc-sectionbar">
        <span className="pc-sectitle">{mode === 'service' ? 'SERVICE HEALTH & SLA TESTS' : 'INFRASTRUCTURE PERFORMANCE TESTS'}</span>
        <span className="pc-secline" />
        <span className="pc-secpath">{selPath} · {selected.length} {mode === 'service' ? 'service(s)' : 'host(s)'}</span>
        {/* 설정 바로가기 — 특수기능을 거치지 않고 이 화면에서 바로 성능점검 설정으로.
            현재 모드/선택 경로를 프리필로 넘겨 그 컨텍스트에서 열린다(대량 등록·템플릿 등). */}
        <button type="button" className="pc-secbtn" title="성능점검 설정 열기"
          onClick={() => goToConfig('tpl', { kind: mode, path: sel && sel !== '' ? sel.replace(/^target:/, '') : '' })}>
          ⚙ 설정
        </button>
      </div>

      <div className="pc-cards">
        {[
          { k: 'total', label: 'TOTAL TESTS', v: summary.total, note: `${targets.length}개 대상 그룹`, cls: 'b' },
          { k: 'ok', label: '정상', v: summary.ok, note: 'Ok · Host is alive', cls: 'g' },
          { k: 'warn', label: '경고', v: summary.warn, note: '임계치 근접', cls: 'a' },
          { k: 'bad', label: '실패', v: summary.bad, note: 'No answer · Error', cls: 'r' },
          { k: 'off', label: '중지', v: summary.disabled, note: 'Disabled', cls: 'o' },
          // 아래 둘은 '중지'와 합치면 감시 공백이 정상 설정으로 보인다(폴러 과부하 시 뒤쪽 항목이 굶는다).
          { k: 'stale', label: '갱신 안 됨', v: summary.stale ?? 0, note: '주기 초과', cls: 'w' },
          { k: 'pending', label: '점검 대기', v: summary.pending ?? 0, note: '아직 실행 안 됨', cls: 'o' },
        ].map((c) => (
          <div key={c.k} className={`pc-card ${c.cls}`}>
            <div className="pc-card-label">{c.label}</div>
            <div className="pc-card-value">{c.v}</div>
            <div className="pc-card-note">{c.note}</div>
          </div>
        ))}
      </div>

      <div className="pc-body" style={{ gridTemplateColumns: `${leftW}px 8px 1fr` }}>
        <div className="pc-panel pc-tree">
          <div className="pc-panel-head">
            <span>{mode === 'service' ? 'SERVICE TREE' : 'TEST TREE'}</span>
            <span>{targets.length} {mode === 'service' ? 'services' : 'hosts'}</span>
          </div>
          <div className="pc-tree-search">
            <input className="pc-input" placeholder="대상 검색" value={treeQ} onChange={(e) => setTreeQ(e.target.value)} />
          </div>
          {moveErr && <div className="svc-warn" style={{ margin: '6px 8px', fontSize: 12 }}>이동 실패: {moveErr}</div>}
          {canEdit && <div className="muted" style={{ fontSize: 11, padding: '2px 10px' }}>드래그&드롭 — 폴더/대상 가운데에 놓으면 안으로 이동, 위/아래 가장자리에 놓으면 순서 재정렬.</div>}
          <div className="pc-tree-body">
            <div className={`pc-tree-row${sel === '' ? ' sel' : ''}`} style={{ ...(dropStyle(dnd, '') || {}) }}
              onClick={() => setSel('')}
              onDragOver={(e) => dnd.onOver(e, '', true, 'inside')}
              onDragLeave={() => dnd.onLeave('')}
              onDrop={(e) => dnd.onDrop(e, '', true, 'inside')}
              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setSel(''); setCtx({ x: e.clientX, y: e.clientY, node: 'root' }); closeSubs(); }}>
              <span className="pc-tog">−</span><span className="pc-dot pc-off" />
              <span className={`pc-tree-label${sel === '' ? ' on' : ''}`}>Root</span>
            </div>
            <TreeRows node={tree} depth={0} sel={sel} setSel={setSel} expanded={expanded} q={treeQ.trim().toLowerCase()}
              toggle={(id) => setExpanded((e) => ({ ...e, [id]: e[id] === false }))}
              onCtx={(c) => { setCtx(c); closeSubs(); }} dnd={dnd} />
            {targets.length === 0 && <div className="pc-empty" style={{ padding: 24 }}>
              등록된 {mode === 'service' ? '서비스' : '대상'}이 없습니다.{canEdit ? ' ＋ Add 로 등록하세요.' : ' 관리자에게 요청하세요.'}</div>}
          </div>
        </div>

        <div className={`pc-splitter${dragging ? ' on' : ''}`}
          onMouseDown={() => { dragRef.current = true; setDragging(true); document.body.style.userSelect = 'none'; }}
          onDoubleClick={() => { setLeftW(DEFAULT_LEFT_W); try { localStorage.setItem(LEFT_W_KEY, String(DEFAULT_LEFT_W)); } catch { /* noop */ } }}>
          <span className="pc-splitter-bar" />
        </div>

        <div className="pc-panel">
          <div className="pc-toolbar">
            <button className="pc-btn" disabled={!canEdit} onClick={() => { setForm({ ...EMPTY_TARGET, path: sel && !sel.startsWith('target:') ? sel : EMPTY_TARGET.path }); setErr(''); setModal({ kind: 'target' }); }}>＋ Add</button>
            <button className="pc-btn" disabled={!canEdit || !selTarget} title={selTarget ? '' : '트리에서 대상을 선택'}
              onClick={() => openWizard(selTarget.id, selTarget.name, null)}>✎ 점검 추가</button>
            <button className="pc-btn" disabled={!canEdit || !selTarget} title={selTarget ? '이름·호스트·위치 수정' : '트리에서 대상을 선택'}
              onClick={() => editTargetAt(selTarget.id)}>🖉 수정</button>
            <button className="pc-btn" disabled={!canEdit || !selTarget} onClick={removeSel}>✕ Remove</button>
            <button className="pc-btn accent" disabled={!canEdit} onClick={doRefresh}>⟳ Refresh</button>
            <button className="pc-btn" onClick={doReset}>⟲ Reset</button>
            <button className="pc-btn" disabled={!canEdit} title="선택 위치에 폴더 만들기(트리 우클릭도 가능)"
              onClick={() => { setCtx({ x: 0, y: 0, node: sel && !sel.startsWith('target:') ? sel : 'root' }); setTimeout(newFolder, 0); }}>📁 폴더</button>
            <button className="pc-btn" title="점검 로그(CSV) 설정" onClick={openLogSettings}>⚙ 로그</button>
            <span className="pc-sep" />
            {['ALL', 'OK', 'WARN', 'FAIL', 'STALE', 'PENDING', 'DISABLED'].map((f) => (
              <button key={f} className={`pc-chip${filter === f ? ' on' : ''}`} onClick={() => setFilter(f)}>{f}</button>
            ))}
            <input className="pc-input pc-search-right" placeholder="Test name 검색" value={testQ} onChange={(e) => setTestQ(e.target.value)} />
          </div>

          <div className="pc-table-wrap">
            <div className="pc-table">
              <div className="pc-thead">
                <div />
                <div className="pc-th click" onClick={() => setSort(sort === 'name' ? 'none' : 'name')}>TEST NAME{sort === 'name' && ' ▲'}</div>
                <div className="pc-th click" onClick={() => setSort(sort === 'status' ? 'none' : 'status')}>STATUS{sort === 'status' && ' ▲'}</div>
                <div className="pc-th r">RECURREN…</div>
                <div className="pc-th r">REPLY</div>
                <div className="pc-th">TEST METHOD</div>
              </div>
              {groups.map(({ target, tests }) => {
                const alarms = tests.filter((x) => ['bad', 'warn'].includes(statusOf(target, x))).length;
                return (
                  <React.Fragment key={target.id}>
                    <div className="pc-group">
                      <span>🗀 Root\{target.path}\{target.name}\{target.host}</span>
                      <span className="pc-group-meta">{tests.length} tests{alarms ? ` · ${alarms} alarm` : ''}</span>
                    </div>
                    {tests.map((x) => {
                      const st = statusOf(target, x);
                      const meta = STATUS[st] || STATUS.none;
                      const label = st === 'ok' && x.type === 'ping' ? 'Host is alive' : meta.label;
                      return (
                        <div key={x.id} className={`pc-tr${st === 'disabled' ? ' off' : ''}`} onClick={() => setDetail({ target, test: x, st, label })}>
                          <div><span className={`pc-dot glow ${meta.cls}`} /></div>
                          <div className="pc-td-name">{x.name}</div>
                          <div className={`pc-td-status ${meta.cls}`}>{label}</div>
                          <div className="pc-td-num">{x.result?.streak?.toLocaleString() || '—'}</div>
                          <div className="pc-td-reply">{x.result?.reply || '—'}</div>
                          <div className="pc-td-method">{methodText(target, x)}</div>
                        </div>
                      );
                    })}
                  </React.Fragment>
                );
              })}
              {groups.length === 0 && <div className="pc-empty">조건에 맞는 점검 항목이 없습니다.</div>}
              {hiddenTargets > 0 && (
                <div className="pc-empty">
                  대상 {selected.length} / {scoped.length} 표시 중 · {hiddenTargets}개 더 있음{' '}
                  <button type="button" className="tab" onClick={() => setPageN((n) => n + TARGET_PAGE)}>
                    {Math.min(TARGET_PAGE, hiddenTargets)}개 더 보기
                  </button>
                  {hiddenTargets > TARGET_PAGE && (
                    <button type="button" className="tab" onClick={() => setPageN(scoped.length)} style={{ marginLeft: 6 }}>
                      전체 {scoped.length}개
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* ── 엣지 위임 카드 — 원격 법인 엣지가 실행하고 보고한 현황 ──
              이 포탈이 직접 실행한 것(위 트리)과 별도로 표시한다. 무보고 엣지는 그 엣지
              담당 점검의 현재 상태를 **알 수 없는 것**이므로 정상으로도 장애로도 세지 않는다. */}
          {(data?.edges?.length > 0) && (
            <div className="svc-edges">
              <div className="svc-edges-head">
                <b>🛰 엣지 위임 ({data.edges.length})</b>
                {data.edgeTotals && (
                  <span className="muted" style={{ fontSize: 11 }}>
                    합계 — 정상 {data.edgeTotals.ok} · 주의 {data.edgeTotals.warn} · 실패 {data.edgeTotals.bad}
                    · 갱신 안 됨 {data.edgeTotals.stale}
                    {data.edgeTotals.unknown ? ` · 알 수 없음 ${data.edgeTotals.unknown}` : ''}
                    {data.edgeTotals.notRun ? ` · 미점검 ${data.edgeTotals.notRun}` : ''}
                  </span>
                )}
              </div>
              <div className="svc-edge-cards">
                {data.edges.map((e) => (
                  <div key={e.agent} className={`svc-edge-card${e.silent ? ' silent' : ''}`}>
                    <div className="svc-edge-name">
                      {e.silent ? '🔴' : '🟢'} {e.agent}
                      {e.skewWarn && <span className="badge amber" title={`시계 오차 추정 ${Math.round(e.skewMs / 1000)}초(전송 지연 포함)`}>시계 오차</span>}
                      {e.caps?.pingMode === 'tcp-fallback' && (
                        <span className="badge amber" title="이 엣지는 ping CLI 가 없어 TCP 연결로 판정합니다 — ICMP 와 의미가 다릅니다">ping=TCP 폴백</span>
                      )}
                    </div>
                    {e.silent ? (
                      <div className="svc-edge-warn">
                        무보고 {Math.round((e.ageMs || 0) / 1000)}초 — 담당 점검 {e.rows}개의 현재 상태를 알 수 없습니다.
                      </div>
                    ) : (
                      <div className="svc-edge-counts">
                        <span className="pc-ok">OK {e.counts.ok}</span>
                        <span className="pc-warn">WARN {e.counts.warn}</span>
                        <span className="pc-bad">FAIL {e.counts.bad}</span>
                        {e.counts.stale > 0 && <span className="pc-stale">낡음 {e.counts.stale}</span>}
                        {e.notRun > 0 && <span className="pc-pending">미점검 {e.notRun}</span>}
                      </div>
                    )}
                    <div className="svc-edge-meta muted">
                      항목 {e.items} · 보고 {e.rows}행 · {e.lastAt ? `${Math.round((e.ageMs || 0) / 1000)}초 전` : '—'}
                      {e.poller?.overdueSkipped > 0 && ` · 밀림 ${e.poller.overdueSkipped}`}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="pc-footer">
            <span>SHOWN {shown} / {summary.total}</span>
            <span>AVG REPLY {avgMs} ms</span>
            {/* 다중 노드에서는 전역 sweep 시각이 의미가 없다 — 이 포탈 로컬 실행 기준임을 명시 */}
            <span>LOCAL SWEEP {data?.lastSweep ? new Date(data.lastSweep).toLocaleTimeString('ko-KR', { hour12: false }) : '—'}</span>
            <span className="pc-live">● LIVE POLLING</span>
          </div>
        </div>
      </div>

      {ctx && ctx.x > 0 && (
        <div className="pc-ctx" style={{ left: Math.min(ctx.x, window.innerWidth - 260), top: Math.min(ctx.y, window.innerHeight - 320) }}
          onClick={(e) => e.stopPropagation()}>
          <div className="pc-ctx-head">{ctx.node === 'root' ? 'Root' : ctx.node}{ctx.targetId ? ' (대상)' : ''}</div>
          {canEdit && <>
            <button className="pc-ctx-item" onClick={() => { setCtx(null); newFolder(); }}>📁 하위 폴더 만들기</button>
            <button className="pc-ctx-item" onClick={() => {
              setCtx(null);
              setForm({ ...EMPTY_TARGET, kind: mode, path: ctx.node === 'root' ? 'B.Service' : ctx.node });
              setErr(''); setModal({ kind: 'target' });
            }}>🖥 이 폴더에 대상 추가</button>
            {ctx.targetId && (
              <button className="pc-ctx-item" onClick={() => {
                const t = targets.find((x) => x.id === ctx.targetId);
                setCtx(null); closeSubs();
                openWizard(ctx.targetId, t?.name || '', null);
              }}>🧪 이 대상에 점검 추가<span className="pc-ctx-ar">▸</span></button>
            )}
            {ctx.targetId && canEdit && (
              <button className="pc-ctx-item" onClick={() => { const id = ctx.targetId; setCtx(null); closeSubs(); renameTargetAt(id); }}>✎ 이름 변경</button>
            )}
            {ctx.targetId && canEdit && (
              <button className="pc-ctx-item" onClick={() => { const id = ctx.targetId; setCtx(null); closeSubs(); editTargetAt(id); }}>🖉 대상 수정(이름·호스트·위치)</button>
            )}
            {!ctx.targetId && <>
              {/* 대량 등록의 최대 실수 원인은 경로 오타다(오타 경로가 조용히 새 폴더가 된다).
                  우클릭한 폴더를 프리필해 그 실수를 구조적으로 없앤다. 프리필은 1회용. */}
              <button className="pc-ctx-item" onClick={() => {
                setCtx(null); closeSubs();
                goToConfig('bulk', { kind: mode, path: ctx.node === 'root' ? '' : ctx.node });
              }}>📦 이 폴더에 대량 등록…</button>
              <button className="pc-ctx-item" onClick={() => {
                setCtx(null); closeSubs();
                exportFolderCsv(ctx.node === 'root' ? '' : ctx.node);
              }}>⤓ 이 폴더 CSV 내보내기</button>
              <button className="pc-ctx-item" onClick={() => {
                setCtx(null); closeSubs();
                goToConfig('tpl', { kind: mode, path: ctx.node === 'root' ? '' : ctx.node });
              }}>🧩 이 폴더에 템플릿 적용…</button>
            </>}
            <div className="pc-ctx-sep" />
          </>}
          <div className="pc-ctx-cap">하위 폴더 정렬</div>
          <button className={`pc-ctx-item${sortMode === 'name' ? ' on' : ''}`} onClick={() => { setCtx(null); setSortMode('name'); }}>🔤 이름순</button>
          <button className={`pc-ctx-item${sortMode !== 'name' ? ' on' : ''}`} onClick={() => { setCtx(null); setSortMode('manual'); }}>🕘 등록순</button>
          {canEdit && ctx.node !== 'root' && !ctx.targetId && <>
            <div className="pc-ctx-sep" />
            <button className="pc-ctx-item" onClick={() => { const p = ctx.node; setCtx(null); renameFolderAt(p); }}>✎ 폴더 이름 변경</button>
            <button className="pc-ctx-item danger" onClick={() => { const p = ctx.node; setCtx(null); deleteFolderAt(p); }}>🗑 폴더 삭제</button>
          </>}
        </div>
      )}

      {logCfg && (
        <div className="pc-overlay" onClick={() => setLogCfg(null)}>
          <div className="pc-modal" style={{ width: 'min(600px, 94vw)' }} onClick={(e) => e.stopPropagation()}>
            <div className="pc-modal-head"><b>⚙ 점검 로그 설정 (CSV)</b><button className="pc-x" onClick={() => setLogCfg(null)}>✕</button></div>
            <div className="pc-form">
              <div className="pc-lrow"><span>로그 기록</span>
                <div className="pc-seg">
                  <button className={`pc-chip${logCfg.enabled ? ' on' : ''}`} onClick={() => setLogCfg({ ...logCfg, enabled: true })}>사용</button>
                  <button className={`pc-chip${!logCfg.enabled ? ' on' : ''}`} onClick={() => setLogCfg({ ...logCfg, enabled: false })}>중지</button>
                </div></div>
              <div className="pc-lrow"><span>기록 대상</span>
                <div className="pc-seg">
                  <button className={`pc-chip${logCfg.mode === 'all' ? ' on' : ''}`} onClick={() => setLogCfg({ ...logCfg, mode: 'all' })}>모든 결과</button>
                  <button className={`pc-chip${logCfg.mode === 'changes' ? ' on' : ''}`} onClick={() => setLogCfg({ ...logCfg, mode: 'changes' })}>상태 변화만</button>
                </div></div>
              <div className="pc-lrow"><span>파일 분할 단위</span>
                <div className="pc-seg">
                  {(data?.rotateUnits || ['hour', 'day', 'week', 'month', 'quarter']).map((u) => (
                    <button key={u} className={`pc-chip${logCfg.rotate === u ? ' on' : ''}`} onClick={() => setLogCfg({ ...logCfg, rotate: u })}>
                      {(data?.rotateLabels || {})[u] || u}</button>
                  ))}
                </div></div>
              <div className="pc-lrow"><span>보관 파일 수</span><input className="pc-input" style={{ maxWidth: 110 }} value={logCfg.keepFiles}
                onChange={(e) => setLogCfg({ ...logCfg, keepFiles: e.target.value })} /></div>
              <div className="pc-lrow"><span>파일 최대 크기(MB)</span><input className="pc-input" style={{ maxWidth: 110 }} value={logCfg.maxFileMB}
                onChange={(e) => setLogCfg({ ...logCfg, maxFileMB: e.target.value })} /></div>
              <div className="pc-lrow"><span>전체 상한(MB, 0=무제한)</span><input className="pc-input" style={{ maxWidth: 130 }} value={logCfg.maxTotalMB}
                onChange={(e) => setLogCfg({ ...logCfg, maxTotalMB: e.target.value })} /></div>
              <div className="pc-note">분할 단위 × 보관 수 = 실질 보관 기간. 한 파일이 최대 크기를 넘으면 같은 구간에서 -p02 로 이어 씁니다.
                CSV 는 UTF-8 BOM 이라 엑셀에서 바로 열립니다.</div>
              <div className="pc-logfiles">
                <div>저장 위치: <b>{logCfg.dir}</b></div>
                <div>파일 {logCfg.fileCount}개 · 합계 {(logCfg.totalBytes / 1048576).toFixed(1)} MB
                  {logCfg.stats && <> · 기록 {logCfg.stats.written?.toLocaleString?.() || 0}행
                    {logCfg.stats.dropped ? ` · 폐기 ${logCfg.stats.dropped}행` : ''}
                    {logCfg.stats.buffered ? ` · 대기 ${logCfg.stats.buffered}행` : ''}</>}</div>
                {/* 목록 상자가 스크롤되므로 8개로 자르지 않는다 — 자르면 오래된 로그를 내려받을 방법이 없다. */}
                {(logCfg.files || []).slice(0, 200).map((f) => (
                  <div key={f.name}>
                    {/* 링크(<a href>)는 Authorization 헤더를 못 실어 401 이 된다 — fetch+blob 으로 받는다. */}
                    <button type="button" className="pc-dl" onClick={() => downloadLog(f.name)}>⤓ {f.name}</button>
                    <span> · {(f.sizeBytes / 1048576).toFixed(2)} MB</span>
                  </div>
                ))}
                {(logCfg.files || []).length > 200 && <div>… 외 {logCfg.files.length - 200}개</div>}
              </div>
              <div className="pc-modal-actions">
                <button className="pc-btn" onClick={() => setLogCfg(null)}>닫기</button>
                <button className="pc-btn accent" disabled={busy} onClick={saveLogSettings}>{busy ? '저장 중…' : '저장'}</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {detail && (
        <div className="pc-overlay" onClick={() => setDetail(null)}>
          <div className="pc-modal" onClick={(e) => e.stopPropagation()}>
            <div className="pc-modal-head">
              <span className={`pc-dot glow ${STATUS[detail.st]?.cls || 'pc-off'}`} />
              <b>{detail.test.name}</b>
              <button className="pc-x" onClick={() => setDetail(null)}>✕</button>
            </div>
            <div className="pc-modal-grid">
              <span>Status</span><span className={STATUS[detail.st]?.cls}>{detail.label}</span>
              <span>Reply</span><span>{detail.test.result?.reply || '—'}</span>
              <span>Recurrences</span><span>{detail.test.result?.streak?.toLocaleString() || '—'}</span>
              <span>Test method</span><span>{methodText(detail.target, detail.test)}</span>
              <span>주기</span><span>{detail.test.intervalSec}초</span>
              <span>Path</span><span className="pc-modal-path">Root\{detail.target.path}\{detail.target.name}\{detail.target.host}</span>
            </div>
            {canEdit && (
              <div className="pc-modal-actions">
                <button className="pc-btn" onClick={() => { const d = detail; setDetail(null); openWizard(d.target.id, d.target.name, d.test); }}>✎ 수정</button>
                <button className="pc-btn" onClick={async () => {
                  if (!window.confirm(`점검 '${detail.test.name}' 을 삭제할까요?`)) return;
                  try { await delJson(`/svcmon/targets/${detail.target.id}/tests/${detail.test.id}`); setDetail(null); refresh(); } catch (e) { window.alert(e.message); }
                }}>✕ 삭제</button>
              </div>
            )}
          </div>
        </div>
      )}

      {wiz && (
        <div className="pc-overlay" onClick={() => setWiz(null)}>
          <div className="pc-modal pc-wiz" onClick={(e) => e.stopPropagation()}>
            <div className="pc-modal-head">
              <b>{wiz.editId ? '점검 수정' : '점검 추가'}</b>
              <span className="pc-wiz-target">{wiz.targetName}</span>
              <button className="pc-x" onClick={() => setWiz(null)}>✕</button>
            </div>

            {/* 진행 표시 — 완료 단계는 클릭해 되돌아갈 수 있다 */}
            <div className="pc-steps">
              {['카테고리', '점검 유형', '설정'].map((label, i) => {
                const n = i + 1;
                const state = wiz.step === n ? 'on' : (wiz.step > n ? 'done' : '');
                return (
                  <button key={label} className={`pc-step ${state}`} disabled={wiz.step <= n}
                    onClick={() => setWiz({ ...wiz, step: n })}>
                    <span className="pc-step-no">{wiz.step > n ? '✓' : n}</span>{label}
                  </button>
                );
              })}
              <span className="pc-step-count">{wiz.step} / 3</span>
            </div>

            <div className="pc-wiz-body">
              {wiz.step === 1 && (
                <>
                  <div className="pc-wiz-lead">무엇을 점검할지 분류를 고르세요.</div>
                  <div className="pc-wiz-grid">
                    {ADD_MENU.map((g, gi) => (
                      <button key={g.label} className={`pc-wiz-card${wiz.cat === gi ? ' sel' : ''}`}
                        onClick={() => setWiz({ ...wiz, cat: gi, step: 2 })}>
                        <b>{g.label}</b>
                        <span>{g.items.map((i) => i.label.split(' (')[0]).join(' · ')}</span>
                      </button>
                    ))}
                  </div>
                  <div className="pc-wiz-planned">
                    <div className="pc-ctx-cap">다음 단계 예정 (엔진 개발 후 선택 가능)</div>
                    {ADD_MENU_PLANNED.map((t) => <span key={t} className="pc-plan-tag">{t}</span>)}
                  </div>
                </>
              )}

              {wiz.step === 2 && (
                <>
                  <div className="pc-wiz-lead">{ADD_MENU[wiz.cat]?.label} — 점검 유형을 고르세요.</div>
                  <div className="pc-wiz-grid">
                    {(ADD_MENU[wiz.cat]?.items || []).map((it) => (
                      <button key={it.type} className={`pc-wiz-card${wiz.type === it.type ? ' sel' : ''}`}
                        onClick={() => setWiz({
                          ...wiz, type: it.type, step: 3,
                          form: { ...wiz.form, name: wiz.form.name || it.label.split(' (')[0] },
                        })}>
                        <b>{it.label}</b>
                        <span>{TYPE_META[it.type]?.desc || METHOD[it.type]}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}

              {wiz.step === 3 && (
                <>
                  <div className="pc-wiz-lead">
                    <b>{METHOD[wiz.type] || wiz.type}</b> — {TYPE_META[wiz.type]?.desc}
                  </div>
                  <div className="pc-wiz-form">
                    <label>점검 이름<input className="pc-input" value={wiz.form.name || ''} autoFocus
                      onChange={(e) => setWiz({ ...wiz, form: { ...wiz.form, name: e.target.value } })}
                      placeholder="2. Ping: 192.168.10.55" /></label>
                    {(TYPE_META[wiz.type]?.fields || []).map((f) => (
                      <label key={f.key}>{f.label}{f.req && <em> *</em>}
                        {f.area
                          ? <textarea className="pc-input" rows={3} value={wiz.form[f.key] || ''}
                              onChange={(e) => setWiz({ ...wiz, form: { ...wiz.form, [f.key]: e.target.value } })}
                              placeholder={f.ph || ''} />
                          : <input className="pc-input" value={wiz.form[f.key] || ''}
                              onChange={(e) => setWiz({ ...wiz, form: { ...wiz.form, [f.key]: e.target.value } })}
                              placeholder={f.ph || ''} />}
                        {f.hint && <span className="pc-fhint">{f.hint}</span>}
                      </label>
                    ))}
                    <label>점검 주기(초)<input className="pc-input" value={wiz.form.intervalSec}
                      onChange={(e) => setWiz({ ...wiz, form: { ...wiz.form, intervalSec: e.target.value } })} />
                      <span className="pc-fhint">최소 10초. 항목이 많으면 주기를 늘리는 것이 서버 부하에 직접 영향.</span></label>
                    {wiz.type === 'http' && (
                      <label className="pc-check">
                        <input type="checkbox" checked={!!wiz.form.insecure}
                          onChange={(e) => setWiz({ ...wiz, form: { ...wiz.form, insecure: e.target.checked } })} />
                        자체서명 인증서 허용(이 점검에만 적용)
                      </label>
                    )}
                  </div>
                  {err && <div className="pc-err">{err}</div>}
                </>
              )}
            </div>

            <div className="pc-wiz-foot">
              <button className="pc-btn" disabled={wiz.step === 1}
                onClick={() => setWiz({ ...wiz, step: wiz.step - 1 })}>← 뒤로</button>
              <span className="pc-wiz-crumb">
                {wiz.cat >= 0 && ADD_MENU[wiz.cat]?.label}{wiz.type && ` › ${wiz.type}`}
              </span>
              {wiz.step < 3
                ? <button className="pc-btn accent" disabled={wiz.step === 1 ? wiz.cat < 0 : !wiz.type}
                    onClick={() => setWiz({ ...wiz, step: wiz.step + 1 })}>다음 →</button>
                : <button className="pc-btn accent" disabled={busy || !wiz.form.name}
                    onClick={wizSave}>{busy ? '저장 중…' : (wiz.editId ? '수정 저장' : '점검 추가')}</button>}
            </div>
          </div>
        </div>
      )}

      {modal && (
        <div className="pc-overlay" onClick={() => setModal(null)}>
          <div className="pc-modal" onClick={(e) => e.stopPropagation()}>
            <div className="pc-modal-head">
              <b>{modal.kind === 'target' ? (modal.edit ? '대상 수정' : `${mode === 'service' ? '서비스' : '대상'} 추가`) : (modal.edit ? '점검 수정' : '점검 추가')}</b>
              <button className="pc-x" onClick={() => setModal(null)}>✕</button>
            </div>
            <div className="pc-form">
              {modal.kind === 'target' ? <>
                <label>경로 (트리 위치, ＼ 구분)<input className="pc-input" value={form.path || ''} onChange={(e) => setForm({ ...form, path: e.target.value })} placeholder="B.Service\A.Data_Landing(SBP)\01.HQ" /></label>
                <label>이름<input className="pc-input" value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="SBP_Admin01" /></label>
                <label>호스트/IP<input className="pc-input" value={form.host || ''} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="192.168.10.55" /></label>
              </> : <>
                <label>점검 이름<input className="pc-input" value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="2. Ping: 192.168.10.55" /></label>
                <label>유형<select className="pc-input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                  {(data?.testTypes || []).map((t) => <option key={t} value={t}>{t} — {METHOD[t]}</option>)}</select></label>
                {form.type === 'tcp' && <label>포트<input className="pc-input" value={form.port || ''} onChange={(e) => setForm({ ...form, port: e.target.value })} placeholder="8080" /></label>}
                {form.type === 'http' && <>
                  <label>URL<input className="pc-input" value={form.url || ''} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="http://192.168.10.55:8080/health" /></label>
                  <label>본문 키워드(선택)<input className="pc-input" value={form.keyword || ''} onChange={(e) => setForm({ ...form, keyword: e.target.value })} /></label>
                </>}
                {form.type === 'dns' && <label>조회할 이름<input className="pc-input" value={form.record || ''} onChange={(e) => setForm({ ...form, record: e.target.value })} placeholder="portal.example.com" /></label>}
                <label>주기(초, 최소 10)<input className="pc-input" value={form.intervalSec} onChange={(e) => setForm({ ...form, intervalSec: e.target.value })} /></label>
              </>}
              {err && <div className="pc-err">{err}</div>}
              <div className="pc-modal-actions">
                <button className="pc-btn" onClick={() => setModal(null)}>취소</button>
                <button className="pc-btn accent" disabled={busy} onClick={submit}>{busy ? '저장 중…' : '저장'}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
