/**
 * routes/api/vmHygiene.js — 특수 기능 'VM 구성 점검'(도구 키 `vm-hygiene`, v2.698) API.
 * 판정은 `vmhygiene/analyze.js`(순수) 하나 — 여기는 범위로 자른 스냅샷과 설정만 넘긴다. vCenter 왕복 0.
 *
 * 권한
 *  · 조회: `requirePerm('tools')` + toolGate 매핑(`'vm-hygiene'`) + vCenter 범위(scopeSlice).
 *  · 설정 저장·알림 지금 보내기: adminOnly + 전체 범위(설정은 전 법인 공통 · 알림은 전 법인 VM 을 요약한다). 감사 로그.
 *  · CSV: `requirePerm('data.csv')` + tools + 범위. 감사 로그.
 * 화면은 폴링하지 않는다(마운트 1회 + 새로고침).
 */
import { requireRole, requirePerm } from '../../auth/auth.js';
import { scopedVcenterIds } from '../../auth/scope.js';
import { logAudit } from '../../audit.js';
import { store } from '../../store.js';
import { memoJson, scopeSlice, scopeKey } from './shared.js';
import { fullScopeOnlyWith } from '../admin/shared.js';
import { capStr } from '../../util/capStr.js';
import { isAdminDetailUser } from '../../auth/demoGuest.js';
import { csvLine, CSV_BOM } from '../../util/csv.js';
import { fileStamp } from '../../util/dayKey.js';
import { analyzeVmHygiene, ALL_CODES } from '../../vmhygiene/analyze.js';
import { loadVmHygieneSettings, saveVmHygieneSettings } from '../../vmhygiene/settings.js';
import { vmHygieneNotifyOnce, vmHygieneNotifierStatus } from '../../vmhygiene/notifier.js';
import { notReadVcentersOf, notReadPartialOf, notReadCsvLines } from '../../corelicense/analyze.js'; // v2.744(감사 후속 FC): 읽지 못한 vCenter 판정 한 벌(VC-03 과 같은 함수)

const toolsPerm = requirePerm('tools');
const csvPerm = requirePerm('data.csv');
const adminOnly = requireRole('admin');
const fleetOnly = fullScopeOnlyWith('VM 구성 점검 설정 저장·알림 보내기는 전체 범위(vCenter 제한 없는) 계정만 할 수 있습니다 — 설정은 전 법인 공통이고, 알림은 전 법인 VM 을 요약합니다.');
const qStr = (v, n) => (typeof v === 'string' ? capStr(v.trim(), n) : '');

function run(snap, req) {
  const scoped = scopeSlice(snap, req.user, qStr(req.query.vcenterId, 128) || undefined);
  const vcName = new Map((scoped.vcenters || []).map((v) => [v.id, v.name || v.id]));
  const r = analyzeVmHygiene(scoped.vms, loadVmHygieneSettings(), {
    vcName,
    code: qStr(req.query.code, 32) || undefined,
    sev: qStr(req.query.sev, 8) || undefined,
    q: qStr(req.query.q, 128) || undefined,
  });
  // v2.744(감사 후속 FC — VC-03 의 형제): 첫 수집 중·불통(직전 값 없음)·비활성 vCenter 는 스냅샷에 VM 이 0대라 판정 결과 어디에도
  //   나오지 않았다(coverage 는 들어온 VM 만 센다) — 그 목록(범위·선택 안만)과 partial(비활성만 빠졌으면 false)을 싣는다.
  //   ⚠ r 에는 열거하지 않는 allRows(알림 요약용 — v2.719 B1-05)가 있어 펼치면 사라진다 — 원본 객체에 덧붙인다.
  const notReadVcenters = notReadVcentersOf(scoped);
  r.notReadVcenters = notReadVcenters;
  r.partial = notReadPartialOf(notReadVcenters);
  return r;
}

export function registerVmHygiene(api) {
  api.get('/tools/vm-hygiene', toolsPerm, (req, res) => memoJson(req, res, 'vm-hygiene', (snap) => {
    const r = run(snap, req);
    // v2.744(감사 AUTHZ-01): 판정은 isAdminDetailUser — 데모 계정(요청 문맥 admin + demoGuest)은 operator 와 같은 판본이고, memo 키도 역할 문자열이 아니라
    //   판정 결과(a/u)로 만든다(역할 문자열이면 데모와 진짜 관리자가 같은 캐시 칸을 써 한쪽 판본이 다른 쪽에 나간다).
    const isAdmin = isAdminDetailUser(req.user);
    return { ...r, initial: snap.initial === true, generatedAt: snap.generatedAt || null, notify: isAdmin ? vmHygieneNotifierStatus() : null };
  }, { extraKey: `${scopeKey(req.user, store.get())}|${loadVmHygieneSettings().rev}|${isAdminDetailUser(req.user) ? 'a' : 'u'}` }));

  api.get('/tools/vm-hygiene/settings', toolsPerm, (req, res) => {
    const s = loadVmHygieneSettings();
    // v2.721(감사 B2-02): exceptions 는 전 법인 공통 자유 입력(다른 법인 VM 이름·메모 조각)이고 updatedBy 는 계정명이다 —
    // 범위 계정에는 개수만(exceptionsHidden) · updatedBy null. 저장은 어차피 전체 범위 전용이다. 전체 범위 응답은 그대로.
    if (scopedVcenterIds(req.user, store.get())) {
      const n = Array.isArray(s.exceptions) ? s.exceptions.length : 0;
      return res.json({ ok: true, settings: { ...s, exceptions: [], exceptionsCount: n, exceptionsHidden: true, updatedBy: null }, codes: ALL_CODES });
    }
    res.json({ ok: true, settings: s, codes: ALL_CODES });
  });

  api.put('/tools/vm-hygiene/settings', adminOnly, fleetOnly, (req, res) => {
    try {
      const before = loadVmHygieneSettings();
      const s = saveVmHygieneSettings(req.body || {}, req.user?.username);
      logAudit({ user: req.user?.username, action: 'vm-hygiene.settings', target: 'vm-hygiene.json', detail: `rev ${before.rev} → ${s.rev}`, ip: req.ip });
      res.json({ ok: true, settings: s });
    } catch (e) {
      res.status(500).json({ ok: false, reason: String(e?.message || e).slice(0, 300) });
    }
  });

  api.post('/tools/vm-hygiene/notify-now', adminOnly, fleetOnly, async (req, res) => {
    const r = await vmHygieneNotifyOnce({ force: true });
    logAudit({ user: req.user?.username, action: 'vm-hygiene.notify', target: 'alert-channels', detail: `${r.reason}${r.sent ? ' (sent)' : ''}`, ip: req.ip });
    res.json({ ok: r.ok !== false, ...r });
  });

  api.get('/tools/vm-hygiene.csv', csvPerm, toolsPerm, (req, res) => {
    const r = run(store.get(), req);
    const head = ['vCenter', 'VM', '호스트', '클러스터', '전원', '가장 높은 심각도', '판정 코드', '예외'];
    const lines = [CSV_BOM + csvLine(head)];
    for (const row of r.rows) {
      lines.push(csvLine([row.vcenterName, row.name, row.host, row.cluster, row.powerState, row.worst, row.findings.map((f) => f.code).join(' '), row.excepted || '']));
    }
    // v2.744(감사 후속 FC): 읽지 못한 vCenter 의 VM 은 이 파일에 없다 — 마지막 줄에 밝힌다(비용 배분 CSV 와 같은 모양).
    // v2.744(회귀 검토 GF-R2 형제): 읽지 못한 것과 비활성을 나눠 한글 사유로 적는다 — 판정·문구는 corelicense/analyze.js notReadCsvLines 한 벌.
    // v2.744(최종 검토 RV-3·RX-CSV-01): 이 파일은 판정 목록이라 합계가 없다 — mode 'judge'(화면 notReadJudgeNote 와 같은 뜻 · 같은 명사).
    for (const t of notReadCsvLines(r.notReadVcenters, { mode: 'judge', noun: 'VM' })) lines.push(csvLine([t]));
    logAudit({ user: req.user?.username, action: 'vm-hygiene.csv', target: 'vm-hygiene', detail: `${r.rows.length} rows${r.omitted ? ` (+${r.omitted} omitted)` : ''}`, ip: req.ip });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="vm-hygiene-${fileStamp()}.csv"`);
    if (r.omitted) res.setHeader('X-Omitted-Rows', String(r.omitted));
    res.send(lines.join('\r\n'));
  });
}
