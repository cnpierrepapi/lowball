import { Suspense } from "react";
import { MailLink } from "@/components/MailLink";

export default function ConfirmPage() {
  return (
    <Suspense fallback={<main className="min-h-screen bg-[#fff6ea]" />}>
      <MailLink kind="confirm" />
    </Suspense>
  );
}
