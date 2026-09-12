use {
    solana_account_info::AccountInfo,
    solana_clock::Clock,
    solana_msg::msg,
    solana_program_error::{ProgramError, ProgramResult},
    solana_pubkey::Pubkey,
    solana_sysvar::Sysvar,
};

solana_program_entrypoint::entrypoint!(process_instruction);

#[allow(clippy::unnecessary_wraps)]
pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    let account = accounts
        .first()
        .ok_or(ProgramError::NotEnoughAccountKeys)?;
    if account.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    if !account.is_writable {
        return Err(ProgramError::InvalidAccountData);
    }

    if account.data_len() < 17 {
        return Err(ProgramError::AccountDataTooSmall);
    }

    let requested_len = if instruction_data.len() >= 4 {
        let bytes: [u8; 4] = instruction_data[..4].try_into().unwrap();
        u32::from_le_bytes(bytes) as usize
    } else {
        32
    };

    if requested_len < 8 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let mut buffer = Vec::with_capacity(1);
    for index in 0..requested_len {
        buffer.push((index as u8).wrapping_add(1));
    }
    let checksum = buffer
        .iter()
        .fold(0u8, |acc, value| acc.wrapping_add(*value));

    let clock = Clock::get()?;
    msg!(
        "clock unix_timestamp: {}, realloc checksum: {}",
        clock.unix_timestamp,
        checksum
    );

    let mut data = account.try_borrow_mut_data()?;
    data[0] = checksum;
    data[1..9].copy_from_slice(&clock.unix_timestamp.to_le_bytes());
    data[9..17].copy_from_slice(&clock.slot.to_le_bytes());

    Ok(())
}
