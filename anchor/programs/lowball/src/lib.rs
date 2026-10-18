use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer};

declare_id!("AjbVvJWBTYy1685BRoythenR22ruYvPjbT2KYqcbKJh5");

/// Lowball: receipts for haggled deals, and vaults for deals paid in friends.
///
/// The shop server (`shop.authority`) writes facts it has seen settle over x402: a cash deal,
/// a funded pledge, a referred purchase. Money only ever leaves a vault by rules anyone can
/// check and anyone can trigger: to the merchant once the friends showed up (or the buyer
/// topped up to the full price), or back to the buyer once the deadline passed without them.
#[program]
pub mod lowball {
    use super::*;

    pub fn init_shop(ctx: Context<InitShop>) -> Result<()> {
        let shop = &mut ctx.accounts.shop;
        shop.authority = ctx.accounts.authority.key();
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
        let deal = &mut ctx.accounts.deal;
        deal.nonce = nonce;
        deal.item = item;
        deal.buyer = buyer;
        deal.list_price = list_price;
        deal.paid = paid;
        deal.slot = Clock::get()?.slot;
        emit!(DealRecorded { nonce, buyer, list_price, paid });
        Ok(())
    }

    /// Opens the vault a pledge payment goes into. The x402 `payTo` is the pledge address,
    /// so the buyer's USDC lands in `vault` and nowhere else.
    pub fn open_pledge(
        ctx: Context<OpenPledge>,
        nonce: [u8; 16],
        item: [u8; 32],
        merchant: Pubkey,
        price: u64,
        full_price: u64,
        required: u8,
        deadline: i64,
    ) -> Result<()> {
        require!(price > 0 && price < full_price, LowballError::BadAmounts);
        require!(required >= 1, LowballError::BadReferrals);
        require!(deadline > Clock::get()?.unix_timestamp, LowballError::DeadlinePassed);
        let p = &mut ctx.accounts.pledge;
        p.nonce = nonce;
        p.item = item;
        p.merchant = merchant;
        p.buyer = Pubkey::default();
        p.price = price;
        p.full_price = full_price;
        p.required = required;
        p.count = 0;
        p.deadline = deadline;
        p.status = PledgeStatus::Open;
        p.bump = ctx.bumps.pledge;
        Ok(())
    }

    /// The buyer's payment settled into the vault. The vault balance is checked here, so a
    /// pledge can't be marked funded on the server's word alone.
    pub fn fund_pledge(ctx: Context<FundPledge>, buyer: Pubkey) -> Result<()> {
        let p = &mut ctx.accounts.pledge;
        require!(p.status == PledgeStatus::Open, LowballError::WrongStatus);
        require!(ctx.accounts.vault.amount >= p.price, LowballError::NotFunded);
        require!(buyer != Pubkey::default() && buyer != p.merchant, LowballError::BadBuyer);
        p.buyer = buyer;
        p.status = PledgeStatus::Funded;
        emit!(PledgeFunded { nonce: p.nonce, buyer, price: p.price, required: p.required, deadline: p.deadline });
        Ok(())
    }

    /// Someone bought through the pledger's link. One count per wallet, never the pledger.
    pub fn record_referral(ctx: Context<RecordReferral>, referred: Pubkey) -> Result<()> {
        let p = &mut ctx.accounts.pledge;
        require!(p.status == PledgeStatus::Funded, LowballError::WrongStatus);
        require!(Clock::get()?.unix_timestamp < p.deadline, LowballError::DeadlinePassed);
        require!(referred != p.buyer && referred != p.merchant, LowballError::SelfReferral);
        p.count = p.count.saturating_add(1);
        let r = &mut ctx.accounts.referral;
        r.pledge = p.key();
        r.referred = referred;
        emit!(ReferralRecorded { nonce: p.nonce, referred, count: p.count, required: p.required });
        Ok(())
    }

    /// Pays the merchant once the friends showed up, or once the buyer topped the vault up to
    /// the full price. Anyone can call it.
    pub fn release(ctx: Context<Release>) -> Result<()> {
        let p = &ctx.accounts.pledge;
        require!(p.status == PledgeStatus::Funded, LowballError::WrongStatus);
        let vault_amount = ctx.accounts.vault.amount;
        let friends_came = p.count >= p.required;
        let topped_up = vault_amount >= p.full_price;
        require!(friends_came || topped_up, LowballError::NotYet);

        empty_vault(
            &ctx.accounts.token_program,
            &ctx.accounts.vault,
            &ctx.accounts.merchant_ata.to_account_info(),
            &ctx.accounts.rent_to,
            &ctx.accounts.pledge,
            vault_amount,
        )?;
        let p = &mut ctx.accounts.pledge;
        p.status = if friends_came { PledgeStatus::Released } else { PledgeStatus::ToppedUp };
        emit!(PledgeReleased { nonce: p.nonce, amount: vault_amount, topped_up: !friends_came });
        Ok(())
    }

    /// After the deadline, with too few friends and no top-up, the buyer gets everything back.
    /// Anyone can call it.
    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        let p = &ctx.accounts.pledge;
        require!(p.status == PledgeStatus::Funded, LowballError::WrongStatus);
        require!(Clock::get()?.unix_timestamp >= p.deadline, LowballError::NotYet);
        let vault_amount = ctx.accounts.vault.amount;
        require!(p.count < p.required && vault_amount < p.full_price, LowballError::NotRefundable);

        empty_vault(
            &ctx.accounts.token_program,
            &ctx.accounts.vault,
            &ctx.accounts.buyer_ata.to_account_info(),
            &ctx.accounts.rent_to,
            &ctx.accounts.pledge,
            vault_amount,
        )?;
        let p = &mut ctx.accounts.pledge;
        p.status = PledgeStatus::Refunded;
        emit!(PledgeRefunded { nonce: p.nonce, amount: vault_amount });
        Ok(())
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
    // Closing the vault hands its rent back to the shop that paid for it.
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
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum PledgeStatus {
    Open,
    Funded,
    Released,
    ToppedUp,
    Refunded,
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
    pub count: u8,
    pub deadline: i64,
    pub status: PledgeStatus,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Referral {
    pub pledge: Pubkey,
    pub referred: Pubkey,
}

#[derive(Accounts)]
pub struct InitShop<'info> {
    #[account(init, payer = authority, space = 8 + Shop::INIT_SPACE, seeds = [b"shop"], bump)]
    pub shop: Account<'info, Shop>,
    pub mint: Account<'info, Mint>,
    #[account(mut)]
    pub authority: Signer<'info>,
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
pub struct FundPledge<'info> {
    #[account(seeds = [b"shop"], bump = shop.bump, has_one = authority)]
    pub shop: Account<'info, Shop>,
    #[account(mut, seeds = [b"pledge", pledge.nonce.as_ref()], bump = pledge.bump)]
    pub pledge: Account<'info, Pledge>,
    #[account(associated_token::mint = shop.mint, associated_token::authority = pledge)]
    pub vault: Account<'info, TokenAccount>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(referred: Pubkey)]
pub struct RecordReferral<'info> {
    #[account(seeds = [b"shop"], bump = shop.bump, has_one = authority)]
    pub shop: Account<'info, Shop>,
    #[account(mut, seeds = [b"pledge", pledge.nonce.as_ref()], bump = pledge.bump)]
    pub pledge: Account<'info, Pledge>,
    #[account(
        init,
        payer = authority,
        space = 8 + Referral::INIT_SPACE,
        seeds = [b"ref", pledge.key().as_ref(), referred.as_ref()],
        bump
    )]
    pub referral: Account<'info, Referral>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Release<'info> {
    #[account(seeds = [b"shop"], bump = shop.bump)]
    pub shop: Account<'info, Shop>,
    #[account(mut, seeds = [b"pledge", pledge.nonce.as_ref()], bump = pledge.bump)]
    pub pledge: Account<'info, Pledge>,
    #[account(mut, associated_token::mint = shop.mint, associated_token::authority = pledge)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = shop.mint, token::authority = pledge.merchant)]
    pub merchant_ata: Account<'info, TokenAccount>,
    /// CHECK: only receives the vault's rent; pinned to the shop authority.
    #[account(mut, address = shop.authority)]
    pub rent_to: AccountInfo<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(seeds = [b"shop"], bump = shop.bump)]
    pub shop: Account<'info, Shop>,
    #[account(mut, seeds = [b"pledge", pledge.nonce.as_ref()], bump = pledge.bump)]
    pub pledge: Account<'info, Pledge>,
    #[account(mut, associated_token::mint = shop.mint, associated_token::authority = pledge)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = shop.mint, token::authority = pledge.buyer)]
    pub buyer_ata: Account<'info, TokenAccount>,
    /// CHECK: only receives the vault's rent; pinned to the shop authority.
    #[account(mut, address = shop.authority)]
    pub rent_to: AccountInfo<'info>,
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
pub struct PledgeFunded {
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

#[error_code]
pub enum LowballError {
    #[msg("Amounts don't make sense")]
    BadAmounts,
    #[msg("A pledge needs at least one friend")]
    BadReferrals,
    #[msg("The deadline has passed")]
    DeadlinePassed,
    #[msg("Wrong pledge status for this")]
    WrongStatus,
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
}
