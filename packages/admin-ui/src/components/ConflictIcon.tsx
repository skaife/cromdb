// Two overlapping pages with a mark: a document in conflict. Named for
// screen readers; the light red row says the same to the eye.

export function ConflictIcon() {
  return (
    <svg className="conflict-icon" role="img" aria-label="In conflict" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
      <rect x="1.5" y="1.5" width="8" height="10" rx="1" />
      <rect x="6.5" y="4.5" width="8" height="10" rx="1" className="conflict-icon-front" />
      <path d="M10.5 7.5v3M10.5 12.3v.2" strokeLinecap="round" />
    </svg>
  );
}
