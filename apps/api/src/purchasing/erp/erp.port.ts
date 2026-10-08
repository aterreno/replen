/** Canonical purchase order handed to the ERP anti-corruption layer. */
export interface ErpPurchaseOrder {
  poId: string;
  poNumber: string;
  supplierId: string;
  destinationLocationId: string;
  orderDate: string;
  expectedDeliveryDate: string;
  currency: string;
  lines: { lineNo: number; sku: string; quantity: number; unitCost: number }[];
}

export interface ErpAcknowledgement {
  erpPoNumber: string;
  duplicate: boolean;
}

export class ErpError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export interface ErpPort {
  /** Must be idempotent on poId: resubmitting returns the original ERP number. */
  submitPurchaseOrder(po: ErpPurchaseOrder): Promise<ErpAcknowledgement>;
  health(): Promise<"ok" | "unavailable">;
}

export const ERP = Symbol("ERP");
