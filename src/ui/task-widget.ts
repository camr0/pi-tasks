/**
 * task-widget.ts — Persistent widget showing task list with status icons and progress.
 *
 * Display style matches Claude Code's task list:
 *   ✔ completed tasks (strikethrough + dim)
 *   ◼ in_progress tasks
 *   ◻ pending tasks
 *   ✳/✽ actively executing task (star spinner with activeForm text)
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import type { TaskStore } from "../task-store.js";
import type { TasksConfig } from "../tasks-config.js";

// ---- Truncation ----

import type { Task } from "../types.js";

function truncateFromTop(tasks: Task[], limit: number): Task[] {
  return tasks.slice(-limit);
}

function truncateFromBottom(tasks: Task[], limit: number): Task[] {
  return tasks.slice(0, limit);
}

const TRUNCATE_FNS = { top: truncateFromTop, bottom: truncateFromBottom };

// ---- Types ----

export type Theme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
  strikethrough(text: string): string;
};

export type UICtx = {
  setStatus(key: string, text: string | undefined): void;
  setWidget(
    key: string,
    content: undefined | ((tui: any, theme: Theme) => { render(): string[]; invalidate(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
};

/** Star spinner frames for the animated active-task indicator. Claude Code's own
 *  spinner is a shorter mirrored sequence (`· ✢ ✳ ✶ ✻ ✽` and its reverse, with a
 *  ghostty variant); this walks the dingbat block instead. Deliberately ours. */
const SPINNER = ["✳", "✴", "✵", "✶", "✷", "✸", "✹", "✺", "✻", "✼", "✽"];

const DEFAULT_MAX_VISIBLE_TASKS = 10;

/** Per-task runtime metrics (elapsed time, token usage).
 *
 * `activeMs` accumulates busy wall-clock time; `busySince` marks the moment the
 * most recent busy window started (undefined while idle). Elapsed for display is
 * `activeMs + (busySince !== undefined ? now - busySince : 0)` — so the timer
 * freezes whenever nothing is actually running. */
export interface TaskMetrics {
  activeMs: number;
  busySince: number | undefined;
  inputTokens: number;
  outputTokens: number;
}

/** One task in a TaskWidgetSnapshot, serialized for cross-extension consumers. */
export interface TaskWidgetSnapshotTask {
  id: string;
  subject: string;
  description: string;
  status: string;
  activeForm?: string;
  owner?: string;
  agentId?: string;
  blocks: string[];
  blockedBy: string[];
  /** Whether this task is the active (spinner) one right now, regardless of busy. */
  active: boolean;
  /** Frozen-aware elapsed ms — already settled to activeMs when idle. */
  elapsedMs: number;
  inputTokens: number;
  outputTokens: number;
}

/** Live, serializable task-list state for cross-extension consumers. */
export interface TaskWidgetSnapshot {
  /** Whether anything is running (main run or subagent). */
  busy: boolean;
  tasks: TaskWidgetSnapshotTask[];
}

/** Format milliseconds as a human-readable duration (e.g., "2m 49s", "1h 3m"). */
function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
}

/** Format token count with k suffix (e.g., "4.1k", "850"). */
function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
}

// ---- Widget ----

export class TaskWidget {
  private uiCtx: UICtx | undefined;
  private widgetFrame = 0;
  private widgetInterval: ReturnType<typeof setInterval> | undefined;
  /** IDs of tasks currently being actively executed (show spinner). */
  private activeTaskIds = new Set<string>();
  /** Per-task runtime metrics keyed by task ID. */
  private metrics = new Map<string, TaskMetrics>();
  /** Cached TUI instance for requestRender() calls. */
  private tui: any | undefined;
  /** Whether the widget callback is currently registered. */
  private widgetRegistered = false;
  /** Whether anything is actually running right now (main run or any subagent).
   *  When this is false the spinner/timer pause even for in_progress tasks. */
  private busy = false;

  constructor(
    private store: TaskStore,
    private config: TasksConfig = {},
  ) {}

  setStore(store: TaskStore) {
    this.store = store;
  }

  setUICtx(ctx: UICtx) {
    this.uiCtx = ctx;
  }

  /** Report whether anything is running (drives animation + timer freezing). */
  get isBusy(): boolean {
    return this.busy;
  }

  /** Add or remove a task from the active spinner set. */
  setActiveTask(taskId: string | undefined, active = true) {
    if (taskId && active) {
      this.activeTaskIds.add(taskId);
      if (!this.metrics.has(taskId)) {
        this.metrics.set(taskId, {
          activeMs: 0,
          busySince: this.busy ? Date.now() : undefined,
          inputTokens: 0,
          outputTokens: 0,
        });
      }
      this.ensureTimer();
    } else if (taskId) {
      this.activeTaskIds.delete(taskId);
    }
    this.update();
  }

  /** Flip the busy signal. Idle → busy starts the elapsed window for every
   *  active task; busy → idle freezes it (accumulate into activeMs, clear
   *  busySince) so the timer stops climbing while nothing is running. */
  setBusy(busy: boolean) {
    if (busy === this.busy) return;
    const now = Date.now();
    if (busy) {
      for (const id of this.activeTaskIds) {
        const m = this.metrics.get(id);
        if (m && m.busySince === undefined) m.busySince = now;
      }
    } else {
      for (const id of this.activeTaskIds) {
        const m = this.metrics.get(id);
        if (m && m.busySince !== undefined) {
          m.activeMs += now - m.busySince;
          m.busySince = undefined;
        }
      }
    }
    this.busy = busy;
    this.update();
  }

  /** Record token usage for the currently active task(s). Tokens accrue across
   *  busy windows (they reflect model output, not wall-clock time). */
  addTokenUsage(inputTokens: number, outputTokens: number) {
    // Distribute to all currently active tasks
    for (const id of this.activeTaskIds) {
      const m = this.metrics.get(id);
      if (m) {
        m.inputTokens += inputTokens;
        m.outputTokens += outputTokens;
      }
    }
  }

  /** Ensure the widget update timer is running. The spinner advances here and
   *  nowhere else: `update()` also runs on every task mutation and tool execution,
   *  so incrementing there tied the animation speed to how busy the agent was. */
  ensureTimer() {
    if (!this.widgetInterval) {
      this.widgetInterval = setInterval(() => {
        this.widgetFrame++;
        this.update();
      }, 150);
    }
  }

  /** Render callback entry point. Guarded so a render error can never escape to
   *  the TUI timer and crash the whole host process — worst case the widget is
   *  empty for one frame. */
  private renderWidget(tui: any, theme: Theme): string[] {
    try {
      return this.buildWidgetLines(tui, theme);
    } catch {
      return [];
    }
  }

  /** Build widget lines from current live state. */
  private buildWidgetLines(tui: any, theme: Theme): string[] {
    const sortOrder = this.config.sortOrder ?? "id";
    const tasks = this.store.list(sortOrder);
    const w = tui.terminal.columns;
    const truncate = (line: string) => truncateToWidth(line, w);

    if (tasks.length === 0) return [];

    const completed = tasks.filter(t => t.status === "completed");
    const inProgress = tasks.filter(t => t.status === "in_progress");
    const pending = tasks.filter(t => t.status === "pending");

    const parts: string[] = [];
    if (completed.length > 0) parts.push(`${completed.length} done`);
    if (inProgress.length > 0) parts.push(`${inProgress.length} in progress`);
    if (pending.length > 0) parts.push(`${pending.length} open`);
    const statusText = `${tasks.length} tasks (${parts.join(", ")})`;

    const spinnerChar = SPINNER[this.widgetFrame % SPINNER.length];
    const lines: string[] = [truncate(theme.fg("accent", "●") + " " + theme.fg("accent", statusText))];

    // Collapsing only decides what goes in the list; the visible-limit logic below
    // then runs unchanged over whatever remains.
    const collapseCompleted = this.config.collapseCompleted ?? false;
    const listed = collapseCompleted ? tasks.filter(t => t.status !== "completed") : tasks;
    const showAll = this.config.showAll ?? false;
    const limit = this.config.maxVisible ?? DEFAULT_MAX_VISIBLE_TASKS;
    // Narrowed rather than defaulted: config is hand-editable JSON, and an
    // unrecognised value would index TRUNCATE_FNS to undefined and blank the widget.
    const hiddenAt = this.config.hiddenAt === "top" ? "top" : "bottom";
    const visible = showAll ? listed : TRUNCATE_FNS[hiddenAt](listed, limit);

    const hiddenCount = listed.length - visible.length;
    const overflowLine = hiddenCount > 0
      ? truncate(theme.fg("dim", `    … and ${hiddenCount} more`))
      : undefined;

    if (overflowLine && hiddenAt === "top") {
      lines.push(overflowLine);
    }
    for (let i = 0; i < visible.length; i++) {
      const task = visible[i];
      // Spinner only while something is actually running. An in_progress task
      // with a stale active marker (LLM settled, no subagents) renders as a
      // static ◼ with a frozen elapsed time instead of an animate spinner.
      const inActiveSet = this.activeTaskIds.has(task.id);
      const isActive = inActiveSet && task.status === "in_progress";
      const isAnimating = isActive && this.busy;

      let icon: string;
      if (isAnimating) {
        icon = theme.fg("accent", spinnerChar);
      } else if (task.status === "completed") {
        icon = theme.fg("success", "✔");
      } else if (task.status === "in_progress") {
        icon = theme.fg("accent", "◼");
      } else {
        icon = "◻";
      }

      let suffix = "";
      if (task.status === "pending" && task.blockedBy.length > 0) {
        const openBlockers = task.blockedBy.filter(bid => {
          const blocker = this.store.get(bid);
          return blocker && blocker.status !== "completed";
        });
        if (openBlockers.length > 0) {
          suffix = theme.fg("dim", ` › blocked by ${openBlockers.map(id => "#" + id).join(", ")}`);
        }
      }

      // Build an optional ` (elapsed · tokens)` stats suffix from the task's
      // metrics. Elapsed is frozen when idle (activeMs settles, no busySince
      // window open) and live when animating.
      const statsFor = (m: TaskMetrics | undefined): string => {
        if (!m) return "";
        const elapsed = formatDuration(this.elapsedFor(m));
        const tokenParts: string[] = [];
        if (m.inputTokens > 0) tokenParts.push(`↑ ${formatTokens(m.inputTokens)}`);
        if (m.outputTokens > 0) tokenParts.push(`↓ ${formatTokens(m.outputTokens)}`);
        return tokenParts.length > 0
          ? ` ${theme.fg("dim", `(${elapsed} · ${tokenParts.join(" ")})`)}`
          : ` ${theme.fg("dim", `(${elapsed})`)}`;
      };

      let text: string;
      if (isAnimating) {
        const form = task.activeForm || task.subject;
        const agentId = task.metadata?.agentId;
        const agentLabel = agentId ? ` (agent ${agentId.slice(0, 5)})` : "";
        text = `  ${icon} ${theme.fg("dim", "#" + task.id)} ${theme.fg("accent", form + agentLabel + "…")}${statsFor(this.metrics.get(task.id))}`;
      } else if (task.status === "completed") {
        text = `  ${icon} ${theme.fg("dim", theme.strikethrough("#" + task.id + " " + task.subject))}`;
      } else if (task.status === "in_progress") {
        // Non-animated in_progress: keep the subject, attach a frozen stats
        // suffix when the task had been actively worked on (has metrics).
        const agentSuffix = task.metadata?.agentId
          ? theme.fg("dim", ` (agent ${task.metadata.agentId.slice(0, 5)})`)
          : "";
        text = `  ${icon} ${theme.fg("dim", "#" + task.id)} ${task.subject}${agentSuffix}${statsFor(this.metrics.get(task.id))}`;
      } else {
        text = `  ${icon} ${theme.fg("dim", "#" + task.id)} ${task.subject}`;
      }

      lines.push(truncate(text + suffix));
    }

    if (overflowLine && hiddenAt !== "top") {
      lines.push(overflowLine);
    }
    if (collapseCompleted && completed.length > 0) {
      lines.push(truncate(`  ${theme.fg("success", "✔")} ${theme.fg("dim", `${completed.length} completed`)}`));
    }

    return lines;
  }

  /** Elapsed ms for an active task — frozen while idle, live while busy. */
  private elapsedFor(m: TaskMetrics): number {
    return m.activeMs + (m.busySince !== undefined ? Date.now() - m.busySince : 0);
  }

  /** Serializable snapshot for cross-extension consumers (e.g. the pi-subagents
   *  viewer). Mirrors the widget's live list, but structured so a caller can
   *  render tasks with its own theme/width. `index.ts` answers the
   *  `tasks:rpc:state` request with this. */
  snapshot(): TaskWidgetSnapshot {
    const tasks = this.store.list(this.config.sortOrder ?? "id");
    return {
      busy: this.busy,
      tasks: tasks.map(t => {
        const m = this.metrics.get(t.id);
        return {
          id: t.id,
          subject: t.subject,
          description: t.description,
          status: t.status,
          activeForm: t.activeForm,
          owner: t.owner,
          agentId: typeof t.metadata?.agentId === "string" ? t.metadata.agentId : undefined,
          blocks: t.blocks,
          blockedBy: t.blockedBy,
          active: this.activeTaskIds.has(t.id) && t.status === "in_progress",
          elapsedMs: m ? this.elapsedFor(m) : 0,
          inputTokens: m?.inputTokens ?? 0,
          outputTokens: m?.outputTokens ?? 0,
        };
      }),
    };
  }

  /** Force an immediate widget update. */
  update() {
    if (!this.uiCtx) return;
    const tasks = this.store.list();

    // Transition: visible → hidden
    if (tasks.length === 0) {
      if (this.widgetRegistered) {
        this.uiCtx.setWidget("tasks", undefined);
        this.widgetRegistered = false;
      }
      if (this.widgetInterval) {
        clearInterval(this.widgetInterval);
        this.widgetInterval = undefined;
      }
      return;
    }

    // Prune stale active IDs (deleted or no longer in_progress)
    for (const id of this.activeTaskIds) {
      const t = this.store.get(id);
      if (!t || t.status !== "in_progress") {
        this.activeTaskIds.delete(id);
        this.metrics.delete(id);
      }
    }

    // Only animate (spinner + advancing timer) while something is actually
    // running. Idle tasks stop the 150ms re-render loop entirely.
    const hasActiveSpinner = this.busy && tasks.some(t => this.activeTaskIds.has(t.id) && t.status === "in_progress");
    if (hasActiveSpinner) {
      this.ensureTimer();
    } else if (!hasActiveSpinner && this.widgetInterval) {
      clearInterval(this.widgetInterval);
      this.widgetInterval = undefined;
    }

    // Transition: hidden → visible — register widget callback once
    if (!this.widgetRegistered) {
      this.uiCtx.setWidget("tasks", (tui, theme) => {
        this.tui = tui;
        return { render: () => this.renderWidget(tui, theme), invalidate: () => {} };
      }, { placement: "aboveEditor" });
      this.widgetRegistered = true;
    } else if (this.tui) {
      // Widget already registered — just request a re-render
      this.tui.requestRender();
    }
  }

  dispose() {
    if (this.widgetInterval) {
      clearInterval(this.widgetInterval);
      this.widgetInterval = undefined;
    }
    if (this.uiCtx) {
      this.uiCtx.setWidget("tasks", undefined);
    }
    this.widgetRegistered = false;
    this.tui = undefined;
  }
}
