/**
 * bareos/probePlan.js — bareos-probe '--restore-plan' 의 복원 명령 미리 보기(순수 · v2.863).
 *
 * 포탈이 새 VM 복원에서 Director 로 보낼 명령을 **같은 함수**(restorePluginOptions · chainFromHistory · chainIssue · restoreCommand)로 만들어
 * 보여 준다 — 보내지 않는다. 실환경에서 '이 jobid 로 이 이름 · 데이터스토어에 복원하면 어떤 명령이 가는가' 를 먼저 눈으로 확인하게 한다.
 * 데이터스토어가 그 vCenter 인벤토리에 있는지는 포탈만 안다(probe 는 Director 에만 닿는다) — 결과에 그 사실을 적는다.
 */
import { restorePluginOptions, pluginValueIssue, isResourceName } from './names.js';
import { chainFromHistory, chainIssue, restoreBaseKv } from './restore.js';
import { restoreCommand } from './director.js';

/**
 * @param {{ row: object|null, runs: object[], jobid: number, restoreJob: string, pluginName?: string, newName?: string, datastore?: string,
 *   base?: { vcserver?: string, configFile?: string, dc?: string, folder?: string } }} a
 *   row = jobStatus(jobid) · runs = 그 잡 이름의 실행 이력(jobRuns) · base = 포탈이 복원 명령에 싣는 기본 키(사이트 매핑 · 대상의 데이터센터 · 폴더 — v2.866)
 * @returns {{ ok: boolean, issue?: string, name?: string, client?: string, chain?: number[], pluginOptions?: string, command?: string }}
 */
export function restorePreview({ row, runs, jobid, restoreJob, pluginName = 'python3', newName = '', datastore = '', base = null }) {
  if (!row || !row.name) return { ok: false, issue: '그 jobid 를 카탈로그에서 찾지 못했습니다.' };
  if (row.type !== 'B' || !(row.state === 'ok' || row.state === 'warning')) return { ok: false, issue: `그 jobid 는 성공한 백업이 아닙니다(종류 ${row.type || '—'} · 상태 ${row.status || '—'}) — 포탈도 이 jobid 로는 복원하지 않습니다.` };
  if (!isResourceName(row.client)) return { ok: false, issue: `카탈로그의 FD 이름(‘${String(row.client || '').slice(0, 64)}’)을 쓸 수 없습니다.` };
  const mine = (Array.isArray(runs) ? runs : []).filter((r) => !r.name || r.name === row.name);
  const chain = chainFromHistory(mine, jobid);
  const ci = chainIssue(chain, jobid);
  if (ci) return { ok: false, issue: ci };
  const name = String(newName || '').trim() || `${row.name}-probe`;
  const ni = pluginValueIssue(name, '새 VM 이름');
  if (ni) return { ok: false, issue: ni };
  // v2.874(점검 B1-04): v2.866 부터 포탈은 복원 명령에 백업과 같은 기본 키(vcserver · dc · folder · config_file)를 싣는다 — 미리 보기도 같아야
  //   '포탈이 보내는 그 글자' 다(빠지면 이 명령을 그대로 시험할 때 'vcuser not defined' 가 다시 난다). 기본 키를 모르면 만들지 않는다.
  if (!base?.dc || !base?.folder) return { ok: false, issue: '포탈이 싣는 기본 키를 알아야 같은 명령을 만듭니다 — --dc · --folder(대상의 데이터센터 · 폴더)와 --vcserver · --config-file(사이트 매핑)을 주세요.' };
  const bk = restoreBaseKv({ vcserver: base.vcserver || '', configFile: base.configFile || '' }, { dc: base.dc, folder: base.folder, vmName: name });
  if (bk.issue) return { ok: false, issue: `${bk.issue} — --vcserver · --config-file 로 주세요.` };
  const kv = { ...bk.kv, vmname: name, restore_powerstate: 'off' };
  const ds = String(datastore || '').trim();
  if (ds) {
    const di = pluginValueIssue(ds, '데이터스토어');
    if (di) return { ok: false, issue: di };
    kv.restore_datastore = ds;
  }
  const po = restorePluginOptions(kv, pluginName);
  if (po.issue) return { ok: false, issue: po.issue };
  let command;
  try { command = restoreCommand({ client: row.client, jobids: chain, restoreJob, pluginOptions: po.value }); } catch (e) { return { ok: false, issue: String(e?.message || e) }; }
  return { ok: true, name: row.name, client: row.client, chain, pluginOptions: po.value, command };
}

/** `status client=` 원문에서 FD 판 한 줄(예: 'bareos-fd Version: 23.0.3 …'). JSON 모드 응답이면 문자열 값들에서 찾는다. 못 찾으면 ''(순수 · 앞 64KB 만 본다). */
export function fdVersionLine(raw) {
  let text = String(raw ?? '').slice(0, 65_536);
  const t = text.trimStart();
  if (t[0] === '{' || t[0] === '[') {
    try {
      const parts = [];
      const walk = (v, depth) => {
        if (parts.length > 2000 || depth > 8) return;
        if (typeof v === 'string') parts.push(v);
        else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x, depth + 1);
      };
      walk(JSON.parse(t), 0);
      text = parts.join('\n');
    } catch { /* 평문으로 본다 */ }
  }
  for (const line of text.split('\n')) if (/Version:/i.test(line)) return line.trim().slice(0, 200);
  return '';
}
