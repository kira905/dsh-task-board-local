/**
 * Task-board settings for availability, agent announcement, optional Host
 * idle-sleep protection, and the card-execution workspace fallback (D-3/D-3b,
 * plan `卡会话独立工作区-方案-20260921.md` §3.3).
 * Registers into the `web-ui.plugin.item` child slot the Web UI plugin group
 * renders, bound to the `task-board` namespace.
 */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Locally declared settings faces (see client-faces.ts): @deepseek-ai/dsh-client-runtime,
// which used to export these types, is absent on the 0.1.2+ line.
import type { SettingsScope, SnapshotStore } from './client-faces.ts'
import { useEffect, useRef, useState } from 'react'
import type { TaskBoardPowerSnapshot } from '../protocol.ts'
import { PluginSettingsCard, BooleanField, ChoiceField } from './PluginSettingsCard.tsx'
import { CardForm, booleanField, textField, type CardActions, type CardShell, type FieldState as CardFieldState } from './settings-form.ts'

/** The task-board fields this card edits (the namespace's full schema). */
export interface TaskBoardSettings {
  /** Master switch for the plugin. */
  enabled?: boolean
  /** Whether the board announces itself in every agent's system prompt. */
  announceToAgent?: boolean
  /** Prevent host idle sleep while sessions run or schedules are armed. */
  preventIdleSleep?: boolean
  /** D · default execution workspace id (empty = fallback disabled). */
  defaultWorkspaceId?: string
  /** M · main workspace id the built-in-card fallback matches against. */
  mainWorkspaceId?: string
  /** Switch for the built-in-card fallback. */
  fallbackEnabled?: boolean
}

/** One selectable workspace in the card's two workspace pickers. */
export interface WorkspaceOption {
  /** Workspace id written into the setting. */
  workspaceId: string
  /** Dropdown label: the workspace title, falling back to its path. */
  label: string
}

/** What the task-board card renders. */
export interface TaskBoardSettingsCardState extends CardShell {
  /** Master switch. */
  enabled: CardFieldState
  /** System-prompt announcement flag. */
  announceToAgent: CardFieldState
  /** Idle-system-sleep protection flag. */
  preventIdleSleep: CardFieldState
  /** D · default execution workspace id. */
  defaultWorkspaceId: CardFieldState
  /** M · main workspace id. */
  mainWorkspaceId: CardFieldState
  /** Built-in-card fallback switch. */
  fallbackEnabled: CardFieldState
}

/** The registration-side face the card's slot entry injects. */
export interface TaskBoardSettingsCardFace extends CardActions {
  hooks: {
    /** Card snapshot bound by the renderer as useTaskBoardSettingsCard. */
    taskBoardSettingsCard: SnapshotStore<TaskBoardSettingsCardState>
    /** Workspaces the two pickers offer, bound as useTaskBoardWorkspaces. */
    taskBoardWorkspaces: SnapshotStore<readonly WorkspaceOption[]>
  }
}

/** Bridges the `task-board` scope onto the card's staged form. */
export class TaskBoardSettingsCardController {
  private readonly form: CardForm<TaskBoardSettings>
  private readonly store: SnapshotStore<TaskBoardSettingsCardState>
  private readonly workspaces: SnapshotStore<readonly WorkspaceOption[]>

  /**
   * @param scope - the bound settings scope for the `task-board` namespace.
   * @param workspaces - live workspace options for the two pickers (the client
   *   wiring feeds this from the runtime workspace list, never from the ledger).
   */
  constructor(scope: SettingsScope<TaskBoardSettings>, workspaces: SnapshotStore<readonly WorkspaceOption[]>) {
    this.workspaces = workspaces
    this.form = new CardForm(scope, [
      booleanField('enabled'),
      booleanField('announceToAgent'),
      booleanField('preventIdleSleep'),
      textField('defaultWorkspaceId'),
      textField('mainWorkspaceId'),
      booleanField('fallbackEnabled'),
    ])
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): TaskBoardSettingsCardState {
    return {
      ...this.form.shell(),
      enabled: this.form.field('enabled'),
      announceToAgent: this.form.field('announceToAgent'),
      preventIdleSleep: this.form.field('preventIdleSleep'),
      defaultWorkspaceId: this.form.field('defaultWorkspaceId'),
      mainWorkspaceId: this.form.field('mainWorkspaceId'),
      fallbackEnabled: this.form.field('fallbackEnabled'),
    }
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot, its form actions, and the workspace options.
   */
  inject(): TaskBoardSettingsCardFace {
    return {
      hooks: { taskBoardSettingsCard: this.store, taskBoardWorkspaces: this.workspaces },
      ...this.form.actions(),
    }
  }

  /**
   * Release the card's scope subscription and bound stores; the slot
   * disposer calls this on teardown.
   */
  dispose(): void {
    this.form.dispose()
  }
}

/** Props the renderer binds for the task-board card. */
export type TaskBoardSettingsCardProps =
  PropsRuntime<'web-ui.plugin.item'>
  & PropsLocale<'task-board'>
  & InjectFace<TaskBoardSettingsCardFace>

/**
 * Render the task-board card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card.
 */
export function TaskBoardSettingsCard(props: TaskBoardSettingsCardProps) {
  const { t } = props
  const state = props.useTaskBoardSettingsCard(snapshot => snapshot)
  const workspaces = props.useTaskBoardWorkspaces((list: readonly WorkspaceOption[]) => list)
  const workspaceChoices = workspaces.map((option: WorkspaceOption) => ({ value: option.workspaceId, label: option.label }))
  const disabled = !state.writable
  const [power, setPower] = useState<TaskBoardPowerSnapshot | undefined>()
  const powerRef = useRef<HTMLParagraphElement | null>(null)
  const [statusLive, setStatusLive] = useState(false)

  // The status line's live channel is demand-driven too: it exists only while
  // this card is actually on screen (settings page open with the card laid
  // out and scrolled into view) and the document is visible. The Host pushes
  // one frame the moment we subscribe, so the line is fresh on every return.
  useEffect(() => {
    const node = powerRef.current
    let intersecting = false
    const onScreen = (): boolean => node !== null && node.isConnected
      && node.offsetParent !== null && intersecting && document.visibilityState === 'visible'
    if (node === null || typeof IntersectionObserver === 'undefined') {
      const sync = (): void => { setStatusLive(document.visibilityState === 'visible') }
      sync()
      document.addEventListener('visibilitychange', sync)
      return () => { document.removeEventListener('visibilitychange', sync) }
    }
    const sync = (): void => { setStatusLive(onScreen()) }
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1]
      // A collapsed (zero-height) card still reports a degenerate intersection
      // rectangle; require real layout height so a folded card stays offline.
      intersecting = entry?.isIntersecting === true && (entry.boundingClientRect.height ?? 0) > 0
      sync()
    })
    observer.observe(node)
    document.addEventListener('visibilitychange', sync)
    return () => {
      observer.disconnect()
      document.removeEventListener('visibilitychange', sync)
    }
  }, [])

  useEffect(() => {
    // The SSE channel carries power on every real change and pushes one frame
    // on subscribe; polling the full /state snapshot every 5 s re-cloned and
    // re-serialized the whole ledger server-side for one field.
    if (!statusLive) return
    let live = true
    const events = new EventSource('/api/task-board/events')
    events.onmessage = (message: MessageEvent<string>): void => {
      try {
        const frame = JSON.parse(message.data) as { power?: TaskBoardPowerSnapshot }
        if (frame.power !== undefined && live) setPower(frame.power)
      } catch {
        // The settings form remains usable while the host status is reconnecting.
      }
    }
    return () => { live = false; events.close() }
  }, [statusLive])
  const fieldProps = {
    overriddenLabel: t('settings.overridden'),
    resetLabel: t('settings.reset'),
    invalidLabel: t('settings.invalidNumber'),
    disabled,
  }
  return (
    <PluginSettingsCard
      t={t}
      titleKey="settings.title"
      descriptionKey="settings.description"
      defaultOpen={false}
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <BooleanField
        id="settings-task-board-enabled"
        label={t('settings.enabled')}
        hint={t('settings.enabledHint')}
        inheritLabel={t('settings.inherit')}
        onLabel={t('settings.on')}
        offLabel={t('settings.off')}
        {...fieldProps}
        {...state.enabled}
        onEdit={(text) => { props.edit('enabled', text) }}
        onReset={() => { props.resetField('enabled') }}
      />
      <BooleanField
        id="settings-task-board-announce"
        label={t('settings.announceToAgent')}
        hint={t('settings.announceToAgentHint')}
        inheritLabel={t('settings.inherit')}
        onLabel={t('settings.on')}
        offLabel={t('settings.off')}
        {...fieldProps}
        {...state.announceToAgent}
        onEdit={(text) => { props.edit('announceToAgent', text) }}
        onReset={() => { props.resetField('announceToAgent') }}
      />
      <BooleanField
        id="settings-task-board-prevent-idle-sleep"
        label={t('settings.preventIdleSleep')}
        hint={t('settings.preventIdleSleepHint')}
        inheritLabel={t('settings.inherit')}
        onLabel={t('settings.on')}
        offLabel={t('settings.off')}
        {...fieldProps}
        {...state.preventIdleSleep}
        onEdit={(text) => { props.edit('preventIdleSleep', text) }}
        onReset={() => { props.resetField('preventIdleSleep') }}
      />
      {/* 卡执行工作区（D-3 / D-3b）：两个工作区下拉 + 一个回落开关。下拉只列
          **运行时已注册**的工作区（id 写进设置），不猜"哪个是主工作区"。 */}
      <ChoiceField
        id="settings-task-board-default-workspace"
        label={t('settings.defaultWorkspace')}
        hint={t('settings.defaultWorkspaceHint')}
        inheritLabel={t('settings.workspaceNone')}
        choices={workspaceChoices}
        {...fieldProps}
        invalidLabel={t('settings.invalidWorkspace')}
        {...state.defaultWorkspaceId}
        onEdit={(text) => { props.edit('defaultWorkspaceId', text) }}
        onReset={() => { props.resetField('defaultWorkspaceId') }}
      />
      <ChoiceField
        id="settings-task-board-main-workspace"
        label={t('settings.mainWorkspace')}
        hint={t('settings.mainWorkspaceHint')}
        inheritLabel={t('settings.workspaceNone')}
        choices={workspaceChoices}
        {...fieldProps}
        invalidLabel={t('settings.invalidWorkspace')}
        {...state.mainWorkspaceId}
        onEdit={(text) => { props.edit('mainWorkspaceId', text) }}
        onReset={() => { props.resetField('mainWorkspaceId') }}
      />
      <BooleanField
        id="settings-task-board-workspace-fallback"
        label={t('settings.fallbackEnabled')}
        hint={t('settings.fallbackEnabledHint')}
        inheritLabel={t('settings.inherit')}
        onLabel={t('settings.on')}
        offLabel={t('settings.off')}
        {...fieldProps}
        {...state.fallbackEnabled}
        onEdit={(text) => { props.edit('fallbackEnabled', text) }}
        onReset={() => { props.resetField('fallbackEnabled') }}
      />
      <p>{t('settings.workspaceFallbackNote')}</p>
      <p ref={powerRef}>
        {t('settings.powerStatus', {
          platform: power?.platform ?? t('settings.powerUnknown'),
          phase: power?.phase ?? t('settings.powerUnknown'),
          running: String(power?.runningSessions ?? 0),
          schedules: String(power?.armedSchedules ?? 0),
        })}
      </p>
      <p>{t('settings.powerBoundary')}</p>
      {power?.lastError !== undefined && <p>{t('settings.powerError', { error: power.lastError })}</p>}
    </PluginSettingsCard>
  )
}
