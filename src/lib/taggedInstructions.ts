export interface TaggedUserInstructionDetails {
  label: string;
  tags: string[];
}

export function isTaggedUserInstruction(text: string) {
  return taggedUserInstructionDetails(text) !== null;
}

export function taggedUserInstructionDetails(text: string): TaggedUserInstructionDetails | null {
  const contentStart = taggedInstructionContentStart(text);
  if (contentStart === null) {
    return null;
  }

  const tags = parseTaggedInstructionSequence(text.slice(contentStart));
  if (tags === null) {
    return null;
  }

  return {
    label: taggedInstructionLabel(tags),
    tags,
  };
}

function parseTaggedInstructionSequence(content: string): string[] | null {
  const result = parseTaggedInstructionSequenceFrom(content, 0);
  return result !== null && result.tags.length > 0 ? result.tags : null;
}

function parseTaggedInstructionSequenceFrom(
  content: string,
  start: number,
): { tags: string[] } | null {
  const index = skipWhitespace(content, start);
  if (index >= content.length) {
    return { tags: [] };
  }

  const openingTag = parseOpeningTagAt(content, index);
  if (openingTag === null) {
    return null;
  }

  const closing = `</${openingTag.tag}>`;
  let closingStart = openingTag.end;
  while (closingStart < content.length) {
    closingStart = content.indexOf(closing, closingStart);
    if (closingStart === -1) {
      return null;
    }

    const rest = parseTaggedInstructionSequenceFrom(content, closingStart + closing.length);
    if (rest !== null) {
      return { tags: [openingTag.tag, ...rest.tags] };
    }
    closingStart += closing.length;
  }

  return null;
}

function taggedInstructionLabel(tags: string[]) {
  const uniqueTags: string[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    if (seen.has(tag)) {
      continue;
    }
    seen.add(tag);
    uniqueTags.push(tag);
  }
  return uniqueTags.map((tag) => `<${tag}>`).join(" ");
}

function taggedInstructionContentStart(text: string) {
  let start = 0;
  while (start < text.length) {
    const lineEnd = text.indexOf("\n", start);
    const end = lineEnd === -1 ? text.length : lineEnd;
    const line = stripTrailingCarriageReturn(text.slice(start, end));
    if (!isTaggedInstructionPrefixLine(line)) {
      return start;
    }
    if (lineEnd === -1) {
      return null;
    }
    start = lineEnd + 1;
  }
  return null;
}

function isTaggedInstructionPrefixLine(line: string) {
  return line.startsWith("# ") || trimHorizontalWhitespace(line).length === 0;
}

function stripTrailingCarriageReturn(value: string) {
  return value.endsWith("\r") ? value.slice(0, -1) : value;
}

function trimHorizontalWhitespace(value: string) {
  let start = 0;
  let end = value.length;
  while (start < end && isHorizontalWhitespace(value[start])) {
    start += 1;
  }
  while (end > start && isHorizontalWhitespace(value[end - 1])) {
    end -= 1;
  }
  return value.slice(start, end);
}

function isHorizontalWhitespace(char: string) {
  return char !== "\n" && char !== "\r" && char.trim() === "";
}

function skipWhitespace(value: string, index: number) {
  while (index < value.length && value[index].trim() === "") {
    index += 1;
  }
  return index;
}

function parseOpeningTagAt(value: string, start: number): { tag: string; end: number } | null {
  if (value[start] !== "<") {
    return null;
  }
  const openingEnd = value.indexOf(">", start + 1);
  if (openingEnd === -1) {
    return null;
  }
  const tag = value.slice(start + 1, openingEnd);
  return isInstructionTagName(tag) ? { tag, end: openingEnd + 1 } : null;
}

function isInstructionTagName(tag: string) {
  if (tag.length === 0) {
    return false;
  }
  for (const char of tag) {
    const code = char.charCodeAt(0);
    const isDigit = code >= 48 && code <= 57;
    const isUpper = code >= 65 && code <= 90;
    const isLower = code >= 97 && code <= 122;
    if (!isDigit && !isUpper && !isLower && char !== "_" && char !== "-") {
      return false;
    }
  }
  return true;
}
