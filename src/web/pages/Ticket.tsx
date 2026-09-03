import { useParams } from "@solidjs/router";

export function Ticket() {
  const params = useParams();
  const id = () => params["id"] ?? "unknown";
  return (
    <div class="shell">
      <div class="card" data-size="sm">
        <header>
          <h2 data-testid="ticket-title">{id()}</h2>
          <p>Skeleton detail view. Later tickets render the full board here.</p>
        </header>
        <section>
          <p class="muted-line">Direct load of this URL must serve the same page, not a 404.</p>
        </section>
        <footer>
          <a class="btn" data-variant="outline" data-size="sm" href="/">
            Back
          </a>
        </footer>
      </div>
    </div>
  );
}
