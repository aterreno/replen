import { createRequire } from "node:module";
import { Injectable } from "@nestjs/common";
import type { ErrorObject, ValidateFunction } from "ajv";
import { CONTRACT_SCHEMAS } from "../generated/contract-schemas.js";

const require = createRequire(import.meta.url);
// ajv ships CommonJS; load it through require to avoid default-export interop differences.
const Ajv2020 = require("ajv/dist/2020.js") as new (opts: object) => {
  addSchema(schema: object): void;
  compile(schema: object): ValidateFunction;
  getSchema(id: string): ValidateFunction | undefined;
};
const addFormats = require("ajv-formats") as (ajv: object) => void;

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

const fmt = (errors: ErrorObject[] | null | undefined) =>
  (errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`);

/** Validates documents against the committed contracts (events and engine schemas). */
@Injectable()
export class ContractValidator {
  private readonly ajv = new Ajv2020({ allErrors: true, strict: false });
  private readonly envelope: ValidateFunction;
  private readonly events = new Map<string, ValidateFunction>();
  private readonly engine = new Map<string, ValidateFunction>();

  /** Schemas come from contracts/ via `npm run contracts:generate`, embedded so the bundle is self-contained. */
  constructor() {
    addFormats(this.ajv);
    const clone = (x: unknown) => JSON.parse(JSON.stringify(x)) as object;
    this.envelope = this.ajv.compile(clone(CONTRACT_SCHEMAS.envelope));
    for (const [type, schema] of Object.entries(CONTRACT_SCHEMAS.events)) this.events.set(type, this.ajv.compile(clone(schema)));
    for (const [name, schema] of Object.entries(CONTRACT_SCHEMAS.engine)) this.engine.set(name, this.ajv.compile(clone(schema)));
  }

  eventTypes(): string[] {
    return [...this.events.keys()];
  }

  validateEvent(envelope: { type: string; data: unknown }): ValidationResult {
    const errors: string[] = [];
    if (!this.envelope(envelope)) errors.push(...fmt(this.envelope.errors).map((e) => `envelope ${e}`));
    const data = this.events.get(envelope.type);
    if (!data) errors.push(`unknown event type ${envelope.type}`);
    else if (!data(envelope.data)) errors.push(...fmt(data.errors).map((e) => `data ${e}`));
    return { valid: errors.length === 0, errors };
  }

  validateEngine(kind: "plan-request" | "plan-response", doc: unknown): ValidationResult {
    const v = this.engine.get(kind)!;
    const valid = v(doc) as boolean;
    return { valid, errors: valid ? [] : fmt(v.errors) };
  }
}
