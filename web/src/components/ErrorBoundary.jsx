import React from 'react';
import { isChunkLoadError, reloadOnChunkError } from '../chunkReload.js';
import { staleNow, checkServerVersion } from '../upgradeNotice.js';
import UpgradeNotice from './UpgradeNotice.jsx';

/**
 * Catches render/runtime errors in its subtree so a single broken component
 * never blanks the whole portal. Shows a small fallback (or a custom one).
 *
 * v2.999(사용자 요청 2026-11-13 · 설계 docs/design/upgrade-reload): 오류를 잡았을 때 **이 창의 판 ≠ 서버의 판**(upgradeNotice.staleNow)이거나
 * 화면 조각을 못 받은 오류(chunkReload — v2.977)면 '프로그램이 업그레이드되었으니 새로고침 하세요' 상자(UpgradeNotice)를 그린다 — fallback 보다 먼저.
 * 판이 같으면 예전 그대로(오류 원문 + 다시 시도 / 호출부 fallback). 폴링 사이에 업그레이드됐을 수 있어 잡은 순간 서버 판을 한 번 더 읽는다.
 * `upgradeClassName` — 상자를 감쌀 클래스(포탈 전체 경계는 'login-screen' 으로 가운데에).
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, upgrade: false };
    this._alive = false;
  }

  static getDerivedStateFromError(error) {
    return { error, upgrade: isChunkLoadError(error) || staleNow() };
  }

  componentDidMount() { this._alive = true; }
  componentWillUnmount() { this._alive = false; }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', error, info?.componentStack);
    // v2.977: 업그레이드 뒤 옛 화면 조각 404 — 한 번 새로 읽는다(60초에 한 번 · chunkReload.js)
    reloadOnChunkError(error);
    // v2.999: 아직 같은 판으로 알고 있으면 서버 판을 한 번 더 읽는다 — 다르면 업그레이드 안내로 바꾼다(같은 오류일 때만)
    if (!isChunkLoadError(error) && !staleNow()) {
      checkServerVersion().then((stale) => {
        if (stale && this._alive && this.state.error === error) this.setState({ upgrade: true });
      });
    }
  }

  render() {
    if (this.state.error) {
      if (this.state.upgrade) {
        // React.lazy 는 실패한 약속을 기억한다 — '다시 시도' 로는 풀리지 않으므로 새로고침을 준다(v2.977) · 판이 다를 때도 같은 상자(v2.999)
        const box = <UpgradeNotice />;
        return this.props.upgradeClassName ? <div className={this.props.upgradeClassName}>{box}</div> : box;
      }
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="error-box" style={{ padding: 24 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>이 영역을 표시하는 중 오류가 발생했습니다.</div>
          <div className="muted" style={{ fontSize: 12, wordBreak: 'break-all' }}>{String(this.state.error?.message || this.state.error)}</div>
          <button className="login-btn" style={{ flex: 'none', padding: '8px 16px', marginTop: 12 }}
            onClick={() => this.setState({ error: null, upgrade: false })}>다시 시도</button>
        </div>
      );
    }
    return this.props.children;
  }
}
