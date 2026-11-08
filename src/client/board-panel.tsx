/**
 * The board as a `main`-slot panel.
 *
 * Before 2026-11-02 the board took the center column over at the DOM level: a
 * container was appended inside `[class*="centerCol"]`, a stylesheet rule hid
 * the conversation subtree under it, and a `data-dsh-taskboard-active`
 * attribute on <html> decided visibility. Two problems came with that shape —
 * the conversation stayed mounted (and painted) underneath, and every
 * "leave the board" path had to be re-invented with className selectors
 * (`[class*="newSession"]`, `[class*="sessionRow"]`, …), which is exactly what
 * collided with the entry row's borrowed classes.
 *
 * The `main` slot removes all of it: the shell renders this component while —
 * and only while — the board is the selected panel, so mounting IS the open
 * signal and unmounting IS the close signal. No overlay, no attribute, no
 * listener on other plugins' DOM.
 *
 * The controller keeps its own view state (`boardOpen`), because it gates the
 * live Host channel: this component mirrors the shell's selection into it and
 * honours controller-side closes by asking the shell to leave the panel.
 */
import { useEffect } from 'react'
import type { BoardController } from '../core/controller.ts'
import { TaskBoard } from './board/TaskBoard.tsx'

/** Props handed to the panel through the slot's `inject` share. */
export interface TaskBoardPanelProps {
  /** Board controller; absent while the settings gate has the board switched off. */
  controller?: BoardController
  /** Leave the panel: the shell shows the Conversation again. */
  onExit: () => void
}

/**
 * Board panel body.
 * @param props - the live controller plus the shell-navigation exit.
 * @returns the board, or null when the board is switched off in settings.
 */
export function TaskBoardPanel({ controller, onExit }: TaskBoardPanelProps) {
  useEffect(() => {
    if (controller === undefined) return
    // Selected by the shell ⇒ the board is open: baseline the session selection
    // and subscribe the live Host channel (see BoardController.openBoard).
    controller.openBoard()
    const unsubscribe = controller.subscribe(() => {
      // The controller can close on its own — the header's back button, or a
      // session navigation (a board stays open only for the session it opened
      // against). The panel itself cannot unmount from here, so hand the centre
      // column back to the Conversation and let the shell unmount us.
      if (!controller.getSnapshot().boardOpen) onExit()
    })
    return () => {
      // Dispose FIRST: the close below must not be mistaken for a
      // controller-side close and bounce a second navigation at the shell while
      // the user is already switching to another panel.
      unsubscribe()
      controller.closeBoard()
    }
  }, [controller, onExit])

  if (controller === undefined) return null
  return (
    <div data-dsh-taskboard-view="" data-dsh-plugin="task-board">
      <TaskBoard controller={controller} />
    </div>
  )
}
