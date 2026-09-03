import { createRouter, defineRoutes } from "@solidjs/router";
import { Home } from "./pages/Home";
import { Ticket } from "./pages/Ticket";

export const Router = createRouter({
  routes: defineRoutes([
    { path: "/", component: Home },
    { path: "/tickets/:id", component: Ticket },
  ]),
});

export const { paths } = Router;
