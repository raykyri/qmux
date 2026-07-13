export interface TaggedUserInstructionDetails {
  label: string;
  tags: string[];
}

export function stripTaggedUserInstructionBlocks(text: string): string {
  const leading = stripLeadingTaggedInstructionBlocks(text);
  const stripped = stripInlineTaggedInstructionBlocks(leading.text);
  return leading.removed || stripped.removed ? stripped.text : text;
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

function stripLeadingTaggedInstructionBlocks(text: string): { text: string; removed: boolean } {
  let current = text;
  let removed = false;

  while (true) {
    const contentStart = taggedInstructionContentStart(current);
    if (contentStart === null) {
      return { text: removed ? "" : current, removed };
    }

    const block = parseTaggedInstructionBlockAt(current, contentStart);
    if (block === null) {
      return { text: current, removed };
    }

    current = current.slice(block.end);
    removed = true;
  }
}

function stripInlineTaggedInstructionBlocks(text: string): { text: string; removed: boolean } {
  let result = "";
  let index = 0;
  let removed = false;

  while (index < text.length) {
    const nextTag = text.indexOf("<", index);
    if (nextTag === -1) {
      result += text.slice(index);
      break;
    }

    result += text.slice(index, nextTag);
    const block = isLineContentStart(text, nextTag)
      ? parseTaggedInstructionBlockAt(text, nextTag)
      : null;
    if (block === null) {
      result += text[nextTag];
      index = nextTag + 1;
      continue;
    }

    removed = true;
    index = block.end;
  }

  return { text: result, removed };
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

function parseTaggedInstructionBlockAt(
  content: string,
  start: number,
): { tag: string; end: number } | null {
  const openingTag = parseOpeningTagAt(content, start);
  if (openingTag === null) {
    return null;
  }

  const opening = `<${openingTag.tag}>`;
  const closing = `</${openingTag.tag}>`;
  let depth = 1;
  let index = openingTag.end;

  while (index < content.length) {
    const nextOpening = content.indexOf(opening, index);
    const nextClosing = content.indexOf(closing, index);
    if (nextClosing === -1) {
      return null;
    }

    if (nextOpening !== -1 && nextOpening < nextClosing) {
      depth += 1;
      index = nextOpening + opening.length;
      continue;
    }

    depth -= 1;
    index = nextClosing + closing.length;
    if (depth === 0) {
      return { tag: openingTag.tag, end: index };
    }
  }

  return null;
}

function isLineContentStart(value: string, index: number) {
  const previousLineEnd = value.lastIndexOf("\n", index - 1);
  const lineStart = previousLineEnd === -1 ? 0 : previousLineEnd + 1;
  for (let cursor = lineStart; cursor < index; cursor += 1) {
    if (!isHorizontalWhitespace(value[cursor])) {
      return false;
    }
  }
  return true;
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
