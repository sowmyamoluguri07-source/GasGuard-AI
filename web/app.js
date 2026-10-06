const SEPOLIA_CHAIN_ID = "0xaa36a7";
const DEPLOYED_REGISTRY_ADDRESS = "0xf6E536D1e3Ed14CA5793AA1Db6021Cd77A661787";
const dashboardElements = {
  notice: document.querySelector("#data-notice"),
  connectButton: document.querySelector("#connect-wallet"),
  walletDetail: document.querySelector("#wallet-detail"),
  contractAddress: document.querySelector("#contract-address"),
  loadContractButton: document.querySelector("#load-contract"),
  contractConfigStatus: document.querySelector("#contract-config-status"),
  anchorButton: document.querySelector("#anchor-prediction"),
  verifyButton: document.querySelector("#verify-on-chain"),
  chainResult: document.querySelector("#chain-result"),
  onchainRecord: document.querySelector("#onchain-record"),
};

let dashboardData = null;
let walletAddress = null;
let chainId = null;
let registryAddress = null;
let registryLoaded = false;
let transactionInProgress = false;
let verificationInProgress = false;
let lastTransactionUi = null;
let anchoredPrediction = null;
let anchoredHistory = [];
let integrityBaseline = null;
let integrityCheckSequence = 0;
let integrityValueEdited = false;

const SEPOLIA_EXPLORER = "https://sepolia.etherscan.io";
const MASK_64 = (1n << 64n) - 1n;
const KECCAK_ROTATIONS = [
  0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21,
  8, 18, 2, 61, 56, 14,
];
const KECCAK_ROUND_CONSTANTS = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an,
  0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an,
  0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n,
  0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
  0x000000000000800an, 0x800000008000000an, 0x8000000080008081n,
  0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

function keccak256(bytes) {
  const rate = 136;
  const paddedLength = Math.ceil((bytes.length + 1) / rate) * rate;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x01;
  padded[padded.length - 1] |= 0x80;
  const state = Array(25).fill(0n);

  for (let block = 0; block < padded.length; block += rate) {
    for (let index = 0; index < rate; index += 1) {
      state[Math.floor(index / 8)] ^=
        BigInt(padded[block + index]) << BigInt((index % 8) * 8);
    }

    for (const roundConstant of KECCAK_ROUND_CONSTANTS) {
      const columns = Array(5).fill(0n);
      const deltas = Array(5).fill(0n);
      for (let x = 0; x < 5; x += 1) {
        columns[x] =
          state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
      }
      for (let x = 0; x < 5; x += 1) {
        deltas[x] =
          columns[(x + 4) % 5] ^
          ((columns[(x + 1) % 5] << 1n) |
            (columns[(x + 1) % 5] >> 63n));
      }
      for (let y = 0; y < 5; y += 1) {
        for (let x = 0; x < 5; x += 1) {
          state[x + 5 * y] = (state[x + 5 * y] ^ deltas[x]) & MASK_64;
        }
      }

      const moved = Array(25).fill(0n);
      for (let y = 0; y < 5; y += 1) {
        for (let x = 0; x < 5; x += 1) {
          const offset = KECCAK_ROTATIONS[x + 5 * y];
          const value = state[x + 5 * y];
          const rotated =
            offset === 0
              ? value
              : ((value << BigInt(offset)) |
                  (value >> BigInt(64 - offset))) &
                MASK_64;
          moved[y + 5 * ((2 * x + 3 * y) % 5)] = rotated;
        }
      }
      for (let y = 0; y < 5; y += 1) {
        for (let x = 0; x < 5; x += 1) {
          state[x + 5 * y] =
            moved[x + 5 * y] ^
            (~moved[((x + 1) % 5) + 5 * y] &
              moved[((x + 2) % 5) + 5 * y]);
        }
      }
      state[0] ^= roundConstant;
    }
  }

  let digest = "";
  for (let index = 0; index < 32; index += 1) {
    digest += Number(
      (state[Math.floor(index / 8)] >> BigInt((index % 8) * 8)) & 0xffn,
    )
      .toString(16)
      .padStart(2, "0");
  }
  return digest;
}

function functionSelector(signature) {
  return keccak256(new TextEncoder().encode(signature)).slice(0, 8);
}

function encodeWord(value) {
  const integer = BigInt(value);
  if (integer < 0n || integer >= 1n << 256n) {
    throw new Error("Contract integer argument is outside uint256 range.");
  }
  return integer.toString(16).padStart(64, "0");
}

function encodeBytes32(hex) {
  const normalized = hex.replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error("Expected a 32-byte prediction hash.");
  }
  return normalized;
}

function encodeStorePrediction(args) {
  const modelBytes = new TextEncoder().encode(args.modelVersion);
  const modelHex = [...modelBytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const paddedModelHex = modelHex.padEnd(Math.ceil(modelHex.length / 64) * 64, "0");
  const head = [
    encodeWord(args.predictionId),
    encodeWord(args.predictedGasFeeWei),
    encodeWord(args.predictionTimestamp),
    encodeWord(args.windowStart),
    encodeWord(args.windowEnd),
    encodeBytes32(args.predictionHash),
    encodeWord(7 * 32),
  ].join("");
  const tail = encodeWord(modelBytes.length) + paddedModelHex;
  return `0x${functionSelector("storePrediction(uint256,uint256,uint256,uint256,uint256,bytes32,string)")}${head}${tail}`;
}

function encodeGetPrediction(predictionId) {
  return `0x${functionSelector("getPrediction(uint256)")}${encodeWord(predictionId)}`;
}

function encodeVerifyPrediction(predictionId, predictionHash) {
  return `0x${functionSelector("verifyPrediction(uint256,bytes32)")}${encodeWord(predictionId)}${encodeBytes32(predictionHash)}`;
}

function decodeWord(data, byteOffset) {
  const start = 2 + byteOffset * 2;
  const word = data.slice(start, start + 64);
  if (word.length !== 64) throw new Error("Registry returned incomplete prediction data.");
  return BigInt(`0x${word}`);
}

function decodeStoredPrediction(encoded) {
  if (!/^0x[0-9a-f]+$/i.test(encoded) || encoded.length < 2 + 64 * 9) {
    throw new Error("Registry returned malformed prediction data.");
  }
  const tupleOffset = Number(decodeWord(encoded, 0));
  const predictionId = decodeWord(encoded, tupleOffset);
  const predictedGasFeeWei = decodeWord(encoded, tupleOffset + 32);
  const predictionTimestamp = decodeWord(encoded, tupleOffset + 64);
  const windowStart = decodeWord(encoded, tupleOffset + 96);
  const windowEnd = decodeWord(encoded, tupleOffset + 128);
  const predictionHash = `0x${encoded.slice(
    2 + (tupleOffset + 160) * 2,
    2 + (tupleOffset + 192) * 2,
  )}`;
  const modelOffset = Number(decodeWord(encoded, tupleOffset + 192));
  const stringLength = Number(decodeWord(encoded, tupleOffset + modelOffset));
  const stringStart = 2 + (tupleOffset + modelOffset + 32) * 2;
  const stringHex = encoded.slice(stringStart, stringStart + stringLength * 2);
  const modelBytes = new Uint8Array(
    stringHex.match(/.{2}/g)?.map((byte) => Number.parseInt(byte, 16)) ?? [],
  );
  if (modelBytes.length !== stringLength) {
    throw new Error("Registry returned malformed model version.");
  }
  return {
    predictionId,
    predictedGasFeeWei,
    predictionTimestamp,
    windowStart,
    windowEnd,
    predictionHash,
    modelVersion: new TextDecoder().decode(modelBytes),
  };
}

async function fingerprintPrediction(contents) {
  const bytes = new TextEncoder().encode(JSON.stringify(contents));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `0x${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function setChainResult(message, hash = null) {
  const result = dashboardElements.chainResult;
  result.hidden = false;
  result.replaceChildren();
  const text = document.createElement("span");
  text.textContent = message;
  result.append(text);
  if (hash) {
    const link = document.createElement("a");
    link.href = `${SEPOLIA_EXPLORER}/tx/${hash}`;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = `View transaction ${hash}`;
    result.append(document.createElement("br"), link);
  }
}

function setTransactionUi(status, message, hash = null) {
  lastTransactionUi = { status, message, hash };
  document.querySelector("#transaction-status").textContent = message;
  document.querySelector("#transaction-tag").textContent = status.toUpperCase();
  document.querySelector("#transaction-tag").className =
    `status-tag ${status === "confirmed" ? "tag-success" : status === "pending" ? "tag-warning" : "tag-error"}`;
  setChainResult(message, hash);
}

function updateAnchorAvailability() {
  const predictionExists = isValidPrediction(dashboardData);
  dashboardElements.anchorButton.hidden = !predictionExists;
  dashboardElements.anchorButton.disabled =
    !window.ethereum ||
    !walletAddress ||
    chainId?.toLowerCase() !== SEPOLIA_CHAIN_ID ||
    !registryLoaded ||
    !predictionExists ||
    transactionInProgress;
  dashboardElements.verifyButton.disabled =
    !window.ethereum ||
    !walletAddress ||
    chainId?.toLowerCase() !== SEPOLIA_CHAIN_ID ||
    !registryLoaded ||
    !anchoredPrediction ||
    transactionInProgress ||
    verificationInProgress;
}

function isValidPrediction(data) {
  if (
    !data ||
    !data.cheapest_window ||
    typeof data.model_version !== "string" ||
    !data.model_version.trim() ||
    data.cheapest_window.average_predicted_gas_fee_gwei == null
  ) {
    return false;
  }
  const predictionTime = new Date(data.generated_at).getTime();
  const windowStart = new Date(data.cheapest_window.start).getTime();
  const windowEnd = new Date(data.cheapest_window.end).getTime();
  const fee = Number(data.cheapest_window.average_predicted_gas_fee_gwei);
  return (
    Number.isFinite(predictionTime) &&
    predictionTime > 0 &&
    Number.isFinite(windowStart) &&
    windowStart > 0 &&
    Number.isFinite(windowEnd) &&
    windowEnd >= windowStart &&
    Number.isFinite(fee) &&
    fee >= 0
  );
}

function updateNetworkUi() {
  const onSepolia = chainId?.toLowerCase() === SEPOLIA_CHAIN_ID;
  document.querySelector(".network-pill").innerHTML = onSepolia
    ? '<span class="pulse-dot"></span> Ethereum Sepolia Testnet'
    : '<span class="status-dot"></span> Sepolia required';

  if (!window.ethereum) {
    dashboardElements.walletDetail.textContent =
      "MetaMask was not detected. Install MetaMask, select Sepolia manually, then connect.";
  } else if (!walletAddress) {
    dashboardElements.walletDetail.textContent =
      "Wallet: Not connected. Connect MetaMask to anchor a prediction.";
    dashboardElements.walletDetail.className = "wallet-detail";
  } else if (!onSepolia) {
    dashboardElements.connectButton.textContent = "Switch to Sepolia";
    dashboardElements.walletDetail.textContent =
      `Wallet: ${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)} · Wrong network. Please switch to Ethereum Sepolia.`;
    dashboardElements.walletDetail.className = "wallet-detail status-yellow";
  } else {
    dashboardElements.connectButton.textContent =
      `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}`;
    dashboardElements.walletDetail.textContent =
      `Wallet: ${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)} · Ethereum Sepolia Testnet`;
    dashboardElements.walletDetail.className = "wallet-detail status-green";
  }
  updateAnchorAvailability();
}

async function providerRequest(method, params = []) {
  if (!window.ethereum) throw new Error("MetaMask was not detected.");
  return window.ethereum.request({ method, params });
}

async function connectWallet() {
  if (!window.ethereum) {
    updateNetworkUi();
    return;
  }
  dashboardElements.connectButton.disabled = true;
  try {
    if (!walletAddress) {
      dashboardElements.connectButton.textContent = "Connecting…";
      const accounts = await providerRequest("eth_requestAccounts");
      walletAddress = accounts[0] ?? null;
      if (!walletAddress) throw new Error("MetaMask did not return an account.");
    } else if (chainId?.toLowerCase() !== SEPOLIA_CHAIN_ID) {
      await providerRequest("wallet_switchEthereumChain", [
        { chainId: SEPOLIA_CHAIN_ID },
      ]);
    }
    chainId = await providerRequest("eth_chainId");
    updateNetworkUi();
    if (chainId.toLowerCase() === SEPOLIA_CHAIN_ID && registryAddress) {
      await loadRegistry(registryAddress);
    } else if (chainId.toLowerCase() === SEPOLIA_CHAIN_ID) {
      await loadRegistry(DEPLOYED_REGISTRY_ADDRESS);
    }
  } catch (error) {
    console.error("Wallet connection was not completed:", error);
    updateNetworkUi();
    dashboardElements.walletDetail.textContent =
      error.code === 4001
        ? "Wallet request was rejected. Connect or switch to Ethereum Sepolia in MetaMask to continue."
        : error.code === 4902
          ? "Ethereum Sepolia is not configured in MetaMask. Add Sepolia manually, then try again."
          : `Wallet connection or network switch failed: ${error.message}`;
    dashboardElements.walletDetail.className = "wallet-detail status-yellow";
  } finally {
    dashboardElements.connectButton.disabled = false;
    updateAnchorAvailability();
  }
}

async function loadRegistry(address) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    throw new Error("Enter a valid 20-byte contract address.");
  }
  let activeChain;
  try {
    activeChain = await providerRequest("eth_chainId");
  } catch (error) {
    setChainResult(`Unable to read MetaMask network: ${error.message}`);
    return;
  }
  if (activeChain.toLowerCase() !== SEPOLIA_CHAIN_ID) {
    chainId = activeChain;
    registryLoaded = false;
    updateNetworkUi();
    throw new Error("Switch MetaMask to Ethereum Sepolia Testnet manually.");
  }
  const code = await providerRequest("eth_getCode", [address, "latest"]);
  if (!code || code === "0x" || /^0x0*$/.test(code)) {
    throw new Error("No contract code was found at this address on Sepolia.");
  }
  registryAddress = address;
  registryLoaded = true;
  dashboardElements.contractAddress.value = address;
  dashboardElements.contractConfigStatus.textContent =
    "Contract code found on Sepolia. Registry interface ready.";
  dashboardElements.contractConfigStatus.className = "config-status success";
  document.querySelector("#blockchain-status").textContent =
    `Registry contract loaded · ${address}`;
  document.querySelector("#blockchain-tag").textContent = "READY";
  document.querySelector("#blockchain-tag").className =
    "status-tag tag-success";
  document.querySelector("#chain-result").hidden = true;
  updateAnchorAvailability();
}

function parsePredictionForChain(data) {
  const predictedGasFeeWei = BigInt(
    Math.round(
      Number(data.cheapest_window.average_predicted_gas_fee_gwei) * 1e9,
    ),
  );
  const predictionTimestamp = BigInt(
    Math.floor(new Date(data.generated_at).getTime() / 1000),
  );
  const windowStart = BigInt(
    Math.floor(new Date(data.cheapest_window.start).getTime() / 1000),
  );
  const windowEnd = BigInt(
    Math.floor(new Date(data.cheapest_window.end).getTime() / 1000),
  );
  if (
    !Number.isFinite(Number(data.cheapest_window.average_predicted_gas_fee_gwei)) ||
    predictionTimestamp <= 0n ||
    windowStart <= 0n ||
    windowEnd < windowStart
  ) {
    throw new Error("Backend prediction contains invalid timestamp or fee values.");
  }
  const idBytes = new Uint8Array(32);
  crypto.getRandomValues(idBytes);
  const predictionId = BigInt(
    `0x${[...idBytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`,
  );
  const fingerprintContents = {
    predictionId: predictionId.toString(),
    predictedGasFeeWei: predictedGasFeeWei.toString(),
    predictionTimestamp: predictionTimestamp.toString(),
    recommendedWindowStart: windowStart.toString(),
    recommendedWindowEnd: windowEnd.toString(),
    modelVersion: data.model_version,
  };
  return {
    predictionId,
    predictedGasFeeWei,
    predictionTimestamp,
    windowStart,
    windowEnd,
    modelVersion: data.model_version,
    fingerprintContents,
  };
}

async function waitForReceipt(transactionHash) {
  const timeoutMs = 5 * 60 * 1000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let timeoutId;
    try {
      const remainingMs = deadline - Date.now();
      const receipt = await Promise.race([
        providerRequest("eth_getTransactionReceipt", [transactionHash]),
        new Promise((_, reject) => {
          timeoutId = window.setTimeout(
            () => reject(new Error("Receipt polling timed out.")),
            remainingMs,
          );
        }),
      ]);
      if (receipt) return receipt;
    } catch (error) {
      if (Date.now() >= deadline) break;
      console.warn("Waiting for Sepolia transaction receipt:", error);
      setTransactionUi(
        "pending",
        `Pending · waiting for Sepolia receipt (${error.message})`,
        transactionHash,
      );
    } finally {
      if (timeoutId) window.clearTimeout(timeoutId);
    }
    const delayMs = Math.min(3000, deadline - Date.now());
    if (delayMs > 0) {
      await new Promise((resolve) => window.setTimeout(resolve, delayMs));
    }
  }
  return null;
}

async function readPredictionOnChain(predictionId) {
  const encoded = await providerRequest("eth_call", [
    {
      to: registryAddress,
      data: encodeGetPrediction(predictionId),
    },
    "latest",
  ]);
  return decodeStoredPrediction(encoded);
}

async function verifyPredictionOnChain(predictionId, predictionHash) {
  const verified = await providerRequest("eth_call", [
    {
      to: registryAddress,
      data: encodeVerifyPrediction(predictionId, predictionHash),
    },
    "latest",
  ]);
  return decodeWord(verified, 0) === 1n;
}

function persistAnchoredPrediction(anchor) {
  anchoredPrediction = anchor;
  setAnchoredIntegrityBaseline(anchor.fingerprintContents, anchor.predictionHash);
  try {
    localStorage.setItem("gasguardAnchoredPrediction", JSON.stringify({
      predictionId: anchor.predictionId.toString(),
      predictionHash: anchor.predictionHash,
      transactionHash: anchor.transactionHash,
    }));
  } catch (error) {
    console.warn("Could not persist the public anchored prediction reference:", error);
  }
  const historyRecord = {
    predictionId: anchor.predictionId.toString(),
    predictedGasFeeGwei: anchor.predictedGasFeeGwei,
    timestamp: anchor.timestamp,
    windowStart: anchor.windowStart,
    windowEnd: anchor.windowEnd,
    modelVersion: anchor.modelVersion,
    transactionHash: anchor.transactionHash,
    verificationStatus: "ANCHORED · NOT VERIFIED",
  };
  anchoredHistory = [
    historyRecord,
    ...anchoredHistory.filter(
      (record) => record.predictionId !== historyRecord.predictionId,
    ),
  ].slice(0, 20);
  saveAnchoredHistory();
  if (dashboardData) {
    renderHistory(dashboardData);
    renderAccuracy(dashboardData);
  }
  updateIntegrityChainStatus();
  updateAnchorAvailability();
}

function saveAnchoredHistory() {
  try {
    localStorage.setItem("gasguardAnchoredHistory", JSON.stringify(anchoredHistory));
  } catch (error) {
    console.warn("Could not persist the confirmed Sepolia prediction history:", error);
  }
}

function loadAnchoredHistory() {
  try {
    const stored = JSON.parse(
      localStorage.getItem("gasguardAnchoredHistory") ?? "[]",
    );
    if (!Array.isArray(stored)) return [];
    return stored.filter((record) => {
      return (
        record &&
        /^\d+$/.test(record.predictionId) &&
        Number.isFinite(Number(record.predictedGasFeeGwei)) &&
        Number(record.predictedGasFeeGwei) >= 0 &&
        Number.isFinite(new Date(record.timestamp).getTime()) &&
        Number.isFinite(new Date(record.windowStart).getTime()) &&
        Number.isFinite(new Date(record.windowEnd).getTime()) &&
        typeof record.modelVersion === "string" &&
        ["ANCHORED · NOT VERIFIED", "VERIFIED ON-CHAIN", "VERIFICATION FAILED"].includes(
          record.verificationStatus,
        )
      );
    }).slice(0, 20);
  } catch (error) {
    console.warn("Could not load confirmed Sepolia prediction history:", error);
    return [];
  }
}

function updateAnchoredHistoryStatus(status) {
  if (!anchoredPrediction) return;
  anchoredPrediction.verificationStatus = status;
  anchoredHistory = anchoredHistory.map((record) =>
    record.predictionId === anchoredPrediction.predictionId.toString()
      ? { ...record, verificationStatus: status }
      : record,
  );
  saveAnchoredHistory();
  try {
    localStorage.setItem("gasguardAnchoredPrediction", JSON.stringify({
      predictionId: anchoredPrediction.predictionId.toString(),
      predictionHash: anchoredPrediction.predictionHash,
      transactionHash: anchoredPrediction.transactionHash,
      verificationStatus: status,
    }));
  } catch (error) {
    console.warn("Could not persist the verified Sepolia prediction status:", error);
  }
  if (dashboardData) {
    renderHistory(dashboardData);
    renderAccuracy(dashboardData);
  }
  updateIntegrityChainStatus();
}

function loadAnchoredPrediction() {
  try {
    const stored = JSON.parse(
      localStorage.getItem("gasguardAnchoredPrediction") ?? "null",
    );
    if (
      !stored ||
      !/^\d+$/.test(stored.predictionId) ||
      !/^0x[0-9a-fA-F]{64}$/.test(stored.predictionHash) ||
      (stored.transactionHash != null &&
        !/^0x[0-9a-fA-F]{64}$/.test(stored.transactionHash))
    ) {
      return null;
    }
    return {
      predictionId: BigInt(stored.predictionId),
      predictionHash: stored.predictionHash,
      transactionHash: stored.transactionHash ?? null,
      verificationStatus:
        stored.verificationStatus === "VERIFIED ON-CHAIN"
          ? "VERIFIED ON-CHAIN"
          : "ANCHORED · NOT VERIFIED",
    };
  } catch (error) {
    console.warn("Could not load the saved public anchored prediction reference:", error);
    return null;
  }
}

function setVerificationUi(state, message) {
  const record = dashboardElements.onchainRecord;
  record.hidden = false;
  record.classList.toggle("verified", state === "verified");
  record.classList.toggle("failed", state === "failed");
  document.querySelector("#verification-title").textContent =
    state === "verified"
      ? "VERIFIED ON-CHAIN"
      : state === "failed"
        ? "VERIFICATION FAILED"
        : state === "checking"
          ? "VERIFYING ON-CHAIN"
          : "ON-CHAIN VERIFICATION";
  document.querySelector("#verification-tag").textContent =
    state === "verified" ? "VERIFIED" : state === "checking" ? "CHECKING" : "NOT VERIFIED";
  document.querySelector("#verification-tag").className =
    `status-tag ${state === "verified" ? "tag-success" : state === "checking" ? "tag-warning" : state === "failed" ? "tag-error" : "tag-neutral"}`;
  document.querySelector("#verification-message").textContent = message;
}

function renderOnChainRecord(record) {
  document.querySelector("#record-contract").textContent = registryAddress;
  document.querySelector("#record-prediction-id").textContent =
    record.predictionId.toString();
  document.querySelector("#record-gas-fee").textContent =
    `${(Number(record.predictedGasFeeWei) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 9 })} Gwei`;
  document.querySelector("#record-timestamp").textContent =
    dateTime(Number(record.predictionTimestamp) * 1000, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  document.querySelector("#record-window").textContent =
    `${dateTime(Number(record.windowStart) * 1000, { dateStyle: "medium", timeStyle: "short" })} – ${dateTime(Number(record.windowEnd) * 1000, { timeStyle: "short" })}`;
  document.querySelector("#record-model-version").textContent =
    record.modelVersion;
  document.querySelector("#record-hash").textContent = record.predictionHash;
}

function fingerprintContentsFromRecord(record) {
  return {
    predictionId: record.predictionId.toString(),
    predictedGasFeeWei: record.predictedGasFeeWei.toString(),
    predictionTimestamp: record.predictionTimestamp.toString(),
    recommendedWindowStart: record.windowStart.toString(),
    recommendedWindowEnd: record.windowEnd.toString(),
    modelVersion: record.modelVersion,
  };
}

function setAnchoredIntegrityBaseline(contents, expectedHash) {
  integrityBaseline = {
    mode: "anchored",
    contents: { ...contents },
    hash: expectedHash,
  };
  integrityValueEdited = false;
  document.querySelector("#integrity-value").value = (
    Number(BigInt(contents.predictedGasFeeWei)) / 1e9
  ).toFixed(9);
  document.querySelector("#integrity-input-label").textContent =
    "Local copy of anchored predicted gas fee · Gwei";
  document.querySelector("#integrity-message").textContent =
    "Edit this local copy, then click Verify On-Chain to test the reconstructed hash. No transaction is sent.";
  updateLocalIntegrityCheck();
}

async function getLocalPredictionHash(storedRecord) {
  if (
    integrityBaseline?.mode !== "anchored" ||
    integrityBaseline.hash !== storedRecord.predictionHash
  ) {
    const keepEditedValue = integrityValueEdited;
    const editedValue = document.querySelector("#integrity-value").value;
    setAnchoredIntegrityBaseline(
      fingerprintContentsFromRecord(storedRecord),
      storedRecord.predictionHash,
    );
    if (!keepEditedValue) return storedRecord.predictionHash;
    document.querySelector("#integrity-value").value = editedValue;
    integrityValueEdited = true;
  }

  const enteredGasFee = Number(document.querySelector("#integrity-value").value);
  if (!Number.isFinite(enteredGasFee) || enteredGasFee < 0) {
    throw new Error("Enter a valid non-negative local gas fee in Gwei.");
  }
  const predictedGasFeeWei = Math.round(enteredGasFee * 1e9);
  if (!Number.isSafeInteger(predictedGasFeeWei) || predictedGasFeeWei < 0) {
    throw new Error("The local gas fee is outside the supported range.");
  }
  const contents = fingerprintContentsFromRecord(storedRecord);
  contents.predictedGasFeeWei = String(predictedGasFeeWei);
  return fingerprintPrediction(contents);
}

async function verifyAnchoredPrediction() {
  if (verificationInProgress) return;
  if (!anchoredPrediction) {
    setVerificationUi("failed", "This prediction has not been anchored on-chain yet.");
    return;
  }
  if (!window.ethereum || !walletAddress) {
    setVerificationUi("failed", "Connect MetaMask to verify this prediction.");
    return;
  }
  if (!registryAddress || !registryLoaded) {
    setVerificationUi("failed", "The Sepolia registry contract is not loaded.");
    return;
  }
  try {
    const activeChain = await providerRequest("eth_chainId");
    chainId = activeChain;
    updateNetworkUi();
    if (activeChain.toLowerCase() !== SEPOLIA_CHAIN_ID) {
      setVerificationUi("failed", "Please switch MetaMask to Ethereum Sepolia.");
      return;
    }
  } catch (error) {
    console.error("Could not check network before on-chain verification:", error);
    setVerificationUi("failed", "Unable to check the MetaMask network.");
    return;
  }

  verificationInProgress = true;
  dashboardElements.verifyButton.textContent = "⏳ Verifying On-Chain...";
  updateAnchorAvailability();
  setVerificationUi("checking", "Reading the prediction and verifying its hash on Ethereum Sepolia. This is read-only and does not request a signature.");
  try {
    const stored = await readPredictionOnChain(anchoredPrediction.predictionId);
    renderOnChainRecord(stored);
    const candidateHash = await getLocalPredictionHash(stored);
    const isVerified =
      stored.predictionId === anchoredPrediction.predictionId &&
      stored.predictionHash.toLowerCase() ===
        anchoredPrediction.predictionHash.toLowerCase() &&
      await verifyPredictionOnChain(
        anchoredPrediction.predictionId,
        candidateHash,
      );
    if (isVerified) {
      updateAnchoredHistoryStatus("VERIFIED ON-CHAIN");
      setVerificationUi(
        "verified",
        `The locally reconstructed prediction hash matches the record returned by the Sepolia contract ${registryAddress}. This check is read-only.`,
      );
      document.querySelector("#blockchain-status").textContent =
        `Verified · prediction ${stored.predictionId.toString()}`;
      document.querySelector("#blockchain-tag").textContent = "VERIFIED";
      document.querySelector("#blockchain-tag").className =
        "status-tag tag-success";
    } else {
      updateAnchoredHistoryStatus("VERIFICATION FAILED");
      setVerificationUi(
        "failed",
        "The locally reconstructed prediction hash does not match the anchored Sepolia record. The blockchain record was not changed and no transaction was sent.",
      );
      document.querySelector("#blockchain-status").textContent =
        "On-chain prediction hash did not match.";
      document.querySelector("#blockchain-tag").textContent = "NOT VERIFIED";
      document.querySelector("#blockchain-tag").className =
        "status-tag tag-error";
    }
  } catch (error) {
    console.error("On-chain prediction verification failed:", error);
    const message = /prediction does not exist/i.test(error.message)
      ? "This prediction has not been anchored on-chain yet."
      : "Unable to read or verify the prediction from the Sepolia contract.";
    setVerificationUi("failed", message);
  } finally {
    verificationInProgress = false;
    dashboardElements.verifyButton.textContent = "✓ Verify On-Chain";
    updateAnchorAvailability();
  }
}

async function anchorPrediction() {
  if (!dashboardData || !registryLoaded || transactionInProgress) return;
  if (!window.ethereum || !walletAddress) {
    setChainResult("Connect MetaMask before anchoring a prediction.");
    return;
  }
  const activeChain = await providerRequest("eth_chainId");
  chainId = activeChain;
  updateNetworkUi();
  if (activeChain.toLowerCase() !== SEPOLIA_CHAIN_ID) {
    setChainResult(
      "Wrong network. Switch to Ethereum Sepolia manually; no transaction was sent.",
    );
    return;
  }
  if (dashboardData.data_source !== "live") {
    const proceed = window.confirm(
      `This prediction uses ${dashboardData.data_source.toUpperCase()} gas data. Its fingerprint will be stored on Sepolia as sample/demo data, not as a live gas prediction. Continue?`,
    );
    if (!proceed) return;
  }

  transactionInProgress = true;
  updateAnchorAvailability();
  let transactionHash = null;
  try {
    const prediction = parsePredictionForChain(dashboardData);
    const predictionHash = await fingerprintPrediction(
      prediction.fingerprintContents,
    );
    const transactionData = encodeStorePrediction({
      predictionId: prediction.predictionId,
      predictedGasFeeWei: prediction.predictedGasFeeWei,
      predictionTimestamp: prediction.predictionTimestamp,
      windowStart: prediction.windowStart,
      windowEnd: prediction.windowEnd,
      predictionHash,
      modelVersion: prediction.modelVersion,
    });
    setTransactionUi("pending", "Waiting for MetaMask confirmation...");
    transactionHash = await providerRequest("eth_sendTransaction", [
      {
        from: walletAddress,
        to: registryAddress,
        value: "0x0",
        data: transactionData,
      },
    ]);
    if (!/^0x[0-9a-fA-F]{64}$/.test(transactionHash)) {
      throw new Error("MetaMask returned an invalid transaction hash.");
    }
    setTransactionUi(
      "pending",
      "Transaction pending... Waiting for Sepolia confirmation.",
      transactionHash,
    );

    const receipt = await waitForReceipt(transactionHash);
    if (!receipt) {
      setTransactionUi(
        "pending",
        "Confirmation timed out after 5 minutes. The transaction may still be pending or may have been mined; check Sepolia Etherscan before retrying.",
        transactionHash,
      );
      document.querySelector("#blockchain-status").textContent =
        "Confirmation not observed; transaction may still be pending.";
      document.querySelector("#blockchain-tag").textContent = "PENDING";
      document.querySelector("#blockchain-tag").className =
        "status-tag tag-warning";
      return;
    }
    if (receipt.status !== "0x1") {
      setTransactionUi(
        "failed",
        "Failed · Sepolia receipt reports that the transaction reverted.",
        transactionHash,
      );
      document.querySelector("#blockchain-status").textContent =
        "Transaction reverted; prediction was not verified.";
      document.querySelector("#blockchain-tag").textContent = "NOT VERIFIED";
      document.querySelector("#blockchain-tag").className =
        "status-tag tag-neutral";
      return;
    }

    setTransactionUi(
      "confirmed",
      "Prediction anchored successfully. You can now verify the stored record on-chain.",
      transactionHash,
    );
    persistAnchoredPrediction({
      predictionId: prediction.predictionId,
      predictionHash,
      transactionHash,
      fingerprintContents: prediction.fingerprintContents,
      predictedGasFeeGwei: Number(prediction.predictedGasFeeWei) / 1e9,
      timestamp: new Date(
        Number(prediction.predictionTimestamp) * 1000,
      ).toISOString(),
      windowStart: new Date(Number(prediction.windowStart) * 1000).toISOString(),
      windowEnd: new Date(Number(prediction.windowEnd) * 1000).toISOString(),
      modelVersion: prediction.modelVersion,
    });
    document.querySelector("#blockchain-status").textContent =
      `Transaction confirmed · prediction ${prediction.predictionId.toString()} not yet verified.`;
    document.querySelector("#blockchain-tag").textContent = "ANCHORED";
    document.querySelector("#blockchain-tag").className =
      "status-tag tag-warning";
  } catch (error) {
    console.error("Prediction anchoring failed:", error);
    const errorMessage = String(error.message ?? error);
    const message =
      error.code === 4001
        ? "Failed · MetaMask request was rejected."
        : /insufficient funds/i.test(errorMessage)
          ? "Failed · insufficient Sepolia test ETH to pay network gas."
          : `Failed · ${errorMessage}`;
    setTransactionUi("failed", message, transactionHash);
    if (!transactionHash) {
      document.querySelector("#blockchain-status").textContent =
        "No on-chain prediction was verified.";
      document.querySelector("#blockchain-tag").textContent = "NOT VERIFIED";
      document.querySelector("#blockchain-tag").className =
        "status-tag tag-neutral";
    }
  } finally {
    transactionInProgress = false;
    updateAnchorAvailability();
  }
}

function number(value, digits = 2) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? parsed.toLocaleString(undefined, { maximumFractionDigits: digits })
    : "—";
}

function dateTime(value, options = {}) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Time unavailable";
  return new Intl.DateTimeFormat(undefined, options).format(date);
}

function showNotice(message, type = "loading") {
  dashboardElements.notice.hidden = !message;
  dashboardElements.notice.textContent = message;
  dashboardElements.notice.className = `notice notice-${type}`;
}

function setCondition(element, condition) {
  element.classList.remove("status-green", "status-yellow", "status-red");
  element.classList.add(`status-${condition}`);
}

function renderRecommendation(data) {
  const savings = data.expected_savings;
  const window = data.cheapest_window;
  const savingPercent = Number(savings.savings_percent);
  const savingGwei = Number(savings.savings_gwei);
  const usefulWait = savingPercent > 0;
  const start = new Date(window.start);
  const end = new Date(window.end);
  const range = `${dateTime(start, { weekday: "short", hour: "numeric", minute: "2-digit" })} – ${dateTime(end, { hour: "numeric", minute: "2-digit" })}`;
  const currentFee = Number(data.current_gas_fee_gwei);
  const firstForecast = data.forecast?.[0];
  const firstForecastFee = Number(firstForecast?.predicted_gas_fee_gwei);
  const forecastMinutes = firstForecast
    ? (new Date(firstForecast.timestamp).getTime() -
      new Date(data.current_observation_at).getTime()) / 60_000
    : Number.NaN;
  const confidence = Number(data.validation?.confidence_score_percent);

  if (
    !Number.isFinite(currentFee) ||
    !Number.isFinite(firstForecastFee) ||
    !Number.isFinite(forecastMinutes) ||
    forecastMinutes <= 0 ||
    !Number.isFinite(confidence)
  ) {
    document.querySelector("#recommendation-title").textContent =
      "Recommendation unavailable";
    document.querySelector("#why-wait").textContent =
      "A valid current observation and hourly forecast are required.";
    document.querySelector("#decision-options").replaceChildren();
    document.querySelector("#best-window-time").textContent = "Unavailable";
    document.querySelector("#best-window-fee").textContent = "— Gwei";
    document.querySelector("#window-confidence").textContent = "— confidence";
    document.querySelector("#best-window-explanation").textContent =
      "Forecast data is not available.";
    return;
  }

  const options = [0, 5, 10, 15].map((minutes) => {
    const ratio = Math.min(1, minutes / forecastMinutes);
    const fee = Math.max(0.1, currentFee + (firstForecastFee - currentFee) * ratio);
    return {
      minutes,
      fee,
      savingsPercent: currentFee > 0
        ? Math.max(0, (currentFee - fee) / currentFee * 100)
        : 0,
    };
  });
  const lowestOption = options.reduce((lowest, option) =>
    option.fee < lowest.fee ? option : lowest,
  );
  const recommended = lowestOption.minutes > 0 &&
    lowestOption.savingsPercent >= 0.5
    ? lowestOption
    : options[0];
  const recommendedLabel = recommended.minutes
    ? `WAIT ${recommended.minutes} MIN`
    : "SEND NOW";
  document.querySelector("#recommendation-title").textContent =
    `Recommended: ${recommendedLabel}`;
  document.querySelector("#why-wait").textContent =
    `Expected gas ${number(recommended.fee, 3)} Gwei · estimated saving ${number(recommended.savingsPercent, 1)}% · ${number(confidence, 1)}% validation confidence (heuristic, not probability).`;
  document.querySelector("#decision-options").replaceChildren(
    ...options.map((option) => {
      const item = document.createElement("div");
      item.className = `decision-option${option.minutes === recommended.minutes ? " recommended" : ""}`;
      const action = document.createElement("strong");
      action.textContent = option.minutes ? `WAIT ${option.minutes} MIN` : "SEND NOW";
      const fee = document.createElement("span");
      fee.textContent = `${number(option.fee, 3)} Gwei`;
      item.append(action, fee);
      item.setAttribute(
        "aria-label",
        `${action.textContent}, estimated ${fee.textContent}, ${number(option.savingsPercent, 1)} percent saving`,
      );
      return item;
    }),
  );
  document.querySelector("#window-range").textContent = range;
  document.querySelector("#window-duration").textContent = `${window.duration_hours} hour${window.duration_hours === 1 ? "" : "s"}`;
  document.querySelector("#savings-percent").textContent = number(savingPercent, 1);
  document.querySelector("#savings-gwei").textContent = `${number(savingGwei, 3)} Gwei estimated`;
  document.querySelector("#recommendation-status").textContent = usefulWait
    ? "Potential savings predicted"
    : "No savings predicted";
  setCondition(
    document.querySelector("#recommendation"),
    usefulWait ? (savingPercent >= 10 ? "green" : "yellow") : "red",
  );
  setCondition(
    document.querySelector("#recommendation-dot").parentElement,
    usefulWait ? (savingPercent >= 10 ? "green" : "yellow") : "red",
  );
  document.querySelector("#best-window-time").textContent = range;
  document.querySelector("#best-window-fee").textContent =
    `${number(window.average_predicted_gas_fee_gwei, 3)} Gwei`;
  document.querySelector("#window-confidence").textContent =
    `${number(confidence, 1)}% confidence · heuristic`;
  document.querySelector("#best-window-explanation").textContent =
    usefulWait ? "Lower-fee window predicted." : "No lower-fee window predicted.";

  const riskLevel = recommended.savingsPercent >= 10
    ? "HIGH"
    : recommended.savingsPercent >= 2
      ? "MEDIUM"
      : "LOW";
  const riskPill = document.querySelector("#risk-level");
  riskPill.textContent = riskLevel;
  riskPill.className = `risk-pill risk-${riskLevel.toLowerCase()}`;
  document.querySelector("#risk-explanation").textContent =
    riskLevel === "HIGH"
      ? "Waiting may be better based on the simulated short-horizon estimate."
      : riskLevel === "MEDIUM"
        ? "Consider waiting; a modest fee reduction is simulated."
        : "Good time to transact based on the simulated short-horizon estimate.";
}

function renderForecast(data) {
  const forecast = data.forecast;
  const fees = forecast.map((point) => Number(point.predicted_gas_fee_gwei));
  const minFee = Math.min(...fees);
  const maxFee = Math.max(...fees);
  const spread = maxFee - minFee || 1;
  const cheapestStart = new Date(data.cheapest_window.start).getTime();
  const cheapestEnd = new Date(data.cheapest_window.end).getTime();

  document.querySelector("#forecast-hours").textContent = forecast.length;
  document.querySelector("#model-version").textContent = data.model_version;
  document.querySelector("#source-label").textContent =
    data.data_source === "live" ? "Live data" : `${data.data_source} data`;
  document.querySelector("#forecast-list").innerHTML = forecast
    .map((point) => {
      const time = new Date(point.timestamp);
      const fee = Number(point.predicted_gas_fee_gwei);
      const cheapest =
        time.getTime() >= cheapestStart && time.getTime() <= cheapestEnd;
      const width = 14 + ((fee - minFee) / spread) * 86;
      return `<div class="forecast-row${cheapest ? " is-cheapest" : ""}">
        <span class="forecast-time">${dateTime(time, { weekday: "short", hour: "numeric" })}</span>
        <span class="forecast-bar-track" aria-label="${number(fee)} Gwei"><span class="forecast-bar" style="width:${width}%"></span></span>
        <span class="forecast-fee">${number(fee)} <small>Gwei</small></span>
      </div>`;
    })
    .join("");

  document.querySelector("#current-fee").textContent = number(
    data.current_gas_fee_gwei,
  );
  const direction =
    fees[0] < Number(data.current_gas_fee_gwei)
      ? "Forecast below current fee"
      : "Forecast at or above current fee";
  document.querySelector("#current-status").textContent =
    `Latest observation ${dateTime(data.current_observation_at, { month: "short", day: "numeric", hour: "numeric" })} · ${direction}`;
  setCondition(
    document.querySelector("#current-status").parentElement,
    fees[0] < Number(data.current_gas_fee_gwei) ? "green" : "yellow",
  );
}

function renderChart(data) {
  const history = data.validation_comparison;
  const forecast = data.forecast;
  const values = [
    ...history.flatMap((item) => [
      Number(item.actual_gas_fee_gwei),
      Number(item.predicted_gas_fee_gwei),
    ]),
    ...forecast.map((item) => Number(item.predicted_gas_fee_gwei)),
  ];
  if (!history.length || !values.every(Number.isFinite)) {
    document.querySelector("#chart-wrap").innerHTML =
      '<div class="chart-loading">Not enough validation data to draw the chart.</div>';
    return;
  }

  const width = 720;
  const height = 190;
  const left = 38;
  const right = 12;
  const top = 12;
  const bottom = 22;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = (max - min) * 0.15 || Math.max(max * 0.05, 1);
  const low = Math.max(0, min - pad);
  const high = max + pad;
  const allCount = history.length + forecast.length;
  const x = (index) => left + (index / (allCount - 1)) * plotWidth;
  const y = (value) => top + ((high - value) / (high - low)) * plotHeight;
  const actualPoints = history
    .map((item, index) => `${x(index)},${y(Number(item.actual_gas_fee_gwei))}`)
    .join(" ");
  const validationPredictions = history
    .map((item, index) => `${x(index)},${y(Number(item.predicted_gas_fee_gwei))}`)
    .join(" ");
  const forecastPoints = [
    `${x(history.length - 1)},${y(Number(history.at(-1).predicted_gas_fee_gwei))}`,
    ...forecast.map(
      (item, index) =>
        `${x(history.length + index)},${y(Number(item.predicted_gas_fee_gwei))}`,
    ),
  ].join(" ");
  const grid = [0, 1, 2, 3].map((index) => {
    const value = high - ((high - low) / 3) * index;
    const gridY = top + (plotHeight / 3) * index;
    return `<line x1="${left}" y1="${gridY}" x2="${width - right}" y2="${gridY}" stroke="#ffffff10"/>
      <text x="${left - 7}" y="${gridY + 3}" fill="#748178" font-size="9" text-anchor="end">${number(value, 1)}</text>`;
  }).join("");
  const actualDots = history
    .filter((_, index) => index % Math.max(1, Math.floor(history.length / 16)) === 0)
    .map((item) => {
      const index = history.indexOf(item);
      return `<circle cx="${x(index)}" cy="${y(Number(item.actual_gas_fee_gwei))}" r="2.2" fill="#dce9df"/>`;
    })
    .join("");
  const forecastStart = x(history.length - 1);

  document.querySelector("#chart-wrap").innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Chart comparing historical validation predictions with actual gas fees and future forecast">
      ${grid}
      <line x1="${forecastStart}" y1="${top}" x2="${forecastStart}" y2="${height - bottom}" stroke="#82967f" stroke-dasharray="3 4"/>
      <polyline points="${actualPoints}" fill="none" stroke="#dce9df" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
      <polyline points="${validationPredictions}" fill="none" stroke="#b6f27b" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" opacity=".72"/>
      <polyline points="${forecastPoints}" fill="none" stroke="#b6f27b" stroke-width="2" stroke-dasharray="5 4" stroke-linejoin="round" stroke-linecap="round"/>
      ${actualDots}
    </svg>`;
}

function renderHistory(data) {
  const localRuns = data.prediction_history ?? [];
  const rows = [
    ...anchoredHistory.map((record) => ({
      id: `ON-CHAIN #${record.predictionId}`,
      fee: record.predictedGasFeeGwei,
      timestamp: record.timestamp,
      windowStart: record.windowStart,
      windowEnd: record.windowEnd,
      modelVersion: record.modelVersion,
      verificationStatus: record.verificationStatus,
      statusClass: record.verificationStatus === "VERIFIED ON-CHAIN"
        ? "verified"
        : record.verificationStatus === "VERIFICATION FAILED"
          ? "failed"
          : "anchored",
    })),
    ...localRuns.map((record) => ({
      id: `RUN #${record.id} · LOCAL`,
      fee: record.predicted_window_gwei,
      timestamp: record.generated_at,
      windowStart: record.recommended_start,
      windowEnd: record.recommended_end,
      modelVersion: record.model_version,
      verificationStatus: "NOT ANCHORED · LOCAL",
      statusClass: "",
    })),
  ].sort(
    (left, right) =>
      new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime(),
  );
  document.querySelector("#history-count").textContent =
    `${data.prediction_history_total ?? localRuns.length} saved runs · ${anchoredHistory.length} confirmed anchor${anchoredHistory.length === 1 ? "" : "s"}`;

  const body = document.querySelector("#history-body");
  body.replaceChildren();
  if (!rows.length) {
    const row = document.createElement("tr");
    const empty = document.createElement("td");
    empty.colSpan = 6;
    empty.className = "table-empty";
    empty.textContent = "No prediction runs saved yet.";
    row.append(empty);
    body.append(row);
    return;
  }

  for (const record of rows) {
    const row = document.createElement("tr");
    const values = [
      record.id,
      `${number(record.fee, 3)} Gwei`,
      dateTime(record.timestamp, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }),
      `${dateTime(record.windowStart, { month: "short", day: "numeric", hour: "numeric" })} – ${dateTime(record.windowEnd, { hour: "numeric" })}`,
      record.modelVersion,
    ];
    for (const value of values) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    const statusCell = document.createElement("td");
    const status = document.createElement("span");
    status.className = `history-status ${record.statusClass}`;
    status.textContent = record.verificationStatus;
    statusCell.append(status);
    row.append(statusCell);
    body.append(row);
  }
}

function renderAccuracy(data) {
  const validation = data.validation;
  const wmape = Number(validation.wmape_percent);
  const accuracy = Number.isFinite(wmape)
    ? Math.max(0, Math.min(100, 100 - wmape))
    : Number.NaN;
  const dataIsDemo = data.data_source !== "live";
  document.querySelector("#accuracy-total").textContent =
    number(data.prediction_history_total ?? data.prediction_history.length, 0);
  document.querySelector("#accuracy-error").textContent =
    number(validation.mae_gwei, 3);
  document.querySelector("#accuracy-percent").textContent =
    `${number(accuracy, 1)}%`;
  document.querySelector("#accuracy-verified").textContent =
    String(anchoredHistory.filter(
      (record) => record.verificationStatus === "VERIFIED ON-CHAIN",
    ).length);
  document.querySelector("#accuracy-source").textContent = dataIsDemo
    ? "DEMO / SIMULATED"
    : "HOLDOUT VALIDATION";
  document.querySelector("#accuracy-disclaimer").textContent = dataIsDemo
    ? "Metrics use synthetic demo history. Accuracy estimate = 100 − holdout WMAPE; not real-world accuracy or a guarantee."
    : "Accuracy estimate = 100 − holdout WMAPE on the configured observations; not a guarantee of future performance.";
}

function updateIntegrityChainStatus() {
  const status = document.querySelector("#integrity-chain-status");
  if (!status) return;
  status.textContent = anchoredPrediction
    ? anchoredPrediction.verificationStatus ?? "ANCHORED · NOT VERIFIED"
    : "NOT ANCHORED · local demo only";
}

async function updateLocalIntegrityCheck() {
  if (!integrityBaseline) return;
  const version = ++integrityCheckSequence;
  const value = Number(document.querySelector("#integrity-value").value);
  const status = document.querySelector("#integrity-status");
  if (!Number.isFinite(value) || value < 0) {
    status.textContent = "Enter a valid non-negative value";
    status.className = "integrity-status failed";
    document.querySelector("#integrity-message").textContent =
      "A non-negative gas value is required to recompute the local demo hash.";
    document.querySelector("#integrity-hash").textContent = "—";
    return;
  }

  try {
    let contents;
    if (integrityBaseline.mode === "anchored") {
      const predictedGasFeeWei = Math.round(value * 1e9);
      if (!Number.isSafeInteger(predictedGasFeeWei)) {
        throw new Error("The local gas fee is outside the supported range.");
      }
      contents = {
        ...integrityBaseline.contents,
        predictedGasFeeWei: String(predictedGasFeeWei),
      };
    } else {
      contents = {
        ...integrityBaseline.contents,
        predictedGasFeeGwei: value,
      };
    }
    const hash = await fingerprintPrediction(contents);
    if (version !== integrityCheckSequence) return;
    const matches = hash === integrityBaseline.hash;
    document.querySelector("#integrity-hash").textContent =
      `${hash.slice(0, 14)}…${hash.slice(-10)}`;
    document.querySelector("#integrity-hash").title = hash;
    status.textContent = matches
      ? integrityBaseline.mode === "anchored"
        ? "LOCAL HASH MATCHES ANCHOR"
        : "LOCAL DEMO HASH MATCHES"
      : "INTEGRITY CHECK FAILED";
    status.className = `integrity-status ${matches ? "verified" : "failed"}`;
    document.querySelector("#integrity-message").textContent = matches
      ? integrityBaseline.mode === "anchored"
        ? "The edited local value reconstructs the anchored hash. Click Verify On-Chain for the real read-only contract check."
        : "The local demo value matches its original fingerprint. This is not an on-chain verification."
      : integrityBaseline.mode === "anchored"
        ? "The edited local value changes the candidate hash. Click Verify On-Chain to confirm it does not match Sepolia."
        : "The local demo value changed and its hash no longer matches. No blockchain record or transaction was changed.";
  } catch (error) {
    console.error("Could not recompute the local demo integrity hash:", error);
    status.textContent = "Local integrity check unavailable";
    status.className = "integrity-status failed";
    document.querySelector("#integrity-message").textContent =
      `Unable to compute the local demo hash: ${error.message}`;
  }
}

function renderIntegrity(data) {
  if (!integrityBaseline) {
    const fee = Number(data.current_gas_fee_gwei);
    if (!Number.isFinite(fee) || fee < 0) {
      document.querySelector("#integrity-status").textContent =
        "Integrity check unavailable";
      document.querySelector("#integrity-message").textContent =
        "A valid current gas fee is required to create a local demo fingerprint.";
      return;
    }
    integrityBaseline = {
      contents: {
        generatedAt: data.generated_at,
        modelVersion: data.model_version,
        dataSource: data.data_source,
        predictedGasFeeGwei: fee,
      },
    };
    document.querySelector("#integrity-value").value = String(fee);
    fingerprintPrediction(integrityBaseline.contents)
      .then((hash) => {
        integrityBaseline.hash = hash;
        updateLocalIntegrityCheck();
      })
      .catch((error) => {
        console.error("Could not create the local demo integrity hash:", error);
        document.querySelector("#integrity-status").textContent =
          "Local integrity check unavailable";
        document.querySelector("#integrity-status").className =
          "integrity-status failed";
        document.querySelector("#integrity-message").textContent =
          `Unable to create the local demo hash: ${error.message}`;
      });
  }
  updateIntegrityChainStatus();
}

function testTamperDetection() {
  if (!integrityBaseline) return;
  const currentValue = Number(document.querySelector("#integrity-value").value);
  const originalFee = Number(integrityBaseline.contents.predictedGasFeeGwei);
  const nextValue = Number.isFinite(currentValue) && currentValue >= 0
    ? currentValue + 0.01
    : originalFee + 0.01;
  document.querySelector("#integrity-value").value = nextValue.toFixed(3);
  integrityValueEdited = true;
  updateLocalIntegrityCheck();
}

function resetIntegrityPrediction() {
  if (!integrityBaseline) return;
  document.querySelector("#integrity-value").value =
    integrityBaseline.mode === "anchored"
      ? (
          Number(BigInt(integrityBaseline.contents.predictedGasFeeWei)) /
          1e9
        ).toFixed(9)
      : String(integrityBaseline.contents.predictedGasFeeGwei);
  integrityValueEdited = false;
  updateLocalIntegrityCheck();
}

function renderDashboard(data) {
  dashboardData = data;
  updateAnchorAvailability();
  const validation = data.validation;
  document.querySelector("#gasguard-score").textContent = number(
    data.gasguard_score,
    0,
  );
  document.querySelector("#confidence").textContent = number(
    validation.confidence_score_percent,
    1,
  );
  document.querySelector("#mae").textContent = number(validation.mae_gwei, 3);
  document.querySelector("#validation-detail").textContent =
    `${validation.validation_observations} holdout observations · WMAPE ${number(validation.wmape_percent, 2)}%`;
  document.querySelector("#footer-validation").textContent =
    `${validation.method.replaceAll("_", " ")} · ${validation.validation_observations} holdout points`;
  document.querySelector("#updated-at").textContent =
    `Updated ${dateTime(data.generated_at, { hour: "numeric", minute: "2-digit" })}`;
  renderRecommendation(data);
  renderForecast(data);
  renderChart(data);
  renderHistory(data);
  renderAccuracy(data);
  renderIntegrity(data);

  const sourceNotice =
    data.data_source === "demo"
      ? "DEMO DATA: these predictions are based on synthetic sample gas fees, not live Sepolia observations."
      : data.data_source === "mixed"
        ? "MIXED DATA: the history contains both demo and live observations."
        : "";
  showNotice(sourceNotice, sourceNotice ? "loading" : "loading");
  if (!registryLoaded) {
    document.querySelector("#blockchain-status").textContent =
      data.blockchain.message;
    document.querySelector("#blockchain-tag").textContent = "NOT VERIFIED";
    document.querySelector("#blockchain-tag").className =
      "status-tag tag-neutral";
  }
  if (!lastTransactionUi) {
    document.querySelector("#transaction-status").textContent =
      data.transaction.message;
    document.querySelector("#transaction-tag").textContent = "NOT SUBMITTED";
    document.querySelector("#transaction-tag").className =
      "status-tag tag-neutral";
  }
}

async function refreshDashboard() {
  try {
    const response = await fetch("/api/dashboard?horizon_hours=8&window_hours=1", {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || `Dashboard API returned ${response.status}`);
    }
    renderDashboard(data);
  } catch (error) {
    console.error("Could not load GasGuard dashboard:", error);
    showNotice(
      `Unable to load gas analysis from the backend: ${error.message}. Confirm that the dashboard server is running and check its logs.`,
      "error",
    );
    document.querySelector("#chart-wrap").innerHTML =
      '<div class="chart-loading">Analysis unavailable.</div>';
  }
}

dashboardElements.connectButton.addEventListener("click", connectWallet);
dashboardElements.loadContractButton.addEventListener("click", async () => {
  registryLoaded = false;
  updateAnchorAvailability();
  dashboardElements.contractConfigStatus.textContent =
    "Checking the contract address on Sepolia…";
  dashboardElements.contractConfigStatus.className = "config-status";
  try {
    await loadRegistry(DEPLOYED_REGISTRY_ADDRESS);
  } catch (error) {
    console.error("Could not load Sepolia registry:", error);
    dashboardElements.contractConfigStatus.textContent = error.message;
    dashboardElements.contractConfigStatus.className = "config-status error";
    document.querySelector("#blockchain-status").textContent =
      "Registry not loaded.";
    document.querySelector("#blockchain-tag").textContent = "NOT VERIFIED";
    document.querySelector("#blockchain-tag").className =
      "status-tag tag-neutral";
  }
});
dashboardElements.anchorButton.addEventListener("click", anchorPrediction);
dashboardElements.verifyButton.addEventListener("click", verifyAnchoredPrediction);
document.querySelector("#integrity-value").addEventListener(
  "input",
  () => {
    integrityValueEdited = true;
    updateLocalIntegrityCheck();
  },
);
document.querySelector("#test-tamper").addEventListener(
  "click",
  testTamperDetection,
);
document.querySelector("#reset-integrity").addEventListener(
  "click",
  resetIntegrityPrediction,
);
dashboardElements.contractAddress.value = DEPLOYED_REGISTRY_ADDRESS;
anchoredHistory = loadAnchoredHistory();
anchoredPrediction = loadAnchoredPrediction();

if (window.ethereum?.isMetaMask) {
  providerRequest("eth_chainId")
    .then(async (network) => {
      chainId = network;
      updateNetworkUi();
      if (network.toLowerCase() === SEPOLIA_CHAIN_ID) {
        try {
          await loadRegistry(DEPLOYED_REGISTRY_ADDRESS);
        } catch (error) {
          dashboardElements.contractConfigStatus.textContent = error.message;
          dashboardElements.contractConfigStatus.className =
            "config-status error";
        }
      }
    })
    .catch((error) => {
      console.warn("Unable to detect MetaMask network:", error);
    });
  providerRequest("eth_accounts")
    .then((accounts) => {
      walletAddress = accounts[0] ?? null;
      updateNetworkUi();
    })
    .catch((error) => {
      console.warn("Unable to read connected MetaMask accounts:", error);
    });
} else {
  updateNetworkUi();
}

if (window.ethereum?.on) {
  window.ethereum.on("accountsChanged", (accounts) => {
    walletAddress = accounts[0] ?? null;
    updateNetworkUi();
  });
  window.ethereum.on("chainChanged", (network) => {
    chainId = network;
    registryLoaded = false;
    updateNetworkUi();
    if (network.toLowerCase() !== SEPOLIA_CHAIN_ID) {
      dashboardElements.contractConfigStatus.textContent =
        "Switch to Sepolia manually; registry use is disabled on this network.";
      dashboardElements.contractConfigStatus.className = "config-status error";
    } else if (registryAddress) {
      loadRegistry(registryAddress).catch((error) => {
        dashboardElements.contractConfigStatus.textContent = error.message;
        dashboardElements.contractConfigStatus.className = "config-status error";
      });
    }
  });
}

refreshDashboard();
window.setInterval(refreshDashboard, 60_000);
