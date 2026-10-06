import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.api import app, build_dashboard


class DashboardApiTests(unittest.TestCase):
    def setUp(self):
        app.config.update(TESTING=True)
        self.client = app.test_client()

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

    def test_health_endpoints_return_success_json(self):
        for endpoint in ("/health", "/api/health"):
            with self.subTest(endpoint=endpoint):
                response = self.client.get(endpoint)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.get_json(), {"status": "ok"})

    def test_dashboard_route_preserves_payload_and_allows_vercel_origin(self):
        origin = "https://gasguard.vercel.app"
        with tempfile.TemporaryDirectory() as directory, patch.dict(
            "os.environ",
            {"GASGUARD_DB_PATH": str(Path(directory) / "predictions.sqlite3")},
        ):
            response = self.client.get(
                "/api/dashboard?horizon_hours=8&window_hours=1",
                headers={"Origin": origin},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.headers["Access-Control-Allow-Origin"],
            origin,
        )
        payload = response.get_json()
        self.assertEqual(payload["network"], "Ethereum Sepolia Testnet")
        self.assertFalse(payload["real_money"])
        self.assertEqual(payload["data_source"], "demo")
        self.assertEqual(len(payload["forecast"]), 8)
        self.assertIn("prediction_history", payload)
        self.assertEqual(response.headers["Cache-Control"], "no-store")

    def test_root_serves_existing_dashboard_and_unknown_api_is_json(self):
        page = self.client.get("/")
        self.assertEqual(page.status_code, 200)
        self.assertIn(b"GasGuard AI", page.data)
        page.close()
        stylesheet = self.client.get("/styles.css")
        self.assertEqual(stylesheet.status_code, 200)
        stylesheet.close()

        unknown = self.client.get("/api/not-a-route")
        self.assertEqual(unknown.status_code, 404)
        self.assertEqual(unknown.get_json(), {"error": "API endpoint not found"})


if __name__ == "__main__":
    unittest.main()
