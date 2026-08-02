import { IconSearch } from './icons.jsx';

export default function Toolbar({ searchTerm, onSearchChange, sortBy, onSortChange, onImport, importing, onAddTorrent }) {
  return (
    <div className="toolbar">
      <div className="toolbar-search">
        <IconSearch />
        <input
          type="text"
          aria-label="Search library"
          placeholder="Search title or author…"
          value={searchTerm}
          onChange={(e) => onSearchChange(e.target.value)}
        />
      </div>

      <select
        className="toolbar-sort"
        value={sortBy}
        onChange={(e) => onSortChange(e.target.value)}
        aria-label="Sort books"
      >
        <option value="recent">Recently added</option>
        <option value="title">Title A–Z</option>
        <option value="author">Author A–Z</option>
      </select>

      <div className="toolbar-spacer" />

      <button type="button" className="btn btn-ghost" onClick={onImport} disabled={importing}>
        {importing ? 'Importing…' : 'Import books…'}
      </button>
      <button type="button" className="btn btn-primary" onClick={onAddTorrent}>
        Add torrent
      </button>
    </div>
  );
}
