"""Dependency-free gas-fee forecasting engine with honest holdout evaluation."""

from __future__ import annotations

import argparse
import csv
import json
import math
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable


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


def load_gas_data(csv_path: str | Path | None = None) -> GasHistory:
    """Load and validate CSV history or return clearly marked synthetic demo data.

    CSV columns are: timestamp (ISO 8601 with timezone), gas_fee_gwei, source.
    The source column must be 'live' or 'demo'; malformed records are rejected.
    """
    if csv_path is None:
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
            }
        )

    cheapest_window = calculate_cheapest_window(forecast, window_hours)
    savings = calculate_savings(
        last_observation.gas_fee_gwei,
        float(cheapest_window["average_predicted_gas_fee_gwei"]),
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
