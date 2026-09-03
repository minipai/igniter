// @vitest-environment jsdom

import { render } from "@solidjs/web";
import { flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { paths } from "./router";

let dispose: (() => void) | undefined;

function renderApp() {
  dispose?.();
  document.body.innerHTML = "";
  document.documentElement.classList.remove("dark");
  window.history.replaceState(null, "", "/");
  dispose = render(() => <App />, document.body);
}

function stubHealth() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      json: async () => ({ ok: true, service: "igniter" }),
    })),
  );
}

async function settle(): Promise<void> {
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

describe("skeleton shell", () => {
  it("shows a Basecoat card and button with the Bun health JSON", async () => {
    stubHealth();
    renderApp();

    expect(document.querySelector(".card")).not.toBeNull();
    expect(document.querySelector("a.btn")?.getAttribute("href")).toBe("/tickets/STA-1");

    await settle();
    expect(document.querySelector('[data-testid="health"]')?.textContent).toContain(
      '"service":"igniter"',
    );
  });

  it("toggles html.dark from the header button", async () => {
    stubHealth();
    renderApp();
    await settle();

    const toggle = document.querySelector("header.topbar button.btn");
    if (!(toggle instanceof HTMLButtonElement)) throw new Error("theme toggle is missing");
    expect(toggle.textContent).toBe("Dark");
    toggle.click();
    flush();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(toggle.textContent).toBe("Light");
  });

  it("submits the jump form natively and renders the ticket route", async () => {
    stubHealth();
    renderApp();
    await settle();

    expect(String(paths.tickets("STA-1"))).toBe("/tickets/STA-1");

    const form = document.querySelector("form.jump-form");
    const input = document.querySelector('input[name="id"]');
    if (!(form instanceof HTMLFormElement) || !(input instanceof HTMLInputElement)) {
      throw new Error("jump form is missing");
    }
    input.value = "STA-1";
    form.requestSubmit();
    await settle();

    expect(document.querySelector('[data-testid="ticket-title"]')?.textContent).toBe("STA-1");
  });

  it("renders the ticket route on direct load", async () => {
    stubHealth();
    dispose?.();
    document.body.innerHTML = "";
    window.history.replaceState(null, "", "/tickets/STA-42");
    dispose = render(() => <App />, document.body);
    await settle();

    expect(document.querySelector('[data-testid="ticket-title"]')?.textContent).toBe("STA-42");
  });
});
