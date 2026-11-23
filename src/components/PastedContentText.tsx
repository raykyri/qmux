// Claude may repeat the id attribute on the closing tag as well.
const PASTE_TAG = /(<\/?pasted_content(?:\s+[^<>]*?)?>)/g;

export function hasPastedContent(text: string): boolean {
  return /<pasted_content(?:\s+[^<>]*?)?>/.test(text);
}

export default function PastedContentText({ text }: { text: string }) {
  return text.split(PASTE_TAG).map((part, index) =>
    index % 2 === 1
      ? <span className="turn-paste-tag" key={index}>{part}</span>
      : part,
  );
}
