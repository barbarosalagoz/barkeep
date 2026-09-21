// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

/*
 * Throwaway. Same as Throwaway1271, except the signature it accepts is NOT 65
 * bytes: it is the owner's signature followed by a 32-byte tag that must match
 * the one fixed at construction (97 bytes). That is the shape a real tab
 * contract needs -- context riding inside the signature -- and the question is
 * whether a facilitator passes such bytes through untouched.
 */
contract Wrapped1271 {
    bytes4 private constant MAGIC = 0x1626ba7e;
    bytes4 private constant REFUSED = 0xffffffff;

    address public immutable owner;
    bytes32 public immutable tag;

    constructor(address owner_, bytes32 tag_) {
        owner = owner_;
        tag = tag_;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        if (signature.length != 97) return REFUSED;
        if (bytes32(signature[65:97]) != tag) return REFUSED;
        address recovered = ecrecover(hash, uint8(signature[64]), bytes32(signature[0:32]), bytes32(signature[32:64]));
        return recovered != address(0) && recovered == owner ? MAGIC : REFUSED;
    }

    function sweep(address token, address to) external {
        require(msg.sender == owner, "not owner");
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("balanceOf(address)", address(this)));
        require(ok, "balanceOf");
        (ok, ) = token.call(abi.encodeWithSignature("transfer(address,uint256)", to, abi.decode(ret, (uint256))));
        require(ok, "transfer");
    }
}
