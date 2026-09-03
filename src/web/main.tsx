import { render } from "@solidjs/web";
import App from "./App";
import "./app.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
render(() => <App />, root);
