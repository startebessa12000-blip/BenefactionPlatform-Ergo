import { compile } from "@fleet-sdk/compiler";
import { network_id } from "./envs";
import { blake2b256, sha256 } from "@fleet-sdk/crypto";
import { uint8ArrayToHex } from "./utils";
import { get_dev_contract_address, get_dev_contract_hash, get_dev_fee } from "./dev/dev_contract";
import { type ConstantContent } from "$lib/common/project";
import CONTRACT_V1_0 from '../../../contracts/bene_contract/contract_v1_0.es?raw';
import CONTRACT_V1_1 from '../../../contracts/bene_contract/contract_v1_1.es?raw';
import CONTRACT_V2 from '../../../contracts/bene_contract/contract_v2.es?raw';
import CONTRACT_V3 from '../../../contracts/bene_contract/contract_v3.es?raw';
import MINT_CONTRACT from '../../../contracts/mint_contract/mint_idt.es?raw';
import MINT_CONTRACT_V3 from '../../../contracts/mint_contract/mint_idt_v3.es?raw';

export const TERMINAL_ERGOTREE_HEX = "1906010100d17300";

export type contract_version = "v3" | "v2" | "v1_1" | "v1_0";

function generate_contract_v1_0(owner_ergotree: string, dev_hash: string, dev_fee: number, pft_token_id: string): string {
    return CONTRACT_V1_0
        .replace(/`\+owner_ergotree\+`/g, owner_ergotree)
        .replace(/`\+dev_hash\+`/g, dev_hash)
        .replace(/`\+dev_fee\+`/g, dev_fee.toString())
        .replace(/`\+pft_token_id\+`/g, pft_token_id);
}

function generate_contract_v1_1(owner_ergotree: string, dev_hash: string, dev_fee: number, pft_token_id: string, base_token_id: string): string {
    return CONTRACT_V1_1
        .replace(/`\+owner_ergotree\+`/g, owner_ergotree)
        .replace(/`\+dev_hash\+`/g, dev_hash)
        .replace(/`\+dev_fee\+`/g, dev_fee.toString())
        .replace(/`\+pft_token_id\+`/g, pft_token_id)
        .replace(/`\+base_token_id\+`/g, base_token_id);
}

/**
 * Generate v2 contract (current version)
 */
function generate_contract_v2(): string {
    return CONTRACT_V2;
}

/**
 * Generate v3 contract
 */
function generate_contract_v3(): string {
    return CONTRACT_V3;
}

function handle_contract_generator(version: contract_version) {
    let f;
    switch (version) {
        case "v1_0":
            f = generate_contract_v1_0;
            break;
        case "v1_1":
            f = generate_contract_v1_1;
            break;
        case "v2":
            f = generate_contract_v2;
            break;
        case "v3":
            f = generate_contract_v3;
            break;
        default:
            throw new Error("Invalid contract version");
    }
    return f
}

/**
 * Get ErgoTree hex for v2 and v3 contracts
 */
export function get_ergotree_hex(constants: ConstantContent, version: contract_version) {
    const contract = version === "v3" ? generate_contract_v3() : generate_contract_v2();

    const ergoTree = compile(contract, { version: 1, network: network_id });
    return ergoTree.toHex();
}

/**
 * Get template hash for any contract version
 * This is needed by fetch.ts to identify old projects
 */
export function get_template_hash(version: contract_version): string {
    const random_constants = {
        "owner": "9fcwctfPQPkDfHgxBns5Uu3dwWpaoywhkpLEobLuztfQuV5mt3T",  // RANDOM
        "dev_addr": get_dev_contract_address(),  // RANDOM
        "dev_hash": get_dev_contract_hash(),  // RANDOM
        "dev_fee": get_dev_fee(),    // RANDOM
        "pft_token_id": "a3f7c9e12bd45890ef12aa7c6d54b9317c0df4a28b6e5590d4f1b3e8c92d77af",  // RANDOM
        "base_token_id": "2c5d596d617aaafe16f3f58b2c562d046eda658f0243dc1119614160d92a4717" // RANDOM
    }

    let contract;
    if (version === "v3") {
        contract = CONTRACT_V3;
    } else if (version === "v2") {
        contract = CONTRACT_V2;
    } else {
        contract = handle_contract_generator(version)(random_constants.owner, random_constants.dev_hash ?? get_dev_contract_hash(), random_constants.dev_fee, random_constants.pft_token_id, random_constants.base_token_id);
    }

    let ergoTree = compile(contract, { version: 1, network: network_id });
    let templateBytes = ergoTree.template;
    return uint8ArrayToHex(sha256(templateBytes));
}

/**
 * Get contract hash for v2 and v3 contracts
 */
function get_contract_hash(constants: ConstantContent, version: contract_version): string {
    try {
        const contractSource = version === "v3" ? generate_contract_v3() : generate_contract_v2();

        const ergoTree = compile(contractSource, {
            version: 1,
            network: network_id
        });

        return uint8ArrayToHex(blake2b256(ergoTree.bytes));
    } catch (error: any) {
        console.error("Error compiling contract:", error);
        throw new Error(`Failed to compile contract: ${error?.message || error}`);
    }
}

/**
 * Get mint contract address for v2 and v3 contracts
 */
export function mint_contract_address(constants: ConstantContent, version: contract_version): string {
    const mintSource = version === "v3" ? MINT_CONTRACT_V3 : MINT_CONTRACT;
    const ergoTree = compile(mintSource, { version: 1, network: network_id });
    return ergoTree.toAddress(network_id).toString();
}
