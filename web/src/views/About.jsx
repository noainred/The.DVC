import React from 'react';
import { usePolling } from '../api.js';

/** 설정 → About: 프로그램 정보 · 저작권 · 저작자. (브랜드 히어로 스타일) */
export default function About() {
  const { data: health } = usePolling('/health', {}, 60_000);
  const year = new Date().getFullYear();

  return (
    <>
      <div className="section-title" style={{ marginTop: 0 }}>ℹ️ About</div>

      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        {/* Hero 배너 */}
        <div style={{
          position: 'relative', overflow: 'hidden', borderRadius: 18, padding: '34px 28px 30px',
          background: 'radial-gradient(1200px 300px at 20% -40%, rgba(99,102,241,.55), transparent 60%), linear-gradient(135deg, #0b1220 0%, #131c33 50%, #1a1140 100%)',
          border: '1px solid rgba(129,140,248,.35)', boxShadow: '0 20px 60px -25px rgba(79,70,229,.6)',
        }}>
          <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(700px 200px at 90% 120%, rgba(34,211,238,.18), transparent 60%)' }} />
          <div style={{ position: 'relative' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <div style={{
                width: 64, height: 64, borderRadius: 16, display: 'grid', placeItems: 'center', fontSize: 34,
                background: 'linear-gradient(135deg, rgba(99,102,241,.9), rgba(34,211,238,.7))',
                boxShadow: '0 10px 30px -8px rgba(56,189,248,.7)',
              }}>🛰️</div>
              <div>
                <div style={{ fontSize: 24, fontWeight: 900, letterSpacing: '-.4px', lineHeight: 1.15,
                  background: 'linear-gradient(90deg,#e0e7ff,#a5f3fc)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
                  VMware Global Monitoring Portal
                </div>
                <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>The Davinci Virtual Platform · 전세계 분산 vCenter 통합 모니터링</div>
              </div>
            </div>
            <div style={{ marginTop: 16, fontSize: 16, fontWeight: 800, letterSpacing: '-.2px',
              background: 'linear-gradient(90deg,#fde68a,#fca5a5,#c4b5fd)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
              ⭐ 전세계 최고의 VMware 관리 솔루션 · World&apos;s Best VMware Management Solution
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 18 }}>
              <span style={chip('rgba(129,140,248,.18)', '#c7d2fe')}>v{health?.version || '—'}</span>
              <span style={chip('rgba(34,211,238,.16)', '#a5f3fc')}>Node · React · Vite</span>
              <span style={chip('rgba(52,211,153,.16)', '#a7f3d0')}>Enterprise Edition</span>
            </div>
          </div>
        </div>

        {/* 저작자 / 저작권 카드 */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: 14, marginTop: 16 }}>
          <div className="card" style={cardStyle}>
            <div className="muted" style={{ fontSize: 12, letterSpacing: '.5px', textTransform: 'uppercase' }}>저작자 · Author</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10 }}>
              <div style={{ width: 46, height: 46, borderRadius: '50%', display: 'grid', placeItems: 'center', fontWeight: 800, fontSize: 18,
                background: 'linear-gradient(135deg,#6366f1,#22d3ee)', color: '#0b1220' }}>박</div>
              <div>
                <div style={{ fontWeight: 800, fontSize: 17 }}>박준호 <span className="muted" style={{ fontWeight: 500, fontSize: 13 }}>(Park Junho)</span></div>
                <a href="mailto:noainred@lgcns.com" style={{ color: '#7dd3fc', fontSize: 13, textDecoration: 'none' }}>noainred@lgcns.com</a>
              </div>
            </div>
          </div>

          <div className="card" style={cardStyle}>
            <div className="muted" style={{ fontSize: 12, letterSpacing: '.5px', textTransform: 'uppercase' }}>저작권 · Copyright</div>
            <div style={{ fontSize: 22, fontWeight: 800, marginTop: 12 }}>© {year} 박준호</div>
            <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>All rights reserved.</div>
          </div>
        </div>

        {/* 주요 기능 */}
        <div className="card" style={{ ...cardStyle, marginTop: 14 }}>
          <div className="muted" style={{ fontSize: 12, letterSpacing: '.5px', textTransform: 'uppercase', marginBottom: 12 }}>주요 기능 · Key Features</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))', gap: 12 }}>
            {FEATURES.map((f) => (
              <div key={f.title} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                <div style={{ fontSize: 22, lineHeight: 1, flex: '0 0 auto', width: 30, textAlign: 'center' }}>{f.icon}</div>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>{f.title}</div>
                  <div className="muted" style={{ fontSize: 12.5, marginTop: 2, lineHeight: 1.5 }}>{f.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 라이선스 고지 */}
        <div className="card" style={{ ...cardStyle, marginTop: 14, borderLeft: '3px solid #818cf8' }}>
          <div className="muted" style={{ fontSize: 13, lineHeight: 1.9 }}>
            본 소프트웨어 <b style={{ color: 'var(--text)' }}>VMware Global Monitoring Portal</b> 의 모든 저작권은 저작권자
            <b style={{ color: 'var(--text)' }}> 박준호</b> 에게 있습니다. 저작권자의 사전 서면 동의 없이 본 프로그램의 전부 또는 일부를
            무단으로 복제·배포·수정·역설계할 수 없습니다.
            <div style={{ marginTop: 8, fontStyle: 'italic', opacity: .85 }}>
              Copyright © {year} 박준호 (Park Junho). All rights reserved. Unauthorized reproduction or distribution is prohibited.
            </div>
          </div>
        </div>

        <div className="muted" style={{ textAlign: 'center', fontSize: 12, marginTop: 18, opacity: .7 }}>
          Made with ❤ for global VMware operations · {year}
        </div>
      </div>
    </>
  );
}

const FEATURES = [
  { icon: '🌐', title: '글로벌 vCenter 통합 모니터링', desc: '전세계 분산 vCenter(13→30대 확장)의 호스트·VM·스토리지·네트워크·알람을 단일 화면에서 집계' },
  { icon: '🗺️', title: '세계 지도 · 리전 롤업 · 랭킹', desc: '사이트 상태 지도, 리전별 요약, CPU/메모리/스토리지 상위 소비 리소스 랭킹' },
  { icon: '🛡️', title: 'NSX 통합 모니터링', desc: 'NSX Manager의 T0/T1 게이트웨이·세그먼트·전송노드·분산방화벽(DFW) 수집' },
  { icon: '📒', title: '센터별 IP 관리대장', desc: '/24 엑셀형 대장, 공인/사설 분류, 무시 대역, 타 프로그램 공유용 SQLite' },
  { icon: '🖥️', title: 'VM 대량 생성', desc: '템플릿 클론으로 비슷한 VM 일괄 생성 + 게스트 hostname/IP 자동 지정' },
  { icon: '🔌', title: '원격 접속 (SSH/RDP)', desc: 'HAProxy 중계 경유 브라우저 SSH 터미널·웹 RDP, 세션 자동 만료' },
  { icon: '🔎', title: 'AI 자연어 검색', desc: '로컬 LLM(Ollama) 기반으로 VM·호스트·IP를 자연어로 검색' },
  { icon: '⚡', title: 'iDRAC/OME 전력 수집', desc: 'Dell 서버 실측 전력(Watts) 시계열 수집 + 호스트 매핑' },
  { icon: '🛰️', title: '분산 수집 · 자동 배포', desc: 'DC별 수집 에이전트 + SSH 자동 설치/업그레이드, 중앙 집계' },
  { icon: '🔐', title: 'AD 로그인 · Google OTP', desc: 'Active Directory 인증 + TOTP 2단계 인증, 사용자 관리' },
  { icon: '📦', title: '오프라인 설치 · 원격 업그레이드', desc: 'Rocky 9/Windows 에어갭 설치 패키지, SHA-256 검증 원격 업그레이드' },
  { icon: '🚀', title: '고지연·대규모 최적화', desc: 'per-vCenter 병렬+타임아웃, 논블로킹 수집/DB로 800ms+ RTT 환경 대응' },
];

const chip = (bg, color) => ({
  padding: '5px 12px', borderRadius: 999, fontSize: 12, fontWeight: 700,
  background: bg, color, border: `1px solid ${color}33`,
});
const cardStyle = { padding: '16px 18px', background: 'rgba(255,255,255,.02)' };
