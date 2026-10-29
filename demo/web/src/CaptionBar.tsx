import { useState } from "react";
import captions from "./captions.json";

// The numbered steps; the last caption is a closing note without a number.
const STEPS = captions.filter((caption) => caption.scene !== "").length;

/** Shows one caption at a time. Back and Next only change the text: they never touch a replica. */
export function CaptionBar() {
  const [index, setIndex] = useState(0);
  const caption = captions[index] ?? { scene: "", text: "" };
  return (
    <header className="captions">
      <button type="button" onClick={() => setIndex((i) => Math.max(0, i - 1))} disabled={index === 0}>
        Back
      </button>
      <div className="caption" aria-live="polite">
        <div className="caption-scene">
          {caption.scene === "" ? "CromDB demo" : `${caption.scene} · Step ${index + 1} of ${STEPS}`}
        </div>
        <div className="caption-text" data-testid="caption">
          {caption.text}
        </div>
      </div>
      <button type="button" onClick={() => setIndex((i) => Math.min(captions.length - 1, i + 1))} disabled={index === captions.length - 1}>
        Next
      </button>
    </header>
  );
}
