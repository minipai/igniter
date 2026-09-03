import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const HealthSchema = Type.Object({
  ok: Type.Literal(true),
  service: Type.Literal("igniter"),
});

export type Health = Static<typeof HealthSchema>;

export function buildHealth(): Health {
  const health: Health = { ok: true, service: "igniter" };
  if (!Value.Check(HealthSchema, health)) {
    throw new Error("health payload failed validation");
  }
  return health;
}
