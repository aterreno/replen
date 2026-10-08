"""Demand distribution quantiles.

Large expected demand uses a normal approximation. Small expected demand uses a negative binomial
matched to the mean and variance (Poisson when variance <= mean), because the normal places
probability mass below zero and understates the right tail for slow movers.
"""

from __future__ import annotations

import math
from statistics import NormalDist

NORMAL_THRESHOLD = 30.0
_STD_NORMAL = NormalDist()


def z_for_service_level(service_level: float) -> float:
    return _STD_NORMAL.inv_cdf(service_level)


def _discrete_quantile(mean: float, variance: float, q: float) -> int:
    """Smallest integer s with P(D <= s) >= q for D ~ NB(mean, variance) or Poisson(mean)."""
    if mean <= 0:
        return 0
    if variance <= mean * (1 + 1e-9):
        pmf = math.exp(-mean)
        cdf = pmf
        k = 0
        while cdf < q:
            k += 1
            pmf *= mean / k
            cdf += pmf
            if k > 100_000:
                break
        return k
    # NB parameterised by r (size) and p (success probability): mean = r(1-p)/p
    r = mean * mean / (variance - mean)
    p = r / (r + mean)
    log_pmf = r * math.log(p)
    pmf = math.exp(log_pmf)
    cdf = pmf
    k = 0
    while cdf < q:
        pmf *= (k + r) / (k + 1) * (1 - p)
        k += 1
        cdf += pmf
        if k > 100_000:
            break
    return k


def demand_quantile(mean: float, variance: float, q: float) -> float:
    """Quantile of demand over a period. Returns an integer-valued float for the discrete branch."""
    if mean <= 0:
        return 0.0
    if mean >= NORMAL_THRESHOLD:
        return max(0.0, mean + _STD_NORMAL.inv_cdf(q) * math.sqrt(max(variance, 0.0)))
    return float(_discrete_quantile(mean, max(variance, mean), q))


def distribution_name(mean: float, variance: float) -> str:
    if mean <= 0:
        return "none"
    if mean >= NORMAL_THRESHOLD:
        return "normal"
    return "poisson" if variance <= mean * (1 + 1e-9) else "negative_binomial"
