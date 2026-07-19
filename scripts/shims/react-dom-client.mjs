// See react.mjs — same single-instance rationale, for react-dom/client's
// exports (createRoot for extension-owned floating UI roots).
const RDC = window.__tmuxServerModules["react-dom/client"];
export const { createRoot, hydrateRoot } = RDC;
export default RDC;
