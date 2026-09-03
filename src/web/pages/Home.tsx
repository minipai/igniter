import { createSignal, onSettled } from "solid-js";
import { useNavigate } from "@solidjs/router";

export function Home() {
  const [health, setHealth] = createSignal("checking…");
  const navigate = useNavigate();

  onSettled(() => {
    let alive = true;
    fetch("/api/health")
      .then((res) => res.json())
      .then((data: unknown) => {
        if (alive) setHealth(JSON.stringify(data));
      })
      .catch(() => {
        if (alive) setHealth("unreachable");
      });
    return () => {
      alive = false;
    };
  });

  function jump(event: SubmitEvent): void {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const id = String(new FormData(form).get("id") ?? "").trim();
    if (!id) return;
    navigate(`/tickets/${encodeURIComponent(id)}`);
    form.reset();
  }

  return (
    <div class="shell">
      <div class="card" data-size="sm">
        <header>
          <h2>igniter skeleton</h2>
          <p>Bun serves the API, the events boundary, and this page.</p>
        </header>
        <section>
          <p class="muted-line" data-testid="health">
            api health: {health()}
          </p>
        </section>
        <footer>
          <a class="btn" data-size="sm" href="/tickets/STA-1">
            Open STA-1
          </a>
        </footer>
      </div>
      <form class="jump-form" onSubmit={jump}>
        <input class="input" type="text" name="id" placeholder="Ticket id, e.g. STA-1" autocomplete="off" />
        <button class="btn" data-variant="outline" data-size="sm" type="submit">
          Jump
        </button>
      </form>
    </div>
  );
}
