import { PublicKey, LAMPORTS_PER_SOL, PartiallyDecodedInstruction, ConfirmedSignatureInfo } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID, Token } from "@raydium-io/raydium-sdk";
import { getMint } from '@solana/spl-token';
import { swap } from './swapAmm';
import { connection, wallet, BotConfig, RAYDIUM_PUBLIC_KEY, DEFAULT_TOKEN } from './config';
import { getWalletTokenAccount } from './util';
import { getPrice } from "./getPrice";
import { SingleBar, Presets } from "cli-progress";


let signatureInfo: ConfirmedSignatureInfo[];
let lastSignature: string;

let isBought: boolean;
let initialPrice: number;
let curWallet: PublicKey;
let curToken: Token;
let curAmmId: string;
let curTime: number = 0;
let maxDuration: number = 0;
let newTokenMint: string;

const opt = {
    format: "TakeProfit: {percentage}% | ETA: {eta}s | {value}/{total}",
};
const progressBar = new SingleBar(
    opt,
    Presets.shades_classic
);


const main = async () => {
    await init()
    moniterWallet()
    console.log(`\n---------- Checking wallet: ${curWallet} ... ----------`);
}

const init = async () => {
    curWallet = new PublicKey(BotConfig.trackWallet);
    signatureInfo = await connection.getSignaturesForAddress(curWallet, { limit: 1 });
    lastSignature = signatureInfo[0].signature;
    isBought = false
    curTime = Date.now();
}

const moniterWallet = async () => {
    try {
        signatureInfo = await connection.getSignaturesForAddress(curWallet, { until: lastSignature }, "finalized");
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
                    const sender = tx.transaction.message.accountKeys[0].pubkey.toString();
                    const recipient = tx.transaction.message.accountKeys[1].pubkey.toString();
                    if (sender === curWallet.toString()) {
                        if (txAmount <= -BotConfig.threshold * LAMPORTS_PER_SOL) {
                            lastSignature = tx.transaction.signatures[0]
                            console.log(`\n# Last transaction of new wallet: https://solscan.io/tx/${lastSignature}`)
                            curWallet = new PublicKey(recipient)
                            const log = {
                                'Signature:': `https://solscan.io/tx/${tx.transaction.signatures}`,
                                'From:': sender,
                                'To:': recipient,
                                'Amount:': `${-txAmount / LAMPORTS_PER_SOL} SOL`
                            }
                            console.log(`\n# Detected over ${BotConfig.threshold} Sol transferring`)
                            console.table(log)
                            console.log(`\n---------- Checking wallet: ${curWallet} ... ----------`);
                        } else if (txAmount <= -BotConfig.oneSol * LAMPORTS_PER_SOL) {
                            if (curToken && isBought) {
                                const duration = (tx.blockTime - curTime);
                                curTime = tx.blockTime
                                if (duration > maxDuration)
                                    maxDuration = duration
                                if (duration > 20)
                                    console.log(duration + ' / ' + maxDuration)
                            }
                        }

                    }
                } else {
                    const isMinted: any = tx.transaction.message.instructions.find((item: any) =>
                        item.parsed?.type === 'mintTo'
                    )
                    if (isMinted) {
                        const tokenMint: string = isMinted.parsed.info.mint;
                        if (tokenMint === newTokenMint) return
                        newTokenMint = tokenMint;
                        const amount: number = isMinted.parsed.info.amount;
                        const tokenMintInfo = await getMint(connection, new PublicKey(tokenMint));
                        const decimal: number = tokenMintInfo.decimals
                        const frozenToken: boolean = tokenMintInfo.freezeAuthority == null ? true : false;
                        const log = {
                            'Signature:': `https://solscan.io/tx/${tx.transaction.signatures}`,
                            'Token Mint:': tokenMint,
                            'Decimal:': decimal,
                            'Amount:': amount,
                            'Frozen:': frozenToken
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
                            const frozenToken: boolean = baseTokenInfo.freezeAuthority == null ? true : false;
                            console.log(`\n# Current token's Freeze Authority disabled state: ${frozenToken}`)
                            if (frozenToken === BotConfig.onlyFrozenToken) {
                                curToken = new Token(TOKEN_PROGRAM_ID, baseToken, baseDecimal)
                                curAmmId = ammid.toString()
                                if (!isBought) {
                                    isBought = true
                                    await buyToken(curToken, curAmmId)
                                    curTime = tx.blockTime
                                    progressBar.start(initialPrice, 0);
                                }
                            }
                        }
                    }
                }
                if (curToken && isBought) {

                    const t = (tx.blockTime - curTime)
                    if (t > BotConfig.stoppingTime) {
                        console.log(`\n# It seems the stopping time now! Delay: ${t}s / ${maxDuration}s at ${tx.blockTime}`)
                        isBought = false
                        maxDuration = 0
                        progressBar.stop()
                        sellToken(curToken, curAmmId)
                    }
                }
            });
        }

        if (curToken && isBought) {

            const walletInfs = await getWalletTokenAccount(connection, wallet.publicKey);
            const one = walletInfs.find(i => i.accountInfo.mint.toString() === curToken.mint.toString());
            if (one) {
                const curPrice = await getPrice(curToken.mint.toString());
                if (curPrice) {
                    progressBar.update(curPrice - initialPrice);
                    if (curPrice >= initialPrice * BotConfig.takeProfit || curPrice < initialPrice * BotConfig.loseProfit) {
                        isBought = false
                        maxDuration = 0
                        progressBar.stop()
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
        console.log(`\n# Buying new token`)
        console.table(log)
        const checkTxRes = async () => {
            const state = await connection.getSignatureStatus(res, { searchTransactionHistory: true });
            // console.log(`# checking buying transaction result ${state.value}`)
            if (state && state.value) {
                if (state.value.err) {
                    console.log(`\n# Transaction failed! Sending a transaction again to buy the token: ${bt.mint}`)
                    buyToken(bt, ammId)
                } else {
                    console.log('\n# Transaction succeeded!')
                }
            }
            else
                setTimeout(checkTxRes, BotConfig.intervalTime);
        }
        checkTxRes()
    } catch (e) {
        console.log(`\n# Error while trying to buy token: ${bt.mint}, ${e}`)
        buyToken(bt, ammId)
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
                console.log(`\n# Selling the token`)
                console.table(log)

                const checkTxRes = async () => {
                    const state = await connection.getSignatureStatus(res, { searchTransactionHistory: true });
                    // console.log(`# checking selling transaction result ${state.value}`)
                    if (state && state.value) {
                        if (state.value.err) {
                            console.log(`\n# Transaction failed! Sending a transaction again to sell the token: ${bt.mint}`)
                            sellToken(bt, ammId)
                        } else {
                            console.log('\n# Transaction succeeded!')
                        }
                    }
                    else
                        setTimeout(checkTxRes, BotConfig.intervalTime);
                }
                checkTxRes()
            }
        }
    } catch (e) {
        console.log(`\n# Error while trying to sell token: ${bt.mint}\n ${e}`)
        sellToken(bt, ammId)
    }
}

main();

// sellToken(new Token(TOKEN_PROGRAM_ID, new PublicKey('vxJhBCi6jpiZQjAxp8rN8MeAo2MRr63MvQsGQ4nUSzx'), 8), '3EfxTTYJvfEHEsZAtoAHgPVAT5iuwxKgfy4YPeAcGLzA')