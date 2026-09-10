// The pieces of the host context the viewer components need, captured once at
// activation.
//
// Viewers are registered by class, not constructed with ctx, so there's no
// prop to pass these down — and putting them in client.tsx would make every
// viewer import the module that imports it. This module is the shared leaf
// both sides can depend on.
import type { ThemeApi } from "./monacoLoader";

export let hostAssetUrl: ((relPath: string) => string) | null = null;
export let hostThemeApi: ThemeApi | null = null;
export let hostOpenDiff: ((req: import("./requests").DiffRequest) => Promise<boolean>) | null = null;
// Rendered-preview access: an editor tab can offer "show this as Markdown /
// as a table" without knowing which extension provides it. Absent on hosts
// that predate the API.
// Closes one of this extension's own viewer tabs — what `:q` needs. It has no
// unsaved-changes confirm of its own, so the caller owns that check.
export let hostCloseViewerTab: ((viewerId: string, path: string) => void) | null = null;
export let hostCanPreview: ((path: string) => boolean) | null = null;
export let hostOpenPreview: ((path: string) => void) | null = null;

export function setHost(host: {
  assetUrl: (relPath: string) => string;
  themeApi: ThemeApi;
  openDiff?: (req: import("./requests").DiffRequest) => Promise<boolean>;
  canPreview?: (path: string) => boolean;
  openPreview?: (path: string) => void;
  closeViewerTab?: (viewerId: string, path: string) => void;
}): void {
  hostAssetUrl = host.assetUrl;
  hostThemeApi = host.themeApi;
  hostOpenDiff = host.openDiff ?? null;
  hostCloseViewerTab = host.closeViewerTab ?? null;
  hostCanPreview = host.canPreview ?? null;
  hostOpenPreview = host.openPreview ?? null;
}

export function clearHost(): void {
  hostAssetUrl = null;
  hostThemeApi = null;
  hostOpenDiff = null;
  hostCloseViewerTab = null;
  hostCanPreview = null;
  hostOpenPreview = null;
}
