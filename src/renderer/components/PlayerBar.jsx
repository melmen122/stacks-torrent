import { useState } from 'react';
import { usePlayer } from '../context/PlayerContext.jsx';
import { formatClock } from '../utils/format.js';
import { mediaUrl } from '../utils/media.js';
import { gradientFor, initialsFor } from '../utils/color.js';
import {
  IconPlay,
  IconPause,
  IconPrevTrack,
  IconNextTrack,
  IconRewind,
  IconFastForward,
  IconVolume,
  IconClose,
  IconChapters,
} from './icons.jsx';
import ChapterMenu from './ChapterMenu.jsx';

export default function PlayerBar() {
  const player = usePlayer();
  const { book } = player;
  const [chaptersOpen, setChaptersOpen] = useState(false);
  if (!book) return null;

  const fileCount = book.files?.length || 0;
  const canPrev = player.fileIndex > 0;
  const canNext = player.fileIndex < fileCount - 1;

  return (
    <div className="player-bar">
      <div className="player-book">
        {book.coverPath ? (
          <img src={mediaUrl(book.coverPath)} alt="" className="player-cover" />
        ) : (
          <div
            className="player-cover player-cover-placeholder"
            style={{ background: gradientFor(`${book.title || ''}${book.author || ''}`) }}
          >
            <span>{initialsFor(book.title)}</span>
          </div>
        )}
        <div className="player-meta">
          <div className="player-title" title={book.title}>{book.title}</div>
          <div className="player-author">
            {book.author}
            {fileCount > 1 && (
              <span className="player-file-index"> · File {player.fileIndex + 1} of {fileCount}</span>
            )}
          </div>
        </div>
      </div>

      <div className="player-controls">
        <div className="player-buttons">
          <button
            type="button"
            className="icon-button"
            title="Previous file"
            aria-label="Previous file"
            disabled={!canPrev}
            onClick={player.prevFile}
          >
            <IconPrevTrack />
          </button>
          <button
            type="button"
            className="icon-button skip-btn"
            title="Back 30 seconds"
            aria-label="Back 30 seconds"
            onClick={() => player.skip(-30)}
          >
            <IconRewind />
            <span className="skip-btn-label">30</span>
          </button>
          <button
            type="button"
            className="icon-button icon-button-lg"
            title={player.isPlaying ? 'Pause' : 'Play'}
            aria-label={player.isPlaying ? 'Pause' : 'Play'}
            onClick={player.togglePlay}
          >
            {player.isPlaying ? <IconPause /> : <IconPlay />}
          </button>
          <button
            type="button"
            className="icon-button skip-btn"
            title="Forward 30 seconds"
            aria-label="Forward 30 seconds"
            onClick={() => player.skip(30)}
          >
            <IconFastForward />
            <span className="skip-btn-label">30</span>
          </button>
          <button
            type="button"
            className="icon-button"
            title="Next file"
            aria-label="Next file"
            disabled={!canNext}
            onClick={player.nextFile}
          >
            <IconNextTrack />
          </button>
        </div>

        <div className="player-seek">
          <span className="player-time">{formatClock(player.currentTime)}</span>
          <input
            type="range"
            aria-label="Seek"
            min={0}
            max={player.duration || 0}
            step={1}
            value={Math.min(player.currentTime, player.duration || 0)}
            onChange={(e) => player.seekTo(Number(e.target.value))}
            className="seek-slider"
          />
          <span className="player-time">{formatClock(player.duration)}</span>
        </div>
      </div>

      <div className="player-side">
        <div className="chapter-trigger">
          <button
            type="button"
            className="icon-button"
            title="Chapters"
            aria-label="Chapters"
            aria-haspopup="menu"
            aria-expanded={chaptersOpen}
            onClick={() => setChaptersOpen((o) => !o)}
          >
            <IconChapters />
          </button>
          {chaptersOpen && (
            <ChapterMenu
              chapters={player.chapters}
              activeIndex={player.activeChapterIndex}
              onSelect={(chapter) => player.jumpToChapter(chapter)}
              onClose={() => setChaptersOpen(false)}
            />
          )}
        </div>
        <IconVolume />
        <input
          type="range"
          aria-label="Volume"
          min={0}
          max={1}
          step={0.01}
          value={player.volume}
          onChange={(e) => player.setVolume(Number(e.target.value))}
          className="volume-slider"
        />
        <button
          type="button"
          className="icon-button"
          title="Close player"
          aria-label="Close player"
          onClick={player.closePlayer}
        >
          <IconClose />
        </button>
      </div>
    </div>
  );
}
