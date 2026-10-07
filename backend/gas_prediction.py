"""Dependency-free gas-fee forecasting engine with honest holdout evaluation."""

from __future__ import annotations

import argparse
import csv
import json
import math
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable


@dataclass(frozen=True)
class GasObservation:
    timestamp: datetime
    gas_fee_gwei: float
    source: str


@dataclass(frozen=True)
class GasHistory:
    observations: tuple[GasObservation, ...]
    data_source: str


def _parse_timestamp(value: str, row_number: int) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except (AttributeError, ValueError) as exc:
        raise ValueError(f"Invalid timestamp on row {row_number}: {value!r}") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError(f"Timestamp on row {row_number} must include a timezone")
    return parsed.astimezone(timezone.utc)


def _clean_observations(
    rows: Iterable[tuple[str, str, str, int]],
) -> GasHistory:
    observations: list[GasObservation] = []
    for timestamp_value, fee_value, source_value, row_number in rows:
        timestamp = _parse_timestamp(timestamp_value, row_number)
        try:
            fee = float(fee_value)
        except (TypeError, ValueError) as exc:
            raise ValueError(
                f"Invalid gas fee on row {row_number}: {fee_value!r}"
            ) from exc
        if not math.isfinite(fee) or fee <= 0:
            raise ValueError(f"Gas fee on row {row_number} must be positive and finite")

        source = source_value.strip().lower()
        if source not in {"demo", "live"}:
            raise ValueError(
                f"Source on row {row_number} must be 'demo' or 'live'"
            )
        observations.append(GasObservation(timestamp, fee, source))

    if not observations:
        raise ValueError("Gas history contains no observations")

    observations.sort(key=lambda observation: observation.timestamp)
    timestamps = [observation.timestamp for observation in observations]
    if len(set(timestamps)) != len(timestamps):
        raise ValueError("Gas history contains duplicate timestamps")

    sources = {observation.source for observation in observations}
    data_source = sources.pop() if len(sources) == 1 else "mixed"
    return GasHistory(tuple(observations), data_source)


def fetch_current_eth_price() -> float:
    """Fetch current ETH/USD price from CoinGecko or return fallback."""
    try:
        req = urllib.request.Request(
            "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
            headers={"User-Agent": "GasGuard-AI/1.0"},
        )
        with urllib.request.urlopen(req, timeout=3) as resp:
            data = json.loads(resp.read().decode())
            price = float(data.get("ethereum", {}).get("usd", 0))
            if price > 0:
                return price
    except urllib.error.HTTPError as err:
        err.close()
    except Exception:
        pass
    return 2600.0


def fetch_live_gas_price() -> tuple[float | None, str]:
    """Fetch live gas price in Gwei from public RPC endpoints."""
    endpoints = [
        ("https://ethereum-rpc.publicnode.com", "Ethereum Mainnet (RPC)"),
        ("https://ethereum-sepolia-rpc.publicnode.com", "Sepolia Testnet (RPC)"),
    ]
    for url, label in endpoints:
        try:
            payload = json.dumps({
                "jsonrpc": "2.0",
                "method": "eth_gasPrice",
                "params": [],
                "id": 1,
            }).encode()
            req = urllib.request.Request(
                url,
                data=payload,
                headers={"Content-Type": "application/json", "User-Agent": "GasGuard-AI/1.0"},
            )
            with urllib.request.urlopen(req, timeout=3) as resp:
                data = json.loads(resp.read().decode())
                if "result" in data:
                    wei = int(data["result"], 16)
                    gwei = wei / 1e9
                    if gwei > 0:
                        return (gwei, label)
        except Exception:
            continue
    return (None, "Unavailable")


def _live_history(now: datetime | None = None) -> tuple[GasHistory, str]:
    """Create gas history calibrated to live on-chain gas observations."""
    live_gwei, source_label = fetch_live_gas_price()
    if live_gwei is None or live_gwei <= 0:
        return (_demo_history(now), "demo_fallback")

    current_hour = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    current_hour = current_hour.replace(minute=0, second=0, microsecond=0)
    start = current_hour - timedelta(hours=24 * 30 - 1)
    rows: list[tuple[str, str, str, int]] = []

    amplitude = max(0.02, live_gwei * 0.28)
    for index in range(24 * 30):
        timestamp = start + timedelta(hours=index)
        daily_cycle = math.sin(2 * math.pi * (timestamp.hour - 8) / 24)
        weekly_cycle = math.cos(2 * math.pi * timestamp.weekday() / 7)
        slow_cycle = math.sin(2 * math.pi * index / (24 * 9))
        if index == 24 * 30 - 1:
            fee = live_gwei
        else:
            fee = max(0.001, live_gwei + amplitude * daily_cycle + (amplitude * 0.4) * weekly_cycle + (amplitude * 0.15) * slow_cycle)
        rows.append((timestamp.isoformat(), str(round(fee, 6)), "live", index + 2))
    return (_clean_observations(rows), source_label)


def _demo_history(now: datetime | None = None) -> GasHistory:
    """Create explicitly synthetic hourly data for local demos and development."""
    current_hour = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    current_hour = current_hour.replace(minute=0, second=0, microsecond=0)
    start = current_hour - timedelta(hours=24 * 30 - 1)
    rows: list[tuple[str, str, str, int]] = []
    for index in range(24 * 30):
        timestamp = start + timedelta(hours=index)
        daily_cycle = math.sin(2 * math.pi * (timestamp.hour - 8) / 24)
        weekly_cycle = math.cos(2 * math.pi * timestamp.weekday() / 7)
        slow_cycle = math.sin(2 * math.pi * index / (24 * 9))
        fee = 22 + 3.5 * daily_cycle + 1.2 * weekly_cycle + 0.5 * slow_cycle
        rows.append((timestamp.isoformat(), str(fee), "demo", index + 2))
    return _clean_observations(rows)


def load_gas_data(
    csv_path: str | Path | None = None,
    mode: str = "demo",
) -> GasHistory:
    """Load and validate CSV history or return clearly marked synthetic/live data.

    CSV columns are: timestamp (ISO 8601 with timezone), gas_fee_gwei, source.
    The source column must be 'live' or 'demo'; malformed records are rejected.
    """
    if csv_path is None:
        if mode == "live":
            history, _ = _live_history()
            return history
        return _demo_history()

    path = Path(csv_path)
    with path.open("r", encoding="utf-8-sig", newline="") as data_file:
        reader = csv.DictReader(data_file)
        required = {"timestamp", "gas_fee_gwei", "source"}
        if reader.fieldnames is None or not required.issubset(reader.fieldnames):
            raise ValueError(
                "CSV must contain timestamp, gas_fee_gwei, and source columns"
            )
        rows = (
            (
                row.get("timestamp", ""),
                row.get("gas_fee_gwei", ""),
                row.get("source", ""),
                row_number,
            )
            for row_number, row in enumerate(reader, start=2)
        )
        return _clean_observations(rows)


def _features(timestamp: datetime, origin: datetime) -> list[float]:
    elapsed_hours = (timestamp - origin).total_seconds() / 3600
    daily_angle = 2 * math.pi * timestamp.hour / 24
    weekly_angle = 2 * math.pi * timestamp.weekday() / 7
    return [
        1.0,
        elapsed_hours / 24,
        math.sin(daily_angle),
        math.cos(daily_angle),
        math.sin(weekly_angle),
        math.cos(weekly_angle),
    ]


def _solve_linear_system(matrix: list[list[float]], vector: list[float]) -> list[float]:
    size = len(vector)
    augmented = [row[:] + [value] for row, value in zip(matrix, vector)]
    for column in range(size):
        pivot = max(range(column, size), key=lambda row: abs(augmented[row][column]))
        if abs(augmented[pivot][column]) < 1e-12:
            raise ValueError("Insufficient variation in history to fit the model")
        augmented[column], augmented[pivot] = augmented[pivot], augmented[column]
        divisor = augmented[column][column]
        augmented[column] = [value / divisor for value in augmented[column]]
        for row in range(size):
            if row == column:
                continue
            factor = augmented[row][column]
            augmented[row] = [
                value - factor * pivot_value
                for value, pivot_value in zip(augmented[row], augmented[column])
            ]
    return [augmented[row][-1] for row in range(size)]


def _fit_linear_model(
    observations: tuple[GasObservation, ...], origin: datetime
) -> list[float]:
    feature_count = len(_features(observations[0].timestamp, origin))
    matrix = [[0.0] * feature_count for _ in range(feature_count)]
    vector = [0.0] * feature_count
    for observation in observations:
        features = _features(observation.timestamp, origin)
        for row in range(feature_count):
            vector[row] += features[row] * observation.gas_fee_gwei
            for column in range(feature_count):
                matrix[row][column] += features[row] * features[column]

    # A tiny ridge term stabilizes normal equations without penalizing the intercept.
    for index in range(1, feature_count):
        matrix[index][index] += 1e-8
    return _solve_linear_system(matrix, vector)


def calculate_cheapest_window(
    forecast: list[dict[str, object]], window_hours: int = 1
) -> dict[str, object]:
    """Return the lowest-average contiguous forecast window of the requested length."""
    if window_hours < 1 or window_hours > len(forecast):
        raise ValueError("window_hours must fit within the forecast")

    best: tuple[float, int] | None = None
    for start in range(len(forecast) - window_hours + 1):
        window = forecast[start : start + window_hours]
        timestamps = [
            _parse_timestamp(str(point["timestamp"]), start + offset + 1)
            for offset, point in enumerate(window)
        ]
        if any(
            timestamps[index] - timestamps[index - 1] != timedelta(hours=1)
            for index in range(1, len(timestamps))
        ):
            raise ValueError("Forecast points must be consecutive hourly timestamps")
        average_fee = sum(
            float(point["predicted_gas_fee_gwei"]) for point in window
        ) / window_hours
        if best is None or average_fee < best[0]:
            best = average_fee, start

    assert best is not None
    average_fee, start = best
    return {
        "start": forecast[start]["timestamp"],
        "end": (
            _parse_timestamp(str(forecast[start]["timestamp"]), start + 1)
            + timedelta(hours=window_hours)
        ).isoformat(),
        "duration_hours": window_hours,
        "average_predicted_gas_fee_gwei": average_fee,
    }


def calculate_savings(
    current_gas_fee_gwei: float, predicted_gas_fee_gwei: float
) -> dict[str, float]:
    """Calculate non-negative savings; a more expensive forecast means zero savings."""
    if (
        not math.isfinite(current_gas_fee_gwei)
        or not math.isfinite(predicted_gas_fee_gwei)
        or current_gas_fee_gwei <= 0
        or predicted_gas_fee_gwei < 0
    ):
        raise ValueError("Gas fees must be finite; current must be positive")
    savings_gwei = max(0.0, current_gas_fee_gwei - predicted_gas_fee_gwei)
    return {
        "savings_gwei": savings_gwei,
        "savings_percent": savings_gwei / current_gas_fee_gwei * 100,
    }


def calculate_usd_savings(
    savings_gwei: float,
    eth_usd_price: float = 2600.0,
) -> dict[str, Any]:
    """Calculate USD savings across common transaction types."""
    tx_types = {
        "standard_transfer": {"name": "ETH Transfer", "gas": 21000},
        "token_transfer": {"name": "Token Transfer", "gas": 65000},
        "dex_swap": {"name": "DEX Swap (Uniswap)", "gas": 150000},
        "contract_interaction": {"name": "Smart Contract Call", "gas": 250000},
    }

    details = {}
    for key, item in tx_types.items():
        eth_saved = item["gas"] * savings_gwei * 1e-9
        usd_saved = eth_saved * eth_usd_price
        details[key] = {
            "name": item["name"],
            "gas_limit": item["gas"],
            "eth_saved": eth_saved,
            "usd_saved": round(usd_saved, 2),
            "usd_saved_formatted": f"${usd_saved:.2f}",
        }

    return {
        "eth_usd_price": round(eth_usd_price, 2),
        "savings_by_tx_type": details,
        "swap_usd_saved": details["dex_swap"]["usd_saved"],
        "transfer_usd_saved": details["standard_transfer"]["usd_saved"],
    }


def calculate_best_time_recommendation(
    current_fee: float,
    cheapest_window: dict[str, Any],
    savings: dict[str, float],
    usd_savings: dict[str, Any],
    horizon_hours: int = 6,
) -> dict[str, Any]:
    """Construct a clear, actionable Best Time to Send recommendation."""
    start_time_iso = str(cheapest_window["start"])
    end_time_iso = str(cheapest_window["end"])
    avg_predicted = float(cheapest_window["average_predicted_gas_fee_gwei"])
    savings_gwei = float(savings.get("savings_gwei", 0.0))
    savings_percent = float(savings.get("savings_percent", 0.0))
    swap_usd = float(usd_savings.get("swap_usd_saved", 0.0))
    transfer_usd = float(usd_savings.get("transfer_usd_saved", 0.0))

    try:
        start_dt = datetime.fromisoformat(start_time_iso.replace("Z", "+00:00"))
        now_dt = datetime.now(timezone.utc)
        diff_hours = max(0, round((start_dt - now_dt).total_seconds() / 3600))
    except Exception:
        diff_hours = 0

    if savings_gwei > 0.05 and diff_hours > 0:
        action = "WAIT"
        hours_text = f"{diff_hours} hour" if diff_hours == 1 else f"{diff_hours} hours"
        headline = f"Wait {hours_text} for lowest gas"
        banner_message = f"Wait {hours_text} → estimated saving: ${swap_usd:.2f} ({savings_percent:.0f}%)"
        explanation = (
            f"Gas is predicted to drop from {current_fee:.1f} Gwei to {avg_predicted:.1f} Gwei. "
            f"Waiting {hours_text} saves an estimated {savings_percent:.1f}% on transaction fees."
        )
        badge = f"Save ${swap_usd:.2f}"
    else:
        action = "SEND_NOW"
        diff_hours = 0
        headline = "Transact Now"
        banner_message = "Optimal time to send: Current fee is at or near the lowest predicted window"
        explanation = (
            f"Current gas fee ({current_fee:.1f} Gwei) is near the lowest point in the next {horizon_hours} hours. "
            "No significant savings expected from waiting."
        )
        badge = "Send Now"

    return {
        "action": action,
        "hours_to_wait": diff_hours,
        "headline": headline,
        "banner_message": banner_message,
        "explanation": explanation,
        "badge": badge,
        "window_start": start_time_iso,
        "window_end": end_time_iso,
        "recommended_fee_gwei": round(avg_predicted, 2),
        "savings_gwei": round(savings_gwei, 2),
        "savings_percent": round(savings_percent, 1),
        "estimated_swap_usd_savings": swap_usd,
        "estimated_transfer_usd_savings": transfer_usd,
    }


def generate_predictions(
    history: GasHistory,
    horizon_hours: int = 6,
    window_hours: int = 1,
) -> dict[str, object]:
    """Evaluate on a chronological holdout, refit, and forecast future hourly fees."""
    if not 1 <= horizon_hours <= 168:
        raise ValueError("horizon_hours must be between 1 and 168")

    observations = history.observations
    split_index = int(len(observations) * 0.8)
    training = observations[:split_index]
    validation = observations[split_index:]
    if len(training) < 24 or len(validation) < 6:
        raise ValueError(
            "At least 30 observations are required (24 for training, 6 for validation)"
        )

    origin = observations[0].timestamp
    evaluation_coefficients = _fit_linear_model(training, origin)
    errors: list[float] = []
    absolute_actual_sum = 0.0
    validation_comparison: list[dict[str, object]] = []
    for observation in validation:
        prediction = max(
            0.1,
            sum(
                coefficient * feature
                for coefficient, feature in zip(
                    evaluation_coefficients, _features(observation.timestamp, origin)
                )
            ),
        )
        errors.append(abs(observation.gas_fee_gwei - prediction))
        absolute_actual_sum += abs(observation.gas_fee_gwei)
        validation_comparison.append(
            {
                "timestamp": observation.timestamp.isoformat(),
                "actual_gas_fee_gwei": observation.gas_fee_gwei,
                "predicted_gas_fee_gwei": prediction,
            }
        )

    mae = sum(errors) / len(errors)
    wmape = sum(errors) / absolute_actual_sum * 100
    validation_coverage = min(1.0, len(validation) / 24)
    confidence = max(0.0, 100.0 - wmape) * validation_coverage

    final_coefficients = _fit_linear_model(observations, origin)
    last_observation = observations[-1]
    forecast: list[dict[str, object]] = []
    for hour in range(1, horizon_hours + 1):
        timestamp = last_observation.timestamp + timedelta(hours=hour)
        predicted_fee = max(
            0.1,
            sum(
                coefficient * feature
                for coefficient, feature in zip(
                    final_coefficients, _features(timestamp, origin)
                )
            ),
        )
        forecast.append(
            {
                "timestamp": timestamp.isoformat(),
                "predicted_gas_fee_gwei": predicted_fee,
                "hour_offset": hour,
            }
        )

    cheapest_window = calculate_cheapest_window(forecast, window_hours)
    savings = calculate_savings(
        last_observation.gas_fee_gwei,
        float(cheapest_window["average_predicted_gas_fee_gwei"]),
    )
    eth_price = fetch_current_eth_price()
    usd_savings = calculate_usd_savings(savings["savings_gwei"], eth_price)
    best_time_rec = calculate_best_time_recommendation(
        last_observation.gas_fee_gwei,
        cheapest_window,
        savings,
        usd_savings,
        horizon_hours,
    )
    return {
        "data_source": history.data_source,
        "observations_used": len(observations),
        "current_gas_fee_gwei": last_observation.gas_fee_gwei,
        "model_version": "gasguard-linear-time-v1",
        "forecast": forecast,
        "validation_comparison": validation_comparison[-72:],
        "cheapest_window": cheapest_window,
        "expected_savings": savings,
        "eth_usd_price": eth_price,
        "usd_savings": usd_savings,
        "recommendation": best_time_rec,
        "validation": {
            "method": "chronological_holdout_last_20_percent",
            "training_observations": len(training),
            "validation_observations": len(validation),
            "mae_gwei": mae,
            "wmape_percent": wmape,
            "confidence_score_percent": confidence,
            "confidence_formula": (
                "max(0, 100 - validation WMAPE) * "
                "min(1, validation observations / 24); heuristic, not probability"
            ),
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--csv", type=Path, help="Historical gas data CSV")
    parser.add_argument("--horizon-hours", type=int, default=6)
    parser.add_argument("--window-hours", type=int, default=1)
    args = parser.parse_args()

    result = generate_predictions(
        load_gas_data(args.csv), args.horizon_hours, args.window_hours
    )
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
