// A person's name, or their shortened ID with the full one on hover.

import type { NameLabel } from "../api/names.ts";

export function Name({ label }: { label: NameLabel }) {
  return label.title === undefined ? <>{label.text}</> : <span title={label.title}>{label.text}</span>;
}
