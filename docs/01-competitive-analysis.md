# A. Competitive capability matrix

Reviewed 2026-10-08 from public sources only. Nothing here describes vendor algorithms; where a vendor names a technique (for example "probabilistic forecasting") that is recorded as their claim, not as a verified implementation detail.

## Evidence grading

| Grade | Meaning |
|---|---|
| V | Vendor-published statement (product page, press release, vendor-hosted case study). A claim, not independently verified. |
| T | Third-party source: analyst summary, trade press, independent review site, customer review. Usually still derived from vendor material. |
| P | Partial or indirect: capability implied by a broader statement, or evidence is old (pre-2022) and may not describe the current product. |
| ? | Not found in public sources during this review. Absence of evidence only. Confirm in an RFI before scoring the vendor down. |

None of the evidence below verifies forecast accuracy, scale, or optimisation quality. Every outcome percentage quoted by vendors (inventory reduction, productivity) is self-reported and is excluded from the matrix.

## Matrix

| # | Capability | RELEX | Blue Yonder | o9 Solutions | Manhattan | ToolsGroup | Replen design response |
|---|---|---|---|---|---|---|---|
| 1 | Unified inventory position | P [R1] | P [B1] | V [O1] | V [M1] | P [T2] | Explicit position buckets with an auditable calculation per SKU-location (slice) |
| 2 | SKU/location/channel/day forecasting with drivers | V [R1][R2] T [R6] | V [B3][B4] | V [O1][O3] | V [M1] | V [T1] | Demand classification + per-class models, promo uplift, censored stockout days excluded (slice); global ML model (M2) |
| 3 | New-product forecasting by attributes/analogues | V [R4] T [R7] (review reports weaker accuracy for new items) | ? | P [O1] | P [M1] (short lifecycle items) | ? | k-nearest analogue by attribute distance, analogue list shown to planner (slice) |
| 4 | Replenishment from forecast, lead time, review period, service level, safety stock | V [R1][R3] | V [B1][B2] | V [O1] | V [M1] | V [T1][T3] | Periodic review (R,S) with lead-time variance, quantile safety stock, step-by-step trace (slice) |
| 5 | Multi-echelon optimisation | V [R6] (multi-echelon order calculations) | P [B2] (DC/store synchronisation) | P [O1] | ? | V [T1][T2] | Echelon demand roll-up in slice; guaranteed-service MEIO in M3 |
| 6 | Order constraints (MOQ, packs, calendars, capacity, budget, transport) | V [R1] | V [B5] (supplier, warehouse, logistics constraints) | V [O1] (capacity, policies) | ? | V [T3] | Item-level rules + CP-SAT order-level solve for budget and min order value (slice); vehicle fill in M2 |
| 7 | Automated PO/TO creation, approval, amendment, tracking | P | P | P | P | P | PO lifecycle with ERP anti-corruption adapter, four-eyes approval limits (slice, mock ERP) |
| 8 | Allocation, launches, end-of-life, markdown-aware replenishment | V [R1] | V [B1] (size-level allocation) | V [O2] (allocation, markdown) | V [M1] (switch between allocation and replenishment per SKU) | V [T4] (allocation, rebalancing, markdown) | End-of-life truncation in slice; allocation and markdown hand-off in M4 |
| 9 | Supplier portal and exception management | T [R5] (Forrester CSN Wave via vendor release) | V [B5] | V [O2] (supplier collaboration in M&S scope) | ? | ? | Supplier confirmation API and portal in M3, separate internet-facing service |
| 10 | Planner workbench with explanations, overrides, approvals | V [R8] (vendor says recommendations are traceable) | V [B6] (mobile review of store orders) | V [O3] | P | V [T5] (stock-to-service curves) | Exception-first queue, calculation waterfall, reason-coded overrides (slice) |
| 11 | What-if simulation | V [R8] (plan stress testing agent) | V [B6] (inventory ops agent tests strategies) | V [O1] (service level, capacity, policy trade-offs) | ? | P [T5] | Engine what-if endpoint over the same code path, not persisted (slice, basic) |
| 12 | Natural-language assistant | V [R8][R9] (Rebot, launched as RELEX-GPT on GPT-4) | V [B6] (AI agents) | V [O3] (GenAI on Digital Brain) | ? | ? | Read-only assistant grounded in stored calculation traces, no write tools (M2 design only) |
| 13 | KPI dashboard (availability, WAPE, bias, turns, DoS, OTIF) | P | P | P | P | P | KPI API and dashboard computed from synthetic data, definitions documented (slice) |

Analyst positioning, as reported by the vendors themselves: RELEX [R10], Blue Yonder [B7] and o9 [O4] each announced Leader placement in the 2025 Gartner Magic Quadrant for Supply Chain Planning Solutions. Manhattan's and ToolsGroup's 2025 placements were not checked. Gartner states its research should not be read as statements of fact.

## Reading the matrix

Rows 1, 2, 4, 6 and 10 are table stakes: every vendor claims them and a buyer will not shortlist without them. Rows 3, 5, 11 and 12 are where public claims diverge and where an RFI should ask for demonstrations on the retailer's own data. Row 7 is rated P across the board because vendors describe order generation but rarely publish how amendment, ERP acknowledgement and supplier confirmation are modelled; that detail lives in implementation contracts, not marketing.

Uncertainties that matter for a build decision:

- Probabilistic forecasting depth. ToolsGroup [T1] and Blue Yonder [B3] say they output demand distributions; RELEX and Manhattan describe ML forecasts without saying whether planners see distributions. Replen outputs quantiles from day one because safety stock depends on them.
- Explainability. Only RELEX publishes a direct claim about traceable recommendations [R8], via a customer case study. Replen treats the calculation trace as a first-class stored artefact rather than a UI feature.
- Supplier collaboration. The strongest evidence is RELEX's Forrester mention [R5]; others describe it inside broader platform scope. Expect integration work regardless of vendor.
- ToolsGroup product naming. One industry commentary reports a May 2026 consolidation of engines under a new brand name. Not verified; treat as low confidence.

## Where an independent build can compete, and where it cannot

Competes on: transparent, reproducible calculations; ownership of data and contracts; GCP-native operation without a second cloud estate; marginal cost per SKU-location once built.

Does not compete on (without years of investment): breadth across merchandise financial planning, space planning and pricing; tuned ML across hundreds of retailers' data; reference customers; a vendor-backed support organisation. See [08-build-vs-buy.md](08-build-vs-buy.md).

## Sources

RELEX
- [R1] RELEX, "Cut through retail complexity with advanced forecasting and replenishment technology": https://www.relexsolutions.com/resources/cut-through-retail-complexity-with-advanced-forecasting-replenishment-technology/
- [R2] RELEX customer story, Booths (promotion similarity, weather profiles): https://www.relexsolutions.com/resources/booths-cool-innovations/
- [R3] RELEX, Horizon 2020 project (promotion regression, cannibalisation, weather): https://www.relexsolutions.com/horizon-2020/
- [R4] RELEX news, Skincity (promotions, new product releases): https://www.relexsolutions.com/news/skincity-looks-to-relex-for-more-accurate-forecasting-of-promotions-and-new-product-releases/
- [R5] Business Wire, RELEX named a Leader in Forrester Collaborative Supply Networks evaluation (2024-10-28): https://www.businesswire.com/news/home/20241028082896/en/RELEX-Solutions-Named-a-Leader-in-Collaborative-Supply-Networks-Analyst-Report
- [R6] ERP Research, RELEX overview: https://www.erpresearch.com/erp-add-ons/demand-planning/relex
- [R7] TrustRadius, user reviews (new-product accuracy comment): https://www.trustradius.com/compare-products/forecast-now-vs-relex-solutions
- [R8] RELEX, agentic AI for supply planning (2026): https://www.relexsolutions.com/resources/relex-agentic-ai-for-supply-planning/ and Liverpool case study: https://relexsolutions.com/news/liverpool-adopts-artificial-intelligence-for-demand-forecasting-and-replenishment-of-internal-supplies-with-relex-solutions
- [R9] DC Velocity, "RELEX advances Gen AI capabilities" (Rebot): https://www.dcvelocity.com/articles/60235-relex-advances-gen-ai-capabilities-to-unlock-faster-data-driven-decision-making
- [R10] Business Wire, RELEX Leader in 2025 Gartner MQ for SCP: https://www.businesswire.com/news/home/20250415771445/en/RELEX-Solutions-Named-a-Leader-in-the-2025-Gartner-Magic-Quadrant-for-Supply-Chain-Planning

Blue Yonder
- [B1] Blue Yonder, Allocation and Replenishment: https://medialibrarycdn.blueyonder.com/solutions/allocation-and-replenishment
- [B2] CILT(UK), "Blue Yonder launches machine learning replenishment optimisation" (2017, graded P for age): https://ciltuk.org.uk/News/Latest-News/ArtMID/6887/ArticleID/10881/Blue-Yonder-launches-machine-learning-replenishment-optimisation-
- [B3] IT Supply Chain, "JDA introduces Luminate Demand Edge" (probabilistic forecasts): https://itsupplychain.com/?p=2984
- [B4] Blue Yonder, Cognitive Demand Planning solution sheet: https://medialibrarycdn.blueyonder.com/-/media/files/blue%20yonder/master/knowledge%20center%20documents/solution%20sheet/ss%20cognitive%20demand%20planning.pdf?rev=-1
- [B5] Business Wire, "Blue Yonder unifies demand and supply planning" (2025-12-02): https://www.businesswire.com/news/home/20251202145707/en/Blue-Yonder-Unifies-Demand-and-Supply-Planning-With-End-to-End-Collaboration-and-Actionable-Insights
- [B6] Business Wire, "Blue Yonder expands agentic AI and mobile experiences" (2026-03-11): https://www.businesswire.com/news/home/20260311026920/en/Blue-Yonder-Expands-Agentic-AI-and-Mobile-Experiences-for-Industry-Specific-Supply-Chain-Execution
- [B7] Business Wire, Blue Yonder Leader in 2025 Gartner MQ for SCP: https://www.businesswire.com/news/home/20250421590060/en/

o9 Solutions
- [O1] o9, retail grocery industry page (EKG, scenario trade-offs): https://o9solutions.com/industries/retail/grocery
- [O2] Business Wire, o9 to support M&S Clothing & Home planning (2024-01-15): https://www.businesswire.com/news/home/20240115452039/en/o9-Solutions-to-Support-MS-With-the-Digital-Transformation-and-Upgrade-of-Its-Clothing-Home-Planning-Systems
- [O3] o9 news, GenAI innovations on the Digital Brain platform (2024-04-04): https://o9solutions.com/news/o9-transforms-integrated-planning-and-decisioning-with-genai-powered-innovations-to-its-digital-brain-platform
- [O4] Business Wire, o9 Leader in 2025 Gartner MQ for SCP: https://www.businesswire.com/news/home/20250416064587/en/o9-Named-a-Leader-in-the-2025-Gartner-Magic-Quadrant-for-Supply-Chain-Planning-Solutions

Manhattan Associates
- [M1] Manhattan Active Supply Chain Planning: https://manh.com/solutions/supply-chain-planning-software/manhattan-active-supply-chain-planning
- [M2] Nasdaq, Pet Supplies Plus selects Manhattan Active SCP: https://www.nasdaq.com/press-release/pet-supplies-plus-synchronizes-business-functions-manhattan-activer-supply-chain

ToolsGroup
- [T1] ToolsGroup, inventory optimisation (probabilistic forecasting, MEIO): https://www.toolsgroup.com/solutions/inventory-optimization/
- [T2] ToolsGroup, multi-echelon inventory brochure: https://www.toolsgroup.com/resources/multi-echelon-inventory-brochure/
- [T3] ERP Research, ToolsGroup overview: https://erpresearch.com/erp-add-ons/demand-planning/toolsgroup
- [T4] ToolsGroup news, in-season retail inventory optimisation launch (2024): https://www.toolsgroup.com/news/toolsgroup-launches-integrated-in-season-retail-inventory-optimization-solution/
- [T5] ToolsGroup blog, JustEnough 2023.1 (stock-to-service curves): https://www.toolsgroup.com/blog/justenough-version-2023-1/
