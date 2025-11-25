use {
    bincode::deserialize,
    deno_bindgen::deno_bindgen,
    litesvm::{
        error::LiteSVMError,
        types::{
            FailedTransactionMetadata, SimulatedTransactionInfo, TransactionMetadata,
            TransactionResult,
        },
        LiteSVM,
    },
    once_cell::sync::Lazy,
    serde::{Deserialize, Serialize},
    solana_account::{AccountSharedData, ReadableAccount, WritableAccount},
    solana_pubkey::Pubkey,
    solana_transaction::{versioned::VersionedTransaction, Transaction},
    std::collections::HashMap,
    std::sync::{
        atomic::{AtomicU32, Ordering},
        Mutex,
    },
};

extern crate linkme;

pub type LiteSvmHandle = u32;

static NEXT_ID: AtomicU32 = AtomicU32::new(1);
static INSTANCES: Lazy<Mutex<HashMap<LiteSvmHandle, LiteSVM>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn convert_pubkey(bytes: &[u8]) -> Result<Pubkey, String> {
    if bytes.len() != 32 {
        return Err("expected 32 byte public key".to_string());
    }
    Ok(Pubkey::new_from_array(bytes.try_into().unwrap()))
}

fn to_js_error(msg: &str, err: LiteSVMError) -> String {
    format!("{msg}: {err}")
}

fn with_instance_mut<F, R>(handle: &LiteSvmHandle, f: F) -> Result<R, String>
where
    F: FnOnce(&mut LiteSVM) -> Result<R, String>,
{
    let mut map = INSTANCES
        .lock()
        .map_err(|_| "LiteSVM instances poisoned".to_string())?;
    let svm = map
        .get_mut(handle)
        .ok_or_else(|| "LiteSVM handle not found".to_string())?;
    f(svm)
}

#[derive(Default, Serialize, Deserialize)]
pub struct OperationResult {
    pub error: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
pub struct BytesResult {
    pub value: Option<Vec<u8>>,
    pub error: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
pub struct AccountResult {
    pub value: Option<SerializableAccount>,
    pub error: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
pub struct TransactionResponse {
    pub value: Option<TransactionResultEnvelope>,
    pub error: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
pub struct SimulationResponse {
    pub value: Option<SimulationResultEnvelope>,
    pub error: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
pub struct U64Result {
    pub value: Option<u64>,
    pub error: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
pub struct StringResult {
    pub value: Option<String>,
    pub error: Option<String>,
}

fn into_operation_result(value: Result<(), String>) -> OperationResult {
    match value {
        Ok(()) => OperationResult { error: None },
        Err(error) => OperationResult { error: Some(error) },
    }
}

fn wrap_value<T>(value: Result<T, String>) -> (Option<T>, Option<String>) {
    match value {
        Ok(value) => (Some(value), None),
        Err(error) => (None, Some(error)),
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum TransactionResultEnvelope {
    Ok(TransactionMetadata),
    Err(FailedTransactionMetadata),
}

impl From<TransactionResult> for TransactionResultEnvelope {
    fn from(value: TransactionResult) -> Self {
        match value {
            Ok(meta) => TransactionResultEnvelope::Ok(meta),
            Err(err) => TransactionResultEnvelope::Err(err),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum SimulationResultEnvelope {
    Ok(SimulatedTransactionInfo),
    Err(FailedTransactionMetadata),
}

fn wrap_simulation_result(
    value: Result<SimulatedTransactionInfo, FailedTransactionMetadata>,
) -> SimulationResultEnvelope {
    match value {
        Ok(meta) => SimulationResultEnvelope::Ok(meta),
        Err(err) => SimulationResultEnvelope::Err(err),
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SerializableAccount {
    pub lamports: u64,
    pub data: Vec<u8>,
    pub owner: [u8; 32],
    pub executable: bool,
    pub rent_epoch: u64,
}

impl From<AccountSharedData> for SerializableAccount {
    fn from(value: AccountSharedData) -> Self {
        SerializableAccount {
            lamports: value.lamports(),
            data: value.data().to_vec(),
            owner: value.owner().to_bytes(),
            executable: value.executable(),
            rent_epoch: value.rent_epoch(),
        }
    }
}

impl From<SerializableAccount> for AccountSharedData {
    fn from(value: SerializableAccount) -> Self {
        let mut account = AccountSharedData::new(
            value.lamports,
            value.data.len(),
            &Pubkey::new_from_array(value.owner),
        );
        account.set_data_from_slice(&value.data);
        account.set_executable(value.executable);
        account.set_rent_epoch(value.rent_epoch);
        account
    }
}

#[deno_bindgen]
pub fn create_default() -> LiteSvmHandle {
    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    let mut map = INSTANCES.lock().expect("mutex poisoned");
    map.insert(id, LiteSVM::default());
    id
}

#[deno_bindgen]
pub fn create_basic() -> LiteSvmHandle {
    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    let mut map = INSTANCES.lock().expect("mutex poisoned");
    map.insert(id, LiteSVM::new());
    id
}

#[deno_bindgen]
pub fn dispose(handle: &LiteSvmHandle) {
    if let Ok(mut map) = INSTANCES.lock() {
        map.remove(handle);
    }
}

#[deno_bindgen]
pub fn set_default_programs(handle: &LiteSvmHandle) -> OperationResult {
    into_operation_result(with_instance_mut(handle, |svm| {
        svm.set_default_programs();
        Ok(())
    }))
}

#[deno_bindgen]
pub fn set_precompiles(handle: &LiteSvmHandle) -> OperationResult {
    into_operation_result(with_instance_mut(handle, |svm| {
        svm.set_precompiles();
        Ok(())
    }))
}

#[deno_bindgen]
pub fn set_builtins(handle: &LiteSvmHandle) -> OperationResult {
    into_operation_result(with_instance_mut(handle, |svm| {
        svm.set_builtins();
        Ok(())
    }))
}

#[deno_bindgen]
pub fn set_sysvars(handle: &LiteSvmHandle) -> OperationResult {
    into_operation_result(with_instance_mut(handle, |svm| {
        svm.set_sysvars();
        Ok(())
    }))
}

#[deno_bindgen]
pub fn latest_blockhash(handle: &LiteSvmHandle) -> BytesResult {
    let (value, error) = wrap_value(with_instance_mut(handle, |svm| {
        Ok(svm.latest_blockhash().as_ref().to_vec())
    }));
    BytesResult { value, error }
}

#[deno_bindgen]
pub fn expire_blockhash(handle: &LiteSvmHandle) -> OperationResult {
    into_operation_result(with_instance_mut(handle, |svm| {
        svm.expire_blockhash();
        Ok(())
    }))
}

#[deno_bindgen]
pub fn airdrop(handle: &LiteSvmHandle, pubkey: &[u8], lamports: u64) -> OperationResult {
    let pubkey = match convert_pubkey(pubkey) {
        Ok(pk) => pk,
        Err(error) => return OperationResult { error: Some(error) },
    };
    into_operation_result(with_instance_mut(handle, |svm| {
        svm.airdrop(&pubkey, lamports)
            .map(|_| ())
            .map_err(|e| format!("Failed to airdrop: {e:?}"))
    }))
}

#[deno_bindgen]
pub fn get_account(handle: &LiteSvmHandle, pubkey: &[u8]) -> AccountResult {
    let pubkey = match convert_pubkey(pubkey) {
        Ok(pk) => pk,
        Err(error) => {
            return AccountResult {
                value: None,
                error: Some(error),
            }
        }
    };
    let (value, error) = match with_instance_mut(handle, |svm| {
        Ok(svm.get_account(&pubkey).map(|account| {
            let shared: AccountSharedData = account.into();
            SerializableAccount::from(shared)
        }))
    }) {
        Ok(value) => (value, None),
        Err(error) => (None, Some(error)),
    };
    AccountResult { value, error }
}

#[deno_bindgen]
pub fn set_account(
    handle: &LiteSvmHandle,
    pubkey: &[u8],
    account: &SerializableAccount,
) -> OperationResult {
    let pubkey = match convert_pubkey(pubkey) {
        Ok(pk) => pk,
        Err(error) => return OperationResult { error: Some(error) },
    };
    into_operation_result(with_instance_mut(handle, |svm| {
        let shared: AccountSharedData = account.clone().into();
        svm.set_account(pubkey, shared.into())
            .map_err(|e| to_js_error("Failed to set account", e))
    }))
}

#[deno_bindgen]
pub fn add_program(
    handle: &LiteSvmHandle,
    program_id: &[u8],
    program_bytes: &[u8],
) -> OperationResult {
    let pubkey = match convert_pubkey(program_id) {
        Ok(pk) => pk,
        Err(error) => return OperationResult { error: Some(error) },
    };
    into_operation_result(with_instance_mut(handle, |svm| {
        svm.add_program(pubkey, program_bytes)
            .map_err(|e| to_js_error("Failed to add program", e))
    }))
}

fn deserialize_transaction(tx_bytes: &[u8]) -> Result<Transaction, String> {
    deserialize(tx_bytes).map_err(|e| format!("Failed to decode transaction: {e}"))
}

fn deserialize_versioned_transaction(tx_bytes: &[u8]) -> Result<VersionedTransaction, String> {
    deserialize(tx_bytes).map_err(|e| format!("Failed to decode versioned transaction: {e}"))
}

#[deno_bindgen]
pub fn send_legacy_transaction(handle: &LiteSvmHandle, tx_bytes: &[u8]) -> TransactionResponse {
    let (value, error) = wrap_value(deserialize_transaction(tx_bytes).and_then(|tx| {
        with_instance_mut(handle, |svm| {
            Ok(TransactionResultEnvelope::from(svm.send_transaction(tx)))
        })
    }));
    TransactionResponse { value, error }
}

#[deno_bindgen]
pub fn send_versioned_transaction(handle: &LiteSvmHandle, tx_bytes: &[u8]) -> TransactionResponse {
    let (value, error) = wrap_value(deserialize_versioned_transaction(tx_bytes).and_then(|tx| {
        with_instance_mut(handle, |svm| {
            Ok(TransactionResultEnvelope::from(svm.send_transaction(tx)))
        })
    }));
    TransactionResponse { value, error }
}

#[deno_bindgen]
pub fn simulate_legacy_transaction(handle: &LiteSvmHandle, tx_bytes: &[u8]) -> SimulationResponse {
    let (value, error) = wrap_value(deserialize_transaction(tx_bytes).and_then(|tx| {
        with_instance_mut(handle, |svm| {
            Ok(wrap_simulation_result(svm.simulate_transaction(tx)))
        })
    }));
    SimulationResponse { value, error }
}

#[deno_bindgen]
pub fn simulate_versioned_transaction(
    handle: &LiteSvmHandle,
    tx_bytes: &[u8],
) -> SimulationResponse {
    let (value, error) = wrap_value(deserialize_versioned_transaction(tx_bytes).and_then(|tx| {
        with_instance_mut(handle, |svm| {
            Ok(wrap_simulation_result(svm.simulate_transaction(tx)))
        })
    }));
    SimulationResponse { value, error }
}

#[deno_bindgen]
pub fn set_transaction_history(handle: &LiteSvmHandle, capacity: usize) -> OperationResult {
    into_operation_result(with_instance_mut(handle, |svm| {
        svm.set_transaction_history(capacity);
        Ok(())
    }))
}

#[deno_bindgen]
pub fn minimum_balance_for_rent_exemption(handle: &LiteSvmHandle, data_len: usize) -> U64Result {
    let (value, error) = wrap_value(with_instance_mut(handle, |svm| {
        Ok(svm.minimum_balance_for_rent_exemption(data_len))
    }));
    U64Result { value, error }
}

#[deno_bindgen]
pub fn latest_blockhash_string(handle: &LiteSvmHandle) -> StringResult {
    let (value, error) = wrap_value(with_instance_mut(handle, |svm| {
        Ok(svm.latest_blockhash().to_string())
    }));
    StringResult { value, error }
}
