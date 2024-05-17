import { PublicKey } from '@solana/web3.js'
import { connection } from "./config";

export const checkTxResult = async (sig: string) => {
    const state = await connection.getSignatureStatus(sig, { searchTransactionHistory: true });
    console.log(state)
    if (state.value.err) {
        console.log(` - Transaction is failed: https://solscan.io/tx/${sig}`);
        return false;
    }
    else {
        console.log(` - Transaction is succeed: https://solscan.io/tx/${sig}`);
        return true;
    }
}

// // //const connection = new Connection('https://mainnet.helius-rpc.com/?api-key=45d2a95e-937d-4802-8487-98dec2736fc9');
// const sig = '4H2Ueo33Cqu9mSngRZSnF2114DCUFHGNDnj3BxvZZAQqE9CPDmnmeNKZjNJNfbYAFfBrUH6oU6JF2G8NpN2ZrKR9'
// const sig = '5tb3Jd6quqc42f5E2fbQzEAiT2i8LyYjzPeuootbYNsFRGQbJGf7rpvhcVaErLGjkTwQL26AgvRbXzcomzhHMaTW'
// checkTxResult(sig);



// const sleep = (ms:number) => {
//     return new Promise(resolve => setTimeout(resolve, ms));
// }


//websokect

const test = (id: number) => {
    console.log(id)
    let ACCOUNT_TO_WATCH = new PublicKey('3LGt65CAjNcgw3ZkAsSj9miop5SW5YfjaJb2aRJ7EycK');
    const subscriptionId = connection.onLogs(
        ACCOUNT_TO_WATCH,
        ({logs, signature}) =>{
            if(logs){
                setTimeout(() => {
                    ACCOUNT_TO_WATCH = new PublicKey('5PXxuZkvftsg5CAGjv5LL5tEtvBRskdx1AAjxw8hK2Qx')
                    console.log(`---Event Notification for ${ACCOUNT_TO_WATCH.toString()}--- \nNew Account Balance:`, signature)
                    test(subscriptionId);
                    // connection.removeOnLogsListener(subscriptionId) 
                }, 1000);
            }
        },
        "finalized"
    );
    console.log('Starting web socket, subscription ID: ', subscriptionId);
    // await sleep(10000); //Wait 10 seconds for Socket Testing
    // solanaConnection.removeAccountChangeListener(subscriptionId);
}

test(0)