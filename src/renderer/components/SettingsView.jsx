import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useToast } from '../context/ToastContext.jsx';
import { useVirusTotal } from '../context/VirusTotalContext.jsx';
import ConfirmDialog from './ConfirmDialog.jsx';

function phoneErrorMessage(error) {
  if (!error) return null;
  if (error === 'port_in_use') return "That port is already in use — try a different one.";
  if (error === 'invalid_port') return 'Pick a port between 1024 and 65535.';
  return `Something went wrong (${error}).`;
}

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

  const [phoneStatus, setPhoneStatus] = useState(null);
  const [phoneLoading, setPhoneLoading] = useState(true);
  const [enableBusy, setEnableBusy] = useState(false);
  const [portBusy, setPortBusy] = useState(false);
  const [pinBusy, setPinBusy] = useState(false);
  const [confirmingRegeneratePin, setConfirmingRegeneratePin] = useState(false);
  const [portDraft, setPortDraft] = useState('');
  const portEditingRef = useRef(false);

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

  useEffect(() => {
    let cancelled = false;
    if (!api?.phoneGetStatus) {
      setPhoneLoading(false);
      return undefined;
    }
    api.phoneGetStatus()
      .then((status) => {
        if (cancelled) return;
        setPhoneStatus(status);
        if (!portEditingRef.current) setPortDraft(String(status?.port ?? ''));
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setPhoneLoading(false);
      });
    const unsubscribe = api.onPhoneStatusChanged?.((status) => {
      setPhoneStatus(status);
      if (!portEditingRef.current) setPortDraft(String(status?.port ?? ''));
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  const togglePhoneEnabled = async () => {
    if (!api?.phoneSetEnabled || enableBusy || !phoneStatus) return;
    const next = !phoneStatus.enabled;
    setEnableBusy(true);
    try {
      const status = await api.phoneSetEnabled(next);
      setPhoneStatus(status);
      push(next ? 'Phone access enabled' : 'Phone access disabled', { type: next ? 'success' : 'info' });
    } catch (err) {
      push(err?.message || "Couldn't change phone access.", { type: 'error' });
    } finally {
      setEnableBusy(false);
    }
  };

  const savePhonePort = async () => {
    if (!api?.phoneSetPort || portBusy) return;
    const port = Number(portDraft);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      push('Enter a port between 1024 and 65535.', { type: 'error' });
      return;
    }
    setPortBusy(true);
    try {
      const status = await api.phoneSetPort(port);
      setPhoneStatus(status);
      portEditingRef.current = false;
      setPortDraft(String(status?.port ?? port));
      if (status?.error) {
        push(phoneErrorMessage(status.error), { type: 'error' });
      } else {
        push('Port updated', { type: 'success' });
      }
    } catch (err) {
      push(err?.message || "That port couldn't be used — try another.", { type: 'error' });
    } finally {
      setPortBusy(false);
    }
  };

  const regeneratePhonePin = async () => {
    if (!api?.phoneRegeneratePin) return;
    setConfirmingRegeneratePin(false);
    setPinBusy(true);
    try {
      const status = await api.phoneRegeneratePin();
      setPhoneStatus(status);
      push('New code generated — phones will need to sign in again', { type: 'success' });
    } catch (err) {
      push(err?.message || "Couldn't generate a new code.", { type: 'error' });
    } finally {
      setPinBusy(false);
    }
  };

  const copyPhoneUrl = async (url) => {
    try {
      await navigator.clipboard.writeText(url);
      push('Address copied', { type: 'success' });
    } catch {
      push("Couldn't copy — copy the address manually.", { type: 'error' });
    }
  };

  const portDirty = phoneStatus && portDraft !== String(phoneStatus.port);
  const phoneLive = !!phoneStatus?.enabled && !!phoneStatus?.running && !phoneStatus?.error;

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

      <section className="settings-section">
        <h2 className="settings-section-title">Listen on your phone</h2>

        <div className="settings-row">
          <div className="settings-row-text">
            <div className="settings-row-label">Phone access</div>
            <div
              className={`settings-row-value ${
                phoneLoading
                  ? ''
                  : phoneStatus?.error
                    ? 'settings-status-warn'
                    : phoneLive
                      ? 'settings-status-ok'
                      : ''
              }`}
            >
              {phoneLoading
                ? 'Loading…'
                : !phoneStatus
                  ? 'Unavailable'
                  : phoneStatus.error
                    ? phoneErrorMessage(phoneStatus.error)
                    : !phoneStatus.enabled
                      ? 'Disabled'
                      : phoneStatus.running
                        ? 'Enabled — running'
                        : 'Enabled — starting…'}
            </div>
          </div>
          <label className="settings-toggle" aria-label="Enable phone access">
            <input
              type="checkbox"
              checked={!!phoneStatus?.enabled}
              onChange={togglePhoneEnabled}
              disabled={enableBusy || phoneLoading || !phoneStatus || !api?.phoneSetEnabled}
            />
            <span className="settings-toggle-track" aria-hidden="true">
              <span className="settings-toggle-thumb" />
            </span>
          </label>
        </div>

        <div className="settings-row">
          <div className="settings-row-text">
            <div className="settings-row-label">Port</div>
            <div className="settings-row-value">Used for the addresses below on your home network.</div>
          </div>
        </div>
        <div className="vt-key-row">
          <input
            type="number"
            inputMode="numeric"
            aria-label="Phone server port"
            min={1024}
            max={65535}
            value={portDraft}
            onFocus={() => { portEditingRef.current = true; }}
            onChange={(e) => setPortDraft(e.target.value)}
            disabled={portBusy || phoneLoading || !phoneStatus}
          />
          <button
            type="button"
            className="btn btn-ghost"
            onClick={savePhonePort}
            disabled={portBusy || phoneLoading || !phoneStatus || !portDirty || !api?.phoneSetPort}
          >
            Save
          </button>
        </div>

        {phoneLive && phoneStatus?.pin && (
          <div className="settings-row">
            <div className="settings-row-text">
              <div className="settings-row-label">Sign-in code</div>
              <div className="settings-row-value phone-pin">{phoneStatus.pin}</div>
            </div>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setConfirmingRegeneratePin(true)}
              disabled={pinBusy || !api?.phoneRegeneratePin}
            >
              Generate new code
            </button>
          </div>
        )}

        {phoneLive && Array.isArray(phoneStatus?.urls) && phoneStatus.urls.length > 0 && (
          <ul className="phone-url-list">
            {phoneStatus.urls.map((entry) => (
              <li key={entry.url} className="phone-url-row">
                <div className="phone-url-text">
                  <div className="phone-url-label">{entry.label}</div>
                  <div className="phone-url-value">{entry.url}</div>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => copyPhoneUrl(entry.url)}
                >
                  Copy
                </button>
              </li>
            ))}
          </ul>
        )}

        <p className="settings-caption">
          Enter the sign-in code on your iPhone or iPad in Safari, then open the address that
          matches your network — the home-network address only works on the same Wi-Fi, while a
          Tailscale address works from anywhere your device is signed into your tailnet. For the
          best experience, add the page to your home screen from Safari's share menu.
        </p>
      </section>

      {confirmingRegeneratePin && (
        <ConfirmDialog
          title="Generate a new sign-in code?"
          message="Any phones already signed in will be signed out and need the new code to reconnect."
          confirmLabel="Generate new code"
          danger
          onCancel={() => setConfirmingRegeneratePin(false)}
          onConfirm={regeneratePhonePin}
        />
      )}
    </div>
  );
}
