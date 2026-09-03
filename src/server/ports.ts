// Single source of truth for dev ports so the Vite proxy and the Bun
// server can never disagree. Overridden at runtime by --port / IGNITER_PORT.

export const API_PORT = 3457;
export const WEB_PORT = 5173;
