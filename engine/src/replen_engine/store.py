"""Analytical store adapter.

Local: DuckDB file standing in for BigQuery. Production: a BigQuery adapter with the same methods
(not implemented in the slice). Queries are kept to ANSI SQL that ports to BigQuery.

Data contract for `sales_daily` (A-22): one row per ranged SKU x location x channel x day, including
zero-sales days, with `in_stock` = stock available at open. Missing days are treated as not ranged.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from datetime import date, timedelta
from pathlib import Path

import duckdb
import numpy as np

from .analogue import ProductAttributes
from .forecast import Series

TABLES = {
    "sales_daily": {
        "file": "sales_history.csv",
        "columns": {
            "date": "DATE",
            "sku": "VARCHAR",
            "location_id": "VARCHAR",
            "channel": "VARCHAR",
            "units": "DOUBLE",
            "net_price": "DOUBLE",
            "promo": "BOOLEAN",
            "in_stock": "BOOLEAN",
        },
    },
    "promotions": {
        "file": "promotions.csv",
        "columns": {
            "promo_id": "VARCHAR",
            "sku": "VARCHAR",
            "location_id": "VARCHAR",
            "channel": "VARCHAR",
            "start_date": "DATE",
            "end_date": "DATE",
            "discount_pct": "DOUBLE",
        },
    },
    "products": {
        "file": "products.csv",
        "columns": None,  # dimension: inferred
    },
}

DDL_FORECASTS = """
CREATE TABLE IF NOT EXISTS forecast_daily (
  run_id VARCHAR, sku VARCHAR, destination_location_id VARCHAR, date DATE,
  mean DOUBLE, p10 DOUBLE, p90 DOUBLE, created_at TIMESTAMP DEFAULT current_timestamp
);
CREATE TABLE IF NOT EXISTS forecast_accuracy (
  run_id VARCHAR, sku VARCHAR, destination_location_id VARCHAR, as_of_date DATE,
  wape DOUBLE, bias DOUBLE, naive_wape DOUBLE, actual_units DOUBLE, abs_error DOUBLE, error DOUBLE
);
"""


class AnalyticsStore:
    def __init__(self, path: str | Path):
        self.path = str(path)

    @contextmanager
    def connect(self, read_only: bool = False) -> Iterator[duckdb.DuckDBPyConnection]:
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        con = duckdb.connect(self.path, read_only=read_only)
        try:
            yield con
        finally:
            con.close()

    def import_dir(self, directory: str | Path) -> dict[str, int]:
        directory = Path(directory)
        counts: dict[str, int] = {}
        with self.connect() as con:
            for table, spec in TABLES.items():
                f = directory / spec["file"]
                if not f.exists():
                    raise FileNotFoundError(f)
                if spec["columns"]:
                    cols = ", ".join(f"'{k}': '{v}'" for k, v in spec["columns"].items())
                    sql = (
                        f"CREATE OR REPLACE TABLE {table} AS SELECT * FROM read_csv(?, header=true, columns={{{cols}}})"
                    )
                    con.execute(sql, [str(f)])
                else:
                    con.execute(
                        f"CREATE OR REPLACE TABLE {table} AS SELECT * FROM read_csv_auto(?, header=true)", [str(f)]
                    )
                counts[table] = con.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
            con.execute("CREATE INDEX IF NOT EXISTS sales_series ON sales_daily (sku, location_id, channel)")
            con.execute(DDL_FORECASTS)
        return counts

    def status(self) -> dict[str, int | str | None]:
        if not Path(self.path).exists():
            return {"path": self.path, "salesRows": 0, "maxDate": None}
        with self.connect() as con:
            try:
                rows, max_date = con.execute("SELECT count(*), max(date) FROM sales_daily").fetchone()
            except duckdb.CatalogException:
                return {"path": self.path, "salesRows": 0, "maxDate": None}
        return {"path": self.path, "salesRows": rows, "maxDate": max_date.isoformat() if max_date else None}


def load_series(
    con: duckdb.DuckDBPyConnection, sku: str, location_id: str, channel: str, start: date, end: date
) -> Series | None:
    rows = con.execute(
        """
        SELECT date, units, in_stock, promo FROM sales_daily
        WHERE sku = ? AND location_id = ? AND channel = ? AND date BETWEEN ? AND ?
        ORDER BY date
        """,
        [sku, location_id, channel, start, end],
    ).fetchall()
    n = (end - start).days + 1
    units = np.zeros(n)
    observed = np.zeros(n, dtype=bool)
    promo = np.zeros(n, dtype=bool)
    if not rows:
        return Series(start, units, observed, promo)
    for d, u, in_stock, p in rows:
        i = (d - start).days
        units[i] = u
        observed[i] = bool(in_stock)
        promo[i] = bool(p)
    return Series(start, units, observed, promo)


def future_promos(
    con: duckdb.DuckDBPyConnection, sku: str, location_id: str, channel: str, as_of: date, horizon: int
) -> np.ndarray:
    end = as_of + timedelta(days=horizon - 1)
    rows = con.execute(
        """
        SELECT start_date, end_date FROM promotions
        WHERE sku = ? AND location_id = ? AND channel = ? AND end_date >= ? AND start_date <= ?
        """,
        [sku, location_id, channel, as_of, end],
    ).fetchall()
    flags = np.zeros(horizon, dtype=bool)
    for s, e in rows:
        a = max(0, (s - as_of).days)
        b = min(horizon, (e - as_of).days + 1)
        flags[a:b] = True
    return flags


def product_attributes(con: duckdb.DuckDBPyConnection, sku: str) -> ProductAttributes | None:
    row = con.execute(
        "SELECT sku, category, subcategory, brand, colour_family, unit_price FROM products WHERE sku = ?", [sku]
    ).fetchone()
    return ProductAttributes(*row[:5], float(row[5])) if row else None


def category_candidates(con: duckdb.DuckDBPyConnection, category: str) -> list[ProductAttributes]:
    rows = con.execute(
        """SELECT sku, category, subcategory, brand, colour_family, unit_price FROM products
           WHERE category = ? ORDER BY sku""",
        [category],
    ).fetchall()
    return [ProductAttributes(*r[:5], float(r[5])) for r in rows]


def write_forecasts(con: duckdb.DuckDBPyConnection, rows: list[tuple], accuracy_rows: list[tuple]) -> None:
    con.execute(DDL_FORECASTS)
    if rows:
        con.executemany(
            "INSERT INTO forecast_daily (run_id, sku, destination_location_id, date, mean, p10, p90) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            rows,
        )
    if accuracy_rows:
        con.executemany(
            "INSERT INTO forecast_accuracy VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            accuracy_rows,
        )
