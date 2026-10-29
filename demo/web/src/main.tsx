import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import type { ReplicaRef } from "./types.ts";
import "./styles.css";

const root = createRoot(document.getElementById("root") as HTMLElement);

// The page server lists each replica's port. The URL uses the page's own
// hostname, so the page works opened as localhost or as 127.0.0.1.
try {
  const response = await fetch("/config.json");
  const config = (await response.json()) as { replicas: { name: string; port: number }[] };
  const replicas: ReplicaRef[] = config.replicas.map(({ name, port }) => ({
    name,
    url: `${location.protocol}//${location.hostname}:${port}`,
  }));
  // The caption bar is the script for the video: ?captions, with or without a value.
  const captions = new URLSearchParams(location.search).has("captions");
  root.render(
    <StrictMode>
      <App replicas={replicas} captions={captions} />
    </StrictMode>,
  );
} catch (error) {
  root.render(<p className="pane-message">Could not load the demo's config: {String(error)}</p>);
}
