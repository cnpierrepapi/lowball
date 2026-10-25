import { NextRequest, NextResponse } from "next/server";
import { address } from "@solana/kit";
import { usdcAccount, usdcBalance } from "@/lib/chain";

export async function GET(req: NextRequest) {
  try {
    const wallet = address(req.nextUrl.searchParams.get("wallet") ?? "");
    return NextResponse.json({ usdc: await usdcBalance(await usdcAccount(wallet)) });
  } catch {
    return NextResponse.json({ error: "bad_wallet" }, { status: 400 });
  }
}
