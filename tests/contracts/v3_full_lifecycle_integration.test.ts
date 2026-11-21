import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockChain } from "@fleet-sdk/mock-chain";
import { ErgoAddress } from "@fleet-sdk/core";
import { get } from "svelte/store";
import { __setMockWallet } from "wallet-svelte-component";
import { submit_project } from "$lib/ergo/actions/submit";
import { buy_refund } from "$lib/ergo/actions/buy_refund";
import { temp_exchange } from "$lib/ergo/actions/temp_exchange";
import { rebalance } from "$lib/ergo/actions/rebalance";
import { withdraw, calculateDevFee } from "$lib/ergo/actions/withdraw";
import { fetchProjectById, fetchProjectsFromBlockchain, parseProjectBox } from "$lib/ergo/fetch";
import { clearLineageCache, resolveCanonicalBox } from "$lib/ergo/lineage";
import {
    compute_ergotree_template_hash,
    get_ergotree_hex,
    get_template_hash,
    mint_contract_address,
    TERMINAL_ERGOTREE_HEX,
    type contract_version,
} from "$lib/ergo/contract";
import { is_legacy_version } from "$lib/common/project";
import { explorer_uri, projects, project_id_conflicts } from "$lib/common/store";
import { ErgoPlatform } from "$lib/ergo/platform";

class InMemoryExplorer {
    public boxesById = new Map<string, any>();
    public txsById = new Map<string, any>();
    public tokenRegistry = new Map<string, { name: string; description: string; decimals: number; emissionAmount: number }>();

    syncFromParties(eip12Tx: any, mockChain: MockChain, trackedParties: any[], preExecBoxIds: Set<string>, txIndex: number): string {
        const afterMap = new Map<string, any>();
        const newUtxos: any[] = [];
        for (const p of trackedParties) {
            for (const u of p.utxos.toArray()) {
                afterMap.set(u.boxId, u);
                if (!preExecBoxIds.has(u.boxId)) {
                    newUtxos.push(u);
                }
            }
        }

        newUtxos.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

        const fallbackHexTxId = txIndex.toString(16).padStart(64, "0");
        const txId: string = newUtxos[0]?.transactionId ?? fallbackHexTxId;

        for (const inp of eip12Tx.inputs) {
            const existing = this.boxesById.get(inp.boxId);
            if (existing) existing.spentTransactionId = txId;
        }
        for (const oldId of preExecBoxIds) {
            if (!afterMap.has(oldId)) {
                const existing = this.boxesById.get(oldId);
                if (existing && !existing.spentTransactionId) {
                    existing.spentTransactionId = txId;
                }
            }
        }

        const usedBoxIds = new Set<string>();
        const outputs = eip12Tx.outputs.map((out: any, idx: number) => {
            const matched =
                newUtxos.find((u) => !usedBoxIds.has(u.boxId) && u.index === idx) ??
                newUtxos.find(
                    (u) =>
                        !usedBoxIds.has(u.boxId) &&
                        u.ergoTree === out.ergoTree &&
                        BigInt(u.value) === BigInt(out.value) &&
                        (u.assets || []).length === (out.assets || []).length
                );
            if (matched) usedBoxIds.add(matched.boxId);

            const boxId: string = matched
                ? matched.boxId
                : `${txId.slice(0, 60)}${idx.toString(16).padStart(4, "0")}`;
            const rawRegs = matched?.additionalRegisters ?? out.additionalRegisters ?? {};
            const regs: Record<string, any> = {};
            for (const [k, hexVal] of Object.entries(rawRegs)) {
                regs[k] = {
                    serializedValue: hexVal,
                    sigmaType:
                        k === "R4" ? "(SBoolean, SLong)" :
                        k === "R6" ? "Coll[SLong]" :
                        k === "R8" ? "Coll[Coll[SByte]]" :
                        k === "R9" ? "Coll[SByte]" : "SLong",
                };
            }

            const treeHex = matched?.ergoTree ?? out.ergoTree;
            const rec = {
                boxId,
                transactionId: matched?.transactionId ?? txId,
                index: matched?.index ?? idx,
                value: Number(matched?.value ?? out.value),
                ergoTree: treeHex,
                ergoTreeTemplateHash: compute_ergotree_template_hash(treeHex) ?? "other",
                assets: ((matched?.assets ?? out.assets) || []).map((a: any) => ({
                    tokenId: a.tokenId,
                    amount: Number(a.amount),
                })),
                creationHeight: matched?.creationHeight ?? out.creationHeight ?? mockChain.height,
                additionalRegisters: regs,
                spentTransactionId: null as string | null,
            };
            this.boxesById.set(boxId, rec);
            return rec;
        });

        this.txsById.set(txId, { id: txId, numConfirmations: 1, outputs });
        return txId;
    }

    installFetchMock() {
        const self = this;
        globalThis.fetch = (async (input: any, init?: any) => {
            const url = typeof input === "string" ? input : input.toString();
            if (url.includes("/api/v1/tokens/")) {
                const id = url.split("/api/v1/tokens/")[1].split("?")[0];
                const meta = self.tokenRegistry.get(id);
                return new Response(
                    JSON.stringify(meta ? { type: "EIP-004", ...meta } : { type: null, emissionAmount: 100 }),
                    { status: 200 }
                );
            }
            if (url.includes("/api/v1/boxes/unspent/search")) {
                const u = new URL(url, "https://api.ergoplatform.com");
                const off = Number(u.searchParams.get("offset") ?? "0");
                const lim = Number(u.searchParams.get("limit") ?? "100");
                const tpl = init?.body ? JSON.parse(init.body).ergoTreeTemplateHash : "";
                const items = Array.from(self.boxesById.values()).filter(
                    (b) => !b.spentTransactionId && b.ergoTreeTemplateHash === tpl
                );
                return new Response(JSON.stringify({ items: items.slice(off, off + lim) }), { status: 200 });
            }
            if (url.includes("/api/v1/boxes/unspent/byTokenId/")) {
                const id = url.split("/api/v1/boxes/unspent/byTokenId/")[1].split("?")[0];
                const items = Array.from(self.boxesById.values()).filter(
                    (b) => !b.spentTransactionId && b.assets.some((a: any) => a.tokenId === id)
                );
                return new Response(JSON.stringify({ items }), { status: 200 });
            }
            if (url.includes("/api/v1/boxes/byTokenId/")) {
                const [id, q] = url.split("/api/v1/boxes/byTokenId/")[1].split("?");
                const p = new URLSearchParams(q ?? "");
                const off = Number(p.get("offset") ?? "0");
                const lim = Number(p.get("limit") ?? "100");
                const items = Array.from(self.boxesById.values()).filter((b) =>
                    b.assets.some((a: any) => a.tokenId === id)
                );
                return new Response(JSON.stringify({ items: items.slice(off, off + lim) }), { status: 200 });
            }
            if (url.includes("/api/v1/boxes/")) {
                const id = url.split("/api/v1/boxes/")[1].split("?")[0];
                const box = self.boxesById.get(id);
                return box ? new Response(JSON.stringify(box), { status: 200 }) : new Response("404", { status: 404 });
            }
            if (url.includes("/api/v1/transactions/")) {
                const id = url.split("/api/v1/transactions/")[1].split("?")[0];
                const tx = self.txsById.get(id);
                return tx ? new Response(JSON.stringify(tx), { status: 200 }) : new Response("404", { status: 404 });
            }
            return new Response("404", { status: 404 });
        }) as any;
    }
}

function setupLifecycleEnv(version: contract_version, pftTokenId: string, emission = 100, baseTokenId = "") {
    explorer_uri.set("https://api.ergoplatform.com");
    const explorer = new InMemoryExplorer();
    explorer.installFetchMock();
    explorer.tokenRegistry.set(pftTokenId, { name: "PFT", description: "Reward", decimals: 0, emissionAmount: emission });
    if (baseTokenId) {
        explorer.tokenRegistry.set(baseTokenId, { name: "USD", description: "Base", decimals: 0, emissionAmount: 1_000_000 });
    }

    const mockChain = new MockChain({ height: 800_000 });
    const owner = mockChain.newParty("Owner");
    const buyer = mockChain.newParty("Buyer");

    owner.addUTxOs({
        value: 50_000_000_000n,
        ergoTree: owner.address.ergoTree,
        assets: [{ tokenId: pftTokenId, amount: BigInt(emission) }],
        creationHeight: 799_990,
        additionalRegisters: {},
    });
    buyer.addUTxOs({
        value: 100_000_000_000n,
        ergoTree: buyer.address.ergoTree,
        assets: baseTokenId ? [{ tokenId: baseTokenId, amount: 10_000n }] : [],
        creationHeight: 799_990,
        additionalRegisters: {},
    });

    const dummy = { owner: owner.address.toString(), dev_hash: "00".repeat(32), dev_fee: 5, pft_token_id: pftTokenId, base_token_id: baseTokenId };
    const beneParty = mockChain.addParty(get_ergotree_hex(dummy, version), "BeneContract");
    const mintParty = mockChain.addParty(ErgoAddress.fromBase58(mint_contract_address(dummy, version)).ergoTree, "MintContract");
    const terminalParty = mockChain.addParty(TERMINAL_ERGOTREE_HEX, "Terminal");
    const trackedParties = [owner, buyer, beneParty, mintParty, terminalParty];

    let txCount = 0;
    const state = { signer: owner };

    __setMockWallet({
        getCurrentHeight: async () => mockChain.height,
        getChangeAddress: async () => state.signer.address.toString(),
        getUtxos: async () =>
            state.signer.utxos.toArray().map((u: any) => ({
                boxId: u.boxId,
                transactionId: u.transactionId,
                index: u.index,
                ergoTree: u.ergoTree,
                creationHeight: u.creationHeight,
                value: u.value.toString(),
                assets: (u.assets || []).map((a: any) => ({ tokenId: a.tokenId, amount: a.amount.toString() })),
                additionalRegisters: u.additionalRegisters || {},
            })),
        signTransaction: async (tx) => tx,
        submitTransaction: async (tx) => {
            const preExecBoxIds = new Set<string>();
            for (const p of trackedParties) {
                for (const u of p.utxos.toArray()) preExecBoxIds.add(u.boxId);
            }
            expect(mockChain.execute(tx, { signers: [state.signer] })).toBe(true);
            txCount += 1;
            return explorer.syncFromParties(tx, mockChain, trackedParties, preExecBoxIds, txCount);
        },
    });

    return { explorer, mockChain, owner, buyer, beneParty, terminalParty, state };
}

describe("Full End-to-End Project Lifecycle & Lineage Integration (Issues #176 & #177)", () => {
    const origFetch = globalThis.fetch;

    beforeEach(() => {
        (globalThis as any).alert = () => {};
        explorer_uri.set("https://api.ergoplatform.com");
        clearLineageCache();
        projects.set({ data: new Map(), last_fetch: 0 });
        project_id_conflicts.set(new Map());
    });

    afterEach(() => {
        globalThis.fetch = origFetch;
    });

    it("executes complete ERG-base v3 lifecycle: submit(TxA->TxB) -> fetch -> rebalance(+PFT) -> buy(100% sell-out, 0 APT) -> partial withdraw -> temp_exchange -> full withdraw(NFT retired)", async () => {
        expect(new ErgoPlatform().last_version).toBe("v3");
        const env = setupLifecycleEnv("v3", "aa".repeat(32), 100);

        const gen = submit_project(
            "v3", "aa".repeat(32), 80, 800_500, false, 100_000_000,
            JSON.stringify({ title: "V3 E2E", description: "Desc", image: "", link: "" }), 50, "V3E2E"
        );
        await gen.next();
        const res = await gen.next();
        expect((res.value as string[]).length).toBe(2);

        await fetchProjectsFromBlockchain();
        const created = Array.from(get(projects).data.values())[0];
        expect(created).toBeDefined();
        const nftId = created.project_id;
        expect(created.version).toBe("v3");
        expect(is_legacy_version(created.version)).toBe(false);
        expect(BigInt(created.box.assets[0].amount)).toBe(1n);
        expect(created.current_idt_amount).toBe(100);
        expect(created.current_pft_amount).toBe(80);
        expect(await resolveCanonicalBox(nftId, "v3")).toEqual({ status: "live", boxId: created.box.boxId });

        let p = (await fetchProjectById(nftId))!;
        expect(await rebalance(p, 20)).toBeTruthy();

        env.state.signer = env.buyer;
        p = (await fetchProjectById(nftId))!;
        expect(await buy_refund(p, 100)).toBeTruthy();

        p = (await fetchProjectById(nftId))!;
        expect(p.current_idt_amount).toBe(0);
        expect(p.sold_counter).toBe(100);

        env.state.signer = env.owner;
        expect(await withdraw(p, 4)).toBeTruthy();

        env.state.signer = env.buyer;
        p = (await fetchProjectById(nftId))!;
        expect(await temp_exchange(p, 100)).toBeTruthy();

        env.state.signer = env.owner;
        p = (await fetchProjectById(nftId))!;
        expect(await withdraw(p, p.value / 1e9)).toBeTruthy();

        expect(await fetchProjectById(nftId)).toBeNull();
        expect(await resolveCanonicalBox(nftId, "v3")).toEqual({ status: "ended" });
        expect(env.terminalParty.utxos.toArray()[0].assets[0]).toEqual({ tokenId: nftId, amount: 1n });
    });

    it("executes post-deadline ERG refund via real submit -> fetch -> buy -> buy_refund(-amount)", async () => {
        const env = setupLifecycleEnv("v3", "bb".repeat(32), 100);
        const gen = submit_project(
            "v3", "bb".repeat(32), 100, 800_010, false, 100_000_000,
            JSON.stringify({ title: "Refund V3", description: "Desc", image: "", link: "" }), 50, "RefV3"
        );
        await gen.next();
        await gen.next();

        await fetchProjectsFromBlockchain();
        const nftId = Array.from(get(projects).data.keys())[0];

        env.state.signer = env.buyer;
        let p = (await fetchProjectById(nftId))!;
        expect(await buy_refund(p, 20)).toBeTruthy();

        env.mockChain.jumpTo(800_020);
        p = (await fetchProjectById(nftId))!;
        expect(await buy_refund(p, -20)).toBeTruthy();

        p = (await fetchProjectById(nftId))!;
        expect(p.refund_counter).toBe(20);
        expect(p.current_idt_amount).toBe(100);
    });

    it("executes multi-token (USD) v3 lifecycle: buy -> withdraw unsold -> exchange -> 19-unit ceiling withdraw -> full withdraw", async () => {
        const usdId = "dd".repeat(32);
        const env = setupLifecycleEnv("v3", "cc".repeat(32), 100, usdId);
        const gen = submit_project(
            "v3", "cc".repeat(32), 100, 800_500, false, 2,
            JSON.stringify({ title: "USD V3", description: "Desc", image: "", link: "" }), 50, "USDV3", usdId
        );
        await gen.next();
        await gen.next();

        await fetchProjectsFromBlockchain();
        const nftId = Array.from(get(projects).data.keys())[0];

        env.state.signer = env.buyer;
        let p = (await fetchProjectById(nftId))!;
        expect(await buy_refund(p, 60)).toBeTruthy();

        env.state.signer = env.owner;
        p = (await fetchProjectById(nftId))!;
        expect(await rebalance(p, -40)).toBeTruthy();

        env.state.signer = env.buyer;
        p = (await fetchProjectById(nftId))!;
        expect(await temp_exchange(p, 60)).toBeTruthy();

        env.state.signer = env.owner;
        p = (await fetchProjectById(nftId))!;
        expect(calculateDevFee(19n, 5, "v3")).toBe(1n);
        expect(await withdraw(p, 19)).toBeTruthy();

        p = (await fetchProjectById(nftId))!;
        expect(await withdraw(p, 101)).toBeTruthy();
        expect(await fetchProjectById(nftId)).toBeNull();
        expect(env.terminalParty.utxos.toArray().length).toBe(1);
    });

    it("resolves legacy v2 3-way APT impersonation via lineage (#176, #182 fix #3), rejects amount!=1 v3 NFT, & preserves v2 compatibility", async () => {
        const pftId = "ee".repeat(32);
        const env = setupLifecycleEnv("v2", pftId, 100);
        const gen = submit_project(
            "v2", pftId, 100, 800_500, false, 100_000_000,
            JSON.stringify({ title: "Legacy V2", description: "Desc", image: "", link: "" }), 50, "LegV2"
        );
        await gen.next();
        await gen.next();

        await fetchProjectsFromBlockchain();
        const v2Id = Array.from(get(projects).data.keys())[0];
        let v2Proj = (await fetchProjectById(v2Id))!;
        expect(is_legacy_version(v2Proj.version)).toBe(true);
        expect(v2Proj.current_idt_amount).toBe(101);

        env.state.signer = env.buyer;
        await buy_refund(v2Proj, 60);
        v2Proj = (await fetchProjectById(v2Id))!;
        const canonicalId = v2Proj.box.boxId;

        const baseFake = env.explorer.boxesById.get(canonicalId);
        const fake1Id = "f1".repeat(32);
        const fake2Id = "f2".repeat(32);
        env.explorer.boxesById.set(fake1Id, {
            ...baseFake, boxId: fake1Id, transactionId: "a1".repeat(32),
            assets: [{ tokenId: v2Id, amount: 1 }, { tokenId: pftId, amount: 100 }], spentTransactionId: null,
        });
        env.explorer.boxesById.set(fake2Id, {
            ...baseFake, boxId: fake2Id, transactionId: "a2".repeat(32),
            assets: [{ tokenId: v2Id, amount: 1 }, { tokenId: pftId, amount: 100 }], spentTransactionId: null,
        });

        await fetchProjectsFromBlockchain();
        expect(get(project_id_conflicts).size).toBe(0);
        expect(get(projects).data.get(v2Id)?.box.boxId).toBe(canonicalId);
        expect((await fetchProjectById(v2Id))?.box.boxId).toBe(canonicalId);

        const forgedV3 = {
            ...baseFake,
            ergoTree: get_ergotree_hex(v2Proj.constants, "v3"),
            ergoTreeTemplateHash: get_template_hash("v3"),
            assets: [{ tokenId: "ff".repeat(32), amount: 2 }, { tokenId: v2Id, amount: 100 }],
        };
        expect(await parseProjectBox(forgedV3, "v3")).toBeNull();

        env.state.signer = env.owner;
        expect(calculateDevFee(19n, 5, "v2")).toBe(0n);
        expect(await withdraw(v2Proj, 2)).toBeTruthy();
    });
});
