import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export interface RequestContext {
  correlationId: string;
  causationId?: string | null;
  actor?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentContext(): RequestContext {
  return storage.getStore() ?? { correlationId: `bg-${randomUUID()}` };
}

export function setActor(actor: string): void {
  const store = storage.getStore();
  if (store) store.actor = actor;
}
