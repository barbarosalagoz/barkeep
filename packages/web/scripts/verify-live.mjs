// One-shot verification of the deployed Payment Tracker on Stellar Testnet.
// Usage: node scripts/verify-live.mjs
import { Contract, rpc, TransactionBuilder, Account, BASE_FEE, Networks, scValToNative } from '@stellar/stellar-sdk'

const CONTRACT_ID = 'CDWVMXTDTU6DJUG3BDUKI6SK72VIAVTJ44VWCL2VZ7OX5TCRRVD7HH6X'
const RPC_URL = 'https://soroban-testnet.stellar.org'

const server = new rpc.Server(RPC_URL)
const contract = new Contract(CONTRACT_ID)
const source = new Account('GDMLL4EVSZHPFB3IES7XH72TNFITQ64G3S57SAHOE5L6LBZV4LPRZDJY', '0')

async function view(method, ...args) {
  const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build()
  const sim = await server.simulateTransaction(tx)
  if (rpc.Api.isSimulationError(sim)) throw new Error(`${method}: ${sim.error}`)
  return scValToNative(sim.result.retval)
}

const count = await view('get_payment_count')
console.log('get_payment_count =', count)
const token = await view('get_token')
console.log('get_token =', token)

const latest = await server.getLatestLedger()
const events = await server.getEvents({
  startLedger: latest.sequence - 100000 > 0 ? latest.sequence - 100000 : 1,
  filters: [{ type: 'contract', contractIds: [CONTRACT_ID] }],
  limit: 50,
}).catch(e => ({ error: String(e) }))
if (events.error) console.log('getEvents (window too old is OK):', events.error)
else console.log('events in retention window:', events.events?.length ?? 0)
