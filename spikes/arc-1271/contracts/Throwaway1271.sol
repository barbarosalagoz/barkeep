// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

/*
 * Throwaway. The smallest thing that is a "deployed smart contract account"
 * to an x402 facilitator: one owner key, and isValidSignature accepts the
 * owner's 65-byte signature over the digest it is handed.
 *
 * It signs the raw digest, with no domain of its own, so a signature is
 * replayable across any two of these sharing an owner. Fine for a spike on
 * Testnet; not a wallet.
 */
contract Throwaway1271 {
    bytes4 private constant MAGIC = 0x1626ba7e;
    bytes4 private constant REFUSED = 0xffffffff;

    address public immutable owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        if (signature.length != 65) return REFUSED;
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        address recovered = ecrecover(hash, v, r, s);
        return recovered != address(0) && recovered == owner ? MAGIC : REFUSED;
    }

    /* Gets the faucet's USDC back out when the spike is done. */
    function sweep(address token, address to) external {
        require(msg.sender == owner, "not owner");
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("balanceOf(address)", address(this)));
        require(ok, "balanceOf");
        (ok, ) = token.call(abi.encodeWithSignature("transfer(address,uint256)", to, abi.decode(ret, (uint256))));
        require(ok, "transfer");
    }
}
