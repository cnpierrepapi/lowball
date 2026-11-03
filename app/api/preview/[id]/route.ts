import { NextRequest, NextResponse } from "next/server";
import { itemById } from "@/lib/catalog";
import { freeText } from "@/lib/shop/content";

// A free look inside, for anyone. Same for everyone, so the edge can cache it briefly.
export async function GET(req: NextRequest) {
  const id = req.nextUrl.pathname.split("/").pop() ?? "";
  const item = await itemById(id);
  const markdown = item && (await freeText(item));
  if (!item || !markdown) return NextResponse.json({ error: "no_such_item" }, { status: 404 });
  return NextResponse.json({ title: item.name, markdown }, { headers: { "Cache-Control": "public, s-maxage=300" } });
}
