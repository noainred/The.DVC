/* UAG Monitor 프론트 — 프레임워크 없이 DOM 생성만 사용. 모든 사용자/원격 값은
 * textContent 로만 렌더한다(innerHTML 조립 금지 — 등록값이 스크립트가 될 길 차단). */

const $app = document.getElementById('app');
let TOKEN = sessionStorage.getItem('uagmon.token') || '';
let META = { authRequired: false, version: '' };
let STATE = null;        // 마지막 /api/state 응답
let SELECTED = null;     // 상세 표시 중인 target id
let EDITING = null;      // 수정 중인 target id ('new' = 추가 폼)
let LAST_ERROR = null;

/* ------------------------------ 유틸 ------------------------------ */
function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of children) if (c != null) n.append(c);
  return n;
}
const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString('ko-KR'));
const timeStr = (ts) => (ts ? new Date(ts).toLocaleTimeString('ko-KR', { hour12: false }) : '—');

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body != null) headers['Content-Type'] = 'application/json';
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const res = await fetch(path, { ...opts, headers, body: opts.body != null ? JSON.stringify(opts.body) : undefined });
  if (res.status === 401 && META.authRequired) { TOKEN = ''; sessionStorage.removeItem('uagmon.token'); render(); throw new Error('세션이 만료되었습니다. 다시 로그인하세요.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok && data.error) throw new Error(data.error);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return data;
}

/* ------------------------------ 상태 표기 ------------------------------ */
// 상태는 항상 아이콘+텍스트 라벨과 함께(색 단독 금지).
const STATE_LABEL = { up: '● 정상', warn: '⚠ 경고', down: '✕ 오류', unknown: '· 미확인' };

/* ------------------------------ 렌더 ------------------------------ */
function render() {
  $app.replaceChildren();
  if (META.authRequired && !TOKEN) return renderLogin();
  renderDashboard();
}

function renderLogin() {
  const pw = el('input', { type: 'password', placeholder: '접속 비밀번호', autofocus: '' });
  const msg = el('div', { class: 'banner error', style: 'display:none' });
  const submit = async () => {
    try {
      const r = await api('/api/login', { method: 'POST', body: { password: pw.value } });
      TOKEN = r.token; sessionStorage.setItem('uagmon.token', TOKEN);
      await refresh(); render();
    } catch (e) { msg.textContent = e.message; msg.style.display = ''; pw.value = ''; }
  };
  pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  $app.append(el('div', { class: 'login card' },
    el('h1', { text: 'UAG Monitor 로그인' }),
    el('p', { class: 'muted', text: '서버 모드는 접속 비밀번호가 필요합니다.' }),
    msg,
    el('div', { class: 'field' }, pw),
    el('div', { style: 'margin-top:10px' }, el('button', { class: 'primary', text: '로그인', onclick: submit })),
  ));
}

function renderDashboard() {
  const s = STATE;
  // 헤더
  $app.append(el('div', { class: 'topbar' },
    el('h1', { text: '🖥 UAG 모니터링 (Horizon)' }),
    el('span', { class: 'meta', text: s ? `v${s.version} · ${s.pollSeconds}s 폴링` : '불러오는 중…' }),
    el('div', { class: 'spacer' }),
    el('button', { text: '＋ UAG 등록', onclick: () => { EDITING = 'new'; render(); } }),
    el('button', { text: '지금 점검', onclick: async () => { try { await api('/api/poll-now', { method: 'POST', body: {} }); await refresh(); } catch (e) { LAST_ERROR = e.message; } render(); } }),
  ));

  // 폴링 오류 배너 — 데이터가 있으면 화면을 갈아치우지 않고 배너만(포탈 규칙).
  if (LAST_ERROR && s) $app.append(el('div', { class: 'banner warn', text: `일시 오류: ${LAST_ERROR}` }));
  if (LAST_ERROR && !s) return $app.append(el('div', { class: 'banner error', text: `연결 실패: ${LAST_ERROR}` }));
  if (!s) return $app.append(el('div', { class: 'muted', text: '불러오는 중…' }));

  // 요약 타일 — 수치는 텍스트 토큰 색(시리즈 색 미사용).
  $app.append(el('div', { class: 'tiles' },
    tile('등록 UAG', String(s.summary.total), '대'),
    tile('정상', String(s.summary.up), STATE_LABEL.up.slice(0, 1) + ' 응답·서비스 정상'),
    tile('문제', String(s.summary.problem), '경고 또는 오류'),
    tile('총 세션', fmt(s.summary.sessions), '정상 응답 UAG 합계'),
  ));

  if (EDITING) $app.append(renderForm());

  // 어플라이언스 표
  const tbody = el('tbody');
  for (const t of s.targets) {
    const st = t.stats;
    const services = el('div', { class: 'chips' });
    for (const svc of (st?.services || [])) {
      const okSvc = !svc.status || ['UP', 'RUNNING', 'OK'].includes(svc.status);
      services.append(el('span', { class: `chip ${okSvc ? 'up' : 'bad'}`, text: `${svc.id}${okSvc ? '' : '✕'}${svc.sessions != null ? ` ${svc.sessions}` : ''}` }));
    }
    if (!(st?.services || []).length) services.append(el('span', { class: 'muted', text: '—' }));
    tbody.append(el('tr', { class: `row${SELECTED === t.id ? ' selected' : ''}`, onclick: () => { SELECTED = SELECTED === t.id ? null : t.id; render(); if (SELECTED) loadHistory(t.id); } },
      el('td', {}, el('b', { text: t.name })),
      el('td', { class: 'muted', text: `${t.host}:${t.port}` }),
      el('td', { class: 'muted', text: st?.version || '—' }),
      el('td', {}, el('span', { class: `state ${t.state}`, text: STATE_LABEL[t.state] || t.state })),
      el('td', { class: 'num', text: st?.ok ? fmt(st.totalSessions) : '—' }),
      el('td', {}, services),
      el('td', { class: 'muted', text: st ? timeStr(st.at) : '—' }),
      el('td', {},
        el('button', { class: 'small', text: '수정', onclick: (e) => { e.stopPropagation(); EDITING = t.id; render(); } }),
        ' ',
        el('button', { class: 'small danger', text: '삭제', onclick: async (e) => {
          e.stopPropagation();
          if (!window.confirm(`'${t.name}' 등록을 삭제할까요?`)) return;
          try { await api(`/api/targets/${t.id}`, { method: 'DELETE' }); await refresh(); } catch (err) { LAST_ERROR = err.message; }
          render();
        } }),
      ),
    ));
    if (st && !st.ok) {
      tbody.append(el('tr', {}, el('td', { colspan: '8' }, el('span', { class: 'state down', text: '✕ ' }), el('span', { class: 'muted', text: st.error || '수집 실패' }))));
    }
  }
  const table = el('table', {},
    el('thead', {}, el('tr', {},
      el('th', { text: '이름' }), el('th', { text: '주소' }), el('th', { text: '버전' }), el('th', { text: '상태' }),
      el('th', { text: '세션' }), el('th', { text: '엣지 서비스' }), el('th', { text: '마지막 확인' }), el('th', { text: '' }))),
    tbody);
  $app.append(el('div', { class: 'card' }, el('h2', { text: '어플라이언스' }),
    s.targets.length ? table : el('div', { class: 'muted', text: '등록된 UAG가 없습니다. [＋ UAG 등록]으로 추가하세요. 필요한 것: 관리 인터페이스 주소(기본 9443)와 관리 계정.' })));

  // 상세
  if (SELECTED) {
    const t = s.targets.find((x) => x.id === SELECTED);
    if (t) $app.append(renderDetail(t));
  }
}

function tile(label, value, sub) {
  return el('div', { class: 'tile' },
    el('div', { class: 'label', text: label }),
    el('div', { class: 'value', text: value }),
    sub ? el('div', { class: 'sub', text: sub }) : null);
}

/* ------------------------------ 등록/수정 폼 ------------------------------ */
function renderForm() {
  const isNew = EDITING === 'new';
  const t = isNew ? { name: '', host: '', port: 9443, username: '', insecureTls: false } : (STATE.targets.find((x) => x.id === EDITING) || {});
  const f = {
    name: el('input', { type: 'text', value: t.name || '', placeholder: '예: 본사 UAG-01' }),
    host: el('input', { type: 'text', value: t.host || '', placeholder: 'uag01.corp.local 또는 10.x.x.x' }),
    port: el('input', { type: 'number', value: String(t.port || 9443) }),
    username: el('input', { type: 'text', value: t.username || '', placeholder: 'admin' }),
    password: el('input', { type: 'password', placeholder: isNew ? 'UAG 관리 비밀번호' : '변경할 때만 입력' }),
    insecure: el('input', { type: 'checkbox' }),
  };
  f.insecure.checked = Boolean(t.insecureTls);
  const msg = el('div', { class: 'banner error', style: 'display:none' });
  const showErr = (m) => { msg.textContent = m; msg.style.display = ''; };
  const body = () => ({
    name: f.name.value.trim(), host: f.host.value.trim(), port: Number(f.port.value) || 9443,
    username: f.username.value.trim(), password: f.password.value, insecureTls: f.insecure.checked,
  });
  const save = async () => {
    try {
      if (isNew) await api('/api/targets', { method: 'POST', body: body() });
      else await api(`/api/targets/${EDITING}`, { method: 'PUT', body: body() });
      EDITING = null; await refresh(); render();
    } catch (e) { showErr(e.message); }
  };
  return el('div', { class: 'card' },
    el('h2', { text: isNew ? 'UAG 등록' : `수정 — ${t.name}` }),
    msg,
    el('div', { class: 'form-grid' },
      field('표시 이름', f.name), field('관리 주소 (host)', f.host), field('관리 포트', f.port),
      field('관리 계정', f.username), field('비밀번호', f.password),
      el('div', { class: 'field' }, el('span', { class: 'cap', text: 'TLS' }),
        el('label', { class: 'check' }, f.insecure, ' 인증서 검증 안 함(자체서명 UAG — 이 대상에만 적용)')),
    ),
    el('div', { style: 'margin-top:12px; display:flex; gap:8px' },
      el('button', { class: 'primary', text: isNew ? '등록' : '저장', onclick: save }),
      el('button', { text: '취소', onclick: () => { EDITING = null; render(); } }),
      isNew ? null : el('button', { text: '연결 테스트', onclick: async (e) => {
        e.target.disabled = true;
        try { const r = await api(`/api/targets/${EDITING}/test`, { method: 'POST', body: {} });
          if (r.result?.ok) { msg.className = 'banner ok'; msg.textContent = `연결 성공 — 세션 ${fmt(r.result.totalSessions)}, 서비스 ${r.result.services.length}개`; }
          else showErr(`연결 실패: ${r.result?.error || '알 수 없음'}`);
          msg.style.display = '';
        } catch (err) { showErr(err.message); }
        e.target.disabled = false;
      } }),
    ));
}
const field = (cap, input) => el('div', { class: 'field' }, el('span', { class: 'cap', text: cap }), input);

/* ------------------------------ 상세 + 추이 차트 ------------------------------ */
const HISTORY = new Map(); // id -> points
async function loadHistory(id) {
  try { const r = await api(`/api/history?id=${encodeURIComponent(id)}`); HISTORY.set(id, r.points || []); render(); }
  catch { /* 배너는 다음 폴링에서 */ }
}

function renderDetail(t) {
  const st = t.stats;
  const wrap = el('div', { class: 'card' });
  wrap.append(el('h2', { text: `상세 — ${t.name}` }));

  if (st?.ok) {
    const rows = [
      ['버전', st.version || '—'], ['종합 상태', st.overall || '—'],
      ['총 세션', fmt(st.totalSessions)], ['인증 세션', fmt(st.authenticatedSessions)],
      ['최고 수위(HWM)', fmt(st.highWaterMark)], ['CPU', st.cpuPercent != null ? `${st.cpuPercent}%` : '—'],
      ['메모리', st.memPercent != null ? `${st.memPercent}%` : '—'],
      ['가동 시간', st.upSeconds != null ? `${Math.floor(st.upSeconds / 86400)}d ${Math.floor((st.upSeconds % 86400) / 3600)}h` : '—'],
    ];
    const grid = el('div', { class: 'tiles' });
    for (const [k, v] of rows) grid.append(tile(k, String(v)));
    wrap.append(grid);

    if (st.services.length) {
      const tb = el('tbody');
      for (const svc of st.services) {
        const okSvc = !svc.status || ['UP', 'RUNNING', 'OK'].includes(svc.status);
        tb.append(el('tr', {},
          el('td', { text: svc.id }),
          el('td', {}, el('span', { class: `state ${okSvc ? 'up' : 'down'}`, text: okSvc ? `● ${svc.status || 'UP'}` : `✕ ${svc.status}` })),
          el('td', { class: 'num', text: fmt(svc.sessions) }),
          el('td', { class: 'num muted', text: fmt(svc.high) })));
      }
      wrap.append(el('table', { class: 'detail-services' },
        el('thead', {}, el('tr', {}, el('th', { text: '엣지 서비스' }), el('th', { text: '상태' }), el('th', { text: '세션' }), el('th', { text: 'HWM' }))),
        tb));
    }
  } else if (st) {
    wrap.append(el('div', { class: 'banner error', text: `수집 실패: ${st.error || '알 수 없음'}` }));
  }

  // 세션 추이 — 단일 시리즈 선 차트(제목이 시리즈를 설명하므로 범례 없음).
  const points = (HISTORY.get(t.id) || []).filter((p) => p.sessions != null);
  wrap.append(el('h2', { text: '세션 수 추이 (수집 이후, 재시작 시 초기화)', style: 'margin-top:14px' }));
  wrap.append(points.length >= 2 ? lineChart(points) : el('div', { class: 'muted', text: '표시할 데이터가 아직 없습니다(2개 이상 샘플 필요).' }));
  return wrap;
}

function lineChart(points) {
  const W = 1040, H = 180, PAD = { l: 44, r: 10, t: 10, b: 20 };
  const xs = points.map((p) => p.ts);
  const ys = points.map((p) => p.sessions);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const yMax = Math.max(1, Math.max(...ys));
  const X = (t) => PAD.l + ((t - x0) / Math.max(1, x1 - x0)) * (W - PAD.l - PAD.r);
  const Y = (v) => H - PAD.b - (v / yMax) * (H - PAD.t - PAD.b);

  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', '100%');

  // 은은한 그리드 2줄 + y 라벨(0/최대), x 라벨(시작/끝)
  for (const v of [0, yMax]) {
    const gl = document.createElementNS(NS, 'line');
    gl.setAttribute('class', 'grid');
    gl.setAttribute('x1', PAD.l); gl.setAttribute('x2', W - PAD.r);
    gl.setAttribute('y1', Y(v)); gl.setAttribute('y2', Y(v));
    svg.append(gl);
    const tx = document.createElementNS(NS, 'text');
    tx.setAttribute('x', PAD.l - 6); tx.setAttribute('y', Y(v) + 3); tx.setAttribute('text-anchor', 'end');
    tx.textContent = String(v);
    svg.append(tx);
  }
  for (const [t, anchor] of [[x0, 'start'], [x1, 'end']]) {
    const tx = document.createElementNS(NS, 'text');
    tx.setAttribute('x', X(t)); tx.setAttribute('y', H - 6); tx.setAttribute('text-anchor', anchor);
    tx.textContent = timeStr(t);
    svg.append(tx);
  }

  const path = document.createElementNS(NS, 'path');
  path.setAttribute('class', 'series');
  path.setAttribute('d', points.map((p, i) => `${i ? 'L' : 'M'}${X(p.ts).toFixed(1)},${Y(p.sessions).toFixed(1)}`).join(''));
  svg.append(path);

  // 호버: 가장 가까운 점에 도트+툴팁(시각·세션 수)
  const dot = document.createElementNS(NS, 'circle');
  dot.setAttribute('class', 'dot'); dot.setAttribute('r', '4'); dot.style.display = 'none';
  svg.append(dot);
  const tip = el('div', { class: 'chart-tip' });
  const wrap = el('div', { class: 'chart-wrap' }, svg, tip);
  svg.addEventListener('mousemove', (e) => {
    const rect = svg.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0, bd = Infinity;
    for (let i = 0; i < points.length; i++) { const d = Math.abs(X(points[i].ts) - mx); if (d < bd) { bd = d; best = i; } }
    const p = points[best];
    dot.setAttribute('cx', X(p.ts)); dot.setAttribute('cy', Y(p.sessions)); dot.style.display = '';
    tip.textContent = `${timeStr(p.ts)} · 세션 ${fmt(p.sessions)}`;
    tip.style.display = 'block';
    tip.style.left = `${(X(p.ts) / W) * rect.width + 8}px`;
    tip.style.top = `${(Y(p.sessions) / H) * rect.height - 26}px`;
  });
  svg.addEventListener('mouseleave', () => { dot.style.display = 'none'; tip.style.display = 'none'; });
  return wrap;
}

/* ------------------------------ 폴링 루프 ------------------------------ */
async function refresh() {
  try {
    STATE = await api('/api/state');
    LAST_ERROR = null;
  } catch (e) {
    LAST_ERROR = e.message; // 데이터 보존 — 렌더에서 배너 처리
  }
}

async function main() {
  try { META = await api('/api/meta'); } catch (e) { LAST_ERROR = e.message; }
  if (!META.authRequired || TOKEN) await refresh();
  // ?select=<id> 딥링크 — 해당 UAG 상세를 바로 연다.
  const sel = new URLSearchParams(location.search).get('select');
  if (sel && STATE?.targets.some((t) => t.id === sel)) { SELECTED = sel; loadHistory(sel); }
  render();
  setInterval(async () => {
    if (META.authRequired && !TOKEN) return;
    await refresh();
    if (SELECTED) { try { const r = await api(`/api/history?id=${encodeURIComponent(SELECTED)}`); HISTORY.set(SELECTED, r.points || []); } catch { /* 배너로 충분 */ } }
    if (!EDITING) render(); // 입력 중 폼을 지우지 않는다
  }, 15_000);
}
main();
