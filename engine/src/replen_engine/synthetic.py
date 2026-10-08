"""Deterministic synthetic dataset for the vertical slice.

Everything here is invented: names, suppliers, prices, volumes. It is shaped to exercise the edge cases
listed in the brief, not to resemble any real retailer. Output is byte-for-byte reproducible for a given
seed and dependency lockfile; `manifest.json` records SHA-256 hashes that tests compare against.
"""

from __future__ import annotations

import csv
import hashlib
import json
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path

import numpy as np

GENERATOR_VERSION = "1.0.0"
DEFAULT_SEED = 20261005
AS_OF = date(2026, 10, 5)  # Monday. Planning date for the slice.
HISTORY_DAYS = 730
DC = "DC1"

LOCATIONS = [
    # location_id, name, type, region, size factor (stores only)
    ("DC1", "Central DC (synthetic)", "DC", "Midlands", 0.0),
    ("S01", "Northbridge (synthetic)", "STORE", "North", 1.4),
    ("S02", "Eastmoor (synthetic)", "STORE", "East", 1.0),
    ("S03", "Southvale (synthetic)", "STORE", "South", 0.8),
    ("S04", "Westholm (synthetic)", "STORE", "West", 0.6),
    ("S05", "Kingsford (synthetic)", "STORE", "London", 1.2),
]

SUPPLIERS = [
    # id, name, lead, lead std, order weekdays, delivery weekdays, on-time prob, mean delay when late
    ("SUP-HOME", "Hearth & Loom Textiles (synthetic)", 14, 2.0, [1, 4], [1, 2, 3, 4, 5], 0.95, 3),
    ("SUP-ELEC", "Voltline Appliances (synthetic)", 7, 1.0, [1, 2, 3, 4, 5], [2, 4], 0.97, 2),
    ("SUP-FASH", "Northern Cotton Co (synthetic)", 21, 4.0, [1], [1, 2, 3, 4, 5], 0.90, 5),
    ("SUP-FURN", "Oakcraft Furniture (synthetic)", 35, 7.0, [3], [1, 3], 0.60, 10),
    ("SUP-SEAS", "Festive Lights Ltd (synthetic)", 28, 3.0, [1], [1, 2, 3, 4, 5], 0.92, 4),
    ("SUP-GARD", "Greenway Outdoor (synthetic)", 21, 3.0, [2, 5], [1, 2, 3, 4, 5], 0.93, 3),
]

ORDER_CONSTRAINTS = [
    # supplier, destination, min order value, budget
    ("SUP-ELEC", DC, 6000.0, None),
    ("SUP-FASH", DC, 0.0, 4500.0),
]

SERVICE_LEVELS = {"Home": 0.95, "Electricals": 0.97, "Fashion": 0.95, "Furniture": 0.90, "Seasonal": 0.92}


@dataclass
class Sku:
    sku: str
    name: str
    category: str
    subcategory: str
    brand: str
    colour: str
    price: float
    cost: float
    supplier: str
    pack: int
    archetype: str  # smooth | erratic | promo | stockouts | intermittent | lumpy | zero
    base: float  # mean daily units per size-1.0 store at yearly factor 1
    profile: str = "general"  # general | xmas | summer | winter
    online: float = 1.0  # online demand relative to a size-1.0 store
    moq: int = 0
    status: str = "ACTIVE"
    launch: date | None = None
    eol: date | None = None
    dc_capacity: int | None = None
    edge: list[str] = field(default_factory=list)


SKUS: list[Sku] = [
    Sku(
        "HOM-TWL-001",
        "Egyptian cotton bath towel, white",
        "Home",
        "Towels",
        "Loomcraft",
        "white",
        18,
        7,
        "SUP-HOME",
        6,
        "smooth",
        1.2,
        online=1.5,
    ),
    Sku(
        "HOM-TWL-002",
        "Egyptian cotton bath towel, charcoal",
        "Home",
        "Towels",
        "Loomcraft",
        "grey",
        18,
        7,
        "SUP-HOME",
        6,
        "smooth",
        0.8,
    ),
    Sku(
        "HOM-TWL-003",
        "Cotton hand towel, white",
        "Home",
        "Towels",
        "Loomcraft",
        "white",
        9,
        3.2,
        "SUP-HOME",
        12,
        "stockouts",
        1.5,
        edge=["censored stockout days"],
    ),
    Sku(
        "HOM-BED-001",
        "Percale duvet cover, double, white",
        "Home",
        "Bedding",
        "Loomcraft",
        "white",
        45,
        17,
        "SUP-HOME",
        4,
        "promo",
        0.6,
        edge=["promo history and planned promo"],
    ),
    Sku(
        "HOM-BED-002",
        "Percale duvet cover, king, grey",
        "Home",
        "Bedding",
        "Loomcraft",
        "grey",
        55,
        21,
        "SUP-HOME",
        4,
        "smooth",
        0.35,
        edge=["negative on-hand at DC"],
    ),
    Sku(
        "HOM-CUS-001",
        "Velvet cushion, teal",
        "Home",
        "Cushions",
        "Atelier Home",
        "teal",
        25,
        8,
        "SUP-HOME",
        8,
        "erratic",
        0.4,
    ),
    Sku(
        "HOM-CUS-002",
        "Velvet cushion, mustard",
        "Home",
        "Cushions",
        "Atelier Home",
        "yellow",
        25,
        8,
        "SUP-HOME",
        8,
        "erratic",
        0.4,
        status="NEW",
        launch=date(2026, 9, 21),
        edge=["new product with 14 days of history"],
    ),
    Sku(
        "HOM-VAS-001",
        "Ceramic vase, large",
        "Home",
        "Decor",
        "Atelier Home",
        "white",
        60,
        22,
        "SUP-HOME",
        2,
        "intermittent",
        0.03,
        moq=24,
        edge=["MOQ conflict"],
    ),
    Sku(
        "HOM-CAN-001",
        "Scented candle, fig",
        "Home",
        "Decor",
        "Ember & Wick",
        "green",
        22,
        6.5,
        "SUP-HOME",
        12,
        "smooth",
        0.5,
        moq=36,
        edge=["MOQ applied"],
    ),
    Sku(
        "ELE-KET-001",
        "Kettle 1.7L, brushed steel",
        "Electricals",
        "Small appliances",
        "Voltline",
        "silver",
        49,
        22,
        "SUP-ELEC",
        4,
        "promo",
        0.7,
        online=2.0,
        edge=["planned promo with history"],
    ),
    Sku(
        "ELE-TOA-001",
        "Toaster, 4-slice",
        "Electricals",
        "Small appliances",
        "Voltline",
        "silver",
        59,
        26,
        "SUP-ELEC",
        4,
        "smooth",
        0.5,
        online=1.5,
        edge=["planned promo without history"],
    ),
    Sku(
        "ELE-HEA-001",
        "Wireless headphones, black",
        "Electricals",
        "Audio",
        "Sonique",
        "black",
        129,
        68,
        "SUP-ELEC",
        6,
        "smooth",
        0.6,
        online=3.0,
        edge=["reserved exceeds on-hand"],
    ),
    Sku(
        "ELE-HEA-002",
        "Wireless headphones, white",
        "Electricals",
        "Audio",
        "Sonique",
        "white",
        129,
        68,
        "SUP-ELEC",
        6,
        "smooth",
        0.6,
        online=3.0,
        status="NEW",
        launch=date(2026, 10, 19),
        edge=["future launch, no history"],
    ),
    Sku(
        "ELE-FAN-001",
        "Desk fan",
        "Electricals",
        "Cooling",
        "Voltline",
        "white",
        35,
        14,
        "SUP-ELEC",
        4,
        "smooth",
        0.6,
        profile="summer",
    ),
    Sku(
        "ELE-RAD-001",
        "Oil-filled radiator",
        "Electricals",
        "Heating",
        "Voltline",
        "white",
        79,
        38,
        "SUP-ELEC",
        2,
        "smooth",
        0.25,
        profile="winter",
    ),
    Sku(
        "ELE-CBL-001",
        "USB-C cable, 2m",
        "Electricals",
        "Accessories",
        "Sonique",
        "black",
        15,
        3,
        "SUP-ELEC",
        20,
        "smooth",
        2.0,
        online=2.0,
    ),
    Sku(
        "FAS-TEE-001",
        "Essential crew T-shirt, white, M",
        "Fashion",
        "Tops",
        "Northern Cotton",
        "white",
        15,
        4.5,
        "SUP-FASH",
        10,
        "smooth",
        2.5,
        online=1.5,
        edge=["budget constrained"],
    ),
    Sku(
        "FAS-TEE-002",
        "Essential crew T-shirt, navy, M",
        "Fashion",
        "Tops",
        "Northern Cotton",
        "navy",
        15,
        4.5,
        "SUP-FASH",
        10,
        "smooth",
        1.8,
        online=1.5,
    ),
    Sku(
        "FAS-TEE-003",
        "Essential crew T-shirt, black, M",
        "Fashion",
        "Tops",
        "Northern Cotton",
        "black",
        15,
        4.5,
        "SUP-FASH",
        10,
        "smooth",
        2.0,
        online=1.5,
    ),
    Sku(
        "FAS-SCK-001",
        "Ankle socks, 5-pack",
        "Fashion",
        "Accessories",
        "Northern Cotton",
        "white",
        12,
        3,
        "SUP-FASH",
        12,
        "smooth",
        3.0,
    ),
    Sku(
        "FAS-JMP-001",
        "Merino jumper, grey, M",
        "Fashion",
        "Knitwear",
        "Highland Knit",
        "grey",
        89,
        31,
        "SUP-FASH",
        5,
        "smooth",
        0.5,
        profile="winter",
    ),
    Sku(
        "FAS-JMP-002",
        "Merino jumper, forest green, M",
        "Fashion",
        "Knitwear",
        "Highland Knit",
        "green",
        89,
        31,
        "SUP-FASH",
        5,
        "smooth",
        0.3,
        profile="winter",
        eol=date(2026, 10, 20),
        edge=["end of life before delivery"],
    ),
    Sku(
        "FAS-SHT-001",
        "Linen shirt, blue, M",
        "Fashion",
        "Tops",
        "Northern Cotton",
        "blue",
        49,
        16,
        "SUP-FASH",
        5,
        "smooth",
        0.4,
        profile="summer",
        status="DISCONTINUED",
        edge=["discontinued with stock"],
    ),
    Sku(
        "FUR-SOF-001",
        "Three-seater sofa, grey",
        "Furniture",
        "Sofas",
        "Oakcraft",
        "grey",
        899,
        420,
        "SUP-FURN",
        1,
        "intermittent",
        0.04,
        online=1.5,
        dc_capacity=6,
        edge=["DC capacity"],
    ),
    Sku(
        "FUR-CHR-001",
        "Oak dining chair",
        "Furniture",
        "Dining",
        "Oakcraft",
        "oak",
        149,
        62,
        "SUP-FURN",
        2,
        "lumpy",
        0.05,
    ),
    Sku(
        "FUR-BKC-001",
        "Bookcase, walnut",
        "Furniture",
        "Storage",
        "Oakcraft",
        "brown",
        299,
        130,
        "SUP-FURN",
        1,
        "intermittent",
        0.03,
        edge=["overdue PO within grace"],
    ),
    Sku(
        "FUR-TBL-001",
        "Coffee table, oak",
        "Furniture",
        "Tables",
        "Oakcraft",
        "oak",
        249,
        105,
        "SUP-FURN",
        1,
        "intermittent",
        0.03,
        edge=["overdue PO beyond grace"],
    ),
    Sku(
        "FUR-LMP-001",
        "Floor lamp, brass",
        "Furniture",
        "Lighting",
        "Oakcraft",
        "gold",
        120,
        48,
        "SUP-FURN",
        2,
        "zero",
        0.02,
        edge=["zero demand"],
    ),
    Sku(
        "SEA-XLT-001",
        "LED string lights, 10m, warm white",
        "Seasonal",
        "Christmas",
        "Twinkle",
        "white",
        25,
        7,
        "SUP-SEAS",
        12,
        "smooth",
        0.12,
        profile="xmas",
    ),
    Sku(
        "SEA-XBA-001",
        "Glass bauble set",
        "Seasonal",
        "Christmas",
        "Twinkle",
        "red",
        18,
        5,
        "SUP-SEAS",
        12,
        "smooth",
        0.08,
        profile="xmas",
    ),
    Sku(
        "SEA-XTR-001",
        "Artificial tree, 6ft",
        "Seasonal",
        "Christmas",
        "Twinkle",
        "green",
        149,
        55,
        "SUP-SEAS",
        1,
        "smooth",
        0.02,
        profile="xmas",
    ),
    Sku(
        "GAR-PAR-001",
        "Garden parasol",
        "Seasonal",
        "Garden",
        "Greenway",
        "grey",
        79,
        30,
        "SUP-GARD",
        2,
        "smooth",
        0.3,
        profile="summer",
    ),
    Sku(
        "GAR-CHR-001",
        "Folding garden chair",
        "Seasonal",
        "Garden",
        "Greenway",
        "green",
        45,
        17,
        "SUP-GARD",
        4,
        "smooth",
        0.4,
        profile="summer",
    ),
]

STORE_DOW = np.array([0.85, 0.85, 0.9, 0.95, 1.1, 1.4, 0.95])  # Mon..Sun
ONLINE_DOW = np.array([1.15, 1.05, 1.0, 0.95, 0.9, 0.85, 1.1])


def _gauss(doy: np.ndarray, centre: float, width: float) -> np.ndarray:
    d = np.abs(doy - centre)
    d = np.minimum(d, 365 - d)
    return np.exp(-0.5 * (d / width) ** 2)


def yearly_profile(profile: str, doy: np.ndarray) -> np.ndarray:
    if profile == "xmas":
        peak = _gauss(doy, 344, 18)  # ~10 Dec
        after = (doy >= 360) | (doy < 10)
        return np.where(after, 0.3, 1.0 + 14.0 * peak)
    if profile == "summer":
        return 0.15 + 1.85 * _gauss(doy, 172, 40)
    if profile == "winter":
        return 0.3 + 1.7 * _gauss(doy, 10, 45)
    return 1.0 + 0.35 * _gauss(doy, 350, 10)


def _promo_windows(sku: Sku, start: date, days: int) -> list[tuple[int, int]]:
    if sku.archetype != "promo":
        return []
    windows = []
    first = 20 + (sum(map(ord, sku.sku)) % 20)
    for s in range(first, days, 56):
        windows.append((s, min(days, s + 7)))
    return windows


FUTURE_PROMOS = [
    # sku, offset from AS_OF, length days, discount
    ("ELE-KET-001", 5, 7, 0.25),
    ("HOM-BED-001", 12, 7, 0.25),
    ("ELE-TOA-001", 3, 7, 0.20),
]


def _series_demand(
    rng: np.random.Generator,
    sku: Sku,
    scale: float,
    dow: np.ndarray,
    doy: np.ndarray,
    weekdays: np.ndarray,
    promo: np.ndarray,
) -> np.ndarray:
    n = len(doy)
    lam = sku.base * scale * yearly_profile(sku.profile, doy) * dow[weekdays]
    lam = lam * np.where(promo, 2.2, 1.0)
    if sku.archetype in ("smooth", "promo", "stockouts"):
        g = rng.gamma(5.0, 1 / 5.0, n)
        return rng.poisson(lam * g).astype(float)
    if sku.archetype == "erratic":
        g = rng.gamma(0.8, 1 / 0.8, n)
        return rng.poisson(lam * g).astype(float)
    if sku.archetype == "intermittent":
        occur = rng.random(n) < np.clip(lam, 0, 1)
        size = 1 + rng.poisson(0.2, n)
        return np.where(occur, size, 0).astype(float)
    if sku.archetype == "lumpy":
        occur = rng.random(n) < np.clip(lam / 3, 0, 1)
        size = rng.choice([2, 4, 6], n)
        return np.where(occur, size, 0).astype(float)
    if sku.archetype == "zero":
        y = rng.poisson(lam).astype(float)
        y[-400:] = 0
        return y
    raise ValueError(sku.archetype)


def _stockouts(rng: np.random.Generator, n: int, rate: float) -> np.ndarray:
    in_stock = np.ones(n, dtype=bool)
    starts = np.where(rng.random(n) < rate)[0]
    lengths = rng.integers(1, 7, len(starts))
    for s, length in zip(starts, lengths, strict=True):
        in_stock[s : s + length] = False
    return in_stock


def _write_csv(path: Path, header: list[str], rows: list[list]) -> None:
    with path.open("w", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(header)
        w.writerows(rows)


def _fmt(x: float) -> str:
    return f"{x:.2f}"


def _iso(d: date | None) -> str:
    return d.isoformat() if d else ""


def generate(out_dir: str | Path, seed: int = DEFAULT_SEED) -> dict:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(seed)
    start = AS_OF - timedelta(days=HISTORY_DAYS)
    dates = [start + timedelta(days=i) for i in range(HISTORY_DAYS)]
    doy = np.array([d.timetuple().tm_yday for d in dates], dtype=float)
    weekdays = np.array([d.weekday() for d in dates])
    stores = [loc for loc in LOCATIONS if loc[2] == "STORE"]
    supplier_by_id = {s[0]: s for s in SUPPLIERS}

    sales_rows: list[list] = []
    promo_rows: list[list] = []
    recent_rate: dict[tuple[str, str, str], float] = {}

    for sku in SKUS:
        windows = _promo_windows(sku, start, HISTORY_DAYS)
        promo = np.zeros(HISTORY_DAYS, dtype=bool)
        for a, b in windows:
            promo[a:b] = True
        series_specs = [(loc[0], "store", loc[4], STORE_DOW) for loc in stores] + [
            (DC, "online", sku.online, ONLINE_DOW)
        ]
        for loc_id, channel, scale, dow in series_specs:
            demand = _series_demand(rng, sku, scale, dow, doy, weekdays, promo)
            rate = 0.03 if sku.archetype == "stockouts" else 0.003
            in_stock = _stockouts(rng, HISTORY_DAYS, rate)
            units = np.where(in_stock, demand, 0.0)
            ranged_from = 0
            if sku.launch is not None:
                ranged_from = max(0, (sku.launch - start).days)
            recent = units[-28:][in_stock[-28:]]
            recent_rate[(sku.sku, loc_id, channel)] = float(recent.mean()) if recent.size else 0.0
            for i in range(ranged_from, HISTORY_DAYS):
                price = sku.price * (0.75 if promo[i] else 1.0)
                sales_rows.append(
                    [
                        dates[i].isoformat(),
                        sku.sku,
                        loc_id,
                        channel,
                        int(units[i]),
                        _fmt(price),
                        "true" if promo[i] else "false",
                        "true" if in_stock[i] else "false",
                    ]
                )
            for k, (a, b) in enumerate(windows):
                promo_rows.append(
                    [
                        f"PR-{sku.sku}-{k:03d}",
                        sku.sku,
                        loc_id,
                        channel,
                        dates[a].isoformat(),
                        dates[b - 1].isoformat(),
                        "0.25",
                    ]
                )
        for s, offset, length, disc in FUTURE_PROMOS:
            if s != sku.sku:
                continue
            for loc_id, channel, _, _ in series_specs:
                promo_rows.append(
                    [
                        f"PR-{sku.sku}-F",
                        sku.sku,
                        loc_id,
                        channel,
                        (AS_OF + timedelta(days=offset)).isoformat(),
                        (AS_OF + timedelta(days=offset + length - 1)).isoformat(),
                        f"{disc:.2f}",
                    ]
                )

    # sales: sort for stable output
    sales_rows.sort(key=lambda r: (r[1], r[2], r[3], r[0]))

    # ---------------- reference data ----------------
    _write_csv(
        out / "locations.csv",
        ["location_id", "name", "type", "region", "serving_dc_id", "fulfils_online"],
        [
            [loc[0], loc[1], loc[2], loc[3], "" if loc[2] == "DC" else DC, "true" if loc[2] == "DC" else "false"]
            for loc in LOCATIONS
        ],
    )
    _write_csv(
        out / "suppliers.csv",
        [
            "supplier_id",
            "name",
            "lead_time_days",
            "lead_time_std_days",
            "order_weekdays",
            "delivery_weekdays",
            "currency",
        ],
        [
            [s[0], s[1], s[2], f"{s[3]:.1f}", "|".join(map(str, s[4])), "|".join(map(str, s[5])), "GBP"]
            for s in SUPPLIERS
        ],
    )
    _write_csv(
        out / "products.csv",
        [
            "sku",
            "name",
            "category",
            "subcategory",
            "brand",
            "colour_family",
            "unit_price",
            "status",
            "launch_date",
            "end_of_life_date",
        ],
        [
            [
                k.sku,
                k.name,
                k.category,
                k.subcategory,
                k.brand,
                k.colour,
                _fmt(k.price),
                k.status,
                _iso(k.launch),
                _iso(k.eol),
            ]
            for k in SKUS
        ],
    )
    _write_csv(
        out / "sourcing.csv",
        ["sku", "supplier_id", "destination_location_id", "unit_cost", "pack_size", "moq"],
        [[k.sku, k.supplier, DC, _fmt(k.cost), k.pack, k.moq] for k in SKUS],
    )
    item_loc_rows = []
    for k in SKUS:
        item_loc_rows.append(
            [k.sku, DC, "SUPPLIER", f"{SERVICE_LEVELS[k.category]:.2f}", "" if k.dc_capacity is None else k.dc_capacity]
        )
        for loc in stores:
            item_loc_rows.append([k.sku, loc[0], "DC_TRANSFER", f"{SERVICE_LEVELS[k.category]:.2f}", ""])
    _write_csv(
        out / "item_locations.csv",
        ["sku", "location_id", "replenishment_source", "service_level", "capacity_units"],
        item_loc_rows,
    )
    _write_csv(
        out / "order_constraints.csv",
        ["supplier_id", "destination_location_id", "min_order_value", "budget"],
        [[s, d, _fmt(m), "" if b is None else _fmt(b)] for s, d, m, b in ORDER_CONSTRAINTS],
    )

    # ---------------- inventory and open orders ----------------
    inv_rows = []
    open_rows = []
    po_seq = 1000
    for k in SKUS:
        dc_daily = sum(recent_rate[(k.sku, loc[0], "store")] for loc in stores) + recent_rate[(k.sku, DC, "online")]
        cover = float(rng.uniform(6, 18))
        on_hand = int(round(dc_daily * cover))
        reserved = int(round(recent_rate[(k.sku, DC, "online")] * rng.uniform(0.5, 1.5)))
        damaged = int(rng.integers(0, 3))
        returns_pending = int(rng.integers(0, 3))
        if k.sku == "HOM-BED-002":
            on_hand = -6
        if k.sku == "ELE-HEA-001":
            on_hand, reserved = 4, 9
        if k.sku == "HOM-VAS-001":
            on_hand, reserved = 1, 0
        if k.sku == "HOM-CAN-001":
            on_hand = int(round(dc_daily * 15))
        if k.sku == "FAS-SHT-001":
            on_hand = 40
        if k.sku == "FUR-LMP-001":
            on_hand = 14
        if k.sku in ("HOM-CUS-002",):
            on_hand = 24
        if k.sku == "ELE-HEA-002":
            on_hand, reserved, damaged, returns_pending = 0, 0, 0, 0
        inv_rows.append([k.sku, DC, AS_OF.isoformat(), on_hand, reserved, 0, damaged, returns_pending])
        for loc in stores:
            r = recent_rate[(k.sku, loc[0], "store")]
            s_on_hand = int(round(r * float(rng.uniform(3, 14))))
            if k.launch and k.launch > AS_OF:
                s_on_hand = 0
            inv_rows.append([k.sku, loc[0], AS_OF.isoformat(), s_on_hand, 0, int(rng.integers(0, 2)), 0, 0])
        lead = supplier_by_id[k.supplier][2]
        if k.sku in ("HOM-TWL-001", "FAS-TEE-002", "ELE-CBL-001", "SEA-XLT-001"):
            po_seq += 1
            qty = int(max(k.pack, round(dc_daily * 7 / k.pack) * k.pack))
            open_rows.append(
                [
                    f"LEG-PO-{po_seq}",
                    k.sku,
                    k.supplier,
                    DC,
                    qty,
                    (AS_OF - timedelta(days=lead - 4)).isoformat(),
                    (AS_OF + timedelta(days=4)).isoformat(),
                ]
            )
        if k.sku == "FUR-BKC-001":
            po_seq += 1
            open_rows.append(
                [
                    f"LEG-PO-{po_seq}",
                    k.sku,
                    k.supplier,
                    DC,
                    2,
                    (AS_OF - timedelta(days=lead + 3)).isoformat(),
                    (AS_OF - timedelta(days=3)).isoformat(),
                ]
            )
        if k.sku == "FUR-TBL-001":
            po_seq += 1
            open_rows.append(
                [
                    f"LEG-PO-{po_seq}",
                    k.sku,
                    k.supplier,
                    DC,
                    3,
                    (AS_OF - timedelta(days=lead + 12)).isoformat(),
                    (AS_OF - timedelta(days=12)).isoformat(),
                ]
            )
    _write_csv(
        out / "inventory_snapshot.csv",
        ["sku", "location_id", "as_of_date", "on_hand", "reserved", "in_transit", "damaged", "returns_pending"],
        inv_rows,
    )
    _write_csv(
        out / "open_purchase_orders.csv",
        ["po_reference", "sku", "supplier_id", "destination_location_id", "quantity", "order_date", "expected_date"],
        open_rows,
    )

    # ---------------- supplier delivery history (OTIF) ----------------
    hist_rows = []
    for s in SUPPLIERS:
        sid, _, lead, _, order_days, _, on_time_p, late_mean = s
        for j in range(12):
            order_date = AS_OF - timedelta(days=200 - j * 14)
            promised = order_date + timedelta(days=lead)
            late = rng.random() > on_time_p
            delay = int(rng.integers(1, 2 * late_mean + 1)) if late else 0
            received = promised + timedelta(days=delay)
            ordered = int(rng.integers(20, 200))
            short = rng.random() < (1 - on_time_p) / 2
            received_units = int(ordered * float(rng.uniform(0.7, 0.95))) if short else ordered
            hist_rows.append(
                [
                    f"HIST-{sid}-{j:02d}",
                    sid,
                    DC,
                    order_date.isoformat(),
                    promised.isoformat(),
                    received.isoformat(),
                    ordered,
                    received_units,
                ]
            )
    _write_csv(
        out / "po_receipt_history.csv",
        [
            "po_reference",
            "supplier_id",
            "destination_location_id",
            "order_date",
            "promised_date",
            "received_date",
            "ordered_units",
            "received_units",
        ],
        hist_rows,
    )

    _write_csv(
        out / "sales_history.csv",
        ["date", "sku", "location_id", "channel", "units", "net_price", "promo", "in_stock"],
        sales_rows,
    )
    promo_rows.sort()
    _write_csv(
        out / "promotions.csv",
        ["promo_id", "sku", "location_id", "channel", "start_date", "end_date", "discount_pct"],
        promo_rows,
    )

    files = sorted(p.name for p in out.glob("*.csv"))
    manifest = {
        "generatorVersion": GENERATOR_VERSION,
        "seed": seed,
        "asOfDate": AS_OF.isoformat(),
        "historyDays": HISTORY_DAYS,
        "synthetic": True,
        "files": {f: hashlib.sha256((out / f).read_bytes()).hexdigest() for f in files},
        "rows": {f: sum(1 for _ in (out / f).open()) - 1 for f in files},
        "edgeCases": {k.sku: k.edge for k in SKUS if k.edge},
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    return manifest
