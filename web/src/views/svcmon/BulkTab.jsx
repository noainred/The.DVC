import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, postJson, downloadFile, postDownload } from '../../api.js';
import { ErrorBox } from '../../components/ui.jsx';
import PreviewTable from './PreviewTable.jsx';
import { IMPORT_ACCEPT, readImportFile } from './fileFormat.js';

/**
 * 대량 자동등록 — 이름 규칙(`{n}`) + 주소 지정으로 대상을 한꺼번에 만든다.
 *
 * 이름은 **시작번호 ~ 끝번호 + 자리수**로 정한다(끝번호를 비우면 IP 범위 모드에서 IP 개수를 따른다).
 * 주소는 세 가지 — IP 범위 / 자동(hostname·DNS) / 수동(호스트마다 IP 직접) 이며, 수동은 호스트가
 * 많을 때 CSV·JSON·XLSX 로 가져오고 템플릿을 내려받아 채울 수 있다.
 *
 * 설계 불변조건(genspec 와 동일):
 * 1) **개수가 안 맞거나 IP 가 빠지면 만들지 않는다.** 잘라 등록·IP 재사용·빈 host 는 전부 없다.
 *    늘린 주소가 다른 팀 장비면 ping·tcp 가 정상으로 떠서 '거짓 정상'이 된다(감시 공백보다 나쁘다).
 * 2) **기본이 '중지' 등록**이다. 중지 점검은 만기 인덱스에 안 들어가 부하 0 — 확인 후 켜게 강제한다.
 */

const EMPTY = {
  kind: 'infra',
  path: '',
  name: { pattern: '', start: 1, end: '', pad: 2 },
  addr: 'ips',          // 'ips' | 'auto' | 'manual'
  autoMode: 'name',     // 'name'(hostname 그대로) | 'dns'(지금 DNS 로 IP 고정)
  host: { ips: '', domain: '' },
  templateId: '',
  enabled: false,
  onDuplicate: 'skip',
};

// 수동 표를 화면에 그리는 상한 — 이보다 많으면 입력칸 대신 CSV 가져오기를 안내한다(수천 개 input 은 무겁다).
const MANUAL_RENDER_CAP = 200;
// 이름 목록 계산 상한 — 서버가 어차피 2,000 으로 막지만, 잘못 입력한 큰 범위로 UI 가 멈추지 않게 한다.
const NAME_CALC_CAP = 5000;

/** 이름 규칙 → 실제 이름 목록(서버 genspec.expandNames 와 같은 규칙: 시작~끝, {n} 치환·pad). */
function genNames(name) {
  const pattern = String(name.pattern || '').trim();
  const s = Number(name.start);
  const e = Number(name.end);
  if (!pattern || !Number.isInteger(s) || !Number.isInteger(e) || e < s) return [];
  const cnt = e - s + 1;
  if (cnt < 1 || cnt > NAME_CALC_CAP) return [];
  const pad = Number(name.pad) || 0;
  const out = [];
  for (let i = 0; i < cnt; i += 1) {
    const num = s + i;
    out.push(pattern.replace(/\{n\}/g, pad > 0 ? String(num).padStart(pad, '0') : String(num)));
  }
  return out;
}

export default function BulkTab({ canEdit, prefill }) {
  const [spec, setSpec] = useState(() => (prefill ? { ...EMPTY, ...prefill } : EMPTY));
  const [manualIps, setManualIps] = useState({});   // { name: ip }
  const [templates, setTemplates] = useState([]);
  const [folders, setFolders] = useState([]);
  const [showFolders, setShowFolders] = useState(false);
  const [preview, setPreview] = useState(null);
  const [batches, setBatches] = useState([]);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [done, setDone] = useState('');
  const [manualMsg, setManualMsg] = useState('');
  const mapFileRef = useRef(null);

  const loadBatches = async () => {
    try { const r = await fetchJson('/svcmon/batches'); setBatches(r.batches || []); } catch { /* 목록 실패는 치명적이지 않다 */ }
  };
  const loadFolders = async () => {
    try { const r = await fetchJson('/svcmon/state?limit=1'); setFolders(r.folders || []); } catch { setFolders([]); }
  };
  useEffect(() => {
    fetchJson('/svcmon/templates').then((r) => setTemplates(r.templates || [])).catch(() => setTemplates([]));
    loadBatches();
    loadFolders();
  }, []);

  const tpl = templates.find((t) => t.id === spec.templateId) || null;
  const itemCount = tpl ? (tpl.items || []).length : 0;
  const setName = (patch) => { setSpec({ ...spec, name: { ...spec.name, ...patch } }); setPreview(null); };
  const setHost = (patch) => { setSpec({ ...spec, host: { ...spec.host, ...patch } }); setPreview(null); };
  const setField = (patch) => { setSpec({ ...spec, ...patch }); setPreview(null); };

  const names = useMemo(() => genNames(spec.name), [spec.name]);
  const nameCount = names.length;

  // 기존 폴더(트리) — 현재 구분(infra/service)만, 경로 기준 정렬·중복 제거. 클릭하면 경로에 채운다.
  const folderPaths = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const f of folders) {
      if ((f.kind || 'infra') !== spec.kind) continue;
      const p = f.path || '';
      if (!p || seen.has(p)) continue;
      seen.add(p); out.push(p);
    }
    out.sort((a, b) => a.localeCompare(b, 'ko'));
    return out;
  }, [folders, spec.kind]);

  // 수동 매핑 커버리지 — 생성될 이름 중 IP 가 채워진 개수.
  const manualFilled = useMemo(() => names.filter((n) => (manualIps[n] || '').trim()).length, [names, manualIps]);

  const namePreview = (() => {
    if (!nameCount) return [];
    if (nameCount <= 4) return names.slice();
    return [names[0], names[1], '…', names[nameCount - 1]];
  })();

  const buildSpec = () => {
    const nm = {
      pattern: spec.name.pattern,
      start: spec.name.start === '' ? '' : Number(spec.name.start),
      pad: spec.name.pad === '' ? '' : Number(spec.name.pad),
      end: spec.name.end === '' ? '' : Number(spec.name.end),
    };
    let host;
    if (spec.addr === 'ips') host = { mode: 'ips', ips: spec.host.ips };
    else if (spec.addr === 'auto') host = { mode: spec.autoMode === 'dns' ? 'dns' : 'name', domain: spec.host.domain };
    else {
      // 수동: 생성될 이름 중 IP 가 채워진 것만 보낸다. 빠진 이름은 서버가 오류로 잡아 전체 거부한다.
      const hostMap = {};
      for (const n of names) { const ip = (manualIps[n] || '').trim(); if (ip) hostMap[n] = ip; }
      host = { mode: 'manual', hostMap };
    }
    return {
      kind: spec.kind, path: spec.path, name: nm, host,
      templateId: spec.templateId, enabled: spec.enabled, onDuplicate: spec.onDuplicate,
    };
  };

  const call = async (mode) => {
    setBusy(mode); setErr(''); setDone('');
    try {
      const body = { spec: buildSpec(), mode };
      if (mode === 'apply') body.expectedCount = preview?.expectedCount;
      const r = await postJson('/svcmon/targets/generate', body);
      if (r.error) { setErr(r.error); setPreview(r); return; }
      if (mode === 'preview') { setPreview(r); return; }
      setDone(`대상 ${r.added}개 · 점검 ${r.newTests}개를 등록했습니다(배치 ${r.batch}). 확인 후 '사용'으로 바꾸세요.`);
      setPreview(null);
      await loadBatches();
      await loadFolders();
    } catch (e) { setErr(e.message); } finally { setBusy(''); }
  };

  /* ── 수동 매핑: 템플릿·가져오기·내보내기 ── */
  const downloadMapTemplate = async () => {
    setManualMsg(''); setBusy('map-tpl');
    try {
      const qs = names.length ? `?names=${encodeURIComponent(names.slice(0, 2000).join(','))}` : '';
      await downloadFile(`/svcmon/targets/hostmap-template.csv${qs}`);
      setManualMsg(names.length ? `호스트 ${Math.min(names.length, 2000)}개가 채워진 템플릿을 내려받았습니다. IP 열만 채워 다시 가져오세요.` : '빈 템플릿을 내려받았습니다.');
    } catch (e) { setErr(e.message); } finally { setBusy(''); }
  };
  const exportMap = async () => {
    setManualMsg(''); setBusy('map-exp');
    try {
      const pairs = names.map((n) => ({ name: n, ip: (manualIps[n] || '').trim() }));
      await postDownload('/svcmon/targets/hostmap/export.csv', { pairs });
      setManualMsg('현재 매핑을 CSV 로 내려받았습니다.');
    } catch (e) { setErr(e.message); } finally { setBusy(''); }
  };
  const onMapFile = async (e) => {
    const file = e.target.files?.[0];
    if (mapFileRef.current) mapFileRef.current.value = '';   // 같은 파일 재선택 허용
    if (!file) return;
    setManualMsg(''); setErr(''); setBusy('map-imp');
    try {
      const { format, content } = await readImportFile(file);
      const r = await postJson('/svcmon/targets/hostmap/parse', { format, content });
      if (r.error) { setErr(r.error); return; }
      const next = { ...manualIps };
      let matched = 0;
      const nameSet = new Set(names);
      for (const p of (r.pairs || [])) {
        const nm = (p.name || '').trim();
        if (!nm) continue;
        next[nm] = (p.ip || '').trim();
        if (nameSet.has(nm)) matched += 1;
      }
      setManualIps(next); setPreview(null);
      const extra = (r.pairs || []).length - matched;
      setManualMsg(`${(r.pairs || []).length}개 매핑을 읽었습니다 — 생성 이름과 일치 ${matched}개${extra > 0 ? ` · 그 외 ${extra}개(무시됨)` : ''}.`);
    } catch (e2) { setErr(e2.message); } finally { setBusy(''); }
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

  const reset = () => { setSpec(EMPTY); setManualIps({}); setPreview(null); setErr(''); setDone(''); setManualMsg(''); };

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
            <select className="select" value={spec.kind} onChange={(e) => setField({ kind: e.target.value })}>
              <option value="infra">인프라</option><option value="service">서비스</option>
            </select>
          </label>
          <label className="flex col" style={{ gap: 4, flex: 1, minWidth: 300 }}>
            <span className="muted" style={{ fontSize: 11 }}>트리 경로 — 구분자 <code>\</code> · 없는 폴더는 자동 생성</span>
            <input className="input" value={spec.path} onChange={(e) => setField({ path: e.target.value })}
              placeholder={'예: A.Infra\\OC2\\SBP 워커노드'} />
          </label>
          <button className="tab" type="button" onClick={() => { setShowFolders((v) => !v); if (!showFolders) loadFolders(); }}>
            {showFolders ? '기존 폴더 닫기' : '📁 기존 폴더에서 선택'}
          </button>
        </div>

        {showFolders && (
          <div className="table-wrap" style={{ maxHeight: '28vh', marginTop: 10, border: '1px solid var(--border, #2a2a2a)', borderRadius: 6 }}>
            {folderPaths.length === 0 ? (
              <div className="muted center" style={{ padding: 16, fontSize: 12 }}>
                {spec.kind === 'infra' ? '인프라' : '서비스'} 트리에 폴더가 아직 없습니다 — 위 입력창에 새 경로를 직접 적으세요.
              </div>
            ) : (
              <div style={{ padding: 6 }}>
                {folderPaths.map((p) => {
                  const depth = p.split('\\').length - 1;
                  const leaf = p.split('\\').pop();
                  const active = spec.path === p;
                  return (
                    <button key={p} type="button" className={`tab ${active ? 'active' : ''}`}
                      style={{ display: 'block', width: '100%', textAlign: 'left', marginLeft: depth * 16, marginBottom: 2, fontSize: 12 }}
                      onClick={() => { setField({ path: p }); }}>
                      📁 {leaf} <span className="muted" style={{ fontSize: 10 }}>({p})</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
          경로 세그먼트에 <code>/ : * ? " &lt; &gt; |</code> 는 쓸 수 없습니다. <code>OC2/SBP</code> 처럼
          슬래시로 나누면 한 폴더 이름으로 저장돼 트리에서 형제 폴더를 만들 수 없으니 <code> OC2\SBP</code> 로 쓰세요.
        </div>
      </div>

      {/* ② 이름 규칙 */}
      <div className="card" style={{ padding: 14 }}>
        <b>② 이름 규칙</b>
        <div className="flex gap wrap" style={{ alignItems: 'flex-end', marginTop: 10 }}>
          <label className="flex col" style={{ gap: 4, minWidth: 220 }}>
            <span className="muted" style={{ fontSize: 11 }}>이름 패턴 — <code>{'{n}'}</code> 자리에 번호가 들어갑니다</span>
            <input className="input" value={spec.name.pattern} onChange={(e) => setName({ pattern: e.target.value })}
              placeholder={'예: lesasbpdp{n}'} />
          </label>
          <label className="flex col" style={{ gap: 4, width: 100 }}>
            <span className="muted" style={{ fontSize: 11 }}>시작 번호</span>
            <input className="input" value={spec.name.start} onChange={(e) => setName({ start: e.target.value })} />
          </label>
          <label className="flex col" style={{ gap: 4, width: 100 }}>
            <span className="muted" style={{ fontSize: 11 }}>끝 번호</span>
            <input className="input" value={spec.name.end} onChange={(e) => setName({ end: e.target.value })}
              placeholder={spec.addr === 'ips' ? 'IP 수' : '필수'} />
          </label>
          <label className="flex col" style={{ gap: 4, width: 90 }}>
            <span className="muted" style={{ fontSize: 11 }}>자리수</span>
            <input className="input" value={spec.name.pad} onChange={(e) => setName({ pad: e.target.value })} />
          </label>
          {nameCount > 0 && <span className="badge gray" style={{ alignSelf: 'center' }}>{nameCount.toLocaleString()}개</span>}
        </div>
        {namePreview.length > 0 && (
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            만들어질 이름: {namePreview.map((n, i) => <code key={i} style={{ marginRight: 6 }}>{n}</code>)}
          </div>
        )}
        <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
          끝 번호를 비우면 IP 범위 모드에서는 IP 개수를 그대로 씁니다. 자동(이름/DNS)·수동에서는 끝 번호가 필요합니다.
        </div>
      </div>

      {/* ③ 주소 지정 */}
      <div className="card" style={{ padding: 14 }}>
        <b>③ 주소 지정</b>
        <div className="flex gap wrap" style={{ marginTop: 10 }}>
          {[
            { v: 'ips', t: 'IP 범위/목록' },
            { v: 'auto', t: '자동 (이름 기반)' },
            { v: 'manual', t: '수동 (호스트별 IP)' },
          ].map((o) => (
            <label key={o.v} className={`tab ${spec.addr === o.v ? 'active' : ''}`} style={{ cursor: 'pointer' }}>
              <input type="radio" name="addr" checked={spec.addr === o.v} onChange={() => setField({ addr: o.v })}
                style={{ marginRight: 6 }} />
              {o.t}
            </label>
          ))}
        </div>

        {/* IP 범위 */}
        {spec.addr === 'ips' && (
          <label className="flex col" style={{ gap: 4, marginTop: 12 }}>
            <span className="muted" style={{ fontSize: 11 }}>
              IP — 한 줄에 하나 · 범위 <code>10.20.30.41-60</code> · CIDR <code>10.20.30.0/24</code> · <code>#</code> 주석 · 최대 4096개
            </span>
            <textarea className="input" rows={5} style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
              value={spec.host.ips} onChange={(e) => setHost({ ips: e.target.value })}
              placeholder={'10.20.30.41-10.20.30.60'} />
            <span className="muted" style={{ fontSize: 11 }}>
              이름 개수와 IP 개수가 다르면 <b>등록하지 않습니다</b> — 잘라 넣거나 IP 를 자동으로 늘리지 않습니다.
            </span>
          </label>
        )}

        {/* 자동(이름 기반) */}
        {spec.addr === 'auto' && (
          <div style={{ marginTop: 12 }}>
            <div className="flex gap wrap">
              {[
                { v: 'name', t: 'hostname 그대로', d: '감시할 때마다 DNS 로 해석 (host = 이름 + 도메인)' },
                { v: 'dns', t: 'DNS 쿼리로 IP 고정', d: '지금 DNS(A 레코드)로 해석해 IP 로 못박음' },
              ].map((o) => (
                <label key={o.v} className={`tab ${spec.autoMode === o.v ? 'active' : ''}`} style={{ cursor: 'pointer' }} title={o.d}>
                  <input type="radio" name="autoMode" checked={spec.autoMode === o.v} onChange={() => setField({ autoMode: o.v })}
                    style={{ marginRight: 6 }} />
                  {o.t}
                </label>
              ))}
            </div>
            <label className="flex col" style={{ gap: 4, marginTop: 10, minWidth: 260, maxWidth: 360 }}>
              <span className="muted" style={{ fontSize: 11 }}>도메인 — <code>.</code> 으로 시작 (host = 이름 + 도메인)</span>
              <input className="input" value={spec.host.domain} onChange={(e) => setHost({ domain: e.target.value })}
                placeholder=".sbp.local" />
            </label>
            <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
              {spec.autoMode === 'dns'
                ? 'DNS 로 해석되지 않는 이름이 하나라도 있으면 전체를 등록하지 않습니다(감시 공백 방지).'
                : '이름 + 도메인을 host 로 저장하고, 실제 해석은 점검할 때 이뤄집니다.'}
            </div>
          </div>
        )}

        {/* 수동(호스트별 IP) */}
        {spec.addr === 'manual' && (
          <div style={{ marginTop: 12 }}>
            <div className="flex gap wrap" style={{ alignItems: 'center' }}>
              <button type="button" className="tab" disabled={busy === 'map-tpl'} onClick={downloadMapTemplate}>⤓ 템플릿(CSV)</button>
              <button type="button" className="tab" disabled={!canEdit || busy === 'map-imp'} onClick={() => mapFileRef.current?.click()}>
                {busy === 'map-imp' ? '읽는 중…' : '⤒ 가져오기 (CSV/JSON/XLSX)'}
              </button>
              <input ref={mapFileRef} type="file" accept={IMPORT_ACCEPT} style={{ display: 'none' }} onChange={onMapFile} />
              <button type="button" className="tab" disabled={!nameCount || busy === 'map-exp'} onClick={exportMap}>⤓ 현재 매핑 내보내기(CSV)</button>
              {nameCount > 0 && (
                <span className={`badge ${manualFilled === nameCount ? 'green' : 'amber'}`}>
                  IP 채움 {manualFilled} / {nameCount}
                </span>
              )}
            </div>
            {manualMsg && <div className="svc-ok" style={{ marginTop: 8 }}>{manualMsg}</div>}

            {nameCount === 0 ? (
              <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
                먼저 ② 이름 규칙에서 패턴·시작·끝 번호를 입력하면 호스트 목록이 생기고, 각 호스트에 IP 를 지정할 수 있습니다.
              </div>
            ) : nameCount > MANUAL_RENDER_CAP ? (
              <div className="svc-warn" style={{ marginTop: 10 }}>
                호스트가 {nameCount.toLocaleString()}개로 많습니다 — 화면 입력 대신 <b>템플릿을 내려받아 IP 를 채운 뒤 가져오기</b>를
                사용하세요(화면 표는 {MANUAL_RENDER_CAP}개까지만 그립니다). 가져온 매핑은 이름으로 대상과 연결됩니다.
              </div>
            ) : (
              <div className="table-wrap" style={{ maxHeight: '38vh', marginTop: 10 }}>
                <table>
                  <thead><tr><th style={{ width: 60 }}>#</th><th>호스트 이름</th><th style={{ width: 220 }}>IP 주소</th></tr></thead>
                  <tbody>
                    {names.map((n, i) => (
                      <tr key={n}>
                        <td className="muted">{i + 1}</td>
                        <td><code style={{ fontSize: 12 }}>{n}</code></td>
                        <td>
                          <input className="input" style={{ width: '100%', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
                            value={manualIps[n] || ''} placeholder="10.20.30.41"
                            onChange={(e) => { setManualIps({ ...manualIps, [n]: e.target.value }); setPreview(null); }} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ④ 점검 */}
      <div className="card" style={{ padding: 14 }}>
        <b>④ 어떤 점검을 넣을까요</b>
        <div className="flex gap wrap" style={{ alignItems: 'flex-end', marginTop: 10 }}>
          <label className="flex col" style={{ gap: 4, minWidth: 260 }}>
            <span className="muted" style={{ fontSize: 11 }}>점검 템플릿</span>
            <select className="select" value={spec.templateId} onChange={(e) => setField({ templateId: e.target.value })}>
              <option value="">(점검 없이 대상만 등록)</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>{t.name} — 항목 {(t.items || []).length}개</option>
              ))}
            </select>
          </label>
          <label className="flex col" style={{ gap: 4 }}>
            <span className="muted" style={{ fontSize: 11 }}>등록 직후 상태</span>
            <select className="select" value={spec.enabled ? '1' : '0'} onChange={(e) => setField({ enabled: e.target.value === '1' })}>
              <option value="0">중지 (권장)</option>
              <option value="1">바로 사용</option>
            </select>
          </label>
          <label className="flex col" style={{ gap: 4 }}>
            <span className="muted" style={{ fontSize: 11 }}>이미 있는 이름</span>
            <select className="select" value={spec.onDuplicate} onChange={(e) => setField({ onDuplicate: e.target.value })}>
              <option value="skip">건너뛰기</option>
              <option value="error">오류로 중단</option>
            </select>
          </label>
        </div>
        {tpl && (
          <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            {tpl.name}: {(tpl.items || []).map((x) => `${x.type}${x.port ? `:${x.port}` : ''}`).join(', ')}
            {' · '}대상당 점검 {itemCount}개
            {nameCount > 0 ? ` → 총 ${itemCount * nameCount}개` : ''}
          </div>
        )}
        {spec.enabled && (
          <div className="svc-warn">
            바로 사용으로 등록하면 즉시 점검이 시작됩니다. 주소·개수를 잘못 넣었을 때 실제 트래픽이 나가므로
            '중지'로 만들어 확인한 뒤 켜는 편이 안전합니다.
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
          <button className="tab" onClick={reset}>초기화</button>
        </div>
      </div>

      {preview?.suggest?.count ? (
        <div className="svc-warn">
          개수가 맞지 않습니다. IP 수({preview.suggest.count})에 맞추겠습니까?{' '}
          <button className="tab" onClick={() => { setName({ end: (Number(spec.name.start) || 1) + preview.suggest.count - 1 }); setPreview(null); }}>
            끝 번호를 {(Number(spec.name.start) || 1) + preview.suggest.count - 1}로 맞추기
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
                  <td>{b.source === 'generate' ? '대량등록' : b.source === 'import' ? '가져오기' : b.source}</td>
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
