// esbuild emits a sibling dist/client.css when an extension's entry imports
// CSS but never auto-links it — call this once from activate() to add it to
// <head>. Copied from tmux-server's client/src/lib pattern (and this repo's
// sibling extensions) — a copy rather than an import, same as every other
// small helper here.
function inject(assetUrl: (relPath: string) => string, relPath: string): () => void {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = assetUrl(relPath);
  document.head.appendChild(link);
  return () => link.remove();
}

export function injectStylesheet(assetUrl: (relPath: string) => string, relPath: string): () => void {
  return inject(assetUrl, relPath);
}
