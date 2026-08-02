import { useEffect, useRef, useState } from 'react';
import { api, HAS_API } from '../api.js';
import { useLibrary } from '../context/LibraryContext.jsx';
import { useToast } from '../context/ToastContext.jsx';

// Native file drags carry a 'Files' entry in dataTransfer.types; drags that
// originate from *inside* the app (e.g. selecting and dragging text in an
// input) don't, so this is what lets us ignore those.
function isFileDrag(dataTransfer) {
  return !!dataTransfer && Array.from(dataTransfer.types || []).includes('Files');
}

export default function DropImportOverlay() {
  const { importPaths } = useLibrary();
  const { push } = useToast();
  const [dragActive, setDragActive] = useState(false);
  const [importing, setImporting] = useState(false);
  const depthRef = useRef(0);
  // Mirrors `importing` state but readable synchronously inside the drop
  // handler (state updates aren't visible until the next render), so a
  // second drop while a big-folder scan is still running gets ignored
  // instead of kicking off a duplicate import.
  const importingRef = useRef(false);

  useEffect(() => {
    if (!HAS_API) return undefined; // no window.api — nothing we can safely import

    const onDragEnter = (e) => {
      if (!isFileDrag(e.dataTransfer)) return;
      e.preventDefault();
      depthRef.current += 1;
      setDragActive(true);
    };

    const onDragOver = (e) => {
      if (!isFileDrag(e.dataTransfer)) return;
      e.preventDefault();
    };

    const onDragLeave = (e) => {
      if (!isFileDrag(e.dataTransfer)) return;
      depthRef.current = Math.max(0, depthRef.current - 1);
      if (depthRef.current === 0) setDragActive(false);
    };

    const onDrop = async (e) => {
      if (!isFileDrag(e.dataTransfer)) return;
      e.preventDefault();
      depthRef.current = 0;
      setDragActive(false);

      // An import is already running (e.g. a large folder is still being
      // scanned) — ignore this drop rather than starting a second import
      // that would create duplicate books.
      if (importingRef.current) return;

      if (!api?.getPathForFile || !api?.libraryImportPaths) return;

      const files = Array.from(e.dataTransfer.files || []);
      const paths = files
        .map((file) => {
          try {
            return api.getPathForFile(file);
          } catch {
            return null;
          }
        })
        .filter(Boolean);

      if (paths.length === 0) {
        push('Nothing importable in that drop', { type: 'error' });
        return;
      }

      importingRef.current = true;
      setImporting(true);
      try {
        const result = await importPaths(paths);
        const addedCount = result?.added?.length || 0;
        if (addedCount > 0) {
          push(`Added ${addedCount} book${addedCount === 1 ? '' : 's'}`, { type: 'success' });
        } else {
          push('Nothing importable in that drop', { type: 'error' });
        }
      } catch (err) {
        push(err?.message || "Couldn't import that drop.", { type: 'error' });
      } finally {
        importingRef.current = false;
        setImporting(false);
      }
    };

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [importPaths, push]);

  if (!dragActive && !importing) return null;

  return (
    <div className="drop-overlay" role="presentation" aria-hidden="true">
      <div className={`drop-overlay-card ${importing ? 'importing' : ''}`}>
        <div className="drop-overlay-icon">{importing ? '⏳' : '📥'}</div>
        <div className="drop-overlay-text">
          {importing ? 'Importing… this can take a while for large folders' : 'Drop audiobooks to import'}
        </div>
      </div>
    </div>
  );
}
