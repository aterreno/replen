export type { paths, components } from "./generated/api.js";
export type * from "./generated/events.js";
export type { PlanRequest } from "./generated/engine-request.js";
export type { PlanResponse } from "./generated/engine-response.js";

import type { components } from "./generated/api.js";

type Schemas = components["schemas"];
export type User = Schemas["User"];
export type Role = Schemas["Role"];
export type ProposalSummary = Schemas["ProposalSummary"];
export type Proposal = Schemas["Proposal"];
export type ProposalLine = Schemas["ProposalLine"];
export type ProposalStatus = Schemas["ProposalStatus"];
export type PlanningRun = Schemas["PlanningRun"];
export type PurchaseOrder = Schemas["PurchaseOrder"];
export type AuditEvent = Schemas["AuditEvent"];
export type OutboxEvent = Schemas["OutboxEvent"];
export type Kpis = Schemas["Kpis"];
export type KpiValue = Schemas["KpiValue"];
export type InventoryPosition = Schemas["InventoryPosition"];
export type SimulationRequest = Schemas["SimulationRequest"];
export type SimulationResult = Schemas["SimulationResult"];
export type ReasonCode = Schemas["ReasonCode"];
export type Problem = Schemas["Problem"];
export type ApprovalCheck = Schemas["ApprovalCheck"];
