import { Controller, Get, Inject } from "@nestjs/common";
import { PurchasingService } from "../purchasing/purchasing.service.js";
import { ReferenceService } from "./reference.service.js";

@Controller("api/v1")
export class ReferenceController {
  constructor(
    private readonly reference: ReferenceService,
    @Inject(PurchasingService) private readonly purchasing: PurchasingService,
  ) {}

  @Get("suppliers")
  async suppliers() {
    const otif = await this.purchasing.otifBySupplier();
    return (await this.reference.suppliers()).map((s) => ({ ...s, otif: otif.get(s.supplierId)?.otif ?? null }));
  }

  @Get("locations")
  locations() {
    return this.reference.locations();
  }

  @Get("products")
  products() {
    return this.reference.products();
  }
}
