// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @dev CREATE2 pool address computation for callback validation
library PoolAddress {
    struct PoolKey {
        address token0;
        address token1;
        uint24 fee;
    }

    function getPoolKey(
        address tokenA,
        address tokenB,
        uint24 fee
    ) internal pure returns (PoolKey memory) {
        if (tokenA > tokenB) (tokenA, tokenB) = (tokenB, tokenA);
        return PoolKey({token0: tokenA, token1: tokenB, fee: fee});
    }

    function computeAddress(
        address factory,
        PoolKey memory key,
        bytes32 initCodeHash
    ) internal pure returns (address pool) {
        require(key.token0 < key.token1, "PoolAddress: INVALID_ORDER");
        pool = address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(
                            hex"ff",
                            factory,
                            keccak256(abi.encode(key.token0, key.token1, key.fee)),
                            initCodeHash
                        )
                    )
                )
            )
        );
    }
}
