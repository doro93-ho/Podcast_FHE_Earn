pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";


contract PodcastFHEEarn is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;
    uint256 public cooldownSeconds;
    bool public paused;

    struct Batch {
        uint256 id;
        bool isOpen;
        uint256 totalEncryptedListens;
        uint256 totalEncryptedRewards;
    }
    Batch public currentBatch;

    uint256 public nextBatchId = 1;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event CooldownSecondsUpdated(uint256 oldCooldown, uint256 newCooldown);
    event ContractPaused();
    event ContractUnpaused();
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event EncryptedListenSubmitted(address indexed user, uint256 indexed batchId, euint32 encryptedDuration);
    event RewardCalculated(address indexed user, uint256 indexed batchId, euint32 encryptedReward);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 totalListens, uint256 totalRewards);

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchNotOpen();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidProof();
    error BatchAlreadyOpen();
    error BatchNotClosed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier respectCooldown(address _user, mapping(address => uint256) storage _lastActionTime) {
        if (block.timestamp < _lastActionTime[_user] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true;
        cooldownSeconds = 60; // Default cooldown of 60 seconds
        emit ProviderAdded(owner);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) external onlyOwner {
        if (isProvider[provider]) {
            isProvider[provider] = false;
            emit ProviderRemoved(provider);
        }
    }

    function setCooldownSeconds(uint256 newCooldown) external onlyOwner {
        uint256 oldCooldown = cooldownSeconds;
        cooldownSeconds = newCooldown;
        emit CooldownSecondsUpdated(oldCooldown, newCooldown);
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit ContractPaused();
    }

    function unpause() external onlyOwner {
        if (!paused) revert Paused(); // Cannot unpause if not paused
        paused = false;
        emit ContractUnpaused();
    }

    function openBatch() external onlyOwner whenNotPaused {
        if (currentBatch.isOpen) revert BatchAlreadyOpen();
        currentBatch = Batch({ id: nextBatchId, isOpen: true, totalEncryptedListens: 0, totalEncryptedRewards: 0 });
        nextBatchId++;
        emit BatchOpened(currentBatch.id);
    }

    function closeBatch() external onlyOwner whenNotPaused {
        if (!currentBatch.isOpen) revert BatchNotClosed();
        currentBatch.isOpen = false;
        emit BatchClosed(currentBatch.id);
    }

    function submitEncryptedListen(euint32 encryptedDuration) external onlyProvider whenNotPaused respectCooldown(msg.sender, lastSubmissionTime) {
        if (!currentBatch.isOpen) revert BatchNotOpen();
        _initIfNeeded(encryptedDuration);

        euint32 memory encryptedReward = _calculateReward(encryptedDuration);
        emit RewardCalculated(msg.sender, currentBatch.id, encryptedReward);

        currentBatch.totalEncryptedListens = FHE.add(currentBatch.totalEncryptedListens, FHE.asEuint32(1));
        currentBatch.totalEncryptedRewards = FHE.add(currentBatch.totalEncryptedRewards, encryptedReward);

        lastSubmissionTime[msg.sender] = block.timestamp;
        emit EncryptedListenSubmitted(msg.sender, currentBatch.id, encryptedDuration);
    }

    function requestBatchDecryption() external onlyOwner whenNotPaused respectCooldown(msg.sender, lastDecryptionRequestTime) {
        if (currentBatch.isOpen) revert BatchNotClosed(); // Ensure batch is closed before decryption

        euint32 memory totalListens = currentBatch.totalEncryptedListens;
        euint32 memory totalRewards = currentBatch.totalEncryptedRewards;
        _requireInitialized(totalListens);
        _requireInitialized(totalRewards);

        bytes32[] memory cts = new bytes32[](2);
        cts[0] = FHE.toBytes32(totalListens);
        cts[1] = FHE.toBytes32(totalRewards);

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({ batchId: currentBatch.id, stateHash: stateHash, processed: false });
        lastDecryptionRequestTime[msg.sender] = block.timestamp;
        emit DecryptionRequested(requestId, currentBatch.id);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        if (decryptionContexts[requestId].processed) revert ReplayAttempt();
        // Security: Replay protection ensures this callback is processed only once for a given requestId.

        euint32 memory totalListens = currentBatch.totalEncryptedListens;
        euint32 memory totalRewards = currentBatch.totalEncryptedRewards;
        _requireInitialized(totalListens);
        _requireInitialized(totalRewards);

        bytes32[] memory cts = new bytes32[](2);
        cts[0] = FHE.toBytes32(totalListens);
        cts[1] = FHE.toBytes32(totalRewards);

        bytes32 currentHash = _hashCiphertexts(cts);
        // Security: State hash verification ensures that the contract state (specifically, the ciphertexts
        // being decrypted) has not changed since the decryption was requested. This prevents scenarios
        // where an attacker might alter the state after a request but before decryption.
        if (currentHash != decryptionContexts[requestId].stateHash) revert StateMismatch();

        if (!FHE.checkSignatures(requestId, cleartexts, proof)) revert InvalidProof();

        uint256 totalListensCleartext = abi.decode(cleartexts[0:32], (uint32));
        uint256 totalRewardsCleartext = abi.decode(cleartexts[32:64], (uint32));

        decryptionContexts[requestId].processed = true;
        emit DecryptionCompleted(requestId, decryptionContexts[requestId].batchId, totalListensCleartext, totalRewardsCleartext);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 x) internal {
        if (!FHE.isInitialized(x)) FHE.asEuint32(0); // Initializes if not already
    }

    function _requireInitialized(euint32 x) internal view {
        if (!FHE.isInitialized(x)) revert("FHE: Not initialized");
    }

    function _calculateReward(euint32 encryptedDuration) internal pure returns (euint32) {
        // Example: Reward = (duration * 10) / 60. Simpler: Reward = duration * 1 (1 token per second)
        // For simplicity, let's say reward is proportional to duration, e.g., 1 token per 60 seconds.
        // reward = (duration * REWARD_PER_MINUTE) / 60
        // For FHE, we can do reward = duration * (REWARD_PER_MINUTE / 60)
        // Let's assume REWARD_PER_MINUTE / 60 = 1 for simplicity. So reward = duration.
        // Or, more realistically, reward = duration * (1 / 60) if we want 1 token per minute.
        // For FHE, we can't do division easily. So, let's define reward = duration * REWARD_RATE.
        // Let REWARD_RATE = 1 (1 token per second for simplicity).
        euint32 memory rewardRate = FHE.asEuint32(1);
        return FHE.mul(encryptedDuration, rewardRate);
    }
}