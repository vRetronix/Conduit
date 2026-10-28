import { useState } from 'react';

/** Rows shown per page in the logs. */
export const LOG_PAGE_SIZE = 5;

/**
 * One page of a list. The page stays put while the list refreshes, and moves back if the list gets shorter than it.
 */
export function usePaged<T>(items: readonly T[], size = LOG_PAGE_SIZE) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(page, pages - 1);
  return { rows: items.slice(current * size, current * size + size), page: current, pages, total: items.length, size, setPage };
}

/** Page numbers to show: the first, the last and the ones around the current page; null marks a gap. */
export function pageNumbers(page: number, pages: number): Array<number | null> {
  const keep = new Set([0, pages - 1, page - 1, page, page + 1].filter((p) => p >= 0 && p < pages));
  const out: Array<number | null> = [];
  let last = -1;
  for (const p of [...keep].sort((a, b) => a - b)) {
    if (p - last > 1) out.push(null);
    out.push(p);
    last = p;
  }
  return out;
}

/** Previous / page numbers / Next under a log, with which rows are shown. Nothing when everything fits on one page. */
export function Pager({ page, pages, total, size, setPage, label }: { page: number; pages: number; total: number; size: number; setPage: (p: number) => void; label: string }) {
  if (pages <= 1) return null;
  const from = page * size + 1;
  const to = Math.min(total, from + size - 1);
  return (
    <nav className="pager" aria-label={`${label} pages`}>
      <span className="muted small">
        {from}–{to} of {total.toLocaleString('en-US')}
      </span>
      <div className="pager-buttons">
        <button type="button" className="pager-btn" disabled={page === 0} onClick={() => setPage(page - 1)} aria-label="Previous page">
          ‹ Prev
        </button>
        {pageNumbers(page, pages).map((p, i) =>
          p === null ? (
            <span key={`gap-${i}`} className="pager-gap" aria-hidden="true">
              …
            </span>
          ) : (
            <button
              key={p}
              type="button"
              className={`pager-btn${p === page ? ' active' : ''}`}
              aria-current={p === page ? 'page' : undefined}
              aria-label={`Page ${p + 1}`}
              onClick={() => setPage(p)}
            >
              {p + 1}
            </button>
          ),
        )}
        <button type="button" className="pager-btn" disabled={page === pages - 1} onClick={() => setPage(page + 1)} aria-label="Next page">
          Next ›
        </button>
      </div>
    </nav>
  );
}
