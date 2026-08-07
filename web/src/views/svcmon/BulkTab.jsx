import React, { useEffect, useState } from 'react';
import { fetchJson, postJson } from '../../api.js';
import { ErrorBox } from '../../components/ui.jsx';
import PreviewTable from './PreviewTable.jsx';

/**
 * 대량 자동등록 — 이름 규칙(`{n}`) + IP 범위로 대상을 한꺼번에 만든다.
 * 예: `lesasbpdp{n}` 1번부터 20개, IP `10.20.30.41-10.20.30.60`, 템플릿 'SBP 워커노드'.
 *
 * 설계상 중요한 두 가지:
 *
 * 1) **개수가 안 맞으면 만들지 않는다.** 이름 20개인데 IP 11개면 오류다. 부족한 만큼 잘라
 *    등록하거나 IP 를 재사용하거나 빈 host 로 만드는 동작은 전부 없다. IP 를 자동으로 늘리는
 *    편의 기능도 두지 않았다 — 늘어난 주소가 다른 팀 장비면 ping·tcp 가 정상으로 떠서
 *    '거짓 정상'이 된다. 감시 공백보다 나쁘다.
 *
 * 2) **기본이 '중지' 상태 등록**이다. 중지된 점검은 만기 인덱스에 들어가지 않아 부하가 0이므로,
 *    수백 대를 잘못 만들어도 즉시 트래픽이 나가지 않는다. 확인 후 켜는 순서를 강제한다.
 */

const EMPTY = {
  kind: 'infra',
  path: '',
  name: { pattern: '', start: 1, pad: 2, count: '' },
  host: { mode: 'ips', ips: '', domain: '' },
  templateId: '',
  enabled: false,
  onDuplicate: 'skip',
};

export default function BulkTab({ canEdit, prefill }) {
  const [spec, setSpec] = useState(() => (prefill ? { ...EMPTY, ...prefill } : EMPTY));
  const [templates, setTemplates] = useState([]);
  const [preview, setPreview] = useState(null);
  const [batches, setBatches] = useState([]);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [done, setDone] = useState('');

  const loadBatches = async () => {
    try { const r = await fetchJson('/svcmon/batches'); setBatches(r.batches || []); } catch { /* 목록 실패는 치명적이지 않다 */ }
  };
  useEffect(() => {
    fetchJson('/svcmon/templates').then((r) => setTemplates(r.templates || [])).catch(() => setTemplates([]));
    loadBatches();
  }, []);

  const tpl = templates.find((t) => t.id === spec.templateId) || null;
  const itemCount = tpl ? (tpl.items || []).length : 0;
  const setName = (patch) => { setSpec({ ...spec, name: { ...spec.name, ...patch } }); setPreview(null); };
  const setHost = (patch) => { setSpec({ ...spec, host: { ...spec.host, ...patch } }); setPreview(null); };

  // 이름 미리보기 — 서버 판정과 별개로 사용자가 패턴을 바로 확인하게 한다(자리수·전이 확인).
  const namePreview = (() => {
    const { pattern, start, pad, count } = spec.name;
    if (!pattern) return [];
    const n = Math.min(3, Math.max(0, Number(count) || 0));
    const out = [];
    for (let i = 0; i < n; i += 1) {
      const num = Number(start || 1) + i;
      out.push(String(pattern).replace(/\{n\}/g, Number(pad) > 0 ? String(num).padStart(Number(pad), '0') : String(num)));
    }
    if ((Number(count) || 0) > 3) {
      const last = Number(start || 1) + Number(count) - 1;
      out.push('…', String(pattern).replace(/\{n\}/g, Number(pad) > 0 ? String(last).padStart(Number(pad), '0') : String(last)));
    }
    return out;
  })();

  const call = async (mode) => {
    setBusy(mode); setErr(''); setDone('');
    try {
      const body = { spec: { ...spec, name: { ...spec.name, count: Number(spec.name.count) || 0 } }, mode };
      if (mode === 'apply') body.expectedCount = preview?.expectedCount;
      const r = await postJson('/svcmon/targets/generate', body);
      if (r.error) { setErr(r.error); setPreview(r); return; }
      if (mode === 'preview') { setPreview(r); return; }
      setDone(`대상 ${r.added}개 · 점검 ${r.newTests}개를 등록했습니다(배치 ${r.batch}). 확인 후 '사용'으로 바꾸세요.`);
      setPreview(null);
      await loadBatches();
    } catch (e) { setErr(e.message); } finally { setBusy(''); }
  };

  const rollback = async (b) => {
    const live = b.liveTargets ?? b.targets;
    if (!window.confirm(`배치 ${b.id} 를 되돌립니다.\n\n등록 당시 대상 ${b.targets}개 · 현재 남아 있는 대상 ${live}개를 삭제합니다.\n계속할까요?`)) return;
    setBusy('rollback'); setErr('');
    try {
      const r = await postJson(`/svcmon/batches/${b.id}/rollback`, { expectedCount: live });
      if (r.error) { setErr(r.error); await loadBatches(); return; }
      setDone(`배치 ${b.id} — 대상 ${r.removed}개 · 점검 ${r.tests}개를 삭제했습니다.`);
      setBatches(r.batches || []);
    } catch (e) { setErr(e.message); } finally { setBusy(''); }
  };

  const canCommit = preview && !preview.error && (preview.summary?.error || 0) === 0
    && (preview.summary?.create || 0) > 0 && preview.capacity?.verdict !== 'reject';

  return (
    <div className="flex col gap">
      {err && <ErrorBox message={err} />}
      {done && <div className="svc-ok">{done}</div>}

      {templates.length === 0 && (
        <div className="svc-warn">
          점검 템플릿이 없습니다. 대상만 만들면 점검이 하나도 없는 대상이 생깁니다 —
          먼저 '템플릿' 탭에서 템플릿을 고르거나 만드세요(기본 제공 6종이 있습니다).
        </div>
      )}

      {/* ① 배치 위치 */}
      <div className="card" style={{ padding: 14 }}>
        <b>① 어디에 만들까요</b>
        <div className="flex gap wrap" style={{ alignItems: 'flex-end', marginTop: 10 }}>
          <label className="flex col" style={{ gap: 4 }}>
            <span className="muted" style={{ fontSize: 11 }}>구분</span>
            <select className="select" value={spec.kind} onChange={(e) => { setSpec({ ...spec, kind: e.target.value }); setPreview(null); }}>
              <option value="infra">인프라</option><option value="service">서비스</option>
            </select>
          </label>
          <label className="flex col" style={{ gap: 4, flex: 1, minWidth: 300 }}>
            <span className="muted" style={{ fontSize: 11 }}>트리 경로 — 구분자 <code>\</code> · 없는 폴더는 자동 생성</span>
            <input className="input" value={spec.path} onChange={(e) => { setSpec({ ...spec, path: e.target.value }); setPreview(null); }}
              placeholder={'예: A.Infra\\OC2\\SBP 워커노드'} />
          </label>
        </div>
        <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
          경로 세그먼트에 <code>/ : * ? " &lt; &gt; |</code> 는 쓸 수 없습니다. <code>OC2/SBP</code> 처럼
          슬래시로 나누면 한 폴더 이름으로 저장돼 트리에서 형제 폴더를 만들 수 없으니
          <code> OC2\SBP</code> 로 쓰세요.
        </div>
      </div>

      {/* ② 이름과 주소 */}
      <div className="card" style={{ padding: 14 }}>
        <b>② 이름과 주소</b>
        <div className="flex gap wrap" style={{ alignItems: 'flex-end', marginTop: 10 }}>
          <label className="flex col" style={{ gap: 4, minWidth: 220 }}>
            <span className="muted" style={{ fontSize: 11 }}>이름 패턴 — <code>{'{n}'}</code> 자리에 번호가 들어갑니다</span>
            <input className="input" value={spec.name.pattern} onChange={(e) => setName({ pattern: e.target.value })}
              placeholder={'예: lesasbpdp{n}'} />
          </label>
          <label className="flex col" style={{ gap: 4, width: 90 }}>
            <span className="muted" style={{ fontSize: 11 }}>시작 번호</span>
            <input className="input" value={spec.name.start} onChange={(e) => setName({ start: e.target.value })} />
          </label>
          <label className="flex col" style={{ gap: 4, width: 90 }}>
            <span className="muted" style={{ fontSize: 11 }}>자리수</span>
            <input className="input" value={spec.name.pad} onChange={(e) => setName({ pad: e.target.value })} />
          </label>
          <label className="flex col" style={{ gap: 4, width: 90 }}>
            <span className="muted" style={{ fontSize: 11 }}>개수</span>
            <input className="input" value={spec.name.count} onChange={(e) => setName({ count: e.target.value })}
              placeholder="IP 수" />
          </label>
        </div>
        {namePreview.length > 0 && (
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            만들어질 이름: {namePreview.map((n, i) => <code key={i} style={{ marginRight: 6 }}>{n}</code>)}
          </div>
        )}

        <div className="flex gap wrap" style={{ alignItems: 'flex-start', marginTop: 12 }}>
          <label className="flex col" style={{ gap: 4 }}>
            <span className="muted" style={{ fontSize: 11 }}>주소 방식</span>
            <select className="select" value={spec.host.mode} onChange={(e) => setHost({ mode: e.target.value })}>
              <option value="ips">IP 목록/범위</option>
              <option value="name">이름 + 도메인</option>
            </select>
          </label>
          {spec.host.mode === 'ips' ? (
            <label className="flex col" style={{ gap: 4, flex: 1, minWidth: 300 }}>
              <span className="muted" style={{ fontSize: 11 }}>
                IP — 한 줄에 하나 · 범위 <code>10.20.30.41-60</code> · CIDR <code>10.20.30.0/24</code> · <code>#</code> 주석 · 최대 4096개
              </span>
              <textarea className="input" rows={5} style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
                value={spec.host.ips} onChange={(e) => setHost({ ips: e.target.value })}
                placeholder={'10.20.30.41-10.20.30.60'} />
            </label>
          ) : (
            <label className="flex col" style={{ gap: 4, minWidth: 260 }}>
              <span className="muted" style={{ fontSize: 11 }}>도메인 — <code>.</code> 으로 시작 (host = 이름 + 도메인)</span>
              <input className="input" value={spec.host.domain} onChange={(e) => setHost({ domain: e.target.value })}
                placeholder=".sbp.local" />
            </label>
          )}
        </div>
        <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
          이름 개수와 IP 개수가 다르면 <b>등록하지 않습니다</b>. 잘라서 넣거나 IP 를 자동으로
          늘리지 않습니다 — 늘어난 주소가 다른 장비면 점검이 '정상'으로 떠서 실제로는 감시가
          안 되는 상태가 됩니다.
        </div>
      </div>

      {/* ③ 점검 */}
      <div className="card" style={{ padding: 14 }}>
        <b>③ 어떤 점검을 넣을까요</b>
        <div className="flex gap wrap" style={{ alignItems: 'flex-end', marginTop: 10 }}>
          <label className="flex col" style={{ gap: 4, minWidth: 260 }}>
            <span className="muted" style={{ fontSize: 11 }}>점검 템플릿</span>
            <select className="select" value={spec.templateId} onChange={(e) => { setSpec({ ...spec, templateId: e.target.value }); setPreview(null); }}>
              <option value="">(점검 없이 대상만 등록)</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>{t.name} — 항목 {(t.items || []).length}개</option>
              ))}
            </select>
          </label>
          <label className="flex col" style={{ gap: 4 }}>
            <span className="muted" style={{ fontSize: 11 }}>등록 직후 상태</span>
            <select className="select" value={spec.enabled ? '1' : '0'} onChange={(e) => { setSpec({ ...spec, enabled: e.target.value === '1' }); setPreview(null); }}>
              <option value="0">중지 (권장)</option>
              <option value="1">바로 사용</option>
            </select>
          </label>
          <label className="flex col" style={{ gap: 4 }}>
            <span className="muted" style={{ fontSize: 11 }}>이미 있는 이름</span>
            <select className="select" value={spec.onDuplicate} onChange={(e) => { setSpec({ ...spec, onDuplicate: e.target.value }); setPreview(null); }}>
              <option value="skip">건너뛰기</option>
              <option value="error">오류로 중단</option>
            </select>
          </label>
        </div>
        {tpl && (
          <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            {tpl.name}: {(tpl.items || []).map((x) => `${x.type}${x.port ? `:${x.port}` : ''}`).join(', ')}
            {' · '}대상당 점검 {itemCount}개
            {Number(spec.name.count) > 0 ? ` → 총 ${itemCount * Number(spec.name.count)}개` : ''}
          </div>
        )}
        {spec.enabled && (
          <div className="svc-warn">
            바로 사용으로 등록하면 즉시 점검이 시작됩니다. 주소·개수를 잘못 넣었을 때
            실제 트래픽이 나가므로 '중지'로 만들어 확인한 뒤 켜는 편이 안전합니다.
          </div>
        )}

        <div className="flex gap" style={{ marginTop: 12 }}>
          <button className="login-btn" disabled={!canEdit || busy === 'preview'} onClick={() => call('preview')}>
            {busy === 'preview' ? '검사 중…' : '미리보기'}
          </button>
          {preview && (
            <button className="login-btn" disabled={!canEdit || !canCommit || busy === 'apply'} onClick={() => call('apply')}>
              {busy === 'apply' ? '등록 중…' : `${(preview.summary?.create || 0).toLocaleString()}개 등록`}
            </button>
          )}
          <button className="tab" onClick={() => { setSpec(EMPTY); setPreview(null); setErr(''); setDone(''); }}>초기화</button>
        </div>
      </div>

      {preview?.suggest?.count ? (
        <div className="svc-warn">
          개수가 맞지 않습니다. IP 수({preview.suggest.count})에 맞추겠습니까?{' '}
          <button className="tab" onClick={() => { setName({ count: preview.suggest.count }); setPreview(null); }}>
            개수를 {preview.suggest.count}로 맞추기
          </button>
        </div>
      ) : null}

      {preview?.stats && (
        <div className="card" style={{ padding: 12 }}>
          <div className="muted" style={{ fontSize: 12 }}>
            이름 {preview.stats.names}개 · IP {preview.stats.ips}개
            {preview.stats.dedupRemoved ? ` · 중복 제거 ${preview.stats.dedupRemoved}건` : ''}
            {preview.stats.firstIp ? ` · 첫 IP ${preview.stats.firstIp}` : ''}
            {preview.stats.lastIp ? ` · 끝 IP ${preview.stats.lastIp}` : ''}
            {preview.stats.nameMaxLen ? ` · 이름 최대 길이 ${preview.stats.nameMaxLen}자` : ''}
          </div>
        </div>
      )}

      {preview && <PreviewTable result={preview} title="대량 등록 미리보기" />}

      {/* 배치 이력 / 롤백 */}
      <div className="card" style={{ padding: 14 }}>
        <div className="flex between wrap gap" style={{ alignItems: 'center', marginBottom: 8 }}>
          <b>등록 이력 (최근 50건)</b>
          <button className="tab" onClick={loadBatches}>새로 고침</button>
        </div>
        <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
          '되돌리기'는 그 배치로 등록된 대상만 삭제합니다. 등록 당시 수와 <b>현재 남아 있는 수</b>를
          나란히 보여주는 이유는, 그사이 일부를 지웠다면 삭제될 개수가 다르기 때문입니다.
        </div>
        <div className="table-wrap" style={{ maxHeight: '34vh' }}>
          <table>
            <thead>
              <tr>
                <th style={{ width: 100 }}>배치</th><th style={{ width: 150 }}>시각</th><th style={{ width: 90 }}>방식</th>
                <th>경로</th><th style={{ width: 110, textAlign: 'right' }}>대상(당시/현재)</th>
                <th style={{ width: 90, textAlign: 'right' }}>점검</th><th style={{ width: 110 }}>등록자</th><th style={{ width: 110 }} />
              </tr>
            </thead>
            <tbody>
              {batches.length === 0 && <tr><td colSpan={8} className="center muted" style={{ padding: 20 }}>이력이 없습니다.</td></tr>}
              {batches.map((b) => (
                <tr key={b.id}>
                  <td><code>{b.id}</code></td>
                  <td className="muted" style={{ fontSize: 11 }}>{b.createdAt ? new Date(b.createdAt).toLocaleString('ko-KR', { hour12: false }) : '—'}</td>
                  <td>{b.source === 'generate' ? '대량등록' : b.source === 'import' ? 'CSV' : b.source}</td>
                  <td><code style={{ fontSize: 11 }}>{b.path || '—'}</code></td>
                  <td style={{ textAlign: 'right' }}>
                    {b.targets}
                    {b.liveTargets !== undefined && b.liveTargets !== b.targets && (
                      <span className="muted"> / {b.liveTargets}</span>
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }}>{b.tests}</td>
                  <td className="muted" style={{ fontSize: 11 }}>{b.createdBy || '—'}</td>
                  <td>
                    {b.rolledBackAt ? (
                      <span className="badge gray">되돌림</span>
                    ) : canEdit && (
                      <button className="tab" disabled={busy === 'rollback'} onClick={() => rollback(b)}>되돌리기</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
