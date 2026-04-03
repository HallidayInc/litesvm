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
    solana_clock::Clock,
    solana_epoch_schedule::EpochSchedule,
    solana_pubkey::Pubkey,
    solana_signature::Signature,
    solana_transaction::{versioned::VersionedTransaction, Transaction},
    std::alloc::{alloc, Layout},
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

/// Serializes a value to JSON and returns a pointer to a length-prefixed buffer.
/// Format: [4-byte little-endian length][JSON bytes]
///
/// This is required because deno_bindgen's automatic struct serialization doesn't
/// match what the TypeScript decodeResult function expects. The TypeScript side
/// reads the first 4 bytes as a u32 length, then reads that many bytes as JSON.
fn serialize_to_ptr<T: serde::Serialize>(value: &T) -> *const u8 {
    let json = serde_json::to_vec(value).expect("serialization failed");
    let len = json.len() as u32;

    // Allocate buffer: 4 bytes for length + JSON data
    let layout = Layout::from_size_align(4 + json.len(), 1).unwrap();
    unsafe {
        let ptr = alloc(layout);
        if ptr.is_null() {
            panic!("allocation failed");
        }
        // Write length as little-endian u32
        std::ptr::copy_nonoverlapping(len.to_le_bytes().as_ptr(), ptr, 4);
        // Write JSON data
        std::ptr::copy_nonoverlapping(json.as_ptr(), ptr.add(4), json.len());
        ptr
    }
}

fn convert_pubkey(bytes: &[u8]) -> Result<Pubkey, String> {
    if bytes.len() != 32 {
        return Err("expected 32 byte public key".to_string());
    }
    Ok(Pubkey::new_from_array(bytes.try_into().unwrap()))
}

fn to_js_error(msg: &str, err: LiteSVMError) -> String {
    format!("{msg}: {err}")
}

fn with_instance_mut<F, R>(handle: u32, f: F) -> Result<R, String>
where
    F: FnOnce(&mut LiteSVM) -> Result<R, String>,
{
    let mut map = INSTANCES
        .lock()
        .map_err(|_| "LiteSVM instances poisoned".to_string())?;
    let svm = map
        .get_mut(&handle)
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
pub fn create_default() -> u32 {
    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    let mut map = INSTANCES.lock().expect("mutex poisoned");
    map.insert(id, LiteSVM::default());
    id
}

#[deno_bindgen]
pub fn create_basic() -> u32 {
    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    let mut map = INSTANCES.lock().expect("mutex poisoned");
    map.insert(id, LiteSVM::new());
    id
}

#[deno_bindgen]
pub fn dispose(handle: u32) {
    if let Ok(mut map) = INSTANCES.lock() {
        map.remove(&handle);
    }
}

#[deno_bindgen]
pub fn set_default_programs(handle: u32) -> *const u8 {
    let result = into_operation_result(with_instance_mut(handle, |svm| {
        svm.set_default_programs();
        Ok(())
    }));
    serialize_to_ptr(&result)
}

#[deno_bindgen]
pub fn set_precompiles(handle: u32) -> *const u8 {
    let result = into_operation_result(with_instance_mut(handle, |svm| {
        svm.set_precompiles();
        Ok(())
    }));
    serialize_to_ptr(&result)
}

#[deno_bindgen]
pub fn set_builtins(handle: u32) -> *const u8 {
    let result = into_operation_result(with_instance_mut(handle, |svm| {
        svm.set_builtins();
        Ok(())
    }));
    serialize_to_ptr(&result)
}

#[deno_bindgen]
pub fn set_sysvars(handle: u32) -> *const u8 {
    let result = into_operation_result(with_instance_mut(handle, |svm| {
        svm.set_sysvars();
        Ok(())
    }));
    serialize_to_ptr(&result)
}

#[deno_bindgen]
pub fn latest_blockhash(handle: u32) -> *const u8 {
    let (value, error) = wrap_value(with_instance_mut(handle, |svm| {
        Ok(svm.latest_blockhash().as_ref().to_vec())
    }));
    let result = BytesResult { value, error };
    serialize_to_ptr(&result)
}

#[deno_bindgen]
pub fn expire_blockhash(handle: u32) -> *const u8 {
    let result = into_operation_result(with_instance_mut(handle, |svm| {
        svm.expire_blockhash();
        Ok(())
    }));
    serialize_to_ptr(&result)
}

#[deno_bindgen]
pub fn airdrop(handle: u32, pubkey: &[u8], lamports: u64) -> *const u8 {
    let result = match convert_pubkey(pubkey) {
        Ok(pk) => into_operation_result(with_instance_mut(handle, |svm| {
            svm.airdrop(&pk, lamports)
                .map(|_| ())
                .map_err(|e| format!("Failed to airdrop: {e:?}"))
        })),
        Err(error) => OperationResult { error: Some(error) },
    };
    serialize_to_ptr(&result)
}

#[deno_bindgen]
pub fn get_account(handle: u32, pubkey: &[u8]) -> *const u8 {
    let result = match convert_pubkey(pubkey) {
        Ok(pk) => {
            let (value, error) = match with_instance_mut(handle, |svm| {
                Ok(svm.get_account(&pk).map(|account| {
                    let shared: AccountSharedData = account.into();
                    SerializableAccount::from(shared)
                }))
            }) {
                Ok(value) => (value, None),
                Err(error) => (None, Some(error)),
            };
            AccountResult { value, error }
        }
        Err(error) => AccountResult {
            value: None,
            error: Some(error),
        },
    };
    serialize_to_ptr(&result)
}

#[deno_bindgen]
pub fn set_account(
    handle: u32,
    pubkey: &[u8],
    account: *const u8,
) -> *const u8 {
    // Deserialize the account from the JSON pointer
    let result = match deserialize_account_from_ptr(account) {
        Ok(serializable_account) => match convert_pubkey(pubkey) {
            Ok(pk) => into_operation_result(with_instance_mut(handle, |svm| {
                let shared: AccountSharedData = serializable_account.into();
                svm.set_account(pk, shared.into())
                    .map_err(|e| to_js_error("Failed to set account", e))
            })),
            Err(error) => OperationResult { error: Some(error) },
        },
        Err(error) => OperationResult { error: Some(error) },
    };
    serialize_to_ptr(&result)
}

/// Deserialize a SerializableAccount from a JSON pointer passed from TypeScript.
/// The TypeScript side sends a pointer to JSON-encoded account data.
fn deserialize_account_from_ptr(ptr: *const u8) -> Result<SerializableAccount, String> {
    if ptr.is_null() {
        return Err("null pointer for account data".to_string());
    }
    unsafe {
        // Read length prefix (4 bytes, little-endian)
        let len = std::ptr::read_unaligned(ptr as *const u32).to_le() as usize;
        // Read JSON data
        let json_slice = std::slice::from_raw_parts(ptr.add(4), len);
        serde_json::from_slice(json_slice).map_err(|e| format!("Failed to deserialize account: {e}"))
    }
}

#[deno_bindgen]
pub fn add_program(
    handle: u32,
    program_id: &[u8],
    program_bytes: &[u8],
) -> *const u8 {
    let result = match convert_pubkey(program_id) {
        Ok(pk) => into_operation_result(with_instance_mut(handle, |svm| {
            svm.add_program(pk, program_bytes)
                .map_err(|e| to_js_error("Failed to add program", e))
        })),
        Err(error) => OperationResult { error: Some(error) },
    };
    serialize_to_ptr(&result)
}

fn deserialize_transaction(tx_bytes: &[u8]) -> Result<Transaction, String> {
    deserialize(tx_bytes).map_err(|e| format!("Failed to decode transaction: {e}"))
}

fn deserialize_versioned_transaction(tx_bytes: &[u8]) -> Result<VersionedTransaction, String> {
    deserialize(tx_bytes).map_err(|e| format!("Failed to decode versioned transaction: {e}"))
}

#[deno_bindgen]
pub fn send_legacy_transaction(handle: u32, tx_bytes: &[u8]) -> *const u8 {
    let (value, error) = wrap_value(deserialize_transaction(tx_bytes).and_then(|tx| {
        with_instance_mut(handle, |svm| {
            Ok(TransactionResultEnvelope::from(svm.send_transaction(tx)))
        })
    }));
    let result = TransactionResponse { value, error };
    serialize_to_ptr(&result)
}

#[deno_bindgen]
pub fn send_versioned_transaction(handle: u32, tx_bytes: &[u8]) -> *const u8 {
    let (value, error) = wrap_value(deserialize_versioned_transaction(tx_bytes).and_then(|tx| {
        with_instance_mut(handle, |svm| {
            Ok(TransactionResultEnvelope::from(svm.send_transaction(tx)))
        })
    }));
    let result = TransactionResponse { value, error };
    serialize_to_ptr(&result)
}

#[deno_bindgen]
pub fn simulate_legacy_transaction(handle: u32, tx_bytes: &[u8]) -> *const u8 {
    let (value, error) = wrap_value(deserialize_transaction(tx_bytes).and_then(|tx| {
        with_instance_mut(handle, |svm| {
            Ok(wrap_simulation_result(svm.simulate_transaction(tx)))
        })
    }));
    let result = SimulationResponse { value, error };
    serialize_to_ptr(&result)
}

#[deno_bindgen]
pub fn simulate_versioned_transaction(
    handle: u32,
    tx_bytes: &[u8],
) -> *const u8 {
    let (value, error) = wrap_value(deserialize_versioned_transaction(tx_bytes).and_then(|tx| {
        with_instance_mut(handle, |svm| {
            Ok(wrap_simulation_result(svm.simulate_transaction(tx)))
        })
    }));
    let result = SimulationResponse { value, error };
    serialize_to_ptr(&result)
}

#[deno_bindgen]
pub fn set_transaction_history(handle: u32, capacity: usize) -> *const u8 {
    let result = into_operation_result(with_instance_mut(handle, |svm| {
        svm.set_transaction_history(capacity);
        Ok(())
    }));
    serialize_to_ptr(&result)
}

#[deno_bindgen]
pub fn minimum_balance_for_rent_exemption(handle: u32, data_len: usize) -> *const u8 {
    let (value, error) = wrap_value(with_instance_mut(handle, |svm| {
        Ok(svm.minimum_balance_for_rent_exemption(data_len))
    }));
    let result = U64Result { value, error };
    serialize_to_ptr(&result)
}

#[deno_bindgen]
pub fn latest_blockhash_string(handle: u32) -> *const u8 {
    let (value, error) = wrap_value(with_instance_mut(handle, |svm| {
        Ok(svm.latest_blockhash().to_string())
    }));
    let result = StringResult { value, error };
    serialize_to_ptr(&result)
}

// ============================================================================
// Sysvar access
// ============================================================================

#[derive(Debug, Serialize, Deserialize)]
pub struct ClockInfo {
    pub slot: u64,
    pub epoch: u64,
    pub unix_timestamp: i64,
    pub leader_schedule_epoch: u64,
    pub epoch_start_timestamp: i64,
}

#[derive(Default, Serialize, Deserialize)]
pub struct ClockInfoResult {
    pub value: Option<ClockInfo>,
    pub error: Option<String>,
}

#[deno_bindgen]
pub fn set_sysvar_clock(
    handle: u32,
    slot: u64,
    epoch: u64,
    unix_timestamp: i64,
    leader_schedule_epoch: u64,
    epoch_start_timestamp: i64,
) -> *const u8 {
    let result = into_operation_result(with_instance_mut(handle, |svm| {
        let clock = Clock {
            slot,
            epoch,
            unix_timestamp,
            leader_schedule_epoch,
            epoch_start_timestamp,
        };
        svm.set_sysvar::<Clock>(&clock);
        Ok(())
    }));
    serialize_to_ptr(&result)
}

#[deno_bindgen]
pub fn get_sysvar_clock(handle: u32) -> *const u8 {
    let (value, error) = wrap_value(with_instance_mut(handle, |svm| {
        let clock: Clock = svm.get_sysvar();
        Ok(ClockInfo {
            slot: clock.slot,
            epoch: clock.epoch,
            unix_timestamp: clock.unix_timestamp,
            leader_schedule_epoch: clock.leader_schedule_epoch,
            epoch_start_timestamp: clock.epoch_start_timestamp,
        })
    }));
    let result = ClockInfoResult { value, error };
    serialize_to_ptr(&result)
}

#[derive(Debug, Serialize, Deserialize)]
pub struct EpochScheduleInfo {
    pub slots_per_epoch: u64,
    pub leader_schedule_slot_offset: u64,
    pub warmup: bool,
    pub first_normal_epoch: u64,
    pub first_normal_slot: u64,
}

#[derive(Default, Serialize, Deserialize)]
pub struct EpochScheduleInfoResult {
    pub value: Option<EpochScheduleInfo>,
    pub error: Option<String>,
}

#[deno_bindgen]
pub fn get_epoch_schedule(handle: u32) -> *const u8 {
    let (value, error) = wrap_value(with_instance_mut(handle, |svm| {
        let schedule: EpochSchedule = svm.get_sysvar();
        Ok(EpochScheduleInfo {
            slots_per_epoch: schedule.slots_per_epoch,
            leader_schedule_slot_offset: schedule.leader_schedule_slot_offset,
            warmup: schedule.warmup,
            first_normal_epoch: schedule.first_normal_epoch,
            first_normal_slot: schedule.first_normal_slot,
        })
    }));
    let result = EpochScheduleInfoResult { value, error };
    serialize_to_ptr(&result)
}

// ============================================================================
// Slot / time control
// ============================================================================

#[deno_bindgen]
pub fn warp_to_slot(handle: u32, slot: u64) -> *const u8 {
    let result = into_operation_result(with_instance_mut(handle, |svm| {
        svm.warp_to_slot(slot);
        Ok(())
    }));
    serialize_to_ptr(&result)
}

// ============================================================================
// Transaction history
// ============================================================================

#[deno_bindgen]
pub fn get_transaction_by_sig(handle: u32, signature: &[u8]) -> *const u8 {
    let result = if signature.len() != 64 {
        TransactionResponse {
            value: None,
            error: Some("expected 64 byte signature".to_string()),
        }
    } else {
        let sig_bytes: [u8; 64] = signature.try_into().unwrap();
        let sig = Signature::from(sig_bytes);

        match with_instance_mut(handle, |svm| {
            Ok(svm.get_transaction(&sig).map(|tx_result| {
                TransactionResultEnvelope::from(tx_result.clone())
            }))
        }) {
            Ok(value) => TransactionResponse { value, error: None },
            Err(error) => TransactionResponse { value: None, error: Some(error) },
        }
    };
    serialize_to_ptr(&result)
}

// ============================================================================
// Account iteration
// ============================================================================

#[derive(Default, Serialize, Deserialize)]
pub struct AccountKeysResult {
    pub value: Option<Vec<[u8; 32]>>,
    pub error: Option<String>,
}

#[deno_bindgen]
pub fn get_all_account_keys(handle: u32) -> *const u8 {
    let (value, error) = wrap_value(with_instance_mut(handle, |svm| {
        let keys: Vec<[u8; 32]> = svm
            .accounts_db()
            .inner
            .keys()
            .map(|pk| pk.to_bytes())
            .collect();
        Ok(keys)
    }));
    let result = AccountKeysResult { value, error };
    serialize_to_ptr(&result)
}
