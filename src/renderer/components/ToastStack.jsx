import { useToast } from '../context/ToastContext.jsx';

export default function ToastStack() {
  const { toasts, dismiss } = useToast();
  if (toasts.length === 0) return null;

  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast toast-${t.type}`}
          onClick={() => dismiss(t.id)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') dismiss(t.id); }}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
