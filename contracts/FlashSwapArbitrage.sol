// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./interfaces/IUniswapV3Pool.sol";
import "./interfaces/IPancakeV3Pool.sol";
import "./interfaces/IUniswapV3SwapCallback.sol";
import "./interfaces/IPancakeV3SwapCallback.sol";
import "./interfaces/IERC20.sol";
import "./libraries/PoolAddress.sol";

contract FlashSwapArbitrage is IUniswapV3SwapCallback, IPancakeV3SwapCallback {
    address public immutable owner;
    address public immutable uniswapV3Factory;
    address public immutable pancakeV3Deployer;
    bytes32 public immutable uniswapV3InitCodeHash;
    bytes32 public immutable pancakeV3InitCodeHash;
    bool public paused;

    uint256 public maxBorrowAmount;

    event MaxBorrowAmountUpdated(uint256 previousAmount, uint256 newAmount);

    error TokenTransferFailed(address token, address to, uint256 amount);
    error EtherTransferFailed(address to, uint256 amount);

    enum DexType { UniswapV3, PancakeSwapV3 }

    struct ArbParams {
        address poolBorrow;
        address poolArb;
        DexType borrowDex;
        bool zeroForOne;
        int256 amountSpecified;
        uint160 sqrtPriceLimitX96;
        uint256 amountOutMin;
    }

    struct FlashCallbackData {
        address poolArb;
        DexType borrowDex;
        address token0;
        address token1;
        uint24 feeBorrow;
        uint24 feeArb;
        bool zeroForOne;
        uint256 amountOutMin;
    }

    struct RepayCallbackData {
        address token0;
        address token1;
        uint24 fee;
        DexType arbDex;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "PAUSED");
        _;
    }

    constructor(
        address _uniswapV3Factory,
        address _pancakeV3Deployer,
        bytes32 _uniswapV3InitCodeHash,
        bytes32 _pancakeV3InitCodeHash,
        uint256 _initialMaxBorrowAmount
    ) {
        require(_initialMaxBorrowAmount > 0, "INVALID_MAX_BORROW");

        owner = msg.sender;
        uniswapV3Factory = _uniswapV3Factory;
        pancakeV3Deployer = _pancakeV3Deployer;
        uniswapV3InitCodeHash = _uniswapV3InitCodeHash;
        pancakeV3InitCodeHash = _pancakeV3InitCodeHash;
        maxBorrowAmount = _initialMaxBorrowAmount;
    }

    function executeArbitrage(ArbParams calldata params) external onlyOwner whenNotPaused {
        require(
            params.amountSpecified > 0 &&
            uint256(params.amountSpecified) <= maxBorrowAmount,
            "INVALID_AMOUNT"
        );

        address token0;
        address token1;
        uint24 feeBorrow;
        uint24 feeArb;

        if (params.borrowDex == DexType.PancakeSwapV3) {
            IPancakeV3Pool pool = IPancakeV3Pool(params.poolBorrow);
            token0 = pool.token0();
            token1 = pool.token1();
            feeBorrow = pool.fee();
        } else {
            IUniswapV3Pool pool = IUniswapV3Pool(params.poolBorrow);
            token0 = pool.token0();
            token1 = pool.token1();
            feeBorrow = pool.fee();
        }

        if (params.borrowDex == DexType.PancakeSwapV3) {
            feeArb = IUniswapV3Pool(params.poolArb).fee();
        } else {
            feeArb = IPancakeV3Pool(params.poolArb).fee();
        }

        FlashCallbackData memory cbData = FlashCallbackData({
            poolArb: params.poolArb,
            borrowDex: params.borrowDex,
            token0: token0,
            token1: token1,
            feeBorrow: feeBorrow,
            feeArb: feeArb,
            zeroForOne: params.zeroForOne,
            amountOutMin: params.amountOutMin
        });

        bytes memory encodedData = abi.encode(true, abi.encode(cbData));

        if (params.borrowDex == DexType.PancakeSwapV3) {
            IPancakeV3Pool(params.poolBorrow).swap(
                address(this),
                params.zeroForOne,
                params.amountSpecified,
                params.sqrtPriceLimitX96,
                encodedData
            );
        } else {
            IUniswapV3Pool(params.poolBorrow).swap(
                address(this),
                params.zeroForOne,
                params.amountSpecified,
                params.sqrtPriceLimitX96,
                encodedData
            );
        }
    }

    function pancakeV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external override {
        _handleCallback(amount0Delta, amount1Delta, data, DexType.PancakeSwapV3);
    }

    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external override {
        _handleCallback(amount0Delta, amount1Delta, data, DexType.UniswapV3);
    }

    function _handleCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data,
        DexType callerDex
    ) internal {
        (bool isFlash, bytes memory innerData) = abi.decode(data, (bool, bytes));

        if (!isFlash) {
            _handleRepayCallback(amount0Delta, amount1Delta, innerData, callerDex);
            return;
        }

        _handleFlashCallback(amount0Delta, amount1Delta, innerData, callerDex);
    }

    function _handleRepayCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes memory innerData,
        DexType callerDex
    ) internal {
        RepayCallbackData memory repayData = abi.decode(innerData, (RepayCallbackData));

        require(repayData.arbDex == callerDex, "DEX_MISMATCH");

        _verifyCallback(
            msg.sender,
            callerDex == DexType.UniswapV3 ? uniswapV3Factory : pancakeV3Deployer,
            callerDex == DexType.UniswapV3 ? uniswapV3InitCodeHash : pancakeV3InitCodeHash,
            repayData.token0,
            repayData.token1,
            repayData.fee
        );

        if (amount0Delta > 0) {
            _safeTransfer(repayData.token0, msg.sender, uint256(amount0Delta));
        }
        if (amount1Delta > 0) {
            _safeTransfer(repayData.token1, msg.sender, uint256(amount1Delta));
        }
    }

    function _handleFlashCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes memory innerData,
        DexType callerDex
    ) internal {
        FlashCallbackData memory cbData = abi.decode(innerData, (FlashCallbackData));

        require(cbData.borrowDex == callerDex, "DEX_MISMATCH");

        _verifyCallback(
            msg.sender,
            callerDex == DexType.UniswapV3 ? uniswapV3Factory : pancakeV3Deployer,
            callerDex == DexType.UniswapV3 ? uniswapV3InitCodeHash : pancakeV3InitCodeHash,
            cbData.token0,
            cbData.token1,
            cbData.feeBorrow
        );

        (address tokenOwed, uint256 amountOwed, uint256 amountReceived) =
            _resolveDeltas(amount0Delta, amount1Delta, cbData.token0, cbData.token1);

        DexType arbDex = cbData.borrowDex == DexType.PancakeSwapV3
            ? DexType.UniswapV3
            : DexType.PancakeSwapV3;

        bool arbZeroForOne = !cbData.zeroForOne;
        uint160 arbSqrtPriceLimit = arbZeroForOne
            ? 4295128740
            : 1461446703485210103287273052203988822378723970341;

        RepayCallbackData memory repayData = RepayCallbackData({
            token0: cbData.token0,
            token1: cbData.token1,
            fee: cbData.feeArb,
            arbDex: arbDex
        });
        bytes memory arbCallbackData = abi.encode(false, abi.encode(repayData));

        int256 arbAmount0;
        int256 arbAmount1;

        if (arbDex == DexType.UniswapV3) {
            (arbAmount0, arbAmount1) = IUniswapV3Pool(cbData.poolArb).swap(
                address(this),
                arbZeroForOne,
                int256(amountReceived),
                arbSqrtPriceLimit,
                arbCallbackData
            );
        } else {
            (arbAmount0, arbAmount1) = IPancakeV3Pool(cbData.poolArb).swap(
                address(this),
                arbZeroForOne,
                int256(amountReceived),
                arbSqrtPriceLimit,
                arbCallbackData
            );
        }

        // arbAmount negative = tokens sent TO us (output from arb swap)
        uint256 arbOutput;
        if (cbData.zeroForOne) {
            // Borrow: zeroForOne → we owe token0, received token1
            // Arb: !zeroForOne (oneForZero) → we sent token1, received token0
            // arbAmount0 should be negative (output to us)
            require(arbAmount0 < 0, "ARB_NO_OUTPUT");
            arbOutput = uint256(-arbAmount0);
        } else {
            // Borrow: oneForZero → we owe token1, received token0
            // Arb: zeroForOne → we sent token0, received token1
            // arbAmount1 should be negative (output to us)
            require(arbAmount1 < 0, "ARB_NO_OUTPUT");
            arbOutput = uint256(-arbAmount1);
        }

        require(arbOutput >= amountOwed, "INSUFFICIENT_OUTPUT");
        uint256 profit = arbOutput - amountOwed;
        require(profit >= cbData.amountOutMin, "BELOW_MIN_PROFIT");

        _safeTransfer(tokenOwed, msg.sender, amountOwed);
    }

    function _resolveDeltas(
        int256 amount0Delta,
        int256 amount1Delta,
        address token0,
        address token1
    ) internal pure returns (address tokenOwed, uint256 amountOwed, uint256 amountReceived) {
        if (amount0Delta > 0) {
            tokenOwed = token0;
            amountOwed = uint256(amount0Delta);
            amountReceived = uint256(-amount1Delta);
        } else {
            tokenOwed = token1;
            amountOwed = uint256(amount1Delta);
            amountReceived = uint256(-amount0Delta);
        }
    }

    function _verifyCallback(
        address caller,
        address deployer,
        bytes32 initCodeHash,
        address token0,
        address token1,
        uint24 fee
    ) internal pure {
        PoolAddress.PoolKey memory key = PoolAddress.getPoolKey(token0, token1, fee);
        address expectedPool = PoolAddress.computeAddress(deployer, key, initCodeHash);
        require(caller == expectedPool, "INVALID_CALLER");
    }

    function withdrawToken(address token, uint256 amount) external onlyOwner {
        _safeTransfer(token, owner, amount);
    }

    function withdrawAllToken(address token) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance > 0) {
            _safeTransfer(token, owner, balance);
        }
    }

    function withdrawBNB(uint256 amount) external onlyOwner {
        (bool success, ) = owner.call{value: amount}("");
        if (!success) {
            revert EtherTransferFailed(owner, amount);
        }
    }

    function pause() external onlyOwner {
        paused = true;
    }

    function unpause() external onlyOwner {
        paused = false;
    }

    function setMaxBorrowAmount(uint256 newMaxBorrowAmount) external onlyOwner {
        require(newMaxBorrowAmount > 0, "INVALID_MAX_BORROW");
        uint256 previousAmount = maxBorrowAmount;
        maxBorrowAmount = newMaxBorrowAmount;
        emit MaxBorrowAmountUpdated(previousAmount, newMaxBorrowAmount);
    }

    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool success, bytes memory data) = token.call(
            abi.encodeCall(IERC20.transfer, (to, amount))
        );
        bool transferOk = success && (data.length == 0 || abi.decode(data, (bool)));
        if (!transferOk) {
            revert TokenTransferFailed(token, to, amount);
        }
    }

    receive() external payable {}
}
