import { describe, it, expect } from "vitest";
import {
  OutputBuilder,
  TransactionBuilder,
  SAFE_MIN_BOX_VALUE,

  RECOMMENDED_MIN_FEE_VALUE,
  ErgoAddress,
} from "@fleet-sdk/core";
import { SColl, SLong, SByte } from "@fleet-sdk/serializer";
import { blake2b256 } from "@fleet-sdk/crypto";
import { hex, utf8 } from "@scure/base";
import { compile } from "@fleet-sdk/compiler";
import { MockChain } from "@fleet-sdk/mock-chain";
import {
  USD_BASE_TOKEN,
  USD_BASE_TOKEN_NAME,
  ERG_BASE_TOKEN_NAME,
  setupBeneTestContext,
  createR4,
} from "./bene_contract_helpers";
import BENE_CONTRACT_V3 from "../../contracts/bene_contract/contract_v3.es?raw";
import MINT_IDT_V3 from "../../contracts/mint_contract/mint_idt_v3.es?raw";

const TERMINAL_HEX = "1906010100d17300";

function addBox(chain: MockChain, box: any) {
  const party = chain.addParty(box.ergoTree, `p_${Math.random().toString(36).slice(2)}`);
  party.addUTxOs(box);
  return party.utxos.toArray().at(-1)!;
}


function longToBytes(n: bigint): Uint8Array {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setBigInt64(0, n, false);
  return new Uint8Array(buf);
}

function buildR8(
  ownerErgoTreeHex: string,
  devFeeErgoTreeHex: string,
  devFeePercent: bigint,
  pftTokenIdHex: string,
  baseTokenIdHex: string
) {
  return SColl(SColl(SByte), [
    hex.decode(ownerErgoTreeHex),
    blake2b256(hex.decode(devFeeErgoTreeHex)),
    longToBytes(devFeePercent),
    hex.decode(pftTokenIdHex),
    baseTokenIdHex ? hex.decode(baseTokenIdHex) : new Uint8Array(0),
  ]);
}

describe("v3 dev fee & #177/#179/#174/#78 contract tests", () => {
  const contractV3 = compile(BENE_CONTRACT_V3, { version: 1 });
  const contractV3Address = ErgoAddress.fromErgoTree(contractV3.toHex());

  it("Test 1: terminalScript compiles to 1906010100d17300", () => {
    const compiled = compile("{ sigmaProp(false) }", { version: 1 });
    expect(compiled.toHex()).toBe(TERMINAL_HEX);
  });

  it("Test 2 (Path 1 of #177): ERG campaign must replicate to withdraw unsold PFT before full isWithdrawFunds", () => {
    const chain = new MockChain({ height: 1_000_000 });
    const owner = chain.newParty("Owner");
    const devFee = chain.newParty("DevFee");
    owner.addBalance({ nanoergs: 10_000_000_000n });

    const ctx = setupBeneTestContext("", ERG_BASE_TOKEN_NAME);
    const nftId = "11".repeat(32);
    const aptId = "22".repeat(32);
    const pftId = "33".repeat(32);
    const terminalAddr = ErgoAddress.fromErgoTree(TERMINAL_HEX);

    const r4 = createR4({
      ...ctx,
      deadline: BigInt(Date.now() - 86_400_000),
      isTimestamp: true,
    });
    const r5 = SLong(50_000n);
    const r6 = SColl(SLong, [60_000n, 0n, 60_000n]);
    const r7 = SLong(1_666_666n);
    const r8 = buildR8(owner.address.ergoTree, devFee.address.ergoTree, 5n, pftId, "");
    const r9 = SColl(SByte, utf8.decode("{}"));

    const campaignUtxo = addBox(chain, {
      ergoTree: contractV3.toHex(),
      value: 100_000_000_000n,
      assets: [
        { tokenId: nftId, amount: 1n },
        { tokenId: aptId, amount: 940_000n },
        { tokenId: pftId, amount: 40_000n },
      ],
      additionalRegisters: {
        R4: r4,
        R5: r5.toHex(),
        R6: r6.toHex(),
        R7: r7.toHex(),
        R8: r8.toHex(),
        R9: r9.toHex(),
      },
    });

    // Attempting to terminate via isWithdrawUnsoldTokens is rejected
    const badTerminateTx = new TransactionBuilder(chain.height)
      .from([campaignUtxo, ...owner.utxos.toArray()])
      .to([
        new OutputBuilder(SAFE_MIN_BOX_VALUE, terminalAddr).addTokens([
          { tokenId: nftId, amount: 1n },
          { tokenId: aptId, amount: 940_000n },
        ]),
        new OutputBuilder(100_000_000_000n, owner.address).addTokens([
          { tokenId: pftId, amount: 40_000n },
        ]),
      ])
      .sendChangeTo(owner.address)
      .payFee(RECOMMENDED_MIN_FEE_VALUE)
      .build();

    expect(chain.execute(badTerminateTx, { signers: [owner], throw: false })).toBe(false);

    // Replicating via isWithdrawUnsoldTokens to withdraw 40,000 PFT while keeping 100 ERG succeeds
    const goodWithdrawUnsoldTx = new TransactionBuilder(chain.height)
      .from([campaignUtxo, ...owner.utxos.toArray()])
      .to([
        new OutputBuilder(100_000_000_000n, contractV3Address)
          .addTokens([
            { tokenId: nftId, amount: 1n },
            { tokenId: aptId, amount: 940_000n },
          ])
          .setAdditionalRegisters({
            R4: r4,
            R5: r5.toHex(),
            R6: r6.toHex(),
            R7: r7.toHex(),
            R8: r8.toHex(),
            R9: r9.toHex(),
          }),
        new OutputBuilder(SAFE_MIN_BOX_VALUE, owner.address).addTokens([
          { tokenId: pftId, amount: 40_000n },
        ]),
      ])
      .sendChangeTo(owner.address)
      .payFee(RECOMMENDED_MIN_FEE_VALUE)
      .build();

    expect(chain.execute(goodWithdrawUnsoldTx, { signers: [owner], throw: false })).toBe(true);

    // Subsequent full isWithdrawFunds (95 ERG owner + 5 ERG devFee + NFT in terminalScript) succeeds
    const replicatedBox = chain.utxos.toArray().find((u) => u.ergoTree === contractV3.toHex())!;
    const withdrawFundsTx = new TransactionBuilder(chain.height)
      .from([replicatedBox, ...owner.utxos.toArray()])
      .to([
        new OutputBuilder(95_000_000_000n, owner.address),
        new OutputBuilder(5_000_000_000n, devFee.address),
        new OutputBuilder(SAFE_MIN_BOX_VALUE, terminalAddr).addTokens([
          { tokenId: nftId, amount: 1n },
          { tokenId: aptId, amount: 940_000n },
        ]),
      ])
      .sendChangeTo(owner.address)
      .payFee(RECOMMENDED_MIN_FEE_VALUE)
      .build();

    expect(chain.execute(withdrawFundsTx, { signers: [owner], throw: false })).toBe(true);
  });

  it("Test 3 (Path 2 of #177): base-token ceiling devFee (19 units @ 5% -> 1n devFee + 18n owner)", () => {
    const chain = new MockChain({ height: 1_000_000 });
    const owner = chain.newParty("Owner");
    const devFee = chain.newParty("DevFee");
    owner.addBalance({ nanoergs: 10_000_000_000n });

    const ctx = setupBeneTestContext(USD_BASE_TOKEN, USD_BASE_TOKEN_NAME);
    const nftId = "11".repeat(32);
    const aptId = "22".repeat(32);
    const pftId = "33".repeat(32);
    const terminalAddr = ErgoAddress.fromErgoTree(TERMINAL_HEX);

    const r4 = createR4({
      ...ctx,
      deadline: BigInt(Date.now() - 86_400_000),
      isTimestamp: true,
    });
    const r5 = SLong(10n);
    const r6 = SColl(SLong, [19n, 0n, 19n]);
    const r7 = SLong(1n);
    const r8 = buildR8(owner.address.ergoTree, devFee.address.ergoTree, 5n, pftId, USD_BASE_TOKEN);
    const r9 = SColl(SByte, utf8.decode("{}"));

    const box = addBox(chain, {
      ergoTree: contractV3.toHex(),
      value: SAFE_MIN_BOX_VALUE * 4n,
      assets: [
        { tokenId: nftId, amount: 1n },
        { tokenId: aptId, amount: 999_981n },
        { tokenId: USD_BASE_TOKEN, amount: 19n },
      ],
      additionalRegisters: {
        R4: r4,
        R5: r5.toHex(),
        R6: r6.toHex(),
        R7: r7.toHex(),
        R8: r8.toHex(),
        R9: r9.toHex(),
      },
    });

    const zeroFeeTx = new TransactionBuilder(chain.height)
      .from([box, ...owner.utxos.toArray()])
      .to([
        new OutputBuilder(SAFE_MIN_BOX_VALUE, owner.address).addTokens([
          { tokenId: USD_BASE_TOKEN, amount: 19n },
        ]),
        new OutputBuilder(SAFE_MIN_BOX_VALUE, devFee.address),
        new OutputBuilder(SAFE_MIN_BOX_VALUE, terminalAddr).addTokens([
          { tokenId: nftId, amount: 1n },
          { tokenId: aptId, amount: 999_981n },
        ]),
      ])
      .sendChangeTo(owner.address)
      .payFee(RECOMMENDED_MIN_FEE_VALUE)
      .build();

    expect(chain.execute(zeroFeeTx, { signers: [owner], throw: false })).toBe(false);

    const ceilingFeeTx = new TransactionBuilder(chain.height)
      .from([box, ...owner.utxos.toArray()])
      .to([
        new OutputBuilder(SAFE_MIN_BOX_VALUE, owner.address).addTokens([
          { tokenId: USD_BASE_TOKEN, amount: 18n },
        ]),
        new OutputBuilder(SAFE_MIN_BOX_VALUE, devFee.address).addTokens([
          { tokenId: USD_BASE_TOKEN, amount: 1n },
        ]),
        new OutputBuilder(SAFE_MIN_BOX_VALUE, terminalAddr).addTokens([
          { tokenId: nftId, amount: 1n },
          { tokenId: aptId, amount: 999_981n },
        ]),
      ])
      .sendChangeTo(owner.address)
      .payFee(RECOMMENDED_MIN_FEE_VALUE)
      .build();

    expect(chain.execute(ceilingFeeTx, { signers: [owner], throw: false })).toBe(true);
  });

  it("Test 4 (#179 review bug 1): mint_idt_v3.es enforces strictly 1n singleton NFT mint", () => {
    const chain = new MockChain({ height: 1_000_000 });
    const owner = chain.newParty("Owner");
    const devFee = chain.newParty("DevFee");
    owner.addBalance({ nanoergs: 10_000_000_000n });

    const contractBytesHashHex = hex.encode(blake2b256(hex.decode(contractV3.toHex())));
    const mintSource = MINT_IDT_V3.replace("`+contract_bytes_hash+`", contractBytesHashHex);
    const mintContract = compile(mintSource, { version: 1 });

    const ctx = setupBeneTestContext("", ERG_BASE_TOKEN_NAME);
    const pftId = "33".repeat(32);
    const r4 = createR4({
      ...ctx,
      deadline: BigInt(Date.now() + 86_400_000),
      isTimestamp: true,
    });
    const r5 = SLong(50_000n);
    const r6 = SColl(SLong, [0n, 0n, 0n]);
    const r7 = SLong(1_000_000n);
    const r8 = buildR8(owner.address.ergoTree, devFee.address.ergoTree, 5n, pftId, "");
    const r9 = SColl(SByte, utf8.decode("{}"));

    const mintInput = addBox(chain, {
      ergoTree: mintContract.toHex(),
      value: 10_000_000n,
    });
    const selfId = mintInput.boxId;

    // Minting 2n in OUTPUTS(0) -> rejected
    const mintTwoTx = new TransactionBuilder(chain.height)
      .from([mintInput, ...owner.utxos.toArray()])
      .to([
        new OutputBuilder(SAFE_MIN_BOX_VALUE * 2n, contractV3Address)
          .mintToken({ amount: 2n, name: "NFT" })
          .addTokens([{ tokenId: pftId, amount: 100_000n }])
          .setAdditionalRegisters({
            R4: r4,
            R5: r5.toHex(),
            R6: r6.toHex(),
            R7: r7.toHex(),
            R8: r8.toHex(),
            R9: r9.toHex(),
          }),
      ])
      .sendChangeTo(owner.address)
      .payFee(RECOMMENDED_MIN_FEE_VALUE)
      .build();

    expect(chain.execute(mintTwoTx, { signers: [owner], throw: false })).toBe(false);

    // Splitting 1n in OUTPUTS(0) + 1n in OUTPUTS(1) -> rejected
    const splitMintTx = new TransactionBuilder(chain.height)
      .from([mintInput, ...owner.utxos.toArray()])
      .to([
        new OutputBuilder(SAFE_MIN_BOX_VALUE * 2n, contractV3Address)
          .mintToken({ amount: 1n, name: "NFT" })
          .addTokens([{ tokenId: pftId, amount: 100_000n }])
          .setAdditionalRegisters({
            R4: r4,
            R5: r5.toHex(),
            R6: r6.toHex(),
            R7: r7.toHex(),
            R8: r8.toHex(),
            R9: r9.toHex(),
          }),
        new OutputBuilder(SAFE_MIN_BOX_VALUE, owner.address).addTokens([
          { tokenId: selfId, amount: 1n },
        ]),
      ])
      .sendChangeTo(owner.address)
      .payFee(RECOMMENDED_MIN_FEE_VALUE)
      .build();

    expect(chain.execute(splitMintTx, { signers: [owner], throw: false })).toBe(false);

    // Strictly 1n at OUTPUTS(0).tokens(0) alongside all IDT at OUTPUTS(0).tokens(1) -> succeeds
    const validMintTx = new TransactionBuilder(chain.height)
      .from([mintInput, ...owner.utxos.toArray()])
      .to([
        new OutputBuilder(SAFE_MIN_BOX_VALUE * 2n, contractV3Address)
          .mintToken({ amount: 1n, name: "NFT" })
          .addTokens([{ tokenId: pftId, amount: 100_000n }])
          .setAdditionalRegisters({
            R4: r4,
            R5: r5.toHex(),
            R6: r6.toHex(),
            R7: r7.toHex(),
            R8: r8.toHex(),
            R9: r9.toHex(),
          }),
      ])
      .sendChangeTo(owner.address)
      .payFee(RECOMMENDED_MIN_FEE_VALUE)
      .build();

    expect(chain.execute(validMintTx, { signers: [owner], throw: false })).toBe(true);
  });

  it("Test 5 (#179 review bug 2): token-mode ERG protection rejects unauthenticated ERG drain", () => {
    const chain = new MockChain({ height: 1_000_000 });
    const owner = chain.newParty("Owner");
    const devFee = chain.newParty("DevFee");
    const attacker = chain.newParty("Attacker");
    attacker.addBalance({ nanoergs: 10_000_000_000n });

    const ctx = setupBeneTestContext(USD_BASE_TOKEN, USD_BASE_TOKEN_NAME);
    const nftId = "11".repeat(32);
    const aptId = "22".repeat(32);
    const pftId = "33".repeat(32);
    const terminalAddr = ErgoAddress.fromErgoTree(TERMINAL_HEX);

    const r4 = createR4({
      ...ctx,
      deadline: BigInt(Date.now() - 86_400_000),
      isTimestamp: true,
    });
    const r5 = SLong(50n);
    const r6 = SColl(SLong, [100n, 0n, 100n]);
    const r7 = SLong(1n);
    const r8 = buildR8(owner.address.ergoTree, devFee.address.ergoTree, 5n, pftId, USD_BASE_TOKEN);
    const r9 = SColl(SByte, utf8.decode("{}"));

    const box = addBox(chain, {
      ergoTree: contractV3.toHex(),
      value: 50_000_000_000n,
      assets: [
        { tokenId: nftId, amount: 1n },
        { tokenId: aptId, amount: 999_900n },
        { tokenId: USD_BASE_TOKEN, amount: 100n },
      ],
      additionalRegisters: {
        R4: r4,
        R5: r5.toHex(),
        R6: r6.toHex(),
        R7: r7.toHex(),
        R8: r8.toHex(),
        R9: r9.toHex(),
      },
    });

    const drainTx = new TransactionBuilder(chain.height)
      .from([box, ...attacker.utxos.toArray()])
      .to([
        new OutputBuilder(SAFE_MIN_BOX_VALUE, owner.address).addTokens([
          { tokenId: USD_BASE_TOKEN, amount: 95n },
        ]),
        new OutputBuilder(SAFE_MIN_BOX_VALUE, devFee.address).addTokens([
          { tokenId: USD_BASE_TOKEN, amount: 5n },
        ]),
        new OutputBuilder(SAFE_MIN_BOX_VALUE, terminalAddr).addTokens([
          { tokenId: nftId, amount: 1n },
          { tokenId: aptId, amount: 999_900n },
        ]),
      ])
      .sendChangeTo(attacker.address)
      .payFee(RECOMMENDED_MIN_FEE_VALUE)
      .build();

    expect(chain.execute(drainTx, { signers: [attacker], throw: false })).toBe(false);
  });

  it("Test 6 (#179 review bug 3): devFee = 0 unlocks full 100% withdrawal without devFeeOutput", () => {
    const chain = new MockChain({ height: 1_000_000 });
    const owner = chain.newParty("Owner");
    const devFee = chain.newParty("DevFee");
    owner.addBalance({ nanoergs: 10_000_000_000n });

    const ctx = setupBeneTestContext("", ERG_BASE_TOKEN_NAME);
    const nftId = "11".repeat(32);
    const aptId = "22".repeat(32);
    const pftId = "33".repeat(32);
    const terminalAddr = ErgoAddress.fromErgoTree(TERMINAL_HEX);

    const r4 = createR4({
      ...ctx,
      deadline: BigInt(Date.now() - 86_400_000),
      isTimestamp: true,
    });
    const r5 = SLong(50_000n);
    const r6 = SColl(SLong, [60_000n, 0n, 60_000n]);
    const r7 = SLong(1_666_666n);
    const r8 = buildR8(owner.address.ergoTree, devFee.address.ergoTree, 0n, pftId, "");
    const r9 = SColl(SByte, utf8.decode("{}"));

    const box = addBox(chain, {
      ergoTree: contractV3.toHex(),
      value: 100_000_000_000n,
      assets: [
        { tokenId: nftId, amount: 1n },
        { tokenId: aptId, amount: 940_000n },
      ],
      additionalRegisters: {
        R4: r4,
        R5: r5.toHex(),
        R6: r6.toHex(),
        R7: r7.toHex(),
        R8: r8.toHex(),
        R9: r9.toHex(),
      },
    });

    const zeroDevFeeTx = new TransactionBuilder(chain.height)
      .from([box, ...owner.utxos.toArray()])
      .to([
        new OutputBuilder(100_000_000_000n, owner.address),
        new OutputBuilder(SAFE_MIN_BOX_VALUE, terminalAddr).addTokens([
          { tokenId: nftId, amount: 1n },
          { tokenId: aptId, amount: 940_000n },
        ]),
      ])
      .sendChangeTo(owner.address)
      .payFee(RECOMMENDED_MIN_FEE_VALUE)
      .build();

    expect(chain.execute(zeroDevFeeTx, { signers: [owner], throw: false })).toBe(true);
  });

  it("Test 7 (#174 clone guard & #78 VLQ top-up): +1,440n top-up succeeds, extra beneTree box at OUTPUTS(2) rejected", () => {
    const chain = new MockChain({ height: 1_000_000 });
    const owner = chain.newParty("Owner");
    const devFee = chain.newParty("DevFee");
    const buyer = chain.newParty("Buyer");
    buyer.addBalance({ nanoergs: 10_000_000_000n });

    const ctx = setupBeneTestContext("", ERG_BASE_TOKEN_NAME);
    const nftId = "11".repeat(32);
    const aptId = "22".repeat(32);
    const pftId = "33".repeat(32);

    const r4 = createR4({
      ...ctx,
      deadline: BigInt(Date.now() - 86_400_000),
      isTimestamp: true,
    });
    const r5 = SLong(50_000n);
    const r6 = SColl(SLong, [60_000n, 0n, 0n]);
    const r7 = SLong(1_000_000n);
    const r8 = buildR8(owner.address.ergoTree, devFee.address.ergoTree, 5n, pftId, "");
    const r9 = SColl(SByte, utf8.decode("{}"));

    const box = addBox(chain, {
      ergoTree: contractV3.toHex(),
      value: 60_000_000_000n,
      assets: [
        { tokenId: nftId, amount: 1n },
        { tokenId: aptId, amount: 940_000n },
        { tokenId: pftId, amount: 100_000n },
      ],
      additionalRegisters: {
        R4: r4,
        R5: r5.toHex(),
        R6: r6.toHex(),
        R7: r7.toHex(),
        R8: r8.toHex(),
        R9: r9.toHex(),
      },
    });

    buyer.addBalance({ tokens: [{ tokenId: aptId, amount: 1_000n }] });

    const cloneTx = new TransactionBuilder(chain.height)
      .from([box, ...buyer.utxos.toArray()])
      .to([
        new OutputBuilder(60_000_001_440n, contractV3Address)
          .addTokens([
            { tokenId: nftId, amount: 1n },
            { tokenId: aptId, amount: 941_000n },
            { tokenId: pftId, amount: 99_000n },
          ])
          .setAdditionalRegisters({
            R4: r4,
            R5: r5.toHex(),
            R6: SColl(SLong, [60_000n, 0n, 1_000n]).toHex(),
            R7: r7.toHex(),
            R8: r8.toHex(),
            R9: r9.toHex(),
          }),
        new OutputBuilder(SAFE_MIN_BOX_VALUE, buyer.address).addTokens([
          { tokenId: pftId, amount: 1_000n },
        ]),
        new OutputBuilder(SAFE_MIN_BOX_VALUE, contractV3Address),
      ])
      .sendChangeTo(buyer.address)
      .payFee(RECOMMENDED_MIN_FEE_VALUE)
      .build();

    expect(chain.execute(cloneTx, { signers: [buyer], throw: false })).toBe(false);

    const topUpTx = new TransactionBuilder(chain.height)
      .from([box, ...buyer.utxos.toArray()])
      .to([
        new OutputBuilder(60_000_001_440n, contractV3Address)
          .addTokens([
            { tokenId: nftId, amount: 1n },
            { tokenId: aptId, amount: 941_000n },
            { tokenId: pftId, amount: 99_000n },
          ])
          .setAdditionalRegisters({
            R4: r4,
            R5: r5.toHex(),
            R6: SColl(SLong, [60_000n, 0n, 1_000n]).toHex(),
            R7: r7.toHex(),
            R8: r8.toHex(),
            R9: r9.toHex(),
          }),
        new OutputBuilder(SAFE_MIN_BOX_VALUE, buyer.address).addTokens([
          { tokenId: pftId, amount: 1_000n },
        ]),
      ])
      .sendChangeTo(buyer.address)
      .payFee(RECOMMENDED_MIN_FEE_VALUE)
      .build();

    expect(chain.execute(topUpTx, { signers: [buyer], throw: false })).toBe(true);
  });
});
