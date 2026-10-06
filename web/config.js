window.GASGUARD_API_BASE_URL = ["localhost", "127.0.0.1"].includes(
  window.location.hostname,
)
  ? ""
  : "https://gasguard-ai.onrender.com";
