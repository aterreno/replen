import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { Injectable } from "@nestjs/common";
import type { ErrorObject, ValidateFunction } from "ajv";
import { repoPath } from "../common/util.js";

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

/** Validates documents against the committed contracts in /contracts (events and engine schemas). */
@Injectable()
export class ContractValidator {
  private readonly ajv = new Ajv2020({ allErrors: true, strict: false });
  private readonly envelope: ValidateFunction;
  private readonly events = new Map<string, ValidateFunction>();
  private readonly engine = new Map<string, ValidateFunction>();

  constructor() {
    addFormats(this.ajv);
    const dir = repoPath("contracts/events");
    const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as {
      envelope: string;
      events: Record<string, string>;
    };
    this.envelope = this.ajv.compile(JSON.parse(readFileSync(join(dir, index.envelope), "utf8")));
    for (const [type, file] of Object.entries(index.events)) {
      this.events.set(type, this.ajv.compile(JSON.parse(readFileSync(join(dir, file), "utf8"))));
    }
    const engineDir = repoPath("contracts/engine");
    for (const name of ["plan-request", "plan-response"]) {
      const schema = JSON.parse(readFileSync(join(engineDir, `${name}.v1.schema.json`), "utf8"));
      this.engine.set(name, this.ajv.compile(schema));
    }
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
