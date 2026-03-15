// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IFlashSwapArbitrageCallbacks {
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external;
    function pancakeV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external;
}

contract FakeCallbackCaller {
    function callUniswapCallback(
        address target,
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external {
        IFlashSwapArbitrageCallbacks(target).uniswapV3SwapCallback(amount0Delta, amount1Delta, data);
    }

    function callPancakeCallback(
        address target,
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external {
        IFlashSwapArbitrageCallbacks(target).pancakeV3SwapCallback(amount0Delta, amount1Delta, data);
    }
}
