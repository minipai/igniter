export type WorkerRole = "build" | "review" | "deliver";
export type WorkerProfile = "builder" | "reviewer" | "deliverer" | "fallback";
export type WorkerAnswer = "y" | "n";

export type CommandRequest =
  | { command: "status"; ticket?: string; json?: boolean }
  | { command: "start" }
  | { command: "begin"; ticket: string }
  | { command: "reconcile"; ticket: string }
  | { command: "approve"; ticket: string; receipt: string }
  | { command: "fail"; ticket: string; reason: string }
  | { command: "submit"; ticket: string; payload: unknown }
  | { command: "block"; ticket: string; reason: string }
  | { command: "unblock"; ticket: string }
  | { command: "worker.start"; ticket: string; role?: WorkerRole }
  | { command: "worker.send"; ticket: string; role?: WorkerRole; text: string }
  | {
    command: "worker.restart";
    ticket: string;
    role?: WorkerRole;
    profile?: WorkerProfile;
    harness?: string;
    model?: string;
    effort?: string;
  }
  | { command: "worker.stop"; ticket: string; role?: WorkerRole }
  | { command: "worker.answer"; ticket: string; role?: WorkerRole; answer: WorkerAnswer };

export type WorkerRequest = Extract<CommandRequest, { command: `worker.${string}` }>;
