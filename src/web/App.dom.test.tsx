// @vitest-environment jsdom

import { render } from "@solidjs/web";
import { flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";

let dispose: (() => void) | undefined;

function renderApp() {
  dispose?.();
  document.body.innerHTML = "";
  document.documentElement.classList.remove("dark");
  window.history.replaceState(null, "", "/");
  dispose = render(() => <App />, document.body);
}

const STATUS_DATA = {
  slots: { used: 1, max: 3 },
  lastPollAt: "2026-09-05T11:59:48.000Z",
  tickets: [
    {
      identifier: "STA-1",
      title: "First",
      state: "Building",
      hasWorkspace: true,
      stage: "build",
      stageAt: "2026-09-05T11:26:00.000Z",
      startedAt: "2026-09-05T10:48:00.000Z",
      elapsedMs: 4320000,
      budgetMs: 14400000,
      over: false,
      commander: "working",
      paused: false,
      stalled: false,
      overBudget: false,
    },
  ],
};

function stubFetch(onCommand: (argv: string[]) => { ok: boolean; text: string }) {
  const calls: string[][] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: { body?: string }) => {
      const argv = JSON.parse(String(init?.body ?? "{}")).argv as string[];
      calls.push(argv);
      if (argv[0] === "status") {
        return { json: async () => ({ ok: true, text: "1 / 3 slots", data: STATUS_DATA }) };
      }
      return { json: async () => onCommand(argv) };
    }),
  );
  return calls;
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  flush();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  flush();
}

afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  document.documentElement.classList.remove("dark");
  window.history.replaceState(null, "", "/");
});

describe("Building panel", () => {
  it("renders rows from status data with slots", async () => {
    stubFetch(() => ({ ok: true, text: "done" }));
    renderApp();
    await settle();

    expect(document.querySelector('[data-testid="slots"]')?.textContent).toContain("1 / 3 slots");
    const rows = document.querySelectorAll('[data-testid="ticket-row"]');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.getAttribute("data-identifier")).toBe("STA-1");
    expect(rows[0]?.textContent).toContain("STA-1");
    expect(rows[0]?.textContent).toContain("commander working");
  });

  it("submits Pause through a native form and shows the result text", async () => {
    const calls = stubFetch((argv) => ({ ok: true, text: `${argv[0]} ${argv[1]} ok` }));
    renderApp();
    await settle();

    const row = document.querySelector('[data-testid="ticket-row"]');
    if (!row) throw new Error("ticket row is missing");
    const pauseForm = [...row.querySelectorAll("form")].find((form) =>
      form.textContent?.includes("Pause"),
    );
    if (!(pauseForm instanceof HTMLFormElement)) throw new Error("pause form is missing");
    const button = pauseForm.querySelector("button");
    expect(button?.type).toBe("submit");

    pauseForm.requestSubmit();
    await settle();

    expect(calls).toContainEqual(["pause", "STA-1"]);
    expect(document.querySelector('[data-testid="result"]')?.textContent).toContain("pause STA-1 ok");
  });

  it("sends fail with the reason input and restart with the model input", async () => {
    const calls = stubFetch((argv) => ({ ok: true, text: argv.join(" ") }));
    renderApp();
    await settle();

    const row = document.querySelector('[data-testid="ticket-row"]');
    if (!row) throw new Error("ticket row is missing");
    const failForm = [...row.querySelectorAll("form")].find((form) =>
      form.textContent?.includes("Fail"),
    );
    const restartForm = [...row.querySelectorAll("form")].find((form) =>
      form.textContent?.includes("Restart"),
    );
    if (!(failForm instanceof HTMLFormElement) || !(restartForm instanceof HTMLFormElement)) {
      throw new Error("fail/restart forms are missing");
    }
    (failForm.querySelector('input[name="reason"]') as HTMLInputElement).value = "wedged";
    failForm.requestSubmit();
    await settle();
    expect(calls).toContainEqual(["fail", "STA-1", "--reason", "wedged"]);

    (restartForm.querySelector('input[name="model"]') as HTMLInputElement).value = "new/model";
    restartForm.requestSubmit();
    await settle();
    expect(calls).toContainEqual(["restart", "STA-1", "--builder", "new/model"]);
  });

  it("starts a ticket from the start form", async () => {
    const calls = stubFetch((argv) => ({ ok: true, text: argv.join(" ") }));
    renderApp();
    await settle();

    const form = document.querySelector("form.start-form");
    if (!(form instanceof HTMLFormElement)) throw new Error("start form is missing");
    (form.querySelector('input[name="ticket"]') as HTMLInputElement).value = "STA-9";
    (form.querySelector('input[name="builder"]') as HTMLInputElement).value = "custom/b";
    form.requestSubmit();
    await settle();

    expect(calls).toContainEqual(["start", "STA-9", "--builder", "custom/b"]);
    expect(document.querySelector('[data-testid="result"]')?.textContent).toContain("STA-9");
  });

  it("renders the ticket route on direct load", async () => {
    stubFetch(() => ({ ok: true, text: "done" }));
    dispose?.();
    document.body.innerHTML = "";
    window.history.replaceState(null, "", "/tickets/STA-42");
    dispose = render(() => <App />, document.body);
    await settle();

    expect(document.querySelector('[data-testid="ticket-title"]')?.textContent).toBe("STA-42");
  });
});

describe("theme toggle", () => {
  it("toggles html.dark through the header form submit", async () => {
    stubFetch(() => ({ ok: true, text: "done" }));
    renderApp();
    await settle();

    const form = document.querySelector("header.topbar form");
    const toggle = document.querySelector("header.topbar button.btn");
    if (!(form instanceof HTMLFormElement) || !(toggle instanceof HTMLButtonElement)) {
      throw new Error("theme toggle form is missing");
    }
    expect(toggle.type).toBe("submit");
    expect(toggle.textContent).toBe("Dark");
    form.requestSubmit();
    flush();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(toggle.textContent).toBe("Light");
    form.requestSubmit();
    flush();
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(toggle.textContent).toBe("Dark");
  });
});
