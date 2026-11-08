/**
 * Sidebar entry + panel identity, registered through the host's official slots.
 *
 * What this replaces (2026-11-02, 主人拍板 B 方案): the entry used to be a DOM
 * injection — find the shell's New Session button, copy its `className` onto a
 * self-made row, insert it as a sibling, and keep it alive with a
 * MutationObserver. The borrowed class is what made a click look dead: it
 * carried the shell's `newSession` fragment, which also matched the board's own
 * capture-phase "a sidebar row was clicked" listener, so one click closed and
 * re-opened the panel in the same event (net zero). The row's styling also
 * drifted with any host restyle, and collapsed/hover/selected states had to be
 * re-implemented by hand.
 *
 * The shell ships a seat for exactly this:
 *   - `sidebar.panellist` (list, one icon per global panel) — the sidebar owns
 *     the row: spacing, hover, the collapsed rail and the selected highlight are
 *     all rendered by the shell; an occupant only supplies a glyph plus a label.
 *   - `main` (keyed by the same entry id) — hosts the panel component itself.
 * 「插件」(id `plugins`, order 0) and 「自动化任务」(id `schedules`, order 10) are
 * registered exactly this way, which is what makes the board look native.
 *
 * Slot registration lives in index.ts (next to the settings seats); this module
 * owns the constants the two registrations share and the glyph they render.
 */

/** Panel identity: the sidebar row id AND the `main` slot key (they must match). */
export const PANEL_ID = 'taskboard'

/** Row position: after 「插件」(0) and 「自动化任务」(10). */
export const ENTRY_ORDER = 20

/**
 * Owner props of one `sidebar.panellist` occupant.
 *
 * Declared locally rather than imported: the declaring package
 * (`@deepseek-ai/dsh-client-ui-sidebar`) is not a build dependency of this
 * bundle, and a browser bundle only ever sees its own externals. The shape is
 * the shell's `SidebarPanelIconOwnerProps` verbatim — read from the live slot
 * catalog on 2026-11-02, two fields, no children.
 */
export interface SidebarPanelIconProps {
  /** Requested square edge in pixels (16 in the wide rail, 18 collapsed). */
  size: number
  /** Whether this panel is the selected one; the row's own class carries the highlight. */
  active: boolean
}

/**
 * Panel glyph. The row's classes carry color and highlight, so the glyph only
 * has to inherit `currentColor` and honor the requested edge.
 * @param props - owner share supplied by the sidebar's panel row.
 * @returns the icon element.
 */
export function SidebarEntryIcon({ size }: SidebarPanelIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <path d="M2 6.5h12M6.5 6.5v7" />
    </svg>
  )
}
