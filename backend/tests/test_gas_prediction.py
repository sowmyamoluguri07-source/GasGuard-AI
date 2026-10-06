import csv
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from backend.gas_prediction import (
    GasHistory,
    GasObservation,
    calculate_cheapest_window,
    calculate_savings,
    generate_predictions,
    load_gas_data,
)


def make_history(count=120, source="live"):
    start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    observations = tuple(
        GasObservation(
            start + timedelta(hours=index),
            20 + 4 * (1 if (index % 24) in range(12, 18) else 0)
            + (index % 7) * 0.1,
            source,
        )
        for index in range(count)
    )
    return GasHistory(observations, source)


class LoadGasDataTests(unittest.TestCase):
    def test_loads_and_normalizes_csv_history(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "history.csv"
            path.write_text(
                "timestamp,gas_fee_gwei,source\n"
                "2026-01-01T01:00:00+01:00,20.5,live\n"
                "2026-01-01T02:00:00+01:00,21,live\n",
                encoding="utf-8",
            )
            history = load_gas_data(path)

        self.assertEqual(history.data_source, "live")
        self.assertEqual(len(history.observations), 2)
        self.assertEqual(
            history.observations[0].timestamp,
            datetime(2026, 1, 1, tzinfo=timezone.utc),
        )

    def test_default_history_is_identified_as_demo(self):
        history = load_gas_data()
        self.assertEqual(history.data_source, "demo")
        self.assertEqual(len(history.observations), 720)
        self.assertTrue(all(item.source == "demo" for item in history.observations))

    def test_rejects_invalid_fees(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "history.csv"
            with path.open("w", newline="", encoding="utf-8") as data_file:
                writer = csv.writer(data_file)
                writer.writerow(["timestamp", "gas_fee_gwei", "source"])
                writer.writerow(["2026-01-01T00:00:00Z", "-1", "live"])
            with self.assertRaisesRegex(ValueError, "must be positive"):
                load_gas_data(path)


class PredictionTests(unittest.TestCase):
    def test_generates_forecast_and_measured_validation_metrics(self):
        result = generate_predictions(make_history(), horizon_hours=6)

        self.assertEqual(len(result["forecast"]), 6)
        validation = result["validation"]
        self.assertEqual(validation["validation_observations"], 24)
        self.assertGreaterEqual(validation["mae_gwei"], 0)
        self.assertGreaterEqual(validation["wmape_percent"], 0)
        self.assertGreaterEqual(validation["confidence_score_percent"], 0)
        self.assertLessEqual(validation["confidence_score_percent"], 100)
        self.assertEqual(result["data_source"], "live")

    def test_requires_enough_actual_history_for_holdout(self):
        with self.assertRaisesRegex(ValueError, "At least 30 observations"):
            generate_predictions(make_history(count=20))


class WindowAndSavingsTests(unittest.TestCase):
    def test_finds_lowest_average_contiguous_window(self):
        forecast = [
            {"timestamp": f"2026-01-01T0{hour}:00:00+00:00", "predicted_gas_fee_gwei": fee}
            for hour, fee in enumerate([10.0, 8.0, 2.0, 4.0, 9.0])
        ]
        window = calculate_cheapest_window(forecast, window_hours=2)
        self.assertEqual(window["start"], forecast[2]["timestamp"])
        self.assertEqual(window["end"], forecast[4]["timestamp"])
        self.assertEqual(window["average_predicted_gas_fee_gwei"], 3.0)

    def test_calculates_savings_against_current_fee(self):
        result = calculate_savings(20.0, 15.0)
        self.assertEqual(result["savings_gwei"], 5.0)
        self.assertEqual(result["savings_percent"], 25.0)

    def test_never_reports_savings_when_forecast_is_more_expensive(self):
        self.assertEqual(
            calculate_savings(20.0, 25.0),
            {"savings_gwei": 0.0, "savings_percent": 0.0},
        )


if __name__ == "__main__":
    unittest.main()
