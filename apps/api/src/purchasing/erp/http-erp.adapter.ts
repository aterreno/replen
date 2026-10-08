import { currentContext } from "../../common/context.js";
import { type ErpAcknowledgement, ErpError, type ErpPort, type ErpPurchaseOrder } from "./erp.port.js";

const compactDate = (iso: string) => iso.replaceAll("-", "");

/**
 * Anti-corruption layer for the ERP purchase-order API (A-23). Translates the canonical model into the ERP's
 * field names, date format and line numbering, and maps ERP responses back to retryable/non-retryable errors.
 * The slice talks to apps/mock-erp; a real ERP needs its own adapter behind the same port.
 */
export class HttpErpAdapter implements ErpPort {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly timeoutMs = 10_000,
  ) {}

  toErpPayload(po: ErpPurchaseOrder) {
    return {
      VENDOR_NO: po.supplierId,
      SHIP_TO: po.destinationLocationId,
      ORDER_DATE: compactDate(po.orderDate),
      DELIVERY_DATE: compactDate(po.expectedDeliveryDate),
      CURRENCY: po.currency,
      EXT_REF: po.poNumber,
      LINES: po.lines.map((l) => ({
        LINE_NO: l.lineNo * 10,
        ITEM_NO: l.sku,
        QTY: l.quantity,
        UOM: "EA",
        UNIT_COST: Number(l.unitCost.toFixed(4)),
      })),
    };
  }

  async submitPurchaseOrder(po: ErpPurchaseOrder): Promise<ErpAcknowledgement> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/erp/v1/purchase-orders`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
          "x-client-reference": po.poId,
          "x-correlation-id": currentContext().correlationId,
        },
        body: JSON.stringify(this.toErpPayload(po)),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new ErpError(`ERP unreachable: ${err instanceof Error ? err.message : String(err)}`, true);
    }
    const body = (await res.json().catch(() => ({}))) as { ERP_PO_NUMBER?: string; ERRORS?: { MSG: string }[] };
    if (res.status === 201 || res.status === 200) {
      if (!body.ERP_PO_NUMBER) throw new ErpError("ERP response missing ERP_PO_NUMBER", true);
      return { erpPoNumber: body.ERP_PO_NUMBER, duplicate: res.status === 200 };
    }
    const msg = body.ERRORS?.map((e) => e.MSG).join("; ") || `HTTP ${res.status}`;
    if (res.status >= 500 || res.status === 429) throw new ErpError(`ERP temporary failure: ${msg}`, true);
    throw new ErpError(`ERP rejected order: ${msg}`, false);
  }

  async health(): Promise<"ok" | "unavailable"> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
      return res.ok ? "ok" : "unavailable";
    } catch {
      return "unavailable";
    }
  }
}
