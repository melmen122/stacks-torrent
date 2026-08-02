import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useToast } from '../context/ToastContext.jsx';

export default function SettingsView() {
  const { push } = useToast();
  const [downloadDir, setDownloadDir] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [isDefaultMagnet, setIsDefaultMagnet] = useState(null); // null = unknown/unsupported
  const [magnetLoading, setMagnetLoading] = useState(true);
  const [magnetBusy, setMagnetBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!api?.settingsGet) {
      setLoading(false);
      return undefined;
    }
    api.settingsGet()
      .then((settings) => {
        if (!cancelled) setDownloadDir(settings?.downloadDir ?? null);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!api?.systemIsDefaultMagnetHandler) {
      setMagnetLoading(false);
      return undefined;
    }
    api.systemIsDefaultMagnetHandler()
      .then((result) => {
        if (!cancelled) setIsDefaultMagnet(!!result);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setMagnetLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const changeDownloadDir = async () => {
    if (!api?.settingsChooseDownloadDir || busy) return;
    setBusy(true);
    try {
      const settings = await api.settingsChooseDownloadDir();
      if (settings) {
        // A folder was actually picked — refresh the shown value and confirm.
        setDownloadDir(settings.downloadDir ?? null);
        push('Download folder updated', { type: 'success' });
      }
      // settings === null means the user canceled the native dialog — no toast.
    } catch (err) {
      push(err?.message || "Couldn't change the download folder.", { type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const makeDefaultMagnetHandler = async () => {
    if (!api?.systemSetDefaultMagnetHandler || magnetBusy) return;
    setMagnetBusy(true);
    try {
      const result = await api.systemSetDefaultMagnetHandler();
      const nowDefault = !!result?.isDefault;
      setIsDefaultMagnet(nowDefault);
      if (result?.ok && nowDefault) {
        push('Set as default magnet handler', { type: 'success' });
      } else if (result?.ok) {
        // Registration succeeded but the OS hasn't confirmed it as default yet
        // (e.g. macOS requires a one-time user confirmation prompt).
        push('Requested — you may need to confirm in your browser/OS', { type: 'info' });
      } else {
        push("Couldn't set Audiobook Library as the default magnet handler.", { type: 'error' });
      }
    } catch (err) {
      push(err?.message || "Couldn't set the default magnet handler.", { type: 'error' });
    } finally {
      setMagnetBusy(false);
    }
  };

  return (
    <div className="settings-view">
      <h1 className="view-title">Settings</h1>

      <section className="settings-section">
        <h2 className="settings-section-title">Downloads</h2>

        <div className="settings-row">
          <div className="settings-row-text">
            <div className="settings-row-label">Download folder</div>
            <div className="settings-row-value">
              {loading ? 'Loading…' : (downloadDir || 'Default location')}
            </div>
          </div>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={changeDownloadDir}
            disabled={busy || loading}
          >
            Change…
          </button>
        </div>

        <p className="settings-caption">
          Existing and in-progress downloads keep using their original folder — only new
          torrents added after the change use the updated location.
        </p>
      </section>

      <section className="settings-section">
        <h2 className="settings-section-title">Magnet links</h2>

        <div className="settings-row">
          <div className="settings-row-text">
            <div className="settings-row-label">Default magnet handler</div>
            <div
              className={`settings-row-value ${
                magnetLoading ? '' : isDefaultMagnet ? 'settings-status-ok' : 'settings-status-warn'
              }`}
            >
              {magnetLoading
                ? 'Checking…'
                : isDefaultMagnet
                  ? 'Audiobook Library is your default magnet app ✓'
                  : 'Not the default'}
            </div>
          </div>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={makeDefaultMagnetHandler}
            disabled={magnetBusy || magnetLoading || !api?.systemSetDefaultMagnetHandler}
          >
            Make default
          </button>
        </div>

        <p className="settings-caption">
          On macOS you may still be prompted by your browser or the OS to confirm this the
          first time you click a magnet link. If another app (e.g. uTorrent) is currently the
          default, you may also need to change it in that app&rsquo;s own settings.
        </p>
      </section>
    </div>
  );
}
