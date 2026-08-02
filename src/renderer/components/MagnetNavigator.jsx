import { useCallback, useEffect, useRef } from 'react';
import { api, HAS_API } from '../api.js';
import { useToast } from '../context/ToastContext.jsx';

// Ignore a repeat delivery of the same magnet within this window — the
// cold-start pull (systemConsumePendingMagnet) and a late warm-path push
// (onMagnetReceived) can both deliver the same magnet once.
const DEDUPE_WINDOW_MS = 2000;

/**
 * Non-visual component: when the main process receives a magnet link (OS
 * "open with" / second-instance argv / macOS open-url — see docs/PLAN3.md)
 * it forwards `{ magnet }` (or `{ magnet, error }` on failure) via the
 * `system:magnet-received` event. The actual torrent add already happened
 * in main; this just switches the renderer to the Downloads view and gives
 * the user feedback.
 *
 * Cold-start race: if the OS launches the app *by* the magnet click, main
 * may push `system:magnet-received` before this component's subscription
 * has attached, and the event is dropped. `systemConsumePendingMagnet` is
 * the pull-based complement — on mount we ask main "is there one queued?"
 * so we still navigate/toast even after missing the push.
 */
export default function MagnetNavigator({ onMagnet }) {
  const { push } = useToast();
  const lastHandledRef = useRef({ magnet: null, at: 0 });

  const handlePayload = useCallback((payload) => {
    const magnet = payload?.magnet;
    if (!magnet) return;

    const now = Date.now();
    const last = lastHandledRef.current;
    if (last.magnet === magnet && now - last.at < DEDUPE_WINDOW_MS) {
      return; // same magnet delivered twice (pull + late push) — already handled
    }
    lastHandledRef.current = { magnet, at: now };

    onMagnet?.();
    if (payload.error) {
      push(`Couldn't add magnet: ${payload.error}`, { type: 'error' });
    } else {
      push('Magnet added — downloading…', { type: 'success' });
    }
  }, [onMagnet, push]);

  useEffect(() => {
    if (!HAS_API) return undefined;

    // Cold start: pick up a magnet that arrived before we could subscribe.
    api?.systemConsumePendingMagnet?.()
      .then((payload) => { if (payload) handlePayload(payload); })
      .catch(() => {});

    // Warm path: app already open (second-instance / open-url while running).
    const unsubscribe = api?.onMagnetReceived?.((payload) => handlePayload(payload));
    return () => unsubscribe?.();
  }, [handlePayload]);

  return null;
}
