import { TOKEN_PROGRAM_ID, Token } from "@raydium-io/raydium-sdk";
import { PublicKey, LAMPORTS_PER_SOL, PartiallyDecodedInstruction, ConfirmedSignatureInfo } from '@solana/web3.js'
import { getMint } from '@solana/spl-token';
import { swap } from './swapAmm';
import { connection, wallet, BotConfig, RAYDIUM_PUBLIC_KEY, DEFAULT_TOKEN } from './config';
import { getWalletTokenAccount } from './util';
import { getPrice } from "./getPrice";

let signatureInfo: ConfirmedSignatureInfo[];
let lastSignature: string;

let curWallet: PublicKey;
let curState: string;
let curAmmId: string;
let curToken: Token;
let initialPrice: number;

let newTokenMint: string;

const main = async () => {
    await init()
    moniterWallet()
    console.log(`\n---------- Checking wallet: ${curWallet} ... ----------`);
}

const init = async () => {
    curWallet = new PublicKey(BotConfig.trackWallet);
    signatureInfo = await connection.getSignaturesForAddress(curWallet, { limit: 1 });
    lastSignature = signatureInfo[0].signature;
    curState = "None"
}

const moniterWallet = async () => {
    try {
        signatureInfo = await connection.getSignaturesForAddress(curWallet, { until: lastSignature }, "confirmed");
        if (signatureInfo.length > 0 && lastSignature != signatureInfo[0].signature) {
            lastSignature = signatureInfo[0].signature;
            // console.log(lastSignature)
            const sigArray = signatureInfo.filter(sig => !sig.err).map(sig => sig?.signature);
            const trxs = await connection.getParsedTransactions(sigArray, { maxSupportedTransactionVersion: 0 });
            const txs = trxs.filter(trx => trx?.transaction)
            txs.forEach(async (tx) => {
                const isTransferred: any = tx.transaction.message.instructions.find((item: any) =>
                    item.parsed?.type === 'transfer'
                )
                if (isTransferred) {
                    const txAmount = tx.meta.postBalances[0] - tx.meta.preBalances[0];
                    if (txAmount <= -BotConfig.threshold * LAMPORTS_PER_SOL) {
                        const sender = tx.transaction.message.accountKeys[0].pubkey.toString();
                        const recipient = tx.transaction.message.accountKeys[1].pubkey.toString();

                        if (recipient !== curWallet.toString()) {
                            curState = "None"
                            curWallet = new PublicKey(recipient)
                            signatureInfo = await connection.getSignaturesForAddress(curWallet, { limit: 1 });
                            lastSignature = signatureInfo[0].signature;
                            const log = {
                                'Signature:': `https://solscan.io/tx/${tx.transaction.signatures}`,
                                'From:': sender,
                                'To:': recipient,
                                'Amount:': `${-txAmount / LAMPORTS_PER_SOL} SOL`
                            }
                            console.log(`\n# Detected over ${BotConfig.threshold} Sol transferring`)
                            console.table(log)
                            console.log(`\n---------- Checking wallet: ${curWallet} ... ----------`);
                        }
                    }
                } else {
                    const isMinted: any = tx.transaction.message.instructions.find((item: any) =>
                        item.parsed?.type === 'mintTo'
                    )
                    if (isMinted) {
                        const tokenMint: string = isMinted.parsed.info.mint;
                        if(tokenMint ==  newTokenMint) return
                        newTokenMint = tokenMint;
                        const amount: number = isMinted.parsed.info.amount;
                        const tokenMintInfo = await getMint(connection, new PublicKey(tokenMint));
                        const decimal: number = tokenMintInfo.decimals
                        const log = {
                            'Signature:': `https://solscan.io/tx/${tx.transaction.signatures}`,
                            'Token Mint:': tokenMint,
                            'Decimal:': decimal,
                            'Amount:': amount,
                        }
                        console.log('\n# New token is minted')
                        console.table(log)

                    } else {
                        //check new Pool information
                        const interactRaydium = tx.transaction.message.instructions.find((item: any) =>
                            item.programId.toString() === RAYDIUM_PUBLIC_KEY
                        ) as PartiallyDecodedInstruction
                        const createdPool = tx.meta.logMessages?.find((item: string) => item.includes('Create'))
                        if (interactRaydium && createdPool) {

                            const ammid = interactRaydium.accounts[4]
                            if (curAmmId === ammid.toString()) return
                            const baseToken = interactRaydium.accounts[8]
                            const quoteToken = interactRaydium.accounts[9]

                            const baseTokenInfo = await getMint(connection, baseToken);
                            const quoteTokenInfo = await getMint(connection, quoteToken);

                            const baseDecimal = baseTokenInfo.decimals;
                            const quoteDecimal = quoteTokenInfo.decimals;

                            const res = tx.meta.logMessages?.find(item => item.includes("InitializeInstruction2"));
                            const keyValuePairs = res.split(", ");

                            let pcAmount = null;
                            let coinAmount = null;
                            for (let i = 0; i < keyValuePairs.length; i++) {
                                const pair = keyValuePairs[i].split(": ");

                                if (pair[0] === "init_pc_amount") {
                                    pcAmount = parseInt(pair[1], 10); // Convert the value to an integer
                                } else if (pair[0] === "init_coin_amount") {
                                    coinAmount = parseInt(pair[1], 10); // Convert the value to an integer
                                }
                            }

                            initialPrice = pcAmount / (coinAmount * (10 ** (quoteDecimal - baseDecimal)))
                            const log = {
                                'Signature:': `https://solscan.io/tx/${tx.transaction.signatures}`,
                                'AMMID:': ammid.toString(),
                                'Base Mint:': baseToken.toString(),
                                'Quote Mint:': quoteToken.toString(),
                                'Base Decimal:': baseDecimal,
                                'Quote Decimal:': quoteDecimal,
                                'Starting Price:': `${initialPrice} SOL`,
                            }
                            console.log('\n# New Pool is created')
                            console.table(log)
                            curToken = new Token(TOKEN_PROGRAM_ID, baseToken, baseDecimal)
                            curAmmId = ammid.toString()
                            if (curState === "None") {
                                buyToken(curToken, curAmmId)
                                curState = "Bought"
                            }
                        }
                    }
                }
            });
        }

        if (curToken && curState === "Bought") {
            const walletInfs = await getWalletTokenAccount(connection, wallet.publicKey);
            const one = walletInfs.find(i => i.accountInfo.mint.toString() === curToken.mint.toString());
            if (one) {
                const curPrice = await getPrice(curToken.mint.toString());
                if (curPrice) {
                    console.log(`* TakeProfit: ${curPrice * 100 / initialPrice} %`);
                    if (curPrice >= initialPrice * BotConfig.takeProfit || curPrice < initialPrice * BotConfig.loseProfit) {
                        curState = "Sold"
                        sellToken(curToken, curAmmId)
                    }
                }
            }
        }
    } catch (e) {
        console.log(' *', e)
    }
    setTimeout(moniterWallet, BotConfig.intervalTime);
}

const buyToken = async (bt: Token, ammId: string) => {
    try {
        const res = await swap(DEFAULT_TOKEN.WSOL, bt, ammId, BotConfig.tokenSwapAmount * LAMPORTS_PER_SOL);
        const log = {
            'Signature:': `https://solscan.io/tx/${res}`,
            'Token Address:': bt.mint.toString(),
            'Spent:': `${BotConfig.tokenSwapAmount} SOL`
        }
        console.log(`\n# Bought new token`)
        console.table(log)
        const checkTxRes = async () => {
            const state = await connection.getSignatureStatus(res, { searchTransactionHistory: true });
            if (state && state.value) {
                if (state.value.err) {
                    console.log(`\n# Sending a transaction again to buy the token: ${bt.mint}`)
                    buyToken(bt, ammId)
                }
                else
                    setTimeout(checkTxRes, BotConfig.intervalTime);
            }
        }
    } catch (e) {
        console.log(`\n# Error while trying to buy token: ${bt.mint}, ${e}`)
    }
}

const sellToken = async (bt: Token, ammId: string) => {
    try {
        const walletInfs = await getWalletTokenAccount(connection, wallet.publicKey);
        const one = walletInfs.find(i => i.accountInfo.mint.toString() === bt.mint.toString());
        if (one) {
            const bal = one.accountInfo.amount
            if (Number(bal) > 1000) {
                const res = await swap(bt, DEFAULT_TOKEN.WSOL, ammId, Number(bal));
                const log = {
                    'Signature:': `https://solscan.io/tx/${res}`,
                    'Token Address:': bt.mint.toString(),
                    'Amount:': Number(bal).toString()
                }
                console.log(`\n# Sold token`)
                console.table(log)

                const checkTxRes = async () => {
                    const state = await connection.getSignatureStatus(res, { searchTransactionHistory: true });
                    if (state && state.value) {
                        if (state.value.err) {
                            console.log(`\n# Sending a transaction again to sell the token: ${bt.mint}`)
                            sellToken(bt, ammId)
                        }
                        else
                            setTimeout(checkTxRes, BotConfig.intervalTime);
                    }
                }
            }
        }
    } catch (e) {
        console.log(`\n# Error while trying to sell token: ${bt.mint}\n ${e}`)
    }
}

main();