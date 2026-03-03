export interface FlushHandlerConfig {
  onFlush: () => void;
}

export function registerFlushHandlers(config: FlushHandlerConfig): () => void {
  const isBrowser =
    typeof document !== "undefined" && typeof window !== "undefined";
  if (!isBrowser) return () => {};

  const handleVisibilityChange = () => {
    if (document.visibilityState === "hidden") {
      config.onFlush();
    }
  };

  const handlePageHide = () => {
    config.onFlush();
  };

  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("pagehide", handlePageHide);

  return () => {
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    window.removeEventListener("pagehide", handlePageHide);
  };
}
