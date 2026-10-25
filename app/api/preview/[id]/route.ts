import { NextRequest, NextResponse } from "next/server";
import { SHELF } from "@/lib/catalog";
import { readItemFile, sampleOf } from "@/lib/book";

// A free look inside, for anyone. Same for everyone, so the edge can cache it.
export async function GET(req: NextRequest) {
  const id = req.nextUrl.pathname.split("/").pop() ?? "";
  const item = SHELF[id];
  if (!item) return NextResponse.json({ error: "no_such_item" }, { status: 404 });
  return NextResponse.json(
    { title: item.name, markdown: sampleOf(await readItemFile(item.file)) },
    { headers: { "Cache-Control": "public, s-maxage=3600" } },
  );
}
