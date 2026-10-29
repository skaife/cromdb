export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** A point on a pane's edge: a side, and how far along it (0 to 1, from the top or left). */
export interface Anchor {
  side: "top" | "bottom" | "left" | "right";
  at: number;
}

export function anchorPoint(r: Rect, { side, at }: Anchor): { x: number; y: number } {
  switch (side) {
    case "top":
      return { x: r.x + r.width * at, y: r.y };
    case "bottom":
      return { x: r.x + r.width * at, y: r.y + r.height };
    case "left":
      return { x: r.x, y: r.y + r.height * at };
    case "right":
      return { x: r.x + r.width, y: r.y + r.height * at };
  }
}

/** The line from a's anchor to b's. */
export function connector(a: Rect, anchorA: Anchor, b: Rect, anchorB: Anchor): Segment {
  const start = anchorPoint(a, anchorA);
  const end = anchorPoint(b, anchorB);
  return { x1: start.x, y1: start.y, x2: end.x, y2: end.y };
}
