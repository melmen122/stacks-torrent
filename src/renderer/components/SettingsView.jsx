import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useToast } from '../context/ToastContext.jsx';
import { useVirusTotal } from '../context/VirusTotalContext.jsx';

export default function SettingsView() {
  const { push } = useToast();
  const virusTotal = useVirusTotal();
  const [downloadDir, setDownloadDir] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [isDefaultMagnet, setIsDefaultMagnet] = useState(null); // null = unknown/unsupported
  const [magnetLoading, setMagnetLoading] = useState(true);
  const [magnetBusy, setMagnetBusy] = useState(false);

  const [vtKeyInput, setVtKeyInput] = useState('');
  const [vtBusy, setVtBusy] = useState(false);

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

  const saveVtKey = async () => {
    const trimmed = vtKeyInput.trim();
    if (!trimmed || vtBusy) return;
    setVtBusy(true);
    try {
      const result = await virusTotal.setKey(trimmed);
      if (result?.ok && result?.valid) {
        setVtKeyInput(''); // never keep the key sitting in the input after it's saved
        push('VirusTotal key saved — scanning enabled', { type: 'success' });
      } else {
        push(result?.reason || "That key couldn't be verified — double-check it and try again.", { type: 'error' });
      }
    } catch (err) {
      push(err?.message || "Couldn't save that key.", { type: 'error' });
    } finally {
      setVtBusy(false);
    }
  };

  const clearVtKey = async () => {
    if (vtBusy) return;
    setVtBusy(true);
    try {
      await virusTotal.setKey(null);
      setVtKeyInput('');
      push('VirusTotal key cleared — scanning disabled', { type: 'info' });
    } catch (err) {
      push(err?.message || "Couldn't clear the key.", { type: 'error' });
    } finally {
      setVtBusy(false);
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

      <section className="settings-section">
        <h2 className="settings-section-title">Virus scanning (VirusTotal)</h2>

        <div className="settings-row">
          <div className="settings-row-text">
            <div className="settings-row-label">Status</div>
            <div
              className={`settings-row-value ${
                virusTotal.settingsLoading
                  ? ''
                  : virusTotal.settings.hasKey && virusTotal.settings.enabled
                    ? 'settings-status-ok'
                    : 'settings-status-warn'
              }`}
            >
              {virusTotal.settingsLoading
                ? 'Loading…'
                : virusTotal.settings.hasKey
                  ? (virusTotal.settings.enabled ? 'Key saved ✓ — scanning enabled' : 'Key saved, scanning is off')
                  : 'No key set — scanning disabled'}
            </div>
          </div>
        </div>

        <div className="vt-key-row">
          <input
            type="password"
            aria-label="VirusTotal API key"
            placeholder={virusTotal.settings.hasKey ? 'Key saved — paste a new key to replace it' : 'Paste your VirusTotal API key'}
            value={vtKeyInput}
            onChange={(e) => setVtKeyInput(e.target.value)}
            autoComplete="off"
            disabled={vtBusy}
          />
          <button
            type="button"
            className="btn btn-primary"
            onClick={saveVtKey}
            disabled={vtBusy || !vtKeyInput.trim() || !api?.virusTotalSetKey}
          >
            Save
          </button>
          {virusTotal.settings.hasKey && (
            <button type="button" className="btn btn-ghost" onClick={clearVtKey} disabled={vtBusy}>
              Clear key
            </button>
          )}
        </div>

        <p className="settings-caption">
          Don&rsquo;t have a key? VirusTotal gives out free API keys — create an account at{' '}
          <strong>virustotal.com</strong> and copy the key from your profile page, then paste
          it above. (This app won&rsquo;t open the site for you — copy the address yourself.)
        </p>

        <p className="settings-caption">
          Scans run <strong>after</strong> a book finishes downloading, once files already
          exist on disk — VirusTotal cannot inspect anything before that. Only file{' '}
          <strong>hashes</strong> are sent, never file contents; this is the only feature in
          this app that contacts an external service. The free tier is rate-limited, so large
          libraries scan slowly in the background. A result of &ldquo;unknown&rdquo; means
          VirusTotal has no record of that file — it is <strong>not</strong> the same as
          &ldquo;clean.&rdquo; This complements but does not replace your operating system's
          antivirus. Your key is stored locally in plain text on this computer.
        </p>
      </section>
    </div>
  );
}
