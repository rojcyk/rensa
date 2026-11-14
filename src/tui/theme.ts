// Hex only. `background` goes on the full-window root Box and on border
// cells that must match it; explicit backgrounds only on selected rows or
// panels (step 14, rule D).
export const theme = {
  /** Primary copy. */
  text: '#e6e6e6',
  /** Secondary copy: descriptions, agent rows. */
  muted: '#9a9a9a',
  /** Borders, rules, inactive markers. */
  dim: '#5c5c5c',
  /** Separators inside panes. */
  faint: '#3a3a3a',
  /** Running step, selection. */
  accent: '#d9b86a',
  ok: '#7fb77e',
  err: '#d47a7a',
  warn: '#d9b86a',
  /** The full-window root fill. */
  background: '#121212',
  /** Background of the selected row or panel. */
  selection: '#2a2a2a',
} as const
