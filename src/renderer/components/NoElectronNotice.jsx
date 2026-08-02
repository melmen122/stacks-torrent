export default function NoElectronNotice() {
  return (
    <div className="no-electron-notice">
      <div className="no-electron-card">
        <div className="no-electron-icon">🎧</div>
        <h1>Run inside Electron</h1>
        <p>
          This app talks to your file system and torrent engine through the Electron desktop
          shell, which isn&rsquo;t present in a plain browser tab. Start the app with its{' '}
          <code>dev</code> script (Electron + Vite together) instead of opening this page
          directly.
        </p>
      </div>
    </div>
  );
}
