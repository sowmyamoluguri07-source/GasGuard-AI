import tempfile
import unittest
from pathlib import Path

from backend.api import build_dashboard


class DashboardApiTests(unittest.TestCase):
    def test_dashboard_payload_uses_model_results_and_records_run_history(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "predictions.sqlite3"
            dashboard = build_dashboard(db_path=database)
            refreshed = build_dashboard(db_path=database)

        self.assertEqual(dashboard["network"], "Ethereum Sepolia Testnet")
        self.assertFalse(dashboard["real_money"])
        self.assertEqual(dashboard["data_source"], "demo")
        self.assertEqual(dashboard["model_version"], "gasguard-linear-time-v1")
        self.assertEqual(len(dashboard["forecast"]), 6)
        self.assertEqual(len(dashboard["validation_comparison"]), 72)
        self.assertGreaterEqual(dashboard["gasguard_score"], 0)
        self.assertLessEqual(dashboard["gasguard_score"], 100)
        self.assertEqual(dashboard["blockchain"]["status"], "not_configured")
        self.assertEqual(dashboard["transaction"]["status"], "not_submitted")
        self.assertEqual(len(refreshed["prediction_history"]), 1)
        self.assertEqual(refreshed["prediction_history_total"], 1)
        self.assertEqual(refreshed["prediction_history"][0]["data_source"], "demo")

    def test_dashboard_rejects_window_longer_than_forecast(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "window_hours must fit"):
                build_dashboard(
                    horizon_hours=2,
                    window_hours=3,
                    db_path=Path(directory) / "predictions.sqlite3",
                )


if __name__ == "__main__":
    unittest.main()
