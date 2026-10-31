/**
 * 백업 서머리 · 백업 세부내용 공용 범위 옵션(v2.780 — 사용자 요청 '켜져있는 VM 과 꺼져있는 VM 선택하는 옵션' + 제안 4개 중 선택분).
 * 전원(전체·켜짐·꺼짐) · 템플릿·vCLS 제외 · 오래된 백업 기준(일). 값은 backupViewText.js loadOpts/saveOpts 로 두 화면이 함께 기억한다.
 */
import React from 'react';
import Select from '../../components/Select.jsx';
import { POWER, RPO_DAYS } from './backupViewText.js';

export default function BackupOptions({ opts, onChange, disabled }) {
  const set = (patch) => onChange({ ...opts, ...patch });
  return (
    <div className="flex gap wrap" data-backup-opts="" style={{ alignItems: 'center', rowGap: 6, fontSize: 12 }}>
      <div className="flex wrap" role="group" aria-label="전원" style={{ gap: 4 }}>
        {POWER.map(([k, label]) => (
          <button key={k} type="button" className={`tab${opts.power === k ? ' active' : ''}`} aria-pressed={opts.power === k} disabled={disabled}
            onClick={() => set({ power: k })} style={{ padding: '4px 12px', fontSize: 12 }}>{label}</button>
        ))}
      </div>
      <label className="flex" style={{ gap: 6, alignItems: 'center', whiteSpace: 'nowrap', cursor: 'pointer' }} title="템플릿과 vCLS(클러스터 서비스 VM)는 백업 대상이 아니라 비율을 낮춥니다">
        <input type="checkbox" checked={opts.excl !== false} disabled={disabled} onChange={(e) => set({ excl: e.target.checked })} />
        템플릿·vCLS 제외
      </label>
      <label className="flex" style={{ gap: 6, alignItems: 'center', whiteSpace: 'nowrap' }} title="마지막 성공 백업(Veeam · Bareos)이 이 기간보다 오래된 VM 을 RPO 미달로 셉니다(백업 안함 정책 제외)">
        RPO 기준
        <Select className="input" sort={false} value={opts.rpoDays} onChange={(e) => set({ rpoDays: Number(e.target.value) })} aria-label="RPO 기준" style={{ fontSize: 12, padding: '3px 6px', minWidth: 0, width: 'auto' }}>
          {RPO_DAYS.map((d) => <option key={d} value={d}>{d === 1 ? '24시간' : `${d}일`}</option>)}
        </Select>
      </label>
    </div>
  );
}
