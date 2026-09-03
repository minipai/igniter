import { createSignal } from "solid-js";
import { Router } from "./router";

export default function App() {
  const [dark, setDark] = createSignal(false);

  function toggleTheme(): void {
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
            <button
              class="btn"
              data-variant="outline"
              data-size="sm"
              type="button"
              onClick={toggleTheme}
            >
              {dark() ? "Light" : "Dark"}
            </button>
          </header>
          {props.children}
        </>
      )}
    </Router>
  );
}
