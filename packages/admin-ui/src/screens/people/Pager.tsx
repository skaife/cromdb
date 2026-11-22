// Previous and Next under a list of people, with where the list is.

export function Pager({
  number,
  shown,
  size,
  order,
  previous,
  next,
}: {
  number: number;
  shown: number;
  size: number;
  order: string;
  previous: (() => void) | undefined;
  next: (() => void) | undefined;
}) {
  return (
    <nav className="pager small" aria-label="Pages">
      <span className="muted">
        Page {number} · {shown} shown · {size} per page · {order}
      </span>
      <span className="pager-buttons">
        <button type="button" className="button small-button" disabled={previous === undefined} onClick={previous}>
          Previous page
        </button>
        <button type="button" className="button small-button" disabled={next === undefined} onClick={next}>
          Next page
        </button>
      </span>
    </nav>
  );
}
