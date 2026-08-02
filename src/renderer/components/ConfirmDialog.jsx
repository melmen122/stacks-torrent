import { useState } from 'react';

/**
 * Modal confirmation dialog with an optional checkbox (used for
 * "also delete files" style confirmations). onConfirm receives the
 * checkbox's checked state.
 */
export default function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  checkboxLabel,
  onConfirm,
  onCancel,
}) {
  const [checked, setChecked] = useState(false);

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="dialog-card" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <h3 id="dialog-title">{title}</h3>
        {message && <p className="dialog-message">{message}</p>}
        {checkboxLabel && (
          <label className="dialog-checkbox">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
            />
            {checkboxLabel}
          </label>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
            onClick={() => onConfirm(checked)}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
