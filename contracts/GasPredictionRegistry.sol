// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract GasPredictionRegistry {
    struct Prediction {
        uint256 predictionId;
        uint256 predictedGasFeeWei;
        uint256 predictionTimestamp;
        uint256 recommendedWindowStart;
        uint256 recommendedWindowEnd;
        bytes32 predictionHash;
        string modelVersion;
    }

    mapping(uint256 => Prediction) private predictions;
    mapping(uint256 => bool) private predictionExists;

    event PredictionStored(
        uint256 indexed predictionId,
        bytes32 indexed predictionHash
    );

    constructor() {
        require(block.chainid == 11155111, "Sepolia only");
    }

    function storePrediction(
        uint256 predictionId,
        uint256 predictedGasFeeWei,
        uint256 predictionTimestamp,
        uint256 recommendedWindowStart,
        uint256 recommendedWindowEnd,
        bytes32 predictionHash,
        string calldata modelVersion
    ) external {
        require(!predictionExists[predictionId], "Prediction already exists");
        require(predictionHash != bytes32(0), "Prediction hash is required");
        require(
            recommendedWindowStart <= recommendedWindowEnd,
            "Invalid recommended window"
        );

        predictions[predictionId] = Prediction({
            predictionId: predictionId,
            predictedGasFeeWei: predictedGasFeeWei,
            predictionTimestamp: predictionTimestamp,
            recommendedWindowStart: recommendedWindowStart,
            recommendedWindowEnd: recommendedWindowEnd,
            predictionHash: predictionHash,
            modelVersion: modelVersion
        });
        predictionExists[predictionId] = true;

        emit PredictionStored(predictionId, predictionHash);
    }

    function getPrediction(
        uint256 predictionId
    ) external view returns (Prediction memory) {
        require(predictionExists[predictionId], "Prediction does not exist");
        return predictions[predictionId];
    }

    function verifyPrediction(
        uint256 predictionId,
        bytes32 predictionHash
    ) external view returns (bool) {
        return
            predictionExists[predictionId] &&
            predictions[predictionId].predictionHash == predictionHash;
    }
}
