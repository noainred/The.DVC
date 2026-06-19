import { useEffect } from 'react';

/**
 * Renders nothing; while mounted, pressing ESC calls onClose. Drop this inside
 * any modal/popup so the Escape key closes it. Mounts/unmounts with the modal,
 * so the listener is active only while the popup is open.
 */
export default function EscClose({ onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose?.(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return null;
}
