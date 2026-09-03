import { createSignal } from "solid-js";
import { Router } from "./router";

export default function App() {
  const [dark, setDark] = createSignal(false);

  function toggleTheme(event: SubmitEvent): void {
    event.preventDefault();
    const next = !dark();
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
  }

  return (
    <Router>
      {(props) => (
        <>
          <header class="topbar">
            <span class="font-semibold text-sm">igniter</span>
            <form onSubmit={toggleTheme}>
              <button class="btn" data-variant="outline" data-size="sm" type="submit">
                {dark() ? "Light" : "Dark"}
              </button>
            </form>
          </header>
          {props.children}
        </>
      )}
    </Router>
  );
}
