import type { Db } from "../../db/db.js";
import type { ErpAcknowledgement, ErpPort, ErpPurchaseOrder } from "./erp.port.js";
import { HttpErpAdapter } from "./http-erp.adapter.js";

/**
 * Database-backed ERP simulator for the hosted demo, where serverless instances cannot share an in-memory
 * mock. Same idempotency contract as apps/mock-erp (client reference = PO id) and the same ACL translation
 * as the HTTP adapter, so the stored payload is what a real ERP would receive. Not a production component.
 */
export class SimulatedErpAdapter implements ErpPort {
  private readonly translator = new HttpErpAdapter("", "");

  constructor(private readonly db: Db) {}

  async submitPurchaseOrder(po: ErpPurchaseOrder): Promise<ErpAcknowledgement> {
    const payload = JSON.stringify(this.translator.toErpPayload(po));
    const inserted = await this.db.query<{ erp_po_number: string }>(
      `INSERT INTO mock_erp.purchase_order (client_reference, erp_po_number, payload)
       VALUES ($1, nextval('mock_erp.po_number_seq')::text, $2::jsonb)
       ON CONFLICT (client_reference) DO NOTHING RETURNING erp_po_number`,
      [po.poId, payload],
    );
    if (inserted.length) return { erpPoNumber: inserted[0].erp_po_number, duplicate: false };
    const [existing] = await this.db.query<{ erp_po_number: string }>(
      "SELECT erp_po_number FROM mock_erp.purchase_order WHERE client_reference = $1",
      [po.poId],
    );
    return { erpPoNumber: existing.erp_po_number, duplicate: true };
  }

  async health(): Promise<"ok" | "unavailable"> {
    return "ok";
  }
}
