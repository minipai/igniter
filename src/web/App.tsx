import { onSettled } from "solid-js";
import { Router } from "./router";

export default function App() {
  onSettled(() => {
    // Dark mode is html.dark (AGENTS.md): follow the OS, no button.
    // jsdom has no matchMedia; there the page stays light.
    if (typeof window.matchMedia !== "function") return;
    const root = document.documentElement;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => root.classList.toggle("dark", query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  });
  return <Router>{(props) => <>{props.children}</>}</Router>;
}
