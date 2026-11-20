import {
    OutputBuilder,
    SAFE_MIN_BOX_VALUE,
    TransactionBuilder
} from '@fleet-sdk/core';
import { SColl, SLong, SPair, SBool, SByte } from '@fleet-sdk/serializer';
import { type Project } from '../../common/project';
import { get_dev_contract_address } from '../dev/dev_contract';
import { getCurrentHeight, getUtxos, signTransaction, submitTransaction } from '../wallet';
import { stringToRendered } from '../utils';
import { TERMINAL_ERGOTREE_HEX, type contract_version } from '../contract';

export function calculateDevFee(
    extractedAmount: bigint,
    devFeePercentage: bigint | number,
    version: contract_version
): bigint {
    const fee = BigInt(devFeePercentage);
    if (extractedAmount <= 0n || fee <= 0n) {
        return 0n;
    }
    if (version === "v3") {
        return (extractedAmount * fee + 99n) / 100n;
    }
    return (extractedAmount * fee) / 100n;
}

// Function to submit a project to the blockchain
export async function withdraw(project: Project, amount: number): Promise<string|null> {
    console.log("Withdrawing", amount, "from project", project.project_id);

    const isV3 = project.version === "v3";
    const walletPk = await ergo.get_change_address();

    // Get the UTXOs from the current wallet to use as inputs
    const inputs = [project.box, ...(await getUtxos())];

    let outputs: OutputBuilder[] = [];

    const isERGBase = project.base_token_id === "" || project.base_token_id === undefined;

    // Dev fee calculation
    const devFeeAmount = Number(calculateDevFee(BigInt(amount), project.constants.dev_fee, project.version));
    const projectAmount = amount - devFeeAmount;

    console.log("Total extraction:", amount, "Project amount:", projectAmount, "Dev fee amount:", devFeeAmount);

    let newValue: bigint;
    let remainingBaseTokens = 0;

    if (isERGBase) {
        newValue = BigInt(project.value) - BigInt(amount);
    } else {
        newValue = BigInt(project.value);
        remainingBaseTokens = project.current_base_token_amount - amount;
    }

    const isFullWithdrawal = isERGBase
        ? newValue <= BigInt(SAFE_MIN_BOX_VALUE)
        : remainingBaseTokens <= 0;

    if (!isFullWithdrawal) {
        // Partial withdrawal: Contract replicates itself
        let contractOutput = new OutputBuilder(
            newValue,
            project.ergo_tree
        );

        if (isV3) {
            contractOutput.addTokens({
                tokenId: project.box.assets[0].tokenId,
                amount: 1n
            });
        }

        contractOutput.addTokens({
            tokenId: project.project_id,
            amount: BigInt(project.current_idt_amount)
        });

        // Keep PFT tokens if present
        if (project.current_pft_amount > 0) {
            contractOutput.addTokens({
                tokenId: project.pft_token_id,
                amount: BigInt(project.current_pft_amount)
            });
        }

        // Keep remaining base tokens if token-based project
        if (!isERGBase && remainingBaseTokens > 0) {
            contractOutput.addTokens({
                tokenId: project.base_token_id,
                amount: BigInt(remainingBaseTokens)
            });
        }

        contractOutput.setAdditionalRegisters({
            R4: SPair(SBool(project.is_timestamp_limit), SLong(BigInt(project.block_limit))).toHex(),
            R5: SLong(BigInt(project.minimum_amount)).toHex(),
            R6: SColl(SLong, [BigInt(project.sold_counter), BigInt(project.refund_counter), BigInt(project.auxiliar_exchange_counter)]).toHex(),
            R7: SLong(BigInt(project.exchange_rate)).toHex(),
            R8: project.constants.raw!,
            R9: stringToRendered(project.content.raw)
        });

        outputs.push(contractOutput);
    }

    // Owner output (Project funds)
    if (isERGBase) {
        outputs.push(
            new OutputBuilder(
                BigInt(projectAmount),
                project.constants.owner
            )
        );
    } else {
        outputs.push(
            new OutputBuilder(
                SAFE_MIN_BOX_VALUE,
                project.constants.owner
            ).addTokens({
                tokenId: project.base_token_id,
                amount: BigInt(projectAmount)
            })
        );
    }

    // Dev fee output
    const devAddress = get_dev_contract_address();
    if (isERGBase) {
        if (devFeeAmount > 0) {
            outputs.push(
                new OutputBuilder(
                    BigInt(devFeeAmount),
                    devAddress
                )
            );
        }
    } else {
        if (!isV3 || devFeeAmount > 0) {
            const devOutput = new OutputBuilder(
                SAFE_MIN_BOX_VALUE,
                devAddress
            ).addTokens({
                tokenId: project.base_token_id,
                amount: BigInt(devFeeAmount)
            });

            // Set R4 register with token ID as Coll[Byte] so dev fee contract can identify token distributions
            // Convert hex string to byte array
            const tokenIdBytes = project.base_token_id!.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16));
            devOutput.setAdditionalRegisters({
                R4: SColl(SByte, tokenIdBytes).toHex()
            });

            outputs.push(devOutput);
        }
    }

    if (isFullWithdrawal && isV3) {
        outputs.push(
            new OutputBuilder(
                SAFE_MIN_BOX_VALUE,
                TERMINAL_ERGOTREE_HEX
            ).addTokens({
                tokenId: project.box.assets[0].tokenId,
                amount: 1n
            })
        );
    }

    console.log(outputs)

    // Building the unsigned transaction
    const unsignedTransaction = await new TransactionBuilder(await getCurrentHeight())
        .from(inputs)                     // Inputs coming from the user's UTXOs
        .to(outputs)                      // Outputs (the new project box)
        .sendChangeTo(walletPk)           // Send change back to the wallet
        .payFee(BigInt(1100000))          // Pay the recommended minimum fee
        .build()                          // Build the transaction
        .toEIP12Object();                 // Convert the transaction to an EIP-12 compatible object

    try {
        // Sign the transaction
        const signedTransaction = await signTransaction(unsignedTransaction);

        // Send the transaction to the Ergo network
        const transactionId = await submitTransaction(signedTransaction);

        console.log("Transaction id -> ", transactionId);
        return transactionId;
    } catch (e) {
        console.log(e);
        return null;
    }
}
