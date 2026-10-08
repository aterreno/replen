import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { EventDataByType, EventType } from "@replen/contracts";
import { currentContext } from "../common/context.js";
import { CONFIG, type AppConfig } from "../config.js";
import type { Queryable } from "../db/db.js";
import { ContractValidator } from "./contracts.js";

export interface Envelope<T extends EventType = EventType> {
  specversion: "1.0";
  id: string;
  source: string;
  type: T;
  subject: string;
  time: string;
  datacontenttype: "application/json";
  dataschema: string;
  correlationid: string;
  causationid: string | null;
  aggregateversion: number;
  tenantid: string;
  data: EventDataByType[T];
}

/** Transactional outbox: events are written in the same transaction as the state change they describe. */
@Injectable()
export class OutboxService {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly validator: ContractValidator,
  ) {}

  build<T extends EventType>(type: T, subject: string, aggregateVersion: number, data: EventDataByType[T]): Envelope<T> {
    const ctx = currentContext();
    const context = type.split(".")[1];
    return {
      specversion: "1.0",
      id: randomUUID(),
      source: `replen-api/${context}`,
      type,
      subject,
      time: new Date().toISOString(),
      datacontenttype: "application/json",
      dataschema: `https://contracts.replen.local/events/${type.replace(/^replen\./, "")}.schema.json`,
      correlationid: ctx.correlationId,
      causationid: ctx.causationId ?? null,
      aggregateversion: aggregateVersion,
      tenantid: this.config.tenantId,
      data,
    };
  }

  async emit<T extends EventType>(
    q: Queryable,
    type: T,
    subject: string,
    aggregateVersion: number,
    data: EventDataByType[T],
  ): Promise<Envelope<T>> {
    const envelope = this.build(type, subject, aggregateVersion, data);
    const check = this.validator.validateEvent(envelope);
    if (!check.valid) {
      // A contract violation is a programming error; fail the transaction rather than publish bad data.
      throw new Error(`event ${type} violates its contract: ${check.errors.join("; ")}`);
    }
    await q.query(
      `INSERT INTO messaging.outbox (event_id, type, subject, ordering_key, aggregate_version, envelope)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [envelope.id, type, subject, subject, aggregateVersion, JSON.stringify(envelope)],
    );
    return envelope;
  }
}
