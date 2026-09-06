// @vitest-environment jsdom

// Board page: rail order, Needs-you count, block bar + answer flow, pane
// focus, poll heartbeat, and the three dispatch views. Fetch, EventSource,
// and timers are faked; no network, no daemon.

import { render } from "@solidjs/web";
import { flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

let dispose: (() => void) | undefined;

interface FixtureOptions {
  approvals?: string[];
  quiet?: string[];
  alive?: string[];
  lastPollAt?: string;
  queue?: { identifier: string; title: string; priority: number; reason: string }[];
  activity?: string[];
  rules?: string;
}

function ticket(identifier: string, kind: "approval" | "quiet" | "alive") {
  const commanderStatus = kind === "approval" ? "blocked" : "working";
  const lower = identifier.toLowerCase();
  const elapsed = kind === "quiet" ? 222 * 60_000 : 40 * 60_000;
  return {
    identifier,
    title: `Title ${identifier}`,
    state: "Building",
    workspaceId: `ws-${lower}`,
    elapsedMs: elapsed,
    budgetMs: 4 * 3600_000,
    level: kind === "quiet" ? "near" : "ok",
    stage: kind === "quiet" ? "verify" : "build",
    stageAgeMs: 5 * 60_000,
    stalled: kind === "quiet",
    paused: false,
    block: kind === "approval" ? "approval" : kind === "quiet" ? "quiet" : null,
    railState: kind === "approval" ? "reply" : kind === "quiet" ? "stalled" : "alive",
    pulse: kind === "approval" ? "waiting on you · 2m" : kind === "quiet" ? "quiet 5m" : "alive · output 8s ago",
    panes: {
      commander: {
        name: `commander-${lower}`,
        kind: "claude",
        agentStatus: commanderStatus,
        lastOutputAt: "2026-09-05T11:59:50.000Z",
        lastLine: `[commander] waiting on owner response…`,
        text: `[commander] holding for approval\n[commander] waiting on owner response…`,
        paneId: `pane-c-${lower}`,
      },
      builder: {
        name: `builder-${lower}`,
        kind: "opencode",
        agentStatus: "idle",
        lastOutputAt: "2026-09-05T11:58:00.000Z",
        lastLine: "[opencode] standing by…",
        text: "[opencode] standing by…",
        paneId: `pane-b-${lower}`,
      },
      reviewer: {
        name: `reviewer-${lower}`,
        kind: null,
        agentStatus: "notstarted",
        lastOutputAt: null,
        lastLine: "",
        text: "",
        paneId: null,
      },
    },
  };
}

function boardFixture(options: FixtureOptions = {}) {
  const approvals = options.approvals ?? ["STA-1"];
  const quiet = options.quiet ?? ["STA-2"];
  const alive = options.alive ?? ["STA-3"];
  return {
    host: "minipc",
    usedSlots: 2,
    maxRunning: 3,
    linearOrg: "starcoder",
    lastPollAt: options.lastPollAt ?? new Date(Date.now() - 12_000).toISOString(),
    needsYou: approvals.length,
    queue: options.queue ?? [
      { identifier: "STA-5", title: "Queued one", priority: 2, reason: "next" },
      { identifier: "STA-6", title: "Queued two", priority: 4, reason: "waiting, slots full" },
    ],
    activity: options.activity ?? [
      "2026-09-05T11:50:00.000Z STA-1 claimed: Ready to build → Building (slot 0)",
      "2026-09-05T11:40:00.000Z STA-2 claimed: Ready to build → Building (slot 1)",
    ],
    rules: options.rules ?? "# Commander rules\n\nBe kind.\n",
    tickets: [
      ...approvals.map((id) => ticket(id, "approval")),
      ...quiet.map((id) => ticket(id, "quiet")),
      ...alive.map((id) => ticket(id, "alive")),
    ],
  };
}

type BoardJson = ReturnType<typeof boardFixture>;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners: Record<string, (() => void)[]> = {};
  closed = false;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: () => void): void {
    (this.listeners[type] ??= []).push(fn);
  }
  fire(type: string): void {
    for (const fn of this.listeners[type] ?? []) fn();
  }
  close(): void {
    this.closed = true;
  }
}

const commands: string[][] = [];
let boardJson: BoardJson = boardFixture();

function stubFetch() {
  commands.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { body?: string }) => {
      if (url === "/api/board") {
        // Fresh identities per fetch, like a real JSON parse: memo gates
        // must see nested changes, not just a new top-level reference.
        return { ok: true, status: 200, json: async () => structuredClone(boardJson) };
      }
      if (url === "/api/command") {
        const argv = JSON.parse(String(init?.body ?? "{}")).argv as string[];
        commands.push(argv);
        const id = argv[1] as string;
        const key = argv[2] as string;
        return {
          ok: true,
          json: async () => ({
            ok: true,
            text: `answered ${key} for ${id} (${key === "y" ? "allowed once" : "denied"}); commander pane received the key`,
          }),
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
}

function renderApp() {
  dispose?.();
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/");
  dispose = render(() => <App />, document.body);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await Promise.resolve();
    flush();
  }
  await Promise.resolve();
}

async function settleTimers(ms: number): Promise<void> {
  vi.advanceTimersByTime(ms);
  await settle();
}

function railTicketIds(): string[] {
  return [...document.querySelectorAll('[data-testid="rail-row"][data-id^="STA-"]')].map(
    (el) => el.getAttribute("data-id") as string,
  );
}

function submitForm(form: HTMLFormElement): void {
  form.requestSubmit();
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.instances = [];
  boardJson = boardFixture();
  stubFetch();
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = "";
  document.documentElement.classList.remove("dark");
  window.history.replaceState(null, "", "/");
});

describe("rail and topbar", () => {
  it("orders approval → quiet → alive with slots and a destructive Needs-you badge", async () => {
    renderApp();
    await settle();

    expect(railTicketIds()).toEqual(["STA-1", "STA-2", "STA-3"]);
    expect(document.querySelector('[data-testid="slots"]')?.textContent).toContain("2 / 3 slots");
    expect(document.querySelector('[data-testid="host"]')?.textContent).toBe("minipc");
    const badge = document.querySelector('[data-testid="needs-you"]');
    expect(badge?.textContent).toContain("Needs you 1");
    expect(badge?.getAttribute("data-variant")).toBe("destructive");
    expect(badge?.getAttribute("data-count")).toBe("1");
  });

  it("greys the badge at 0 and hides the block bar", async () => {
    boardJson = boardFixture({ approvals: [], quiet: [], alive: ["STA-3"] });
    renderApp();
    await settle();

    expect(railTicketIds()).toEqual(["STA-3"]);
    const badge = document.querySelector('[data-testid="needs-you"]');
    expect(badge?.textContent).toContain("Needs you 0");
    expect(badge?.getAttribute("data-variant")).toBeNull();
    expect(badge?.getAttribute("data-count")).toBe("0");
    expect(document.querySelector('[data-testid="blockbar"]')).toBeNull();
    expect(badge?.matches('#alert[data-count="0"]')).toBe(true);
  });

  it("shows the quiet block bar for a stalled ticket", async () => {
    renderApp();
    await settle();

    const stalled = [...document.querySelectorAll('[data-testid="rail-row"]')].find(
      (el) => el.getAttribute("data-id") === "STA-2",
    );
    submitForm(stalled?.closest("form") as HTMLFormElement);
    await settle();

    const bar = document.querySelector('[data-testid="blockbar"]');
    expect(bar?.getAttribute("data-kind")).toBe("stalled");
    expect(bar?.textContent).toContain("Quiet for 5 minutes");
    expect(bar?.textContent).not.toContain("m minutes");
  });
});

describe("answering approvals", () => {
  it("sends y through the Allow form, shows the result, and moves to the next waiting ticket", async () => {
    boardJson = boardFixture({ approvals: ["STA-1", "STA-4"], quiet: [], alive: [] });
    renderApp();
    await settle();

    expect(document.querySelector('[data-testid="blockbar"]')?.textContent).toContain("commander-sta-1");
    const form = document.querySelector('[data-testid="blockbar"]');
    if (!(form instanceof HTMLFormElement)) throw new Error("blockbar form is missing");
    submitForm(form);
    await settle();

    expect(commands).toContainEqual(["answer", "STA-1", "y"]);
    expect(document.querySelector('[data-testid="needs-you"]')?.textContent).toContain("Needs you 1");
    // The answered ticket keeps its one-line result; the stage moved on.
    const stage = document.querySelector('[data-testid="stage"]');
    expect(stage?.textContent).toContain("commander-sta-4");
    const back = [...document.querySelectorAll('[data-testid="rail-row"]')].find(
      (el) => el.getAttribute("data-id") === "STA-1",
    );
    submitForm(back?.closest("form") as HTMLFormElement);
    await settle();
    expect(document.querySelector('[data-testid="clearbar"]')?.textContent).toContain("answered y for STA-1");
  });

  it("shows Nobody is waiting on you when nothing is left", async () => {
    renderApp();
    await settle();

    const form = document.querySelector('[data-testid="blockbar"]');
    if (!(form instanceof HTMLFormElement)) throw new Error("blockbar form is missing");
    submitForm(form);
    await settle();

    expect(commands).toContainEqual(["answer", "STA-1", "y"]);
    expect(document.querySelector('[data-testid="view-nobody"]')?.textContent).toBe("Nobody is waiting on you");
    expect(document.querySelector('[data-testid="needs-you"]')?.textContent).toContain("Needs you 0");
  });

  it("shows the bar again when a ticket blocks after being clear", async () => {
    renderApp();
    await settle();

    const form = document.querySelector('[data-testid="blockbar"]');
    if (!(form instanceof HTMLFormElement)) throw new Error("blockbar form is missing");
    submitForm(form);
    await settle();
    expect(document.querySelector('[data-testid="view-nobody"]')).not.toBeNull();

    // The commander resumed: the board shows no block, so the reload drops
    // the answered entry.
    const first = boardJson.tickets[0];
    if (!first) throw new Error("fixture ticket is missing");
    first.block = null;
    first.railState = "alive";
    first.pulse = "alive · output just now ago";
    boardJson = { ...boardJson };
    FakeEventSource.instances[0]?.fire("poll");
    await settleTimers(300);

    // A later genuine approval blocks again: count +1, bar visible.
    first.block = "approval";
    first.railState = "reply";
    first.pulse = "waiting on you · 1m";
    boardJson = { ...boardJson };
    FakeEventSource.instances[0]?.fire("poll");
    await settleTimers(300);
    expect(document.querySelector('[data-testid="needs-you"]')?.textContent).toContain("Needs you 1");

    const row = [...document.querySelectorAll('[data-testid="rail-row"]')].find(
      (el) => el.getAttribute("data-id") === "STA-1",
    );
    submitForm(row?.closest("form") as HTMLFormElement);
    await settle();
    expect(document.querySelector('[data-testid="blockbar"]')?.textContent).toContain("commander-sta-1");
  });

  it("answers with the y key when no input has focus", async () => {
    renderApp();
    await settle();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "y", bubbles: true }));
    await settle();

    expect(commands).toContainEqual(["answer", "STA-1", "y"]);
  });
});

describe("panes", () => {
  it("shows all three panes at once with peeks, and focuses on submit", async () => {
    renderApp();
    await settle();

    const panes = [...document.querySelectorAll('[data-testid="pane"]')];
    expect(panes.map((p) => p.getAttribute("data-name"))).toEqual([
      "commander-sta-1",
      "builder-sta-1",
      "reviewer-sta-1",
    ]);
    const focused = panes.find((p) => p.getAttribute("data-focus") === "true");
    expect(focused?.getAttribute("data-name")).toBe("commander-sta-1");
    const peeks = [...document.querySelectorAll('[data-testid="pane-peek"]')].map((el) => el.textContent);
    expect(peeks).toContain("[opencode] standing by…");
    expect(document.querySelector('[data-testid="pane-note"]')?.textContent).toBe("not started");

    const builderForm = document.querySelector('[data-testid="pane"][data-name="builder-sta-1"] form');
    if (!(builderForm instanceof HTMLFormElement)) throw new Error("pane focus form is missing");
    submitForm(builderForm);
    flush();

    expect(
      document.querySelector('[data-testid="pane"][data-name="builder-sta-1"]')?.getAttribute("data-focus"),
    ).toBe("true");
    expect(
      document.querySelector('[data-testid="pane"][data-name="commander-sta-1"]')?.getAttribute("data-focus"),
    ).toBe("false");
  });

  it("scrolls the focused pane to the newest output", async () => {
    renderApp();
    await settle();

    const tty = document.querySelector(
      '[data-testid="pane"][data-name="commander-sta-1"] [data-testid="pane-tty"]',
    );
    if (!(tty instanceof HTMLPreElement)) throw new Error("tty is missing");
    // jsdom reports 0 for both, and the pre remounts on reload: stub the
    // height on the prototype so the scroll is observable either way.
    const proto: Record<string, unknown> = window.HTMLPreElement.prototype as unknown as Record<string, unknown>;
    const original = Object.getOwnPropertyDescriptor(proto, "scrollHeight");
    Object.defineProperty(proto, "scrollHeight", { value: 500, configurable: true });
    try {
      const commander = boardJson.tickets[0]?.panes.commander;
      if (!commander) throw new Error("fixture pane is missing");
      commander.text = `${commander.text}\n[commander] 1. Yes / 2. Always / 3. No`;
      commander.lastLine = "[commander] 1. Yes / 2. Always / 3. No";
      boardJson = { ...boardJson };
      FakeEventSource.instances[0]?.fire("pane");
      await settleTimers(300);

      const fresh = document.querySelector(
        '[data-testid="pane"][data-name="commander-sta-1"] [data-testid="pane-tty"]',
      );
      if (!(fresh instanceof HTMLPreElement)) throw new Error("fresh tty is missing");
      expect(fresh.scrollTop).toBe(500);
      expect(fresh.textContent).toContain("1. Yes");
    } finally {
      if (original) Object.defineProperty(proto, "scrollHeight", original);
      else delete (proto as { scrollHeight?: unknown }).scrollHeight;
    }
  });
});

describe("poll heartbeat", () => {
  it("ticks every second and resets on a poll event", async () => {
    renderApp();
    await settle();

    expect(document.querySelector('[data-testid="poll-age"]')?.textContent).toBe("12");
    await settleTimers(3000);
    expect(document.querySelector('[data-testid="poll-age"]')?.textContent).toBe("15");

    boardJson = { ...boardJson, lastPollAt: new Date(Date.now()).toISOString() };
    FakeEventSource.instances[0]?.fire("poll");
    await settleTimers(300);
    expect(document.querySelector('[data-testid="poll-age"]')?.textContent).toBe("0");
  });
});

describe("dark mode", () => {
  it("follows prefers-color-scheme on html.dark without a button", async () => {
    const listeners = new Set<() => void>();
    const query = {
      matches: true,
      addEventListener: (_type: string, fn: () => void) => {
        listeners.add(fn);
      },
      removeEventListener: (_type: string, fn: () => void) => {
        listeners.delete(fn);
      },
    };
    vi.stubGlobal("matchMedia", vi.fn(() => query));
    renderApp();
    await settle();

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    query.matches = false;
    for (const fn of listeners) fn();
    flush();
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
});
describe("router", () => {
  it("renders the ticket route on direct load", async () => {
    dispose?.();
    document.body.innerHTML = "";
    window.history.replaceState(null, "", "/tickets/STA-42");
    dispose = render(() => <App />, document.body);
    await settle();

    expect(document.querySelector('[data-testid="ticket-title"]')?.textContent).toBe("STA-42");
  });
});
describe("dispatch views", () => {
  it("renders Queue, Activity, and Workflow from board data", async () => {
    renderApp();
    await settle();

    const queueButton = [...document.querySelectorAll('[data-testid="rail-row"]')].find(
      (el) => el.getAttribute("data-id") === "queue",
    );
    submitForm(queueButton?.closest("form") as HTMLFormElement);
    await settle();

    const queueRows = [...document.querySelectorAll('[data-testid="queue-row"]')];
    expect(queueRows).toHaveLength(2);
    expect(queueRows[0]?.textContent).toContain("STA-5");
    expect(queueRows[0]?.textContent).toContain("next");
    expect(queueRows[1]?.textContent).toContain("waiting, slots full");
    expect(queueRows[0]?.querySelector("a")?.getAttribute("href")).toBe(
      "https://linear.app/starcoder/issue/STA-5",
    );

    const activityButton = [...document.querySelectorAll('[data-testid="rail-row"]')].find(
      (el) => el.getAttribute("data-id") === "activity",
    );
    submitForm(activityButton?.closest("form") as HTMLFormElement);
    await settle();

    const activityRows = [...document.querySelectorAll('[data-testid="activity-row"]')];
    expect(activityRows).toHaveLength(2);
    expect(activityRows[0]?.textContent).toContain("STA-1");
    expect(activityRows[0]?.textContent).toContain("claimed: Ready to build → Building (slot 0)");
    // Decision times render in the browser's local time, never raw UTC ISO.
    const stamp = new Date("2026-09-05T11:50:00.000Z");
    const local = `${String(stamp.getHours()).padStart(2, "0")}:${String(stamp.getMinutes()).padStart(2, "0")}`;
    expect(activityRows[0]?.textContent).toContain(local);
    const railSummary = document.querySelector('[data-testid="rail-row"][data-id="activity"] .ttitle');
    expect(railSummary?.textContent).toContain(`${local} STA-1`);
    expect(railSummary?.textContent).not.toContain("2026-09-05T");

    const rulesButton = [...document.querySelectorAll('[data-testid="rail-row"]')].find(
      (el) => el.getAttribute("data-id") === "rules",
    );
    submitForm(rulesButton?.closest("form") as HTMLFormElement);
    await settle();

    expect(document.querySelector('[data-testid="view-rules"] pre')?.textContent).toContain("# Commander rules");
  });
});
