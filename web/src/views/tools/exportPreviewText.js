/**
 * views/tools/exportPreviewText.js — 내보내기 미리보기 '크게 보기'(전체 화면 팝업) 도우미(순수, v2.801 — vitest · 서버 테스트가 고정).
 *
 * 사용자 요청(2026-10-27): "지금 미리보기 화면이 작은데, 미리보기를 전체화면으로 팝업해서 크게 볼 수 있게" — 승인 시안 ⑤
 * https://claude.ai/artifact/5PT9nUWUwMPTxwURq3xm1h. 'VM 전체 정보 내보내기'(VmExport.jsx)와 'VM 목록 내보내기'(VmListExportDialog.jsx)가 같이 쓴다.
 *  · 칸 색은 엑셀과 같은 규칙이다 — 서버 server/src/vcenter/vmXlsxStyle.js(KIND_BY_KEY · cellLook)와 한 쌍(서버 테스트 vmExcel2801 이 같은 입력으로 대조).
 *    값은 바꾸지 않는다(내려받는 파일과 같은 글자).
 */
export const PREVIEW_BIG = 100;          // 서버 PREVIEW_MAX(VM 전체 정보) · VM_LIST_PREVIEW_MAX(VM 목록)와 같은 값
export const MISSING_TEXTS = Object.freeze(['수집 안 됨', '내려받을 때 조회']);

/** 열 key → 칸 종류 — 서버 vmXlsxStyle.KIND_BY_KEY 와 같은 표(대조 테스트). */
export const KIND_BY_KEY = Object.freeze({
  powerState: 'power', power: 'power',
  toolsStatus: 'tools',
  cpuUsagePct: 'pct', memUsagePct: 'pct',
  vbkYn: 'yn', vsnapYn: 'yn',
  vjudge: 'verdict',
  name: 'name',
});
const POWER = Object.freeze({ POWERED_ON: 'on', 켜짐: 'on', POWERED_OFF: 'off', 꺼짐: 'off', SUSPENDED: 'warn', '일시 중지': 'warn' });
const TOOLS = Object.freeze({ RUNNING: 'on', NOT_RUNNING: 'warn', OUTDATED: 'warn' });
const YN = Object.freeze({ 예: 'yes', 아니오: 'no', 모름: 'off' });

/**
 * 칸 모양 이름(CSS 클래스 접미사) — '' 이면 손대지 않는다.
 * missing(흐린 기울임) · on(초록) · off(회색) · warn(주황) · yes · no · hot(90%+) · warm(80%+) · v-veeam · v-snap · v-none · v-unknown · name
 */
export function cellTone(v, key) {
  if (typeof v === 'string' && MISSING_TEXTS.includes(v)) return 'missing';
  const kind = KIND_BY_KEY[key] || '';
  if (typeof v === 'number' && Number.isFinite(v)) {
    if (kind === 'pct') return v >= 90 ? 'hot' : v >= 80 ? 'warm' : '';
    return '';
  }
  if (typeof v !== 'string' || !v) return kind === 'name' ? 'name' : '';
  if (kind === 'power') return POWER[v] || '';
  if (kind === 'tools') return TOOLS[v] || '';
  if (kind === 'yn') return YN[v] || '';
  if (kind === 'verdict') {
    if (v === 'Veeam 백업') return 'v-veeam';
    if (v.startsWith('스냅샷 흔적')) return 'v-snap';
    if (v === '확인 안 됨') return 'v-none';
    if (v === '모름') return 'v-unknown';
    return '';
  }
  return kind === 'name' ? 'name' : '';
}

/** 숫자는 천 단위 쉼표(엑셀 숫자 서식과 같은 모양) — 값 자체는 그대로. */
export function cellText(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v.toLocaleString('en-US', { maximumFractionDigits: 1 });
  return v == null ? '' : String(v);
}

const codeCmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/**
 * 폴더별로 나눠 보기 — 행 번호를 폴더 경로로 묶는다. 폴더는 트리와 같은 순서(단계마다 코드 단위 순서 · 상위 폴더가 먼저),
 * 최상위('') 는 맨 뒤(엑셀 폴더 트리와 같다). 한 폴더 안의 행 순서는 받은 순서 그대로.
 * @returns {Array<{folder:string, rows:number[]}>}
 */
export function folderGroups(folders, n) {
  const m = new Map();
  for (let i = 0; i < n; i++) {
    const f = String(folders?.[i] ?? '');
    let g = m.get(f);
    if (!g) { g = []; m.set(f, g); }
    g.push(i);
  }
  return [...m.entries()].map(([folder, rows]) => ({ folder, rows })).sort((a, b) => {
    if (!a.folder || !b.folder) return a.folder ? -1 : b.folder ? 1 : 0;
    const pa = a.folder.split('/'); const pb = b.folder.split('/');
    for (let i = 0; i < Math.min(pa.length, pb.length); i++) { const c = codeCmp(pa[i], pb[i]); if (c) return c; }
    return pa.length - pb.length;
  });
}

/** 찾기 — 어느 칸에든 글자가 들어 있는 행 번호(대소문자 무시). 빈 검색이면 전부. */
export function matchRows(cells, q) {
  const s = String(q || '').trim().toLowerCase();
  const all = (cells || []).map((_, i) => i);
  if (!s) return all;
  return all.filter((i) => (cells[i] || []).some((v) => String(v ?? '').toLowerCase().includes(s)));
}

/** 묶음 띠 — 같은 묶음이 이어지는 열끼리 [{ name, span, group }](엑셀 1행과 같다). cols 가 없으면 []. */
export function bandsOf(cols, groupName = (g) => g) {
  const out = [];
  for (const c of cols || []) {
    const last = out[out.length - 1];
    if (last && last.group === c.group) last.span += 1;
    else out.push({ group: c.group, name: groupName(c.group) || c.group || '', span: 1 });
  }
  return out;
}

/** 폴더 이름 줄 — '▾ A / B · 6 VM'(숨은 vm 없이 · 최상위는 '(최상위)'). */
export const folderLine = (folder, vms) => `${folder ? folder.split('/').join(' / ') : '(최상위)'} · ${vms} VM`;
