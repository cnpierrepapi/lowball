import type { ReactNode } from "react";

// Just enough markdown for the shop's books: headings, paragraphs, lists, quotes, rules,
// **bold** and *italic*. Builds React nodes, so nothing in the text is ever treated as HTML.

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|\*(.+?)\*/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(m[1] !== undefined ? <strong key={m.index}>{m[1]}</strong> : <em key={m.index}>{m[2]}</em>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const blocks = text.replace(/\r/g, "").split(/\n\n+/);
  return (
    <div className="book">
      {blocks.map((b, i) => {
        const lines = b.split("\n");
        if (b.trim() === "---") return <hr key={i} />;
        const h = /^(#{1,3}) (.*)$/.exec(b);
        if (h && lines.length === 1) {
          const Tag = (["h1", "h2", "h3"] as const)[h[1].length - 1];
          return <Tag key={i}>{inline(h[2])}</Tag>;
        }
        if (lines.every((l) => /^- /.test(l))) return <ul key={i}>{lines.map((l, j) => <li key={j}>{inline(l.slice(2))}</li>)}</ul>;
        if (lines.every((l) => /^\d+\. /.test(l))) return <ol key={i}>{lines.map((l, j) => <li key={j}>{inline(l.replace(/^\d+\. /, ""))}</li>)}</ol>;
        if (lines.every((l) => l.startsWith(">"))) {
          return <blockquote key={i}>{lines.map((l, j) => <p key={j}>{inline(l.replace(/^>\s?/, ""))}</p>)}</blockquote>;
        }
        return <p key={i}>{lines.map((l, j) => <span key={j}>{j > 0 && <br />}{inline(l)}</span>)}</p>;
      })}
    </div>
  );
}
