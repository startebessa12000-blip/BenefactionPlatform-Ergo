import { explorer_uri } from "$lib/common/store";
import { get } from "svelte/store";
import { compute_ergotree_template_hash, get_template_hash, type contract_version } from "./contract";

export type LineageResolution =
    | { status: "live"; boxId: string }
    | { status: "ended" }
    | { status: "unresolved" };

interface ExplorerBoxSummary {
    boxId: string;
    ergoTree: string;
    spentTransactionId?: string | null;
    assets?: Array<{ tokenId: string; amount: number | string | bigint }>;
}

const lineageTipCache = new Map<string, ExplorerBoxSummary>();

export function clearLineageCache(): void {
    lineageTipCache.clear();
}

function matchesCampaignTemplate(ergoTreeHex: string, version: contract_version): boolean {
    const actualTemplateHash = compute_ergotree_template_hash(ergoTreeHex);
    if (!actualTemplateHash) return false;
    return actualTemplateHash === get_template_hash(version);
}

async function fetchJson(url: string): Promise<any | null> {
    try {
        const res = await fetch(url, { method: "GET" });
        if (!res.ok) return null;
        return await res.json();
    } catch {
        return null;
    }
}

async function refreshBoxState(baseUri: string, box: ExplorerBoxSummary): Promise<ExplorerBoxSummary | null> {
    if (box.spentTransactionId) return box;
    const latest = await fetchJson(`${baseUri}/api/v1/boxes/${box.boxId}`);
    if (!latest || !latest.boxId) return null;
    return latest;
}

export async function resolveCanonicalBox(
    projectId: string,
    version: contract_version,
    customExplorerUri?: string
): Promise<LineageResolution> {
    const baseUri = customExplorerUri ?? (get(explorer_uri) || "https://api.ergoplatform.com");

    const cacheKey = `${version}:${projectId}`;
    let current = lineageTipCache.get(cacheKey) ?? null;

    if (!current) {
        const mintResp = await fetchJson(`${baseUri}/api/v1/boxes/byTokenId/${projectId}?offset=0&limit=1`);
        const items: ExplorerBoxSummary[] | undefined = mintResp?.items;
        if (!items || items.length === 0) return { status: "unresolved" };

        const firstBox = items[0];
        if (matchesCampaignTemplate(firstBox.ergoTree, version)) {
            if (version === "v3") {
                const firstAsset = firstBox.assets?.[0];
                if (!firstAsset || firstAsset.tokenId !== projectId || BigInt(firstAsset.amount) !== 1n) {
                    return { status: "unresolved" };
                }
            }
            current = firstBox;
        } else {
            if (version === "v3") return { status: "unresolved" };
            const refreshedMint = await refreshBoxState(baseUri, firstBox);
            if (!refreshedMint) return { status: "unresolved" };
            if (!refreshedMint.spentTransactionId) return { status: "ended" };

            const txB = await fetchJson(`${baseUri}/api/v1/transactions/${refreshedMint.spentTransactionId}`);
            const genesisCandidate: ExplorerBoxSummary | undefined = txB?.outputs?.[0];
            if (!genesisCandidate || !matchesCampaignTemplate(genesisCandidate.ergoTree, version)) return { status: "ended" };
            if (genesisCandidate.assets?.[0]?.tokenId !== projectId) return { status: "ended" };
            current = genesisCandidate;
        }
    }

    for (let hop = 0; hop < 10_000; hop++) {
        const refreshed = await refreshBoxState(baseUri, current);
        if (!refreshed) return { status: "unresolved" };
        current = refreshed;
        lineageTipCache.set(cacheKey, current);

        if (!current.spentTransactionId) {
            return { status: "live", boxId: current.boxId };
        }

        const spendTx = await fetchJson(`${baseUri}/api/v1/transactions/${current.spentTransactionId}`);
        if (!spendTx || !Array.isArray(spendTx.outputs)) return { status: "unresolved" };

        const nextOut: ExplorerBoxSummary | undefined = spendTx.outputs[0];
        const continuesAtZero =
            Boolean(nextOut) &&
            matchesCampaignTemplate(nextOut.ergoTree, version) &&
            nextOut.assets?.[0]?.tokenId === projectId &&
            (version !== "v3" || BigInt(nextOut.assets![0].amount) === 1n);

        if (!continuesAtZero) return { status: "ended" };
        current = nextOut;
    }

    return { status: "unresolved" };
}
