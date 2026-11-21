// The browser tab's title for a screen.

import { useEffect } from "react";

export function usePageTitle(title: string): void {
  useEffect(() => {
    document.title = `${title}: CromDB`;
  }, [title]);
}
