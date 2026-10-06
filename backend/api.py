"""Local HTTP API and static-file server for the GasGuard dashboard."""

from __future__ import annotations

import argparse
from contextlib import closing
import json
import logging
import os
import sqlite3
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from backend.gas_prediction import generate_predictions, load_gas_data

ROOT = Path(__file__).resolve().parent.parent
WEB_ROOT = ROOT / "web"
DEFAULT_DB_PATH = Path(__file__).resolve().parent / "gasguard_history.sqlite3"
logger = logging.getLogger(__name__)


def _connect_database(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(db_path)
    connection.row_factory = sqlite3.Row
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS prediction_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            generated_at TEXT NOT NULL,
            data_source TEXT NOT NULL,
            model_version TEXT NOT NULL,
            current_gas_fee_gwei REAL NOT NULL,
            recommended_start TEXT NOT NULL,
            recommended_end TEXT NOT NULL,
            predicted_window_gwei REAL NOT NULL,
            savings_percent REAL NOT NULL,
            confidence_score_percent REAL NOT NULL
        )
        """
    )
    return connection


def build_dashboard(
    horizon_hours: int = 6,
    window_hours: int = 1,
    csv_path: Path | None = None,
    db_path: Path = DEFAULT_DB_PATH,
) -> dict[str, Any]:
    """Build a dashboard payload from the configured history and actual model run."""
    history = load_gas_data(csv_path)
    prediction = generate_predictions(history, horizon_hours, window_hours)
    generated_at = datetime.now(timezone.utc)

    with closing(_connect_database(db_path)) as connection, connection:
        last_row = connection.execute(
            "SELECT generated_at FROM prediction_history ORDER BY id DESC LIMIT 1"
        ).fetchone()
        should_record = True
        if last_row:
            last_time = datetime.fromisoformat(last_row["generated_at"])
            should_record = generated_at - last_time >= timedelta(minutes=15)

        if should_record:
            connection.execute(
                """
                INSERT INTO prediction_history (
                    generated_at, data_source, model_version,
                    current_gas_fee_gwei, recommended_start, recommended_end,
                    predicted_window_gwei, savings_percent,
                    confidence_score_percent
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    generated_at.isoformat(),
                    prediction["data_source"],
                    prediction["model_version"],
                    prediction["current_gas_fee_gwei"],
                    prediction["cheapest_window"]["start"],
                    prediction["cheapest_window"]["end"],
                    prediction["cheapest_window"][
                        "average_predicted_gas_fee_gwei"
                    ],
                    prediction["expected_savings"]["savings_percent"],
                    prediction["validation"]["confidence_score_percent"],
                ),
            )

        records = connection.execute(
            """
            SELECT id, generated_at, data_source, model_version,
                   current_gas_fee_gwei, recommended_start, recommended_end,
                   predicted_window_gwei, savings_percent,
                   confidence_score_percent
            FROM prediction_history
            ORDER BY id DESC
            LIMIT 10
            """
        ).fetchall()
        history_total = connection.execute(
            "SELECT COUNT(*) AS total FROM prediction_history"
        ).fetchone()["total"]

    return {
        "generated_at": generated_at.isoformat(),
        "network": "Ethereum Sepolia Testnet",
        "real_money": False,
        "data_source": prediction["data_source"],
        "observations_used": prediction["observations_used"],
        "current_gas_fee_gwei": prediction["current_gas_fee_gwei"],
        "current_observation_at": history.observations[-1].timestamp.isoformat(),
        "forecast": prediction["forecast"],
        "validation_comparison": prediction["validation_comparison"],
        "cheapest_window": prediction["cheapest_window"],
        "expected_savings": prediction["expected_savings"],
        "validation": prediction["validation"],
        "gasguard_score": round(
            float(prediction["validation"]["confidence_score_percent"])
        ),
        "model_version": prediction["model_version"],
        "prediction_history": [dict(record) for record in records],
        "prediction_history_total": history_total,
        "blockchain": {
            "status": "not_configured",
            "message": (
                "No deployed registry is configured; no on-chain verification "
                "has been performed."
            ),
        },
        "transaction": {
            "status": "not_submitted",
            "message": "No transaction has been initiated.",
        },
    }


class GasGuardHandler(BaseHTTPRequestHandler):
    server_version = "GasGuardLocalAPI/1.0"

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/health":
            self._send_json({"status": "ok"})
            return
        if parsed.path == "/api/dashboard":
            try:
                params = parse_qs(parsed.query)
                horizon = int(params.get("horizon_hours", ["6"])[0])
                window = int(params.get("window_hours", ["1"])[0])
                csv_setting = os.environ.get("GASGUARD_DATA_CSV")
                csv_path = Path(csv_setting) if csv_setting else None
                db_path = Path(
                    os.environ.get("GASGUARD_DB_PATH", str(DEFAULT_DB_PATH))
                )
                payload = build_dashboard(horizon, window, csv_path, db_path)
            except (ValueError, OSError, sqlite3.Error) as exc:
                logger.exception("Unable to build dashboard data")
                self._send_json({"error": str(exc)}, status=500)
                return
            except Exception:
                logger.exception("Unexpected error while building dashboard data")
                self._send_json(
                    {"error": "Unexpected error while building dashboard data"},
                    status=500,
                )
                return
            self._send_json(payload)
            return
        if parsed.path.startswith("/api/"):
            self._send_json({"error": "API endpoint not found"}, status=404)
            return
        self._serve_static(parsed.path)

    def _send_json(self, payload: dict[str, Any], status: int = 200) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _serve_static(self, request_path: str) -> None:
        relative_path = "index.html" if request_path == "/" else request_path.lstrip("/")
        target = (WEB_ROOT / relative_path).resolve()
        if not target.is_relative_to(WEB_ROOT.resolve()) or not target.is_file():
            self.send_error(404)
            return
        content_type = {
            ".css": "text/css; charset=utf-8",
            ".html": "text/html; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
            ".svg": "image/svg+xml",
        }.get(target.suffix.lower(), "application/octet-stream")
        body = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format_string: str, *args: object) -> None:
        logger.info("%s - %s", self.address_string(), format_string % args)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    server = ThreadingHTTPServer((args.host, args.port), GasGuardHandler)
    logger.info("GasGuard dashboard available at http://%s:%s", args.host, args.port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("Stopping GasGuard dashboard")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
