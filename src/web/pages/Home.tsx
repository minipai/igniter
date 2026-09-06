// The dispatch board: top bar, left rail, right stage. Live without
// reloading: the snapshot loads from GET /api/board, typed SSE events on
// /events trigger a re-fetch, and a slow timer covers missed events. Every
// action that sends input is a native <form onSubmit>; y/n keys answer the
// visible approval only when no input has focus.

import { createEffect, createMemo, createSignal, For, onSettled, Show, untrack } from "solid-js";

interface BoardPaneData {
  name: string;
  kind: string | null;
  agentStatus: string;
  lastOutputAt: string | null;
  lastLine: string;
  text: string;
  paneId: string | null;
}

interface BoardTicketData {
  identifier: string;
  title: string;
  state: string;
  workspaceId: string | null;
  elapsedMs: number | null;
  budgetMs: number;
  level: "ok" | "near" | "over";
  stage: string | null;
  stageAgeMs: number | null;
  stalled: boolean;
  paused: boolean;
  block: "approval" | "quiet" | null;
  railState: "reply" | "stalled" | "alive";
  pulse: string;
  panes: { commander: BoardPaneData; builder: BoardPaneData; reviewer: BoardPaneData };
}

interface QueueEntryData {
  identifier: string;
  title: string;
  priority: number;
  reason: string;
}

interface BoardData {
  host: string;
  usedSlots: number;
  maxRunning: number;
  linearOrg: string;
  lastPollAt: string | null;
  needsYou: number;
  queue: QueueEntryData[];
  activity: string[];
  rules: string;
  tickets: BoardTicketData[];
}

interface ClearedEntry {
  key: string;
  text: string;
  /** The block this answer cleared. The entry drops as soon as the board
   *  shows no block (or a different one), so a later genuine approval
   *  blocks again instead of staying hidden forever. */
  block: "approval" | "quiet";
}

type Selection = string;

const DISPATCH_VIEWS: readonly string[] = ["queue", "activity", "rules", "nobody"];

function fmtDur(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "?";
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const rest = totalMinutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h${String(rest).padStart(2, "0")}m`;
}

function ageText(at: string | null, now: number): string {
  if (!at) return "?";
  const ms = now - Date.parse(at);
  if (!Number.isFinite(ms) || ms < 0) return "?";
  return fmtDur(ms);
}

/** Quiet-bar age: one unit, never "36m minutes". */
function fmtQuietAge(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "?";
  const totalMinutes = Math.floor(ms / 60000);
  if (totalMinutes < 1) return "less than a minute";
  if (totalMinutes < 60) return totalMinutes === 1 ? "1 minute" : `${totalMinutes} minutes`;
  return fmtDur(ms);
}

/** Browser-local HH:MM for decision lines (the log stores UTC ISO). */
function formatLocalTime(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function linearUrl(org: string, identifier: string): string {
  return `https://linear.app/${org}/issue/${identifier}`;
}

/** A ticket answered this session stays answered: the bar becomes the
 *  one-line result and never reappears until reload. */
function effectiveBlock(ticket: BoardTicketData, cleared: Record<string, ClearedEntry>): "approval" | "quiet" | null {
  if (cleared[ticket.identifier]) return null;
  return ticket.block;
}

function effectiveRail(ticket: BoardTicketData, cleared: Record<string, ClearedEntry>): "reply" | "stalled" | "alive" {
  const block = effectiveBlock(ticket, cleared);
  if (block === "approval") return "reply";
  if (block === "quiet") return "stalled";
  return "alive";
}

function defaultSelection(board: BoardData, cleared: Record<string, ClearedEntry>): Selection {
  const waiting = board.tickets.find((t) => effectiveBlock(t, cleared) === "approval");
  if (waiting) return waiting.identifier;
  const first = board.tickets[0];
  if (first) return first.identifier;
  return "queue";
}

function nextWaiting(board: BoardData, cleared: Record<string, ClearedEntry>): Selection {
  return board.tickets.find((t) => effectiveBlock(t, cleared) === "approval")?.identifier ?? "nobody";
}

function focusNameFor(ticket: BoardTicketData, want: string | null): string {
  const panes = [ticket.panes.commander, ticket.panes.builder, ticket.panes.reviewer];
  if (want && panes.some((p) => p.name === want)) return want;
  return panes.find((p) => p.agentStatus === "blocked")?.name ?? ticket.panes.commander.name;
}

function paneStateText(pane: BoardPaneData, now: number): string {
  if (pane.agentStatus === "notstarted") return "not started";
  if (pane.agentStatus === "unavailable") return "unavailable";
  return `${pane.agentStatus} · ${ageText(pane.lastOutputAt, now)} ago`;
}

function parseActivityLine(line: string): { time: string; ticket: string; message: string } | null {
  const match = /^(\S+) (\S+) ([\s\S]*)$/.exec(line);
  if (!match?.[1] || !match?.[2] || !match?.[3]) return null;
  const ms = Date.parse(match[1] as string);
  const time = Number.isFinite(ms) ? formatLocalTime(ms) : (match[1] as string);
  return { time, ticket: match[2] as string, message: match[3] as string };
}

/** Short local-time summary for the rail row; unparseable lines pass through raw. */
function activitySummary(line: string): string {
  const parsed = parseActivityLine(line);
  return parsed ? `${parsed.time} ${parsed.ticket} ${parsed.message}` : line;
}

const BOARD_EVENTS = ["pane", "workspace", "poll", "decision", "resync"];

function RailTicketRow(props: {
  ticket: BoardTicketData;
  isCurrent: boolean;
  rail: "reply" | "stalled" | "alive";
  onSelect: (id: string) => void;
}) {
  function submit(event: SubmitEvent): void {
    event.preventDefault();
    props.onSelect(props.ticket.identifier);
  }
  return (
    <li>
      <form onSubmit={submit}>
        <button
          class="slot"
          type="submit"
          data-state={props.rail}
          data-id={props.ticket.identifier}
          data-testid="rail-row"
          aria-current={props.isCurrent ? "true" : "false"}
        >
          <span class="slot-body">
            <span class="slot-top">
              <span class="tid">{props.ticket.identifier}</span>
              <span class="elapsed" data-level={props.ticket.level}>
                {fmtDur(props.ticket.elapsedMs)} / {fmtDur(props.ticket.budgetMs)}
                {props.ticket.level === "over" ? " OVER" : ""}
              </span>
            </span>
            <span class="ttitle">{props.ticket.title}</span>
            <span class="pulse">
              <i class="dot" />
              {props.ticket.pulse}
            </span>
            <span class="stageline">
              stage {props.ticket.stage ?? "?"} · {fmtDur(props.ticket.stageAgeMs)}
            </span>
          </span>
        </button>
      </form>
    </li>
  );
}

function AgentPane(props: {
  pane: BoardPaneData;
  isFocused: boolean;
  now: number;
  onFocus: (name: string) => void;
}) {
  let tty: HTMLPreElement | undefined;
  // The newest output is at the bottom: keep it visible whenever this
  // pane's text grows and whenever the pane becomes focused.
  createEffect(
    () => ({ text: props.pane.text, focused: props.isFocused }),
    (state) => {
      if (state.focused && tty) tty.scrollTop = tty.scrollHeight;
    },
  );
  function submit(event: SubmitEvent): void {
    event.preventDefault();
    props.onFocus(props.pane.name);
  }
  return (
    <div class="pane" data-focus={props.isFocused ? "true" : "false"} data-testid="pane" data-name={props.pane.name}>
      <form onSubmit={submit}>
        <button class="pane-head" type="submit" data-testid="pane-head">
          <i class="adot" data-state={props.pane.agentStatus} />
          <span class="pane-name">{props.pane.name}</span>
          <span class="pane-kind">{props.pane.kind ?? "—"}</span>
          <span class="pane-state">{paneStateText(props.pane, props.now)}</span>
        </button>
      </form>
      <Show when={props.pane.agentStatus === "notstarted" || props.pane.agentStatus === "unavailable"} fallback={
        <>
          <div class="peek" data-testid="pane-peek">{props.pane.lastLine || "(no output yet)"}</div>
          <pre ref={(el) => { tty = el; }} class="tty" data-testid="pane-tty">{props.pane.text || "(no output yet)"}</pre>
        </>
      }>
        <div class="pane-note" data-testid="pane-note">
          {props.pane.agentStatus === "notstarted" ? "not started" : "unavailable — Herdr unreachable"}
        </div>
      </Show>
    </div>
  );
}

function TicketStage(props: {
  ticket: BoardTicketData;
  block: "approval" | "quiet" | null;
  clearedText: string | undefined;
  focusName: string;
  now: number;
  answerError: string;
  onAnswer: (id: string, key: string) => void;
  onFocus: (name: string) => void;
}) {
  function submitAnswer(event: SubmitEvent): void {
    event.preventDefault();
    const key = (event.submitter as HTMLButtonElement | null)?.value === "n" ? "n" : "y";
    props.onAnswer(props.ticket.identifier, key);
  }
  function ignore(event: SubmitEvent): void {
    event.preventDefault();
  }
  const panes = [props.ticket.panes.commander, props.ticket.panes.builder, props.ticket.panes.reviewer];
  return (
    <>
      <Show when={props.block === "approval"}>
        <form class="blockbar" data-kind="approval" data-testid="blockbar" onSubmit={submitAnswer}>
          <div class="blockbar-text">
            <div class="lab">Needs approval</div>
            <p class="ask">{props.ticket.panes.commander.lastLine || "Approval requested"}</p>
            <p class="from">{props.ticket.panes.commander.name} is holding for approval</p>
          </div>
          <div class="acts">
            <button class="btn" data-size="sm" type="submit" name="key" value="y">
              Allow once
            </button>
            <button class="btn" data-variant="outline" data-size="sm" type="submit" name="key" value="n">
              Deny
            </button>
            <span class="keys">
              <kbd class="kbd">y</kbd> allow · <kbd class="kbd">n</kbd> deny
            </span>
          </div>
        </form>
      </Show>
      <Show when={props.block === "quiet"}>
        <form class="blockbar" data-kind="stalled" data-testid="blockbar" onSubmit={ignore}>
          <div class="blockbar-text">
            <div class="lab">Quiet for {fmtQuietAge(props.ticket.stageAgeMs)}</div>
            <p class="ask">{props.ticket.panes.commander.name} isn't blocked — it just isn't moving</p>
            <p class="from">stalled, not failed — the workspace stays open; park it with block when it needs a person</p>
          </div>
          <div class="acts">
            <button class="btn" data-size="sm" type="button" disabled title="Pane takeover ships with STA-165">
              Take over this pane
            </button>
            <button class="btn" data-variant="outline" data-size="sm" type="button" disabled title="Pane takeover ships with STA-165">
              Restart this stage
            </button>
          </div>
        </form>
      </Show>
      <Show when={props.clearedText !== undefined}>
        <div class="clearbar" data-testid="clearbar">{props.clearedText}</div>
      </Show>
      <Show when={props.answerError !== ""}>
        <div class="clearbar" data-testid="answer-error">{props.answerError}</div>
      </Show>
      <div class="panes">
        <For each={panes}>
          {(pane) => (
            <AgentPane
              pane={pane}
              isFocused={props.focusName === pane.name}
              now={props.now}
              onFocus={props.onFocus}
            />
          )}
        </For>
      </div>
    </>
  );
}

export function Home() {
  const [board, setBoard] = createSignal<BoardData | null>(null);
  const [boardError, setBoardError] = createSignal("");
  const [selected, setSelected] = createSignal<Selection | null>(null);
  const [focusedPane, setFocusedPane] = createSignal<string | null>(null);
  const [cleared, setCleared] = createSignal<Record<string, ClearedEntry>>({});
  const [answerError, setAnswerError] = createSignal("");
  const [pollNow, setPollNow] = createSignal(Date.now());

  async function loadBoard(): Promise<BoardData | null> {
    let data: BoardData | null = null;
    try {
      const res = await fetch("/api/board");
      if (!res.ok) {
        setBoardError(res.status === 503 ? "dispatch starting…" : `board failed (${res.status})`);
        return null;
      }
      data = (await res.json()) as BoardData;
    } catch {
      setBoardError("dispatch unreachable");
      return null;
    }
    setBoardError("");
    setBoard(data);
    const done = untrack(cleared);
    if (Object.keys(done).length > 0) {
      const kept: Record<string, ClearedEntry> = {};
      let dropped = false;
      for (const [cid, entry] of Object.entries(done)) {
        const live = data.tickets.find((t) => t.identifier === cid);
        if (live && live.block !== null && live.block === entry.block) kept[cid] = entry;
        else dropped = true;
      }
      if (dropped) setCleared(kept);
    }
    return data;
  }

  function select(id: Selection): void {
    setSelected(id);
    setFocusedPane(null);
  }

  async function answerTicket(id: string, key: string): Promise<void> {
    setAnswerError("");
    let reply: { ok: boolean; text?: string };
    try {
      const res = await fetch("/api/command", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ argv: ["answer", id, key] }),
      });
      reply = (await res.json()) as { ok: boolean; text?: string };
    } catch {
      setAnswerError("dispatch unreachable");
      return;
    }
    if (!reply.ok) {
      setAnswerError(reply.text ?? "answer failed");
      return;
    }
    const merged = {
      ...untrack(cleared),
      [id]: {
        key,
        text: reply.text ?? `answered ${key}`,
        block: untrack(board)?.tickets.find((t) => t.identifier === id)?.block ?? "approval",
      },
    };
    setCleared(merged);
    const data = await loadBoard();
    select(data ? nextWaiting(data, merged) : "nobody");
  }

  function selectView(id: Selection) {
    return (event: SubmitEvent) => {
      event.preventDefault();
      select(id);
    };
  }

  onSettled(() => {
    void loadBoard();
    const tick = setInterval(() => setPollNow(Date.now()), 1000);
    const slow = setInterval(() => {
      void loadBoard();
    }, 5000);
    let source: EventSource | null = null;
    let reloadTimer: ReturnType<typeof setTimeout> | null = null;
    const queueReload = (): void => {
      if (reloadTimer) return;
      reloadTimer = setTimeout(() => {
        reloadTimer = null;
        void loadBoard();
      }, 300);
    };
    try {
      if (typeof EventSource !== "undefined") {
        source = new EventSource("/events");
        for (const type of BOARD_EVENTS) source.addEventListener(type, queueReload);
      }
    } catch {
      source = null;
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "y" && event.key !== "Y" && event.key !== "n" && event.key !== "N") return;
      const active = document.activeElement;
      if (active && ["INPUT", "SELECT", "TEXTAREA"].includes(active.tagName)) return;
      // The same ticket the stage shows: y/n always answers the bar on screen.
      const found = untrack(stageTicket);
      if (!found || effectiveBlock(found, untrack(cleared)) !== "approval") return;
      event.preventDefault();
      void answerTicket(found.identifier, event.key.toLowerCase() === "n" ? "n" : "y");
    };
    document.addEventListener("keydown", onKey);
    return () => {
      clearInterval(tick);
      clearInterval(slow);
      if (reloadTimer) clearTimeout(reloadTimer);
      document.removeEventListener("keydown", onKey);
      source?.close();
    };
  });

  const tickets = createMemo((): BoardTicketData[] => board()?.tickets ?? []);
  const queue = createMemo((): QueueEntryData[] => board()?.queue ?? []);
  const activity = createMemo((): string[] => board()?.activity ?? []);

  const current = createMemo((): Selection => {
    const data = board();
    if (!data) return "queue";
    const sel = selected();
    if (sel && (data.tickets.some((t) => t.identifier === sel) || DISPATCH_VIEWS.includes(sel))) {
      return sel;
    }
    return defaultSelection(data, cleared());
  });

  const stageTicket = createMemo((): BoardTicketData | null => {
    const data = board();
    const sel = current();
    return data?.tickets.find((t) => t.identifier === sel) ?? null;
  });

  const needsYou = createMemo((): number => {
    const data = board();
    if (!data) return 0;
    const done = cleared();
    return data.tickets.filter((t) => effectiveBlock(t, done) === "approval").length;
  });

  const pollAge = createMemo((): string | null => {
    const at = board()?.lastPollAt ?? null;
    if (!at) return null;
    const ms = pollNow() - Date.parse(at);
    return `${Math.max(0, Math.floor(ms / 1000))}`;
  });

  const pollLate = createMemo((): boolean => {
    const at = board()?.lastPollAt ?? null;
    if (!at) return true;
    return pollNow() - Date.parse(at) > 60000;
  });

  return (
    <>
      <header class="topbar">
        <div class="flex items-center gap-2 min-w-0">
          <span class="logo-mark" aria-hidden="true">🔥</span>
          <span class="font-semibold text-sm">igniter</span>
          <span class="text-muted-foreground">/</span>
          <span class="text-sm text-muted-foreground truncate font-mono" data-testid="host">{board()?.host ?? "…"}</span>
        </div>
        <div class="flex items-center gap-3">
          <span class="poll" data-testid="poll" data-late={pollLate() ? "true" : "false"}>
            <i class="poll-dot" />
            <Show when={pollAge() !== null} fallback={<span>dispatch not running</span>}>
              <span>
                last Linear poll <span class="n" data-testid="poll-age">{pollAge()}</span>s ago
              </span>
            </Show>
          </span>
          <span class="text-xs text-muted-foreground tabular-nums" data-testid="slots">
            {board() ? `${(board() as BoardData).usedSlots} / ${(board() as BoardData).maxRunning} slots` : "…"}
          </span>
          <span class="badge" id="alert" data-variant={needsYou() === 0 ? undefined : "destructive"} data-count={needsYou()} data-testid="needs-you">
            Needs you <span class="n">{needsYou()}</span>
          </span>
        </div>
      </header>

      <main class="board">
        <nav class="rail" aria-label="Building tickets and dispatch">
          <ul class="rail-list">
            <li class="rail-head">
              Building{" "}
              <span class="rail-count" data-testid="rail-count">
                {board() ? `${(board() as BoardData).tickets.length} / ${(board() as BoardData).maxRunning}` : "…"}
              </span>
            </li>
            <Show when={boardError() !== ""}>
              <li class="rail-head" data-testid="board-error">{boardError()}</li>
            </Show>
            <Show when={tickets().length === 0 && boardError() === ""}>
              <li class="rail-head">no building tickets</li>
            </Show>
            <For each={tickets()}>
              {(item) => (
                <RailTicketRow
                  ticket={item}
                  isCurrent={current() === item.identifier}
                  rail={effectiveRail(item, cleared())}
                  onSelect={select}
                />
              )}
            </For>
            <li class="rail-head">Dispatch</li>
            <li>
              <form onSubmit={selectView("queue")}>
                <button class="slot" type="submit" data-state="view" data-id="queue" data-testid="rail-row" aria-current={current() === "queue" ? "true" : "false"}>
                  <span class="slot-body">
                    <span class="slot-top">
                      <span class="tid">Queue</span>
                      <span class="elapsed">{queue().length} in Ready to build</span>
                    </span>
                    <span class="ttitle">{queue()[0] ? `${(queue()[0] as QueueEntryData).identifier} next` : "empty"}</span>
                  </span>
                </button>
              </form>
            </li>
            <li>
              <form onSubmit={selectView("activity")}>
                <button class="slot" type="submit" data-state="view" data-id="activity" data-testid="rail-row" aria-current={current() === "activity" ? "true" : "false"}>
                  <span class="slot-body">
                    <span class="slot-top">
                      <span class="tid">Activity</span>
                      <span class="elapsed">{activity().length} decisions</span>
                    </span>
                    <span class="ttitle">{activity()[0] ? activitySummary(activity()[0] as string) : "no decisions yet"}</span>
                  </span>
                </button>
              </form>
            </li>
            <li>
              <form onSubmit={selectView("rules")}>
                <button class="slot" type="submit" data-state="view" data-id="rules" data-testid="rail-row" aria-current={current() === "rules" ? "true" : "false"}>
                  <span class="slot-body">
                    <span class="slot-top">
                      <span class="tid">Workflow</span>
                      <span class="elapsed">{board()?.rules ? `${(board() as BoardData).rules.split("\n").length} lines` : "…"}</span>
                    </span>
                    <span class="ttitle">Commander playbook, bundled with igniter</span>
                  </span>
                </button>
              </form>
            </li>
          </ul>
        </nav>

        <div class="stage" data-testid="stage">
          <Show when={stageTicket()} keyed>
            {(found) => (
              <TicketStage
                ticket={found}
                block={effectiveBlock(found, cleared())}
                clearedText={cleared()[found.identifier]?.text}
                focusName={focusNameFor(found, focusedPane())}
                now={pollNow()}
                answerError={answerError()}
                onAnswer={answerTicket}
                onFocus={setFocusedPane}
              />
            )}
          </Show>

          <Show when={stageTicket() === null && current() === "queue"}>
            <section class="view" data-view="queue" data-testid="view-queue">
              <div class="sheetview">
                <div class="sheet">
                  <div class="sheet-head">
                    <span>Ready to build, in claim order</span>
                    <span class="sheet-note">priority first, then longest waiting</span>
                  </div>
                  <ul class="sheet-list">
                    <For each={queue()} fallback={<li class="sheet-row">empty</li>}>
                      {(entry, index) => (
                        <li class="sheet-row" data-state={entry.reason.startsWith("skipped") ? "skip" : "wait"} data-testid="queue-row">
                          <span class="sheet-n">{index() + 1}</span>
                          <span class="sheet-main">
                            <span class="slot-top">
                              <a class="tid" href={linearUrl(board()?.linearOrg ?? "", entry.identifier)} target="_blank" rel="noopener">
                                {entry.identifier}
                              </a>
                              <span class="ttitle">{entry.title}</span>
                            </span>
                            <span class="sheet-meta">priority {entry.priority}</span>
                          </span>
                          <span class="reason">{entry.reason}</span>
                        </li>
                      )}
                    </For>
                  </ul>
                </div>
              </div>
            </section>
          </Show>

          <Show when={stageTicket() === null && current() === "activity"}>
            <section class="view" data-view="activity" data-testid="view-activity">
              <div class="sheetview">
                <div class="sheet">
                  <div class="sheet-head">
                    <span>What the runner decided today</span>
                    <span class="sheet-note">newest first · polls are not decisions and are not listed</span>
                  </div>
                  <ul class="sheet-list">
                    <For each={activity()} fallback={<li class="sheet-row">no decisions yet</li>}>
                      {(line) => {
                        const parsed = parseActivityLine(line);
                        if (!parsed) return <li class="sheet-row" data-testid="activity-row">{line}</li>;
                        return (
                          <li class="sheet-row" data-testid="activity-row">
                            <span class="act-time">{parsed.time}</span>
                            <span class="sheet-main">
                              <a class="tid" href={linearUrl(board()?.linearOrg ?? "", parsed.ticket)} target="_blank" rel="noopener">
                                {parsed.ticket}
                              </a>{" "}
                              <span class="act-text">{parsed.message}</span>
                            </span>
                          </li>
                        );
                      }}
                    </For>
                  </ul>
                </div>
              </div>
            </section>
          </Show>

          <Show when={stageTicket() === null && current() === "rules"}>
            <section class="view" data-view="rules" data-testid="view-rules">
              <div class="rulesview">
                <pre class="rules">{board()?.rules || "(no rules loaded)"}</pre>
              </div>
            </section>
          </Show>

          <Show when={stageTicket() === null && current() === "nobody"}>
            <div class="empty-stage" data-testid="view-nobody">Nobody is waiting on you</div>
          </Show>
        </div>
      </main>
    </>
  );
}
