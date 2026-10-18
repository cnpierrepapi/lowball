use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer};

declare_id!("AjbVvJWBTYy1685BRoythenR22ruYvPjbT2KYqcbKJh5");

/// Most friends a pledge can ask for. Their wallets live in the pledge account itself.
pub const MAX_REFERRALS: u8 = 10;

/// Lowball: receipts for haggled deals, and vaults for deals paid in friends.
///
/// The shop server (`shop.authority`) writes facts it has seen settle over x402: a cash deal,
/// a pledge with its buyer, a friend's purchase. Money only ever leaves a vault by rules anyone
/// can check and anyone can trigger: to the merchant once the friends showed up (or the buyer
/// topped up to the full price), or back to the buyer once the deadline passed without them.
/// Whether a pledge is paid is never the server's word, it's the vault balance.
#[program]
pub mod lowball {
    use super::*;

    /// Only the program's upgrade authority can set the shop up, so nobody can grab the shop
    /// PDA between deploy and init.
    pub fn init_shop(ctx: Context<InitShop>, authority: Pubkey) -> Result<()> {
        let shop = &mut ctx.accounts.shop;
        shop.authority = authority;
        shop.mint = ctx.accounts.mint.key();
        shop.bump = ctx.bumps.shop;
        Ok(())
    }

    /// A cash deal that settled. One receipt per signed offer (seeded by its nonce).
    pub fn record_deal(
        ctx: Context<RecordDeal>,
        nonce: [u8; 16],
        item: [u8; 32],
        buyer: Pubkey,
        list_price: u64,
        paid: u64,
    ) -> Result<()> {
        require!(paid > 0 && paid <= list_price, LowballError::BadAmounts);
        require!(buyer != Pubkey::default(), LowballError::BadBuyer);
        let deal = &mut ctx.accounts.deal;
        deal.nonce = nonce;
        deal.item = item;
        deal.buyer = buyer;
        deal.list_price = list_price;
        deal.paid = paid;
        deal.slot = Clock::get()?.slot;
        deal.counted = false;
        emit!(DealRecorded { nonce, buyer, list_price, paid });
        Ok(())
    }

    /// Hands a receipt's rent back once the server has it indexed.
    pub fn close_deal(_ctx: Context<CloseDeal>) -> Result<()> {
        Ok(())
    }

    /// Opens the vault a pledge payment goes into. Called after x402 has verified the payment
    /// and before it settles, so the buyer is known up front and the vault exists for the
    /// transfer. The x402 `payTo` is the pledge address, so the USDC lands in `vault` only.
    pub fn open_pledge(
        ctx: Context<OpenPledge>,
        nonce: [u8; 16],
        item: [u8; 32],
        merchant: Pubkey,
        buyer: Pubkey,
        price: u64,
        full_price: u64,
        required: u8,
        deadline: i64,
    ) -> Result<()> {
        require!(price > 0 && price < full_price, LowballError::BadAmounts);
        require!(required >= 1 && required <= MAX_REFERRALS, LowballError::BadReferrals);
        require!(deadline > Clock::get()?.unix_timestamp, LowballError::DeadlinePassed);
        require!(buyer != Pubkey::default() && buyer != merchant, LowballError::BadBuyer);
        let p = &mut ctx.accounts.pledge;
        p.nonce = nonce;
        p.item = item;
        p.merchant = merchant;
        p.buyer = buyer;
        p.price = price;
        p.full_price = full_price;
        p.required = required;
        p.deadline = deadline;
        p.opened_slot = Clock::get()?.slot;
        p.referred = Vec::new();
        p.bump = ctx.bumps.pledge;
        emit!(PledgeOpened { nonce, buyer, price, required, deadline });
        Ok(())
    }

    /// A friend bought through the pledger's link. The friend's cash receipt is the proof: same
    /// item, bought after the pledge opened, never the pledger or the merchant, one count per
    /// wallet and one use per receipt. A friend's own pledge has no receipt, so it can't count.
    pub fn record_referral(ctx: Context<RecordReferral>) -> Result<()> {
        let p = &mut ctx.accounts.pledge;
        let d = &mut ctx.accounts.deal;
        require!(ctx.accounts.vault.amount >= p.price, LowballError::NotFunded);
        require!(Clock::get()?.unix_timestamp < p.deadline, LowballError::DeadlinePassed);
        require!(d.item == p.item, LowballError::WrongItem);
        require!(d.slot >= p.opened_slot, LowballError::OldReceipt);
        require!(!d.counted, LowballError::AlreadyCounted);
        require!(d.buyer != p.buyer && d.buyer != p.merchant, LowballError::SelfReferral);
        require!(!p.referred.contains(&d.buyer), LowballError::AlreadyCounted);
        require!(p.referred.len() < p.required as usize, LowballError::Enough);
        d.counted = true;
        p.referred.push(d.buyer);
        emit!(ReferralRecorded { nonce: p.nonce, referred: d.buyer, count: p.referred.len() as u8, required: p.required });
        Ok(())
    }

    /// Pays the merchant once the friends showed up, or once the buyer topped the vault up to
    /// the full price. Anyone can call it. The vault and the pledge both close.
    pub fn release(ctx: Context<Release>) -> Result<()> {
        let p = &ctx.accounts.pledge;
        let vault_amount = ctx.accounts.vault.amount;
        let friends_came = p.friends_came(vault_amount);
        require!(friends_came || vault_amount >= p.full_price, LowballError::NotYet);

        empty_vault(
            &ctx.accounts.token_program,
            &ctx.accounts.vault,
            &ctx.accounts.merchant_ata.to_account_info(),
            &ctx.accounts.rent_to,
            p,
            vault_amount,
        )?;
        emit!(PledgeReleased { nonce: p.nonce, amount: vault_amount, topped_up: !friends_came });
        Ok(())
    }

    /// After the deadline, with too few friends and no top-up, the buyer gets everything back.
    /// Anyone can call it. Works whether or not the server ever saw the payment.
    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        let p = &ctx.accounts.pledge;
        require!(Clock::get()?.unix_timestamp >= p.deadline, LowballError::NotYet);
        let vault_amount = ctx.accounts.vault.amount;
        require!(!p.friends_came(vault_amount) && vault_amount < p.full_price, LowballError::NotRefundable);

        empty_vault(
            &ctx.accounts.token_program,
            &ctx.accounts.vault,
            &ctx.accounts.buyer_ata.to_account_info(),
            &ctx.accounts.rent_to,
            p,
            vault_amount,
        )?;
        emit!(PledgeRefunded { nonce: p.nonce, amount: vault_amount });
        Ok(())
    }

    /// The payment never settled: the shop closes the empty pledge and gets its rent back.
    /// Only an empty vault can be cancelled, so there's never money in the way.
    pub fn cancel_pledge(ctx: Context<CancelPledge>) -> Result<()> {
        require!(ctx.accounts.vault.amount == 0, LowballError::NotEmpty);
        let p = &ctx.accounts.pledge;
        let seeds: &[&[u8]] = &[b"pledge", &p.nonce, &[p.bump]];
        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.vault.to_account_info(),
                destination: ctx.accounts.authority.to_account_info(),
                authority: p.to_account_info(),
            },
            &[seeds],
        ))?;
        emit!(PledgeCancelled { nonce: p.nonce });
        Ok(())
    }
}

impl Pledge {
    fn friends_came(&self, vault_amount: u64) -> bool {
        self.referred.len() >= self.required as usize && vault_amount >= self.price
    }
}

fn empty_vault<'info>(
    token_program: &Program<'info, Token>,
    vault: &Account<'info, TokenAccount>,
    to: &AccountInfo<'info>,
    rent_to: &AccountInfo<'info>,
    pledge: &Account<'info, Pledge>,
    amount: u64,
) -> Result<()> {
    let seeds: &[&[u8]] = &[b"pledge", &pledge.nonce, &[pledge.bump]];
    let signer = &[seeds];
    if amount > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                token_program.to_account_info(),
                Transfer { from: vault.to_account_info(), to: to.clone(), authority: pledge.to_account_info() },
                signer,
            ),
            amount,
        )?;
    }
    // Closing the vault hands its rent back to the shop that paid for it. The pledge account
    // closes through its `close` constraint.
    token::close_account(CpiContext::new_with_signer(
        token_program.to_account_info(),
        CloseAccount { account: vault.to_account_info(), destination: rent_to.clone(), authority: pledge.to_account_info() },
        signer,
    ))
}

#[account]
#[derive(InitSpace)]
pub struct Shop {
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Deal {
    pub nonce: [u8; 16],
    pub item: [u8; 32],
    pub buyer: Pubkey,
    pub list_price: u64,
    pub paid: u64,
    pub slot: u64,
    pub counted: bool, // already used as a referral
}

#[account]
#[derive(InitSpace)]
pub struct Pledge {
    pub nonce: [u8; 16],
    pub item: [u8; 32],
    pub merchant: Pubkey,
    pub buyer: Pubkey,
    pub price: u64,
    pub full_price: u64,
    pub required: u8,
    pub deadline: i64,
    pub opened_slot: u64,
    #[max_len(10)]
    pub referred: Vec<Pubkey>,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct InitShop<'info> {
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ LowballError::NotAdmin)]
    pub program: Program<'info, crate::program::Lowball>,
    #[account(constraint = program_data.upgrade_authority_address == Some(deployer.key()) @ LowballError::NotAdmin)]
    pub program_data: Account<'info, ProgramData>,
    #[account(init, payer = deployer, space = 8 + Shop::INIT_SPACE, seeds = [b"shop"], bump)]
    pub shop: Account<'info, Shop>,
    pub mint: Account<'info, Mint>,
    #[account(mut)]
    pub deployer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(nonce: [u8; 16])]
pub struct RecordDeal<'info> {
    #[account(seeds = [b"shop"], bump = shop.bump, has_one = authority)]
    pub shop: Account<'info, Shop>,
    #[account(init, payer = authority, space = 8 + Deal::INIT_SPACE, seeds = [b"deal", nonce.as_ref()], bump)]
    pub deal: Account<'info, Deal>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseDeal<'info> {
    #[account(seeds = [b"shop"], bump = shop.bump, has_one = authority)]
    pub shop: Account<'info, Shop>,
    #[account(mut, close = authority, seeds = [b"deal", deal.nonce.as_ref()], bump)]
    pub deal: Account<'info, Deal>,
    #[account(mut)]
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(nonce: [u8; 16])]
pub struct OpenPledge<'info> {
    #[account(seeds = [b"shop"], bump = shop.bump, has_one = authority, has_one = mint)]
    pub shop: Account<'info, Shop>,
    #[account(init, payer = authority, space = 8 + Pledge::INIT_SPACE, seeds = [b"pledge", nonce.as_ref()], bump)]
    pub pledge: Account<'info, Pledge>,
    pub mint: Account<'info, Mint>,
    #[account(init, payer = authority, associated_token::mint = mint, associated_token::authority = pledge)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RecordReferral<'info> {
    #[account(seeds = [b"shop"], bump = shop.bump, has_one = authority)]
    pub shop: Account<'info, Shop>,
    #[account(mut, seeds = [b"pledge", pledge.nonce.as_ref()], bump = pledge.bump)]
    pub pledge: Account<'info, Pledge>,
    #[account(associated_token::mint = shop.mint, associated_token::authority = pledge)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"deal", deal.nonce.as_ref()], bump)]
    pub deal: Account<'info, Deal>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct Release<'info> {
    #[account(seeds = [b"shop"], bump = shop.bump)]
    pub shop: Account<'info, Shop>,
    #[account(mut, close = rent_to, seeds = [b"pledge", pledge.nonce.as_ref()], bump = pledge.bump)]
    pub pledge: Account<'info, Pledge>,
    #[account(mut, associated_token::mint = shop.mint, associated_token::authority = pledge)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = shop.mint, token::authority = pledge.merchant)]
    pub merchant_ata: Account<'info, TokenAccount>,
    /// CHECK: only receives rent; pinned to the shop authority.
    #[account(mut, address = shop.authority)]
    pub rent_to: AccountInfo<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(seeds = [b"shop"], bump = shop.bump)]
    pub shop: Account<'info, Shop>,
    #[account(mut, close = rent_to, seeds = [b"pledge", pledge.nonce.as_ref()], bump = pledge.bump)]
    pub pledge: Account<'info, Pledge>,
    #[account(mut, associated_token::mint = shop.mint, associated_token::authority = pledge)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = shop.mint, token::authority = pledge.buyer)]
    pub buyer_ata: Account<'info, TokenAccount>,
    /// CHECK: only receives rent; pinned to the shop authority.
    #[account(mut, address = shop.authority)]
    pub rent_to: AccountInfo<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CancelPledge<'info> {
    #[account(seeds = [b"shop"], bump = shop.bump, has_one = authority)]
    pub shop: Account<'info, Shop>,
    #[account(mut, close = authority, seeds = [b"pledge", pledge.nonce.as_ref()], bump = pledge.bump)]
    pub pledge: Account<'info, Pledge>,
    #[account(mut, associated_token::mint = shop.mint, associated_token::authority = pledge)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[event]
pub struct DealRecorded {
    pub nonce: [u8; 16],
    pub buyer: Pubkey,
    pub list_price: u64,
    pub paid: u64,
}

#[event]
pub struct PledgeOpened {
    pub nonce: [u8; 16],
    pub buyer: Pubkey,
    pub price: u64,
    pub required: u8,
    pub deadline: i64,
}

#[event]
pub struct ReferralRecorded {
    pub nonce: [u8; 16],
    pub referred: Pubkey,
    pub count: u8,
    pub required: u8,
}

#[event]
pub struct PledgeReleased {
    pub nonce: [u8; 16],
    pub amount: u64,
    pub topped_up: bool,
}

#[event]
pub struct PledgeRefunded {
    pub nonce: [u8; 16],
    pub amount: u64,
}

#[event]
pub struct PledgeCancelled {
    pub nonce: [u8; 16],
}

#[error_code]
pub enum LowballError {
    #[msg("Amounts don't make sense")]
    BadAmounts,
    #[msg("A pledge needs between 1 and 10 friends")]
    BadReferrals,
    #[msg("The deadline has passed")]
    DeadlinePassed,
    #[msg("The vault doesn't hold the pledge price yet")]
    NotFunded,
    #[msg("Bad buyer")]
    BadBuyer,
    #[msg("You can't refer yourself")]
    SelfReferral,
    #[msg("Not yet")]
    NotYet,
    #[msg("This pledge can't be refunded")]
    NotRefundable,
    #[msg("Only the program's upgrade authority can do this")]
    NotAdmin,
    #[msg("That receipt is for a different item")]
    WrongItem,
    #[msg("That purchase happened before the pledge opened")]
    OldReceipt,
    #[msg("That purchase or wallet already counted")]
    AlreadyCounted,
    #[msg("The pledge already has all its friends")]
    Enough,
    #[msg("The vault isn't empty")]
    NotEmpty,
}
