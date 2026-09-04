import { createSignal, For, onSettled } from "solid-js";

interface BuildingTicket {
  identifier: string;
  title: string;
  state: string;
  hasWorkspace: boolean;
  stage: string | null;
  stageAt: string | null;
  startedAt: string | null;
  elapsedMs: number | null;
  budgetMs: number;
  over: boolean;
  commander: string;
  paused: boolean;
  stalled: boolean;
  overBudget: boolean;
}

interface BuildingData {
  slots: { used: number; max: number };
  lastPollAt: string | null;
  tickets: BuildingTicket[];
}

interface CommandReply {
  ok: boolean;
  text?: string;
  data?: BuildingData;
}

async function postCommand(argv: string[]): Promise<CommandReply> {
  const res = await fetch("/api/command", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ argv }),
  });
  return (await res.json()) as CommandReply;
}

function formatElapsed(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "?";
  const minutes = Math.max(0, Math.floor(ms / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h${String(rest).padStart(2, "0")}m`;
}

function formatAgo(at: string | null): string {
  if (!at) return "?";
  const ms = Date.now() - Date.parse(at);
  if (!Number.isFinite(ms) || ms < 0) return "?";
  return `${formatElapsed(ms)} ago`;
}

export function Home() {
  const [tickets, setTickets] = createSignal<BuildingTicket[]>([]);
  const [slots, setSlots] = createSignal("loading…");
  const [result, setResult] = createSignal("");

  async function loadStatus(): Promise<void> {
    try {
      const reply = await postCommand(["status"]);
      const data = reply.data;
      if (!data) {
        setSlots("dispatch answered without data");
        return;
      }
      setTickets(data.tickets);
      setSlots(`${data.slots.used} / ${data.slots.max} slots`);
    } catch {
      setSlots("dispatch unreachable");
    }
  }

  async function send(argv: string[]): Promise<void> {
    try {
      const reply = await postCommand(argv);
      setResult(reply.text ?? "");
    } catch {
      setResult("dispatch unreachable");
    }
    await loadStatus();
  }

  onSettled(() => {
    void loadStatus();
    const timer = setInterval(() => {
      void loadStatus();
    }, 5000);
    return () => clearInterval(timer);
  });

  function pause(id: string) {
    return (event: SubmitEvent) => {
      event.preventDefault();
      void send(["pause", id]);
    };
  }

  function resume(id: string) {
    return (event: SubmitEvent) => {
      event.preventDefault();
      void send(["resume", id]);
    };
  }

  function fail(id: string) {
    return (event: SubmitEvent) => {
      event.preventDefault();
      const reason = String(new FormData(event.currentTarget as HTMLFormElement).get("reason") ?? "");
      void send(["fail", id, "--reason", reason]);
    };
  }

  function restart(id: string) {
    return (event: SubmitEvent) => {
      event.preventDefault();
      const model = String(new FormData(event.currentTarget as HTMLFormElement).get("model") ?? "");
      void send(["restart", id, "--builder", model]);
    };
  }

  function start(event: SubmitEvent): void {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const fields = new FormData(form);
    const id = String(fields.get("ticket") ?? "").trim();
    const builder = String(fields.get("builder") ?? "").trim();
    if (!id) return;
    const argv = builder ? ["start", id, "--builder", builder] : ["start", id];
    form.reset();
    void send(argv);
  }

  return (
    <div class="shell">
      <div class="card" data-size="sm">
        <header>
          <h2>Building</h2>
          <p class="muted-line" data-testid="slots">
            {slots()}
          </p>
        </header>
        <section class="building-list">
          <For each={tickets()} fallback={<p class="muted-line">no building tickets</p>}>
            {(ticket) => (
              <div class="building-row" data-testid="ticket-row" data-identifier={ticket.identifier}>
                <div class="building-main">
                  <strong>{ticket.identifier}</strong>
                  <span class="muted-line">{ticket.title}</span>
                  <span class="muted-line" data-testid="ticket-meta">
                    {ticket.state} · {formatElapsed(ticket.elapsedMs)} / {formatElapsed(ticket.budgetMs)}
                    {ticket.over ? " OVER" : ""} · {ticket.stage ?? "no stage"}
                    {ticket.stageAt ? ` · ${formatAgo(ticket.stageAt)}` : ""} · commander {ticket.commander}
                    {ticket.paused ? " · paused" : ""}
                    {ticket.stalled ? " · stalled" : ""}
                    {ticket.overBudget ? " · over_budget" : ""}
                  </span>
                </div>
                <div class="building-actions">
                  <form onSubmit={pause(ticket.identifier)}>
                    <button class="btn" data-variant="outline" data-size="sm" type="submit">
                      Pause
                    </button>
                  </form>
                  <form onSubmit={resume(ticket.identifier)}>
                    <button class="btn" data-variant="outline" data-size="sm" type="submit">
                      Resume
                    </button>
                  </form>
                  <form onSubmit={fail(ticket.identifier)}>
                    <input class="input" type="text" name="reason" placeholder="Fail reason" autocomplete="off" />
                    <button class="btn" data-variant="outline" data-size="sm" type="submit">
                      Fail
                    </button>
                  </form>
                  <form onSubmit={restart(ticket.identifier)}>
                    <input class="input" type="text" name="model" placeholder="Builder model" autocomplete="off" />
                    <button class="btn" data-variant="outline" data-size="sm" type="submit">
                      Restart
                    </button>
                  </form>
                </div>
              </div>
            )}
          </For>
        </section>
        <footer>
          <form class="start-form" onSubmit={start}>
            <input class="input" type="text" name="ticket" placeholder="Ticket id, e.g. STA-176" autocomplete="off" />
            <input class="input" type="text" name="builder" placeholder="Builder model (optional)" autocomplete="off" />
            <button class="btn" data-size="sm" type="submit">
              Start
            </button>
          </form>
          <div class="result-row">
            <p class="muted-line" data-testid="result">
              {result()}
            </p>
          </div>
        </footer>
      </div>
    </div>
  );
}
