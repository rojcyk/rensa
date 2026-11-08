// Hex only. `background` goes on the fullscreen root Box and nowhere else;
// inline mode paints no root background; explicit backgrounds only on
// selected rows or panels (step 14, rule D).
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
  /** Fullscreen root only. */
  background: '#121212',
  /** Background of the selected row or panel. */
  selection: '#2a2a2a',
} as const
