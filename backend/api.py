"""Local HTTP API and static-file server for the GasGuard dashboard."""

from __future__ import annotations

import argparse
from contextlib import closing
import logging
import os
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

try:
    from backend.gas_prediction import generate_predictions, load_gas_data
except ImportError:
    from gas_prediction import generate_predictions, load_gas_data
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

ROOT = Path(__file__).resolve().parent.parent
WEB_ROOT = ROOT / "web"
DEFAULT_DB_PATH = Path(__file__).resolve().parent / "gasguard_history.sqlite3"
logger = logging.getLogger(__name__)

app = Flask(__name__, static_folder=None)
CORS(app, resources={r"/api/.*": {"origins": "*"}, r"/health": {"origins": "*"}})


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
    mode: str = "demo",
) -> dict[str, Any]:
    """Build a dashboard payload from the configured history and actual model run."""
    history = load_gas_data(csv_path, mode=mode)
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
        "eth_usd_price": prediction.get("eth_usd_price", 2600.0),
        "usd_savings": prediction.get("usd_savings", {}),
        "recommendation": prediction.get("recommendation", {}),
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


@app.get("/health")
@app.get("/api/health")
def health() -> tuple[Any, int]:
    response = jsonify({"status": "ok"})
    response.headers["Cache-Control"] = "no-store"
    return response, 200


@app.get("/api/dashboard")
def dashboard() -> tuple[Any, int]:
    try:
        horizon = int(request.args.get("horizon_hours", 6))
        window = int(request.args.get("window_hours", 1))
        mode = request.args.get("mode", "demo").strip().lower()
        csv_setting = os.environ.get("GASGUARD_DATA_CSV")
        csv_path = Path(csv_setting) if csv_setting else None
        db_path = Path(os.environ.get("GASGUARD_DB_PATH", str(DEFAULT_DB_PATH)))
        payload = build_dashboard(horizon, window, csv_path, db_path, mode=mode)
    except (ValueError, OSError, sqlite3.Error) as exc:
        logger.exception("Unable to build dashboard data")
        return jsonify({"error": str(exc)}), 500
    except Exception:
        logger.exception("Unexpected error while building dashboard data")
        return jsonify({"error": "Unexpected error while building dashboard data"}), 500
    response = jsonify(payload)
    response.headers["Cache-Control"] = "no-store"
    return response, 200


@app.get("/api/<path:request_path>")
def unknown_api_endpoint(request_path: str) -> tuple[Any, int]:
    del request_path
    return jsonify({"error": "API endpoint not found"}), 404


@app.get("/")
@app.get("/<path:request_path>")
def serve_static(request_path: str = "") -> Any:
    relative_path = request_path or "index.html"
    response = send_from_directory(WEB_ROOT, relative_path)
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    logger.info("GasGuard dashboard available at http://%s:%s", args.host, args.port)
    app.run(host=args.host, port=args.port, threaded=True)


if __name__ == "__main__":
    main()
